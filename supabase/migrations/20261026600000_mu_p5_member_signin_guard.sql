-- Members sign in only from builds that keep one account per browser (second account S5; reviews wf_f1d111ef-fa9 #1 and
-- wf_955c9c2e-d9a #3).
--
-- The client keeps one account's data per browser (src/lib/accountGuard.js): a browser holding the owner's local
-- generations refuses a member's sign-in. A tab still running an older build has no such check, and would keep a member's
-- session in a browser holding the owner's data (then show and sync that data under the member's session). So
-- verify_admin now answers 'update_required' to a member whose request lacks the guard builds' marker (x-client-info
-- 'proxima-guard/1', added by src/lib/session.js withSessionHeader), after a correct password only and before any counter
-- changes. The owner signs in from any build. The legacy owner-only unlock (unlock_admin_with_backup_code: only older
-- builds call it; current builds unlock by name) refuses requests without the marker, so a member on an older build cannot
-- count wrong codes against the owner's row. No other path issues a member session to an older build: it has no join screen.
--
-- Rollback: supabase/rollback/20261026600000_mu_p5_member_signin_guard.rollback.sql (both bodies before it, verbatim).
-- Tests (rolled back): node scripts/tools/sql-tx.mjs supabase/migrations/20261026600000_mu_p5_member_signin_guard.sql --test scripts/test-member-signin-guard-db.sql

do $guard$
declare
  want constant jsonb := '{
    "public.verify_admin(text,text)": "d24ceca1b96d053ebb05babd99d87cf0",
    "public.unlock_admin_with_backup_code(text,text)": "efa5fb04c91d9a3c374c8f8c351524e3"
  }';
  k text; got text;
begin
  for k in select jsonb_object_keys(want) loop
    select md5(pg_get_functiondef(k::regprocedure)) into got;
    if got is distinct from want->>k then
      raise exception '20261026600000: % changed (live %, expected %)', k, got, want->>k;
    end if;
  end loop;
end $guard$;

-- True when the request comes from a build that keeps one account per browser (x-client-info carries 'proxima-guard/1').
create function proxima_auth._client_guard() returns boolean
  language plpgsql stable set search_path to ''
as $function$
declare
  v_raw text := nullif(current_setting('request.headers', true), '');
  v jsonb;
begin
  if v_raw is null then return false; end if;
  begin v := v_raw::jsonb; exception when others then return false; end;
  return jsonb_typeof(v) = 'object' and coalesce(v->>'x-client-info', '') ~ '(^|\s)proxima-guard/1(\s|$)';
end $function$;
revoke execute on function proxima_auth._client_guard() from public, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.verify_admin(p_username text, p_password text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
declare
  v_th jsonb := proxima_auth._throttle(p_username, false);
  v_u  proxima_auth.users;
  v_s  jsonb;
  v_fail json;
  v_ok boolean;
begin
  v_fail := case when coalesce((v_th->>'blocked')::boolean, false)
                 then json_build_object('ok', false, 'reason', 'throttled', 'retry_after', (v_th->>'retry_after')::int)
                 else json_build_object('ok', false, 'reason', 'invalid') end;
  -- Every typed name queues on its own advisory key before the lookup, whether or not the account exists (review #5:
  -- a row lock taken only for existing names leaked their existence through lock-wait timing). Lock order: IP throttle
  -- row (the check above), then this advisory lock, then the account row.
  perform pg_advisory_xact_lock(hashtextextended('proxima-signin:' || lower(coalesce(p_username, '')), 0));
  select * into v_u from proxima_auth.users u where lower(u.username) = lower(p_username) for no key update;
  if not found or v_u.deleted_at is not null or v_u.disabled_at is not null or v_u.password_hash is null
     or v_u.login_locked_at is not null then
    perform extensions.crypt(coalesce(p_password, ''), (select c.dummy_hash from proxima_auth.auth_config c where c.id));
    perform proxima_auth._throttle(p_username, true);
    return v_fail;
  end if;
  -- Exactly one bcrypt for every input (round 16 #1): a NULL or empty password pays it too, then answers generically.
  v_ok := extensions.crypt(coalesce(p_password, ''), v_u.password_hash) = v_u.password_hash and p_password is not null;
  if v_ok then
    -- 20261026600000: a member signs in only from a build that keeps one account per browser (it marks its requests
    -- 'proxima-guard/1' in x-client-info: src/lib/session.js). An older build would keep a member's session on a browser
    -- holding the owner's local data. Answered only after a correct password, before anything is counted or reset; the owner
    -- signs in from any build.
    if v_u.role <> 'owner' and not proxima_auth._client_guard() then
      return json_build_object('ok', false, 'reason', 'update_required');
    end if;
    if v_u.login_failed <> 0 then
      update proxima_auth.users set login_failed = 0, updated_at = now() where id = v_u.id;
    end if;
    v_s := proxima_auth.issue_session(v_u.id);
    return json_build_object('ok', true, 'token', v_s->>'token', 'expires_at', (v_s->>'expires_at')::bigint,
      'username', v_u.username, 'account_id', v_u.id, 'role', v_u.role, 'scope', v_u.scope);
  end if;
  update proxima_auth.users
     set login_failed = v_u.login_failed + 1, login_locked_at = case when v_u.login_failed + 1 >= 3 then now() end,
         updated_at = now()
   where id = v_u.id;
  perform proxima_auth._throttle(p_username, true);
  return v_fail;
end $function$;

CREATE OR REPLACE FUNCTION public.unlock_admin_with_backup_code(p_code text, p_new_password text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
begin
  -- 20261026600000 (review wf_955c9c2e-d9a #3): only older builds call this owner-only unlock (current builds unlock by name).
  -- From one, a member's own backup code would count against the owner's row: such a request is refused before anything.
  if not proxima_auth._client_guard() then
    return json_build_object('ok', false, 'reason', 'update_required');
  end if;
  return public.unlock_with_backup_code((select u.username from proxima_auth.users u where u.role = 'owner'), p_code, p_new_password);
end $function$;
