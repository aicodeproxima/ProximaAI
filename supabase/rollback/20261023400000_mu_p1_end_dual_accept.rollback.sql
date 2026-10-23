-- Rollback of supabase/migrations/20261023400000_mu_p1_end_dual_accept.sql (M4; docs/P1-AUTH-DESIGN.md §7). Kept OUT
-- of supabase/migrations/. One transaction, no transaction control:
--   0) guards (proxima_auth.users taken in EXCLUSIVE mode first, as M4 does):
--      - REFUSES unless M4 is live, all of it: _verify_session_token and current_account have M4's post-apply md5
--        (59556daf06c76548385bfe196467c2dd / 9175d1aea4b9e6959723c12f0bb708f1: compare-and-swap) and public.set_admin_credentials_rehash(text,text) is
--        absent. A partial state names what differs; re-capture and re-review before rolling anything back.
--   1) the pre-M4 texts, verbatim (pg_get_functiondef captured from the live database on 2026-10-23 by a script, not
--      retyped; = M1's post-apply bodies): _verify_session_token (md5 484c5195284ab3141fcae69a7c80b8af, its 'admin:'
--      dual-accept branch back), current_account (6e53e84b823eaf7e6580d0d8ebed45fc) and set_admin_credentials_rehash
--      (16d6979772017cdaa5ee7c9d4bf80c17) recreated with its pre-M4 grants (postgres, anon, authenticated,
--      service_role; never PUBLIC).
--   2) NOT recreated: M1's frozen guard (proxima_auth.m1_frozen_guard() and its two app_secrets triggers) and
--      proxima_auth.m1_seed_snapshot. Their seed md5s cannot be re-captured, nothing in P1's code writes the frozen
--      rows, and M1's rollback runs without them (design §7, review round 18 #2).
--   3) post-check: the three md5s equal the pre-M4 capture with the captured owner, grants and settings; a fresh
--      'admin:<owner name>' token verifies and resolves to the owner again (the dual-accept window is back, so M3's
--      rollback guard M4-a/b/c passes); a 'u:<owner id>' token still resolves (nobody is signed out).
--   4) M4's own migration record is deleted (supabase_migrations.schema_migrations, version 20261023400000, name
--      mu_p1_end_dual_accept), in this same transaction, so a later re-apply through apply-migration.mjs really
--      applies. Zero rows is fine (M4 applied by a tool that does not record).
-- Order (design §7): this -> M3 (its rollback refuses while M4 is live) -> M2 (RLS session; refuses while M3 is live)
-- -> M1b -> M1 (refuses while M2 is live). A re-apply of M4 after this rollback needs M4's preconditions again (M3
-- live, the clock) and accepts the absent guard and snapshot.
-- Proof: scripts/test-mu-m4-rollback.sql (M4 -> this -> M4 again, and the refusal and chain runs in its header).

-- ── 0. Guards ──
do $guard$
declare
  v_post constant jsonb := '{
    "public._verify_session_token(text)": "59556daf06c76548385bfe196467c2dd",
    "proxima_auth.current_account(text)": "9175d1aea4b9e6959723c12f0bb708f1"
  }';
  v_bad text;
begin
  if to_regclass('proxima_auth.users') is null then
    raise exception 'M4 rollback: proxima_auth.users is missing (M1 not live)';
  end if;
  lock table proxima_auth.users in exclusive mode;
  select string_agg(e.k, ', ' order by e.k) into v_bad from jsonb_each_text(v_post) e(k, m)
   where to_regprocedure(e.k) is null or md5(pg_get_functiondef(to_regprocedure(e.k))) <> e.m;
  if to_regprocedure('public.set_admin_credentials_rehash(text,text)') is not null then
    v_bad := coalesce(v_bad || ', ', '') || 'public.set_admin_credentials_rehash(text,text) exists';
  end if;
  if v_bad is not null then
    raise exception 'M4 rollback compare-and-swap: M4 is not live (or changed since): %', v_bad;
  end if;
end $guard$;

-- ── 1. The pre-M4 bodies, verbatim ──
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
    -- Dual-accept window (until M4): the owner row's exact name and the same issue-time rule as 'u:'.
    select u.sessions_valid_after, u.disabled_at is null and u.deleted_at is null and u.username = substring(v_subject from 7)
      into v_after, v_live
      from proxima_auth.users u where u.role = 'owner';
    if not found or not v_live or v_exp - 43200 <= v_after then raise exception 'session token revoked'; end if;
  else
    raise exception 'malformed session token';
  end if;
  return v_subject;
end $function$
;

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
  elsif v_sub like 'admin:%' then
    select u.id, u.username, u.role, u.scope into v_acc from proxima_auth.users u where u.role = 'owner';
  end if;
  return v_acc;
end $function$
;

CREATE OR REPLACE FUNCTION public.set_admin_credentials_rehash(p_session_token text, p_plain_password text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
declare v_acc proxima_auth.account := proxima_auth.current_account(p_session_token);
begin
  if v_acc.id is null then return json_build_object('ok', false, 'reason', 'forbidden'); end if;
  return json_build_object('ok', false, 'reason', 'not_legacy');
end $function$
;
revoke all on function public.set_admin_credentials_rehash(text, text) from public;
grant execute on function public.set_admin_credentials_rehash(text, text) to anon, authenticated, service_role;

-- ── 3. Post-check ──
do $post$
declare
  v_pre constant jsonb := '{
    "public._verify_session_token(text)": "484c5195284ab3141fcae69a7c80b8af",
    "proxima_auth.current_account(text)": "6e53e84b823eaf7e6580d0d8ebed45fc",
    "public.set_admin_credentials_rehash(text,text)": "16d6979772017cdaa5ee7c9d4bf80c17"
  }';
  v_attrs constant jsonb := '{
    "public._verify_session_token(text)": "{postgres=X/postgres,service_role=X/postgres}|postgres|true|{\"search_path=public, extensions, pg_catalog\"}",
    "proxima_auth.current_account(text)": "{postgres=X/postgres}|postgres|true|{\"search_path=\\\"\\\"\"}",
    "public.set_admin_credentials_rehash(text,text)": "{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}|postgres|true|{\"search_path=public, extensions, pg_catalog\"}"
  }';
  v_bad text; v_id uuid; v_name text; v_ep bigint; v_acc proxima_auth.account;
begin
  select string_agg(e.k, ', ' order by e.k) into v_bad from jsonb_each_text(v_pre) e(k, m)
   where md5(pg_get_functiondef(to_regprocedure(e.k))) <> e.m;
  if v_bad is not null then raise exception 'M4 rollback: restored body differs from the pre-M4 capture: %', v_bad; end if;
  select string_agg(e.k, ', ' order by e.k) into v_bad from jsonb_each_text(v_attrs) e(k, a)
   where (select p.proacl::text || '|' || p.proowner::regrole::text || '|' || p.prosecdef::text || '|' || p.proconfig::text
            from pg_proc p where p.oid = to_regprocedure(e.k)) is distinct from e.a;
  if v_bad is not null then raise exception 'M4 rollback: grants, owner, definer or search_path differ from the capture: %', v_bad; end if;
  select u.id, u.username, u.sessions_valid_after into v_id, v_name, v_ep from proxima_auth.users u where u.role = 'owner';
  v_acc := proxima_auth.current_account(public._sign_session_token('admin:' || v_name,
             to_timestamp(greatest(extract(epoch from clock_timestamp())::bigint, v_ep + 1) + 43200)));
  if v_acc.id is distinct from v_id or v_acc.role is distinct from 'owner' then
    raise exception 'M4 rollback: a fresh admin:<owner> token does not resolve to the owner';
  end if;
  v_acc := proxima_auth.current_account(proxima_auth.mint_token(v_id));
  if v_acc.id is distinct from v_id then
    raise exception 'M4 rollback: the owner''s minted token no longer resolves to the owner';
  end if;
end $post$;

-- ── 4. M4's own migration record, so a re-apply through apply-migration.mjs really applies ──
delete from supabase_migrations.schema_migrations where version = '20261023400000' and name = 'mu_p1_end_dual_accept';
