-- Rollback of supabase/migrations/20261115100000_signin_accurate_answers.sql: verify_admin and unlock_with_backup_code get
-- back the bodies they had before it, verbatim from the live database when the migration was written (full-definition
-- md5 72a9e250ac84c226b7d771158d865d6d and ecb6acfdceca2b288bb5390a5a1c4163, the bodies 20261027100000_signin_history
-- installed): a locked account, a backup pause and a disabled or secret-less account answer the generic 'invalid'
-- again, and a blocked network 'throttled'.
-- Refuses unless the two installed bodies are the ones the migration installed (md5s measured by applying it in a
-- rolled-back transaction when it was written).

set local lock_timeout = '2s';

do $guard$
begin
  if md5(pg_get_functiondef('public.verify_admin(text,text)'::regprocedure)) <> 'edcee5b2072fd8e582499b988ed96009' then
    raise exception 'signin_accurate_answers rollback: % is not the body the migration installed (installed %, expected edcee5b2072fd8e582499b988ed96009)', 'public.verify_admin(text,text)', md5(pg_get_functiondef('public.verify_admin(text,text)'::regprocedure));
  end if;
  if md5(pg_get_functiondef('public.unlock_with_backup_code(text,text,text)'::regprocedure)) <> 'ac504bb8f612eacab1dfc2f2c3b2d9da' then
    raise exception 'signin_accurate_answers rollback: % is not the body the migration installed (installed %, expected ac504bb8f612eacab1dfc2f2c3b2d9da)', 'public.unlock_with_backup_code(text,text,text)', md5(pg_get_functiondef('public.unlock_with_backup_code(text,text,text)'::regprocedure));
  end if;
end $guard$;

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
    perform proxima_auth._log_signin(v_u.id, 'signin', case when v_u.id is null then 'unknown' when v_u.deleted_at is not null then 'deleted' when v_u.disabled_at is not null then 'disabled' when v_u.login_locked_at is not null then 'locked' else 'no_password' end, coalesce((v_th->>'blocked')::boolean, false));
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
      perform proxima_auth._log_signin(v_u.id, 'signin', 'update_required', coalesce((v_th->>'blocked')::boolean, false));
      return json_build_object('ok', false, 'reason', 'update_required');
    end if;
    if v_u.login_failed <> 0 then
      update proxima_auth.users set login_failed = 0, updated_at = now() where id = v_u.id;
    end if;
    v_s := proxima_auth.issue_session(v_u.id);
    perform proxima_auth._log_signin(v_u.id, 'signin', 'ok', coalesce((v_th->>'blocked')::boolean, false));
    return json_build_object('ok', true, 'token', v_s->>'token', 'expires_at', (v_s->>'expires_at')::bigint,
      'username', v_u.username, 'account_id', v_u.id, 'role', v_u.role, 'scope', v_u.scope);
  end if;
  update proxima_auth.users
     set login_failed = v_u.login_failed + 1, login_locked_at = case when v_u.login_failed + 1 >= 3 then now() end,
         updated_at = now()
   where id = v_u.id;
  perform proxima_auth._throttle(p_username, true);
  perform proxima_auth._log_signin(v_u.id, 'signin', case when v_u.login_failed + 1 >= 3 then 'locked_now' else 'wrong_password' end, coalesce((v_th->>'blocked')::boolean, false));
  return v_fail;
end $function$;

CREATE OR REPLACE FUNCTION public.unlock_with_backup_code(p_username text, p_code text, p_new_password text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
declare
  v_th jsonb;
  v_u  proxima_auth.users;
  v_s  jsonb;
  v_failed int;
  v_fail json;
  v_ok boolean;
begin
  if p_new_password is not null and length(p_new_password) < 8 then
    perform proxima_auth._log_signin(null, 'unlock', 'weak_password', false);
    return json_build_object('ok', false, 'reason', 'weak_password');
  end if;
  v_th := proxima_auth._throttle(p_username, false);
  v_fail := case when coalesce((v_th->>'blocked')::boolean, false)
                 then json_build_object('ok', false, 'reason', 'throttled', 'retry_after', (v_th->>'retry_after')::int)
                 else json_build_object('ok', false, 'reason', 'invalid') end;
  -- Every typed name queues on its own advisory key before the lookup, whether or not the account exists (review #5:
  -- a row lock taken only for existing names leaked their existence through lock-wait timing). Lock order: IP throttle
  -- row (the check above), then this advisory lock, then the account row.
  perform pg_advisory_xact_lock(hashtextextended('proxima-signin:' || lower(coalesce(p_username, '')), 0));
  select * into v_u from proxima_auth.users u where lower(u.username) = lower(p_username) for no key update;
  if not found or v_u.deleted_at is not null or v_u.disabled_at is not null or v_u.backup_code_hash is null
     or v_u.backup_locked_until > now() then
    perform extensions.crypt(coalesce(trim(p_code), ''), (select c.dummy_hash from proxima_auth.auth_config c where c.id));
    perform proxima_auth._throttle(p_username, true);
    perform proxima_auth._log_signin(v_u.id, 'unlock', case when v_u.id is null then 'unknown' when v_u.deleted_at is not null then 'deleted' when v_u.disabled_at is not null then 'disabled' when v_u.backup_code_hash is null then 'no_backup_code' else 'paused' end, coalesce((v_th->>'blocked')::boolean, false));
    return v_fail;
  end if;
  -- Exactly one bcrypt for every input (round 16 #1): a NULL or empty code pays it too, then counts as wrong.
  v_ok := extensions.crypt(coalesce(trim(p_code), ''), v_u.backup_code_hash) = v_u.backup_code_hash and p_code is not null;
  if not v_ok then
    v_failed := case when v_u.backup_locked_until is not null then 0 else v_u.backup_failed end + 1;
    if v_failed >= 5 then
      update proxima_auth.users set backup_failed = 0, backup_locked_until = now() + interval '15 minutes', updated_at = now()
       where id = v_u.id;
    else
      update proxima_auth.users set backup_failed = v_failed, backup_locked_until = null, updated_at = now() where id = v_u.id;
    end if;
    perform proxima_auth._throttle(p_username, true);
    perform proxima_auth._log_signin(v_u.id, 'unlock', case when v_failed >= 5 then 'paused_now' else 'wrong_code' end, coalesce((v_th->>'blocked')::boolean, false));
    return v_fail;
  end if;
  update proxima_auth.users
     set backup_failed = 0, backup_locked_until = null, login_failed = 0, login_locked_at = null,
         password_hash = case when p_new_password is not null then extensions.crypt(p_new_password, extensions.gen_salt('bf', 12))
                              else password_hash end,
         updated_at = now()
   where id = v_u.id;
  perform proxima_auth._revoke_sessions(v_u.id);
  v_s := proxima_auth.issue_session(v_u.id);
  perform proxima_auth._log_signin(v_u.id, 'unlock', case when p_new_password is not null then 'ok_password_reset' else 'ok' end, coalesce((v_th->>'blocked')::boolean, false));
  return json_build_object('ok', true, 'password_changed', p_new_password is not null, 'token', v_s->>'token',
    'expires_at', (v_s->>'expires_at')::bigint, 'username', v_u.username, 'account_id', v_u.id, 'role', v_u.role,
    'scope', v_u.scope);
end $function$;
