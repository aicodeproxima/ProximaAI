-- Multi-user P1, migration M4 (docs/P1-AUTH-DESIGN.md §3 "The dual-accept window", §4 "Migration order" item 9, §7):
-- the end of the dual-accept window. From this commit every 'admin:<name>' session token is refused with
-- 'session token revoked' (the answer the client and the proxy already treat as a sign-out); 'u:<id>' tokens, sign-in,
-- the unlocks, password change and rename behave exactly as before. Nothing mints 'admin:' since M3.
-- Lands after M1 (20261023100000_mu_p1_accounts), M2 (20261023200000_mu_p1_scope_topic, the RLS session) and M3
-- (20261023300000_mu_p1_mint_u_tokens). The RLS session removes nothing in session_scope here: since M2 it resolves
-- tokens through proxima_auth.current_account only, so this file does not touch it.
-- One transaction (apply-migration.mjs runs one file per transaction); no transaction control here.
-- 0. Preconditions, all in the opening DO block; nothing changes unless all pass. proxima_auth.users is taken in
--    EXCLUSIVE mode first, until the commit (as M3 does): a sign-in, unlock, password change or rename in flight finishes
--    first, none starts until the commit; token reads are not blocked by it.
--    (1) M3 is live: issue_session has M3's post-apply md5 b9ba44a18b04d17bdf0034b944a57035, or (if it changed since) no
--        (?i)'admin:'\s*\|\| in its body; and mint_token(owner id) gives a 'u:<owner id>' token. Otherwise M3 was rolled
--        back (or never applied), and this file would revoke every token the owner is being issued (design §4 item 9).
--    (2) The clock: now() >= 2026-10-23 21:06:07 UTC = M3's apply (2026-10-23 09:01:07 UTC) + 12 h 05 min. Every
--        'admin:' token was issued before M3's commit and lives 12 h, so none is still valid by then. The time moves
--        later if M3 is rolled back and re-applied (12 h 05 min after the LAST apply) or if a script mints an 'admin:'
--        token after M3 (rotate-signing-key.mjs prints the time when it does; from M3 both rotate scripts mint 'u:'
--        only): then edit the constant below in a reviewed commit before applying. The check has no bypass in this
--        file. Tests that need M4 before that time run a scratch copy with exactly the lines between the M4-CLOCK
--        markers removed (never this file):
--          sed '/^  -- M4-CLOCK-BEGIN/,/^  -- M4-CLOCK-END$/d' supabase/migrations/20261023400000_mu_p1_end_dual_accept.sql > <scratch>/m4-noclock.sql
--    (3) Compare-and-swap: every function this file rewrites or drops still has the md5 of pg_get_functiondef captured
--        from the live database on 2026-10-23 (read-only), which is M1's post-apply text for all four. The M1 freeze on
--        the ~30 functions M1 rewrote ends with this file.
--    (4) M1's frozen guard and seed snapshot: each object is either exactly as M1 left it or already absent (M4's own
--        rollback does not recreate them, so a re-apply after that rollback finds them gone): the guard function with
--        M1's md5; the triggers app_secrets_m1_frozen (tgtype 31) and app_secrets_m1_frozen_truncate (tgtype 34) on
--        public.app_secrets, enabled, calling it, and no other trigger calling it; proxima_auth.m1_seed_snapshot a plain
--        table (key text, value_md5 text), owner postgres, row security on, no grant beyond postgres. Present but
--        different refuses (someone changed it: re-capture and re-review).
-- 1. public._verify_session_token: the 'admin:' branch becomes an explicit raise 'session token revoked' (not a
--    deletion, which would fall into 'malformed session token'). Its position is unchanged, so an 'admin:' token with a
--    bad signature or a past exp still gets those answers first, as a 'u:' token does.
-- 2. proxima_auth.current_account: the 'admin:' branch is removed (the verifier raises before it could be reached).
-- 3. public.set_admin_credentials_rehash(text,text) dropped. Callers checked 2026-10-23: none in the catalog; the only
--    client call (src/lib/supabase.js signIn) runs only when verify_admin answers rehash_required, which no body has
--    returned since M1, and it ignores the outcome; edge logs show 0 calls in the 24 h before 2026-10-23 09:06 UTC.
--    public.unlock_admin_with_backup_code(text,text) is KEPT: the live client calls it (unlockWithBackupCode) until
--    client step C1 ships; it is dropped by a later migration after C1, once edge logs show no calls for 24 h.
-- 4. M1's frozen guard: both triggers first, then proxima_auth.m1_frozen_guard(), then proxima_auth.m1_seed_snapshot
--    (only M1's read-only post-apply check reads it). DROP TRIGGER holds public.app_secrets in ACCESS EXCLUSIVE mode
--    until the commit, a fraction of a second; token checks read the signing key there, so they wait that long. Apply
--    with both owner devices idle (no sign-in, unlock, password change or rename in flight); a deadlock with one
--    would only abort this transaction (nothing half-done), and it can be re-run.
-- 5. Post-check, same transaction: both bodies have the reviewed md5 with unchanged owner, grants and settings; no body in
--    public or proxima_auth contains the literal 'admin: except _verify_session_token, once, followed by the revoke;
--    nothing mints 'admin:'; issue_session unchanged; an 'admin:' token (the owner's name issued now, any other
--    name, an empty name) answers 'session token revoked' and current_account refuses it; a 'u:' owner token from
--    mint_token still resolves through current_account and session_scope; set_admin_credentials_rehash, the guard, its
--    triggers and the snapshot are gone; unlock_admin_with_backup_code is unchanged. Tokens live in variables only, never printed.
-- Rollback: supabase/rollback/20261023400000_mu_p1_end_dual_accept.rollback.sql (restores both bodies and
-- set_admin_credentials_rehash verbatim; not the guard or the snapshot). Proof: scripts/test-mu-m4-rollback.sql.
-- Gates: sql-tx <this file or its no-clock copy> --test scripts/test-mu-auth.sql | test-mu-p1-catalog.sql |
-- test-mu-frozen-guard.sql (all ok; the guard suite reports the guard retired).

-- ── 0. Preconditions ──
do $pre$
declare
  -- M3's apply (2026-10-23 09:01:07 UTC) + 12 h 05 min. Later if M3 is re-applied or a script mints an admin: token.
  v_not_before constant timestamptz := '2026-10-23 21:06:07+00';
  v_m3_post constant text := 'b9ba44a18b04d17bdf0034b944a57035';
  -- md5(pg_get_functiondef) of every function this file rewrites or drops, captured live 2026-10-23 (= M1 post-apply).
  v_cas constant jsonb := '{
    "public._verify_session_token(text)": "484c5195284ab3141fcae69a7c80b8af",
    "proxima_auth.current_account(text)": "6e53e84b823eaf7e6580d0d8ebed45fc",
    "public.set_admin_credentials_rehash(text,text)": "16d6979772017cdaa5ee7c9d4bf80c17"
  }';
  v_guard_md5 constant text := 'f61c6c7fffab1ea1dd6db45c9a3f1b5d';   -- proxima_auth.m1_frozen_guard()
  v_bad text; v_def text; v_id uuid; v_tok text; v_guard regprocedure; v_snap regclass; n int;
begin
  if to_regclass('proxima_auth.users') is null or to_regprocedure('proxima_auth.current_account(text)') is null
     or to_regprocedure('proxima_auth.issue_session(uuid)') is null or to_regprocedure('proxima_auth.mint_token(uuid)') is null then
    raise exception 'M4: M1 is not applied (proxima_auth.users, current_account, issue_session or mint_token is missing)';
  end if;
  lock table proxima_auth.users in exclusive mode;

  -- (1) M3 is live.
  v_def := pg_get_functiondef('proxima_auth.issue_session(uuid)'::regprocedure);
  if not (md5(v_def) = v_m3_post or v_def !~* $re$'admin:'\s*\|\|$re$) then
    raise exception 'M4: M3 is not live: issue_session still signs admin: tokens (apply M3 first, then wait 12 h 05 min)';
  end if;
  select u.id into v_id from proxima_auth.users u where u.role = 'owner';
  if v_id is null then raise exception 'M4: no owner row in proxima_auth.users'; end if;
  v_tok := proxima_auth.mint_token(v_id);
  if v_tok is null or left(v_tok, 39) <> 'u:' || v_id::text || '.' then
    raise exception 'M4: M3 is not live: mint_token(owner id) does not give a u:<owner id> token';
  end if;
  perform set_config('proxima_m4.issue_session_md5', md5(v_def), true);   -- the post-check requires it unchanged

  -- M4-CLOCK-BEGIN (2): no bypass here; tests that run M4 early delete exactly these lines in a scratch copy (header).
  if now() < v_not_before then
    raise exception 'M4: too early: not before % (M3''s apply + 12 h 05 min; every admin: token must have expired)',
      to_char(v_not_before at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS "UTC"');
  end if;
  -- M4-CLOCK-END

  -- (3) Compare-and-swap.
  select string_agg(e.k, ', ' order by e.k) into v_bad from jsonb_each_text(v_cas) e(k, m)
   where to_regprocedure(e.k) is null or md5(pg_get_functiondef(to_regprocedure(e.k))) <> e.m;
  if v_bad is not null then
    raise exception 'M4 compare-and-swap: body differs from the reviewed pre-M4 text (or is missing): %', v_bad;
  end if;

  -- (4) M1's frozen guard and seed snapshot: as M1 left them, or absent.
  v_guard := to_regprocedure('proxima_auth.m1_frozen_guard()');
  if v_guard is not null and md5(pg_get_functiondef(v_guard)) <> v_guard_md5 then
    raise exception 'M4: proxima_auth.m1_frozen_guard() differs from M1''s text';
  end if;
  select string_agg(tg.tgname, ', ') into v_bad from pg_trigger tg
   where (tg.tgname in ('app_secrets_m1_frozen', 'app_secrets_m1_frozen_truncate') and tg.tgrelid = 'public.app_secrets'::regclass
          and not (tg.tgfoid = v_guard and tg.tgenabled = 'O'
                   and tg.tgtype = case tg.tgname when 'app_secrets_m1_frozen' then 31 else 34 end))
      or (v_guard is not null and tg.tgfoid = v_guard
          and not (tg.tgrelid = 'public.app_secrets'::regclass and tg.tgname in ('app_secrets_m1_frozen', 'app_secrets_m1_frozen_truncate')));
  if v_bad is not null then
    raise exception 'M4: the frozen-guard triggers differ from M1''s (or another trigger calls the guard): %', v_bad;
  end if;
  v_snap := to_regclass('proxima_auth.m1_seed_snapshot');
  if v_snap is not null then
    select count(*) into n from pg_class c
     where c.oid = v_snap and c.relkind = 'r' and c.relrowsecurity and c.relowner = 'postgres'::regrole
       and c.relacl::text = '{postgres=arwdDxtm/postgres}'
       and (select string_agg(a.attname::text || ':' || format_type(a.atttypid, a.atttypmod), ',' order by a.attnum)
              from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped) = 'key:text,value_md5:text';
    if n <> 1 then raise exception 'M4: proxima_auth.m1_seed_snapshot differs from M1''s table'; end if;
  end if;
end $pre$;

-- ── 1. _verify_session_token: every 'admin:' subject is revoked (explicit branch; nothing else changes) ──
CREATE OR REPLACE FUNCTION public._verify_session_token(p_token text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
declare
  v_parts text[]; v_subject text; v_exp bigint; v_sig text; v_msg text;
  v_key text; v_key_prev text; v_ok boolean := false; v_after bigint; v_id uuid; v_live boolean;
begin
  if p_token is null or p_token = '' then raise exception 'invalid session token'; end if;
  v_parts := string_to_array(p_token, '.');
  if array_length(v_parts, 1) <> 3 then raise exception 'malformed session token'; end if;
  v_subject := v_parts[1];
  begin
    v_exp := v_parts[2]::bigint;
  exception when others then
    raise exception 'malformed exp';
  end;
  v_sig := v_parts[3];
  v_msg := v_subject || '.' || v_exp::text;
  if v_exp < extract(epoch from now())::bigint then raise exception 'session token expired'; end if;
  select value->>'key' into v_key from app_secrets where key = 'session_signing_key';
  if v_key is null then raise exception 'session_signing_key not provisioned'; end if;
  if encode(hmac(v_msg, v_key, 'sha256'), 'hex') = v_sig then
    v_ok := true;
  else
    select value->>'key' into v_key_prev from app_secrets where key = 'session_signing_key_previous';
    if v_key_prev is not null and encode(hmac(v_msg, v_key_prev, 'sha256'), 'hex') = v_sig then v_ok := true; end if;
  end if;
  if not v_ok then raise exception 'invalid signature'; end if;
  if v_subject like 'u:%' then
    begin
      v_id := substring(v_subject from 3)::uuid;
    exception when others then
      raise exception 'malformed session token';
    end;
    select u.sessions_valid_after, u.disabled_at is null and u.deleted_at is null into v_after, v_live
      from proxima_auth.users u where u.id = v_id;
    if not found or not v_live or v_exp - 43200 <= v_after then raise exception 'session token revoked'; end if;
  elsif v_subject like 'admin:%' then
    -- M4 (20261023400000_mu_p1_end_dual_accept): the dual-accept window is over. Every admin: subject is revoked,
    -- whatever its name or issue time: an explicit answer, never a fall-through to the malformed answer below.
    raise exception 'session token revoked';
  else
    raise exception 'malformed session token';
  end if;
  return v_subject;
end $function$
;

-- ── 2. current_account: the 'admin:' branch removed (nothing else changes) ──
CREATE OR REPLACE FUNCTION proxima_auth.current_account(p_token text)
 RETURNS proxima_auth.account
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_sub text := public._verify_session_token(p_token);
  v_acc proxima_auth.account;
begin
  if v_sub like 'u:%' then
    select u.id, u.username, u.role, u.scope into v_acc from proxima_auth.users u where u.id = substring(v_sub from 3)::uuid;
  end if;
  return v_acc;
end $function$
;

-- ── 3. set_admin_credentials_rehash dropped (unlock_admin_with_backup_code is kept until after client step C1) ──
drop function public.set_admin_credentials_rehash(text, text);

-- ── 4. M1's frozen guard (both triggers before the function) and the seed snapshot ──
drop trigger if exists app_secrets_m1_frozen on public.app_secrets;
drop trigger if exists app_secrets_m1_frozen_truncate on public.app_secrets;
drop function if exists proxima_auth.m1_frozen_guard();
drop table if exists proxima_auth.m1_seed_snapshot;

-- ── 5. Post-check ──
do $post$
declare
  v_post constant jsonb := '{
    "public._verify_session_token(text)": "59556daf06c76548385bfe196467c2dd",
    "proxima_auth.current_account(text)": "9175d1aea4b9e6959723c12f0bb708f1"
  }';
  v_attrs constant jsonb := '{
    "public._verify_session_token(text)": "{postgres=X/postgres,service_role=X/postgres}|postgres|true|{\"search_path=public, extensions, pg_catalog\"}",
    "proxima_auth.current_account(text)": "{postgres=X/postgres}|postgres|true|{\"search_path=\\\"\\\"\"}"
  }';
  v_unlock_old constant text := 'efa5fb04c91d9a3c374c8f8c351524e3';   -- public.unlock_admin_with_backup_code, kept
  v_bad text; v_src text; v_id uuid; v_name text; v_scope text; v_ep bigint; v_tok text; v_hdr text; v_got text;
  v_acc proxima_auth.account; v_err text; v_case text; v_issued bigint;
begin
  select string_agg(e.k, ', ' order by e.k) into v_bad from jsonb_each_text(v_post) e(k, m)
   where md5(pg_get_functiondef(to_regprocedure(e.k))) <> e.m;
  if v_bad is not null then raise exception 'M4 post-check: not the reviewed body: %', v_bad; end if;
  select string_agg(e.k, ', ' order by e.k) into v_bad from jsonb_each_text(v_attrs) e(k, a)
   where (select p.proacl::text || '|' || p.proowner::regrole::text || '|' || p.prosecdef::text || '|' || p.proconfig::text
            from pg_proc p where p.oid = to_regprocedure(e.k)) is distinct from e.a;
  if v_bad is not null then raise exception 'M4 post-check: grants, owner, definer or search_path changed: %', v_bad; end if;
  if md5(pg_get_functiondef('proxima_auth.issue_session(uuid)'::regprocedure))
     is distinct from current_setting('proxima_m4.issue_session_md5', true) then
    raise exception 'M4 post-check: issue_session changed';
  end if;
  if to_regprocedure('public.unlock_admin_with_backup_code(text,text)') is null
     or md5(pg_get_functiondef('public.unlock_admin_with_backup_code(text,text)'::regprocedure)) <> v_unlock_old then
    raise exception 'M4 post-check: unlock_admin_with_backup_code is gone or changed (it is kept until after C1)';
  end if;
  if to_regprocedure('public.set_admin_credentials_rehash(text,text)') is not null
     or to_regprocedure('proxima_auth.m1_frozen_guard()') is not null or to_regclass('proxima_auth.m1_seed_snapshot') is not null
     or exists (select 1 from pg_trigger tg where tg.tgname in ('app_secrets_m1_frozen', 'app_secrets_m1_frozen_truncate')) then
    raise exception 'M4 post-check: set_admin_credentials_rehash, the frozen guard, a trigger or the seed snapshot remains';
  end if;
  -- No body accepts admin: any more: the literal only in the verifier, once, and that branch raises revoked.
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad from pg_proc p
   where p.pronamespace in ('public'::regnamespace, 'proxima_auth'::regnamespace) and p.prosrc like '%''admin:%'
     and p.oid <> 'public._verify_session_token(text)'::regprocedure;
  if v_bad is not null then raise exception 'M4 post-check: admin: still handled in %', v_bad; end if;
  select p.prosrc into v_src from pg_proc p where p.oid = 'public._verify_session_token(text)'::regprocedure;
  if (length(v_src) - length(replace(v_src, '''admin:', ''))) / length('''admin:') <> 1
     or v_src !~ $re$elsif v_subject like 'admin:%' then\n(\s*--[^\n]*\n)*\s*raise exception 'session token revoked';$re$ then
    raise exception 'M4 post-check: the verifier''s admin: branch is not the single explicit revoke';
  end if;
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad from pg_proc p
   where p.pronamespace in ('public'::regnamespace, 'proxima_auth'::regnamespace) and p.prosrc ~* $re$'admin:'\s*\|\|$re$;
  if v_bad is not null then raise exception 'M4 post-check: still mints admin: tokens: %', v_bad; end if;

  -- Behaviour: every admin: token is revoked; the owner's u: token still resolves.
  select u.id, u.username, u.scope, u.sessions_valid_after into v_id, v_name, v_scope, v_ep
    from proxima_auth.users u where u.role = 'owner';
  v_issued := greatest(extract(epoch from clock_timestamp())::bigint, v_ep + 1);
  foreach v_case in array array['admin:' || v_name || '|' || (v_issued + 43200), 'admin:__mu_m4_nobody|' || (v_issued + 43200),
                                'admin:|' || (v_issued + 43200)] loop
    v_err := null;
    begin
      perform public._verify_session_token(public._sign_session_token(split_part(v_case, '|', 1),
                                                                      to_timestamp(split_part(v_case, '|', 2)::bigint)));
    exception when others then v_err := sqlerrm; end;
    if v_err is distinct from 'session token revoked' then
      raise exception 'M4 post-check: an admin: token is not revoked by the verifier (%)', coalesce(v_err, 'accepted');
    end if;
  end loop;
  v_err := null;
  begin
    v_acc := proxima_auth.current_account(public._sign_session_token('admin:' || v_name, to_timestamp(v_issued + 43200)));
  exception when others then v_err := sqlerrm; end;
  if v_err is distinct from 'session token revoked' then
    raise exception 'M4 post-check: current_account does not refuse an admin: token (%)', coalesce(v_err, 'accepted');
  end if;
  v_tok := proxima_auth.mint_token(v_id);
  v_acc := proxima_auth.current_account(v_tok);
  v_hdr := current_setting('request.headers', true);
  perform set_config('request.headers', json_build_object('x-proxima-session', v_tok)::text, true);
  v_got := proxima_auth.session_scope(true);
  perform set_config('request.headers', coalesce(v_hdr, ''), true);
  if left(v_tok, 39) <> 'u:' || v_id::text || '.' or v_acc.id is distinct from v_id or v_acc.role is distinct from 'owner'
     or v_acc.scope is distinct from v_scope or v_got is distinct from v_scope then
    raise exception 'M4 post-check: the owner''s u: token no longer resolves to the owner';
  end if;
end $post$;
