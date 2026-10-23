-- Multi-user P1, migration M3 (docs/P1-AUTH-DESIGN.md §3 "Subject", §4 row issue_session and "Migration order" item 7):
-- proxima_auth.issue_session signs 'u:'||id for EVERY role, the owner included. Nothing else in its body changes, and
-- it is the only function this file replaces. From here nothing mints 'admin:' any more; 'admin:' tokens issued before
-- this commit keep verifying (M1's dual-accept branches) until they expire, at most 12 h later, and M4 removes them.
-- Lands after M1 (20261023100000_mu_p1_accounts) and M2 (20261023200000_mu_p1_scope_topic, the RLS session).
-- One transaction (apply-migration.mjs runs one file per transaction); no transaction control here.
-- 0. Preconditions, all in the opening DO block; nothing changes unless all pass:
--    (a) M2 is live: a 'u:' token for the owner, signed exactly as this file's issue_session signs it, placed in
--        request.headers as x-proxima-session, makes proxima_auth.session_scope(true) return the owner's scope (and
--        current_account resolves it to the owner row); proxima_auth.sync_topic's body reads proxima_auth.users;
--    (b) the §9.2 catalog gates: every public function that verifies p_session_token also calls current_account; no
--        fall-through spelling (else ... v_subject, any case); the 'admin:' literal only in _verify_session_token,
--        current_account, session_scope and issue_session; no table privilege for anon, authenticated or service_role
--        on the proxima_auth tables; the P1 helpers executable by postgres only and never through PUBLIC;
--    (c) compare-and-swap: every function M1 rewrote or added still has M1's post-apply md5 (34 entries, captured from
--        the live database at M1's apply; issue_session's own is 69fdda20ce11b5dd3d7e588bf44cbac0).
--    It takes proxima_auth.users in EXCLUSIVE mode first, until the commit: every sign-in, unlock, password change and
--    rename locks its account row, so one in flight finishes first and no new one starts until the commit. Every token
--    such a call mints after the commit is therefore 'u:', which is what M4's timing (12 h 05 min after this commit)
--    relies on. Token reads (the verifier, session_scope, the proxy) are not blocked.
-- 1. issue_session rewritten (only the subject expression changes).
-- 2. Post-check, same transaction: issue_session has exactly the reviewed body (md5) with its owner, grants and
--    settings; no function body in public or proxima_auth matches (?i)'admin:'\s*\|\| ; mint_token(owner id) now gives
--    a 'u:<owner id>' token that session_scope and current_account resolve to the owner; an 'admin:<owner>' token
--    issued before the commit still verifies (dual-accept window). Tokens live in variables only, never printed.
-- Rollback: supabase/rollback/20261023300000_mu_p1_mint_u_tokens.rollback.sql (refuses while M4 is live).
-- Proof: scripts/test-mu-m3-rollback.sql. Gates: sql-tx <this file> --test scripts/test-mu-auth.sql (all ok, owner
-- flows mint u:) and --test scripts/test-mu-p1-catalog.sql (all ok, the no-admin-mint gate applies).
-- M4 (20261023xxxx40_mu_p1_end_dual_accept) may be applied no earlier than 12 h 05 min after the LATEST of this file's
-- last apply (counting any rollback and re-apply) and the last 'admin:' token a script minted (design §3).

-- ── 0. Preconditions ──
do $pre$
declare
  -- M1's post-apply md5 of every function it rewrote or added (pg_get_functiondef), captured at M1's apply.
  v_m1_post constant jsonb := '{
    "proxima_auth._reauth(uuid,text)": "05582d7e1edda7e2441c4c41633e7ef9",
    "proxima_auth._revoke_sessions(uuid)": "0ae147413b06c4da3c4a8b7320c12b63",
    "proxima_auth._throttle(text,boolean)": "03923f986299b321254ba8bb8d35f60d",
    "proxima_auth.current_account(text)": "6e53e84b823eaf7e6580d0d8ebed45fc",
    "proxima_auth.issue_session(uuid)": "69fdda20ce11b5dd3d7e588bf44cbac0",
    "proxima_auth.m1_frozen_guard()": "f61c6c7fffab1ea1dd6db45c9a3f1b5d",
    "proxima_auth.mint_token(uuid)": "d36e0db275e26a7168c08c1a2380dcd1",
    "public._rows_keep_owner()": "6abe16bad953a12837f60b917bdf423a",
    "public._verify_session_token(text)": "484c5195284ab3141fcae69a7c80b8af",
    "public.change_my_password(text,text,text)": "fb9a2721b2b06b48a3c3da1570ffc6cb",
    "public.clear_queued_rows(text,text,bigint,text[])": "b87428a53d9afa56004842b705d08d19",
    "public.delete_my_backup_phase2(text,uuid)": "a0c18323658e1c724a65cbeff2d63b38",
    "public.delete_queued_rows(text,text,text[],bigint)": "0a0684db11559e26e42109a2c22d5ad2",
    "public.generations_live(text,text[])": "597f071e084dc61d980984a7a4c5e49a",
    "public.get_auto_backups(text)": "4b9bb02a32f53b6003d36b5ba52297a3",
    "public.get_my_account(text)": "9771a17c630684e4f4bbe620c3f02dd5",
    "public.get_my_wavespeed_key(text)": "0d9b7b286f6e4981ca165c79298a3336",
    "public.list_my_backups_phase2(text,integer)": "89819bad3e7499ea4845c9974c88b7a5",
    "public.paths_in_use(text,text[])": "2c56b8f787c84ca4738911b569a3e2ca",
    "public.purge_my_backups_of(text,text[],text[])": "03b31626af6461022cb1c17fccd280d0",
    "public.rename_my_account(text,text,text)": "52480f4868d3093b5df2bba84c27a218",
    "public.reset_queued_rows(text,bigint,text[],text[],bigint)": "fc616e80ec387f4d84913190994b0274",
    "public.restore_my_backup_phase2(text,uuid)": "78079d1b4ab6d4178f05295e4d9b3661",
    "public.server_time_ms(text)": "f491efcda665ca4c51f3214ead921ea1",
    "public.set_admin_backup_code(text,text,text)": "f297eac19d4a633909607fb0e4a9b1d2",
    "public.set_admin_credentials_rehash(text,text)": "16d6979772017cdaa5ee7c9d4bf80c17",
    "public.set_auto_backups(text,boolean)": "165cb99a909a0cfacce4a85d63d2f26a",
    "public.set_my_account(text,text,boolean,bigint)": "dbede037e1e0a146ed1ef1945806cbf3",
    "public.set_my_wavespeed_key(text,text)": "15e8e8585f119d3cee83268d370f94fc",
    "public.snapshot_my_data_phase2(text,text,text)": "cd5cfa09ae0b77204709bc230e287069",
    "public.unlock_admin_with_backup_code(text,text)": "efa5fb04c91d9a3c374c8f8c351524e3",
    "public.unlock_with_backup_code(text,text,text)": "b1a9012144bbb6447bfa1cf3032dbdf8",
    "public.upsert_queued_history(text,jsonb,bigint)": "9b577e07e025396952b78287aabf4891",
    "public.verify_admin(text,text)": "9d9c029b789c00be68ea6c68f0acc3f7"
  }';
  v_helpers constant text[] := array['proxima_auth.current_account(text)', 'proxima_auth.issue_session(uuid)',
    'proxima_auth.mint_token(uuid)', 'proxima_auth._reauth(uuid,text)', 'proxima_auth._revoke_sessions(uuid)',
    'proxima_auth._throttle(text,boolean)', 'proxima_auth.m1_frozen_guard()'];
  v_tables constant text[] := array['proxima_auth.users', 'proxima_auth.auth_config', 'proxima_auth.signin_throttle',
    'proxima_auth.m1_seed_snapshot'];
  v_bad text; n int; v_id uuid; v_scope text; v_ep bigint; v_hdr text; v_got text; v_acc proxima_auth.account;
begin
  if to_regclass('proxima_auth.users') is null or to_regprocedure('proxima_auth.current_account(text)') is null
     or to_regprocedure('proxima_auth.mint_token(uuid)') is null then
    raise exception 'M3: M1 is not applied (proxima_auth.users, current_account or mint_token is missing)';
  end if;
  lock table proxima_auth.users in exclusive mode;

  -- (c) compare-and-swap on M1's post-apply bodies (issue_session included: this file replaces it).
  select string_agg(e.k, ', ' order by e.k) into v_bad from jsonb_each_text(v_m1_post) e(k, m)
   where to_regprocedure(e.k) is null or md5(pg_get_functiondef(to_regprocedure(e.k))) <> e.m;
  if v_bad is not null then
    raise exception 'M3 compare-and-swap: body differs from M1''s post-apply text (or is missing): %', v_bad;
  end if;

  -- (a) M2 is live: the owner's 'u:' token gives the owner's scope through session_scope; sync_topic reads the owner row.
  select u.id, u.scope, u.sessions_valid_after into v_id, v_scope, v_ep from proxima_auth.users u where u.role = 'owner';
  if v_id is null then raise exception 'M3: no owner row in proxima_auth.users'; end if;
  v_hdr := current_setting('request.headers', true);
  perform set_config('request.headers', json_build_object('x-proxima-session', public._sign_session_token('u:' || v_id::text,
    to_timestamp(greatest(extract(epoch from clock_timestamp())::bigint, v_ep + 1) + 43200)))::text, true);
  begin
    v_got := proxima_auth.session_scope(true);
    v_acc := proxima_auth.current_account(((current_setting('request.headers', true))::jsonb) ->> 'x-proxima-session');
  exception when others then
    perform set_config('request.headers', coalesce(v_hdr, ''), true);
    raise exception 'M3: M2 is not live: session_scope refuses the owner''s u: token (%)', sqlerrm;
  end;
  perform set_config('request.headers', coalesce(v_hdr, ''), true);
  if v_got is distinct from v_scope or v_acc.id is distinct from v_id or v_acc.role is distinct from 'owner' then
    raise exception 'M3: M2 is not live: the owner''s u: token does not resolve to the owner''s scope';
  end if;
  if to_regprocedure('proxima_auth.sync_topic()') is null
     or pg_get_functiondef('proxima_auth.sync_topic()'::regprocedure) !~ 'proxima_auth\.users' then
    raise exception 'M3: M2 is not live: proxima_auth.sync_topic does not read proxima_auth.users';
  end if;

  -- (b) the §9.2 catalog gates (scripts/test-mu-p1-catalog.sql).
  select string_agg(p.proname, ',') into v_bad from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname <> '_verify_session_token'
     and p.prosrc like '%_verify_session_token(p_session_token)%' and p.prosrc not like '%proxima_auth.current_account%';
  if v_bad is not null then raise exception 'M3 gate semantic: verifies p_session_token without current_account: %', v_bad; end if;
  select string_agg(p.pronamespace::regnamespace || '.' || p.proname, ',') into v_bad from pg_proc p
   where p.pronamespace in ('public'::regnamespace, 'proxima_auth'::regnamespace) and p.prosrc ~* 'else\s+(\w+\s*:=\s*)?v_subject';
  if v_bad is not null then raise exception 'M3 gate no-fall-through: %', v_bad; end if;
  select string_agg(p.pronamespace::regnamespace || '.' || p.proname, ',') into v_bad from pg_proc p
   where p.pronamespace in ('public'::regnamespace, 'proxima_auth'::regnamespace) and p.prosrc like '%''admin:%'
     and (p.pronamespace::regnamespace::text || '.' || p.proname) not in
         ('public._verify_session_token', 'proxima_auth.current_account', 'proxima_auth.session_scope', 'proxima_auth.issue_session');
  if v_bad is not null then raise exception 'M3 gate admin-literal-places: %', v_bad; end if;
  select count(*) into n from unnest(v_tables) t, unnest(array['anon','authenticated','service_role']) g,
         unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) pr
   where to_regclass(t) is not null and has_table_privilege(g, t, pr);
  if n > 0 then raise exception 'M3 gate no-table-privilege: % grants', n; end if;
  select string_agg(p.oid::regprocedure::text || ':' || g, ',') into v_bad
    from pg_proc p, unnest(array['anon','authenticated','service_role']) g
   where p.oid = any (array(select to_regprocedure(x) from unnest(v_helpers) x where to_regprocedure(x) is not null))
     and has_function_privilege(g, p.oid, 'EXECUTE');
  if v_bad is not null then raise exception 'M3 gate helpers-postgres-only: %', v_bad; end if;
  select count(*) into n from pg_proc p, aclexplode(p.proacl) a
   where p.oid = any (array(select to_regprocedure(x) from unnest(v_helpers || 'public.unlock_with_backup_code(text,text,text)'::text) x
                            where to_regprocedure(x) is not null))
     and a.grantee = 0;
  if n > 0 then raise exception 'M3 gate no-public-execute: % P1 functions executable through PUBLIC', n; end if;
end $pre$;

-- ── 1. issue_session: 'u:'||id for every role (the owner's 'admin:'||username branch removed; nothing else changes) ──
CREATE OR REPLACE FUNCTION proxima_auth.issue_session(p_account uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_u proxima_auth.users; v_issued bigint; v_exp bigint; v_tok text;
begin
  select * into v_u from proxima_auth.users u where u.id = p_account;
  if not found then raise exception 'issue_session: unknown account'; end if;
  v_issued := greatest(extract(epoch from clock_timestamp())::bigint, v_u.sessions_valid_after + 1);
  v_exp := v_issued + 43200;
  v_tok := public._sign_session_token('u:' || v_u.id::text,
                                      to_timestamp(v_exp));
  return jsonb_build_object('token', v_tok, 'expires_at', v_exp, 'username', v_u.username, 'account_id', v_u.id,
                            'role', v_u.role, 'scope', v_u.scope);
end $function$
;

-- ── 2. Post-check ──
do $post$
declare
  v_m3_post constant text := 'b9ba44a18b04d17bdf0034b944a57035';   -- md5(pg_get_functiondef) of the body above
  v_bad text; v_id uuid; v_name text; v_scope text; v_ep bigint; v_tok text; v_hdr text; v_got text;
  v_acc proxima_auth.account;
begin
  if md5(pg_get_functiondef('proxima_auth.issue_session(uuid)'::regprocedure)) <> v_m3_post then
    raise exception 'M3 post-check: issue_session is not the reviewed body';
  end if;
  if (select p.proacl::text || '|' || p.proowner::regrole::text || '|' || p.prosecdef::text || '|' || p.proconfig::text
        from pg_proc p where p.oid = 'proxima_auth.issue_session(uuid)'::regprocedure)
     is distinct from '{postgres=X/postgres}|postgres|true|{"search_path=\"\""}' then
    raise exception 'M3 post-check: issue_session''s grants, owner, definer or search_path changed';
  end if;
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad from pg_proc p
   where p.pronamespace in ('public'::regnamespace, 'proxima_auth'::regnamespace) and p.prosrc ~* $re$'admin:'\s*\|\|$re$;
  if v_bad is not null then raise exception 'M3 post-check: still mints admin: tokens: %', v_bad; end if;

  select u.id, u.username, u.scope, u.sessions_valid_after into v_id, v_name, v_scope, v_ep
    from proxima_auth.users u where u.role = 'owner';
  v_tok := proxima_auth.mint_token(v_id);
  if v_tok is null or left(v_tok, 39) <> 'u:' || v_id::text || '.' then
    raise exception 'M3 post-check: mint_token(owner id) does not give a u:<owner id> token';
  end if;
  v_hdr := current_setting('request.headers', true);
  perform set_config('request.headers', json_build_object('x-proxima-session', v_tok)::text, true);
  v_got := proxima_auth.session_scope(true);
  perform set_config('request.headers', coalesce(v_hdr, ''), true);
  v_acc := proxima_auth.current_account(v_tok);
  if v_got is distinct from v_scope or v_acc.id is distinct from v_id or v_acc.role is distinct from 'owner' then
    raise exception 'M3 post-check: the minted u: token does not resolve to the owner';
  end if;
  -- The dual-accept window is intact: an 'admin:<owner>' token issued before this commit (signed as the old
  -- issue_session did) still verifies and resolves to the owner, until M4.
  v_acc := proxima_auth.current_account(public._sign_session_token('admin:' || v_name,
             to_timestamp(greatest(extract(epoch from clock_timestamp())::bigint, v_ep + 1) + 43200)));
  if v_acc.id is distinct from v_id then
    raise exception 'M3 post-check: an admin:<owner> token no longer resolves to the owner';
  end if;
end $post$;
