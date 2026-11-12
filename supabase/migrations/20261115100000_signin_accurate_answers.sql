-- Accurate sign-in and unlock answers. Owner rulings 2026-11-12, after a member's account locked and every later try,
-- the right password included, read "Wrong username or password": "the issue should never be misleading", and "He
-- should receive an error that his account is locked with how to unlock it with the backup code ... all users now and
-- going forward should receive accurate errors". Supersedes docs/P1-AUTH-DESIGN.md decision #1 (a locked account or a
-- running backup pause answered the generic 'invalid').
-- public.verify_admin: a locked account answers 'locked' (its password is still never checked, so a right and a wrong
-- one answer the same bytes and the lock confirms no guess); the wrong password that locks it answers 'locked' with
-- locked_now; a disabled account 'disabled'; an account with no password 'no_password'; a name no account has, a
-- deleted account's and a wrong password 'invalid' (unchanged).
-- public.unlock_with_backup_code: a running pause answers 'backup_locked' with retry_after, the seconds left (the code is
-- still never checked); the 5th wrong code answers 'backup_locked' with retry_after 900 and paused_now; a disabled
-- account 'disabled'; an account with no backup code 'no_backup_code'; an unknown or deleted name and a wrong code
-- 'invalid' (unchanged).
-- Neither answers 'throttled' any more: both check the secret from a blocked network too (decision #22: a right password
-- signs in), so the network limit never decides their outcome and "try again in N min" would be untrue. It stays in the
-- log (the throttled flag) and in join_with_invite, which refuses a blocked network before it checks anything.
-- Cost, accepted by the rulings: a name's existence shows once its account is locked or paused (3 wrong passwords or
-- 5 wrong codes, each in the owner's sign-in history), and a disabled account's at once.
-- The browser has mapped 'locked' (to the unlock form) and 'backup_locked' (with its minutes) since before M1
-- (src/lib/signinText.js), so every reachable answer reads accurately on the build that is live when this is applied;
-- 'disabled', 'no_password' and 'no_backup_code' (no state that reaches them exists: nothing sets disabled_at or clears a
-- hash) read accurately from the client commit that ships with this.
-- Nothing else changes: the same locks and lock order, one bcrypt per call, the same counts and the same log rows.
-- Generated from the installed bodies (20261027100000_signin_history's; md5-guarded below).
-- Tests: scripts/test-mu-auth.sql (cases 4, 5, 7, 7b, 15, 18) and scripts/test-signin-history-db.sql (H7, H15).
-- Rollback: supabase/rollback/20261115100000_signin_accurate_answers.rollback.sql

set local lock_timeout = '2s';

do $guard$
begin
  if md5(pg_get_functiondef('public.verify_admin(text,text)'::regprocedure)) <> '72a9e250ac84c226b7d771158d865d6d' then
    raise exception 'signin_accurate_answers: % changed since this migration was written (installed %, expected 72a9e250ac84c226b7d771158d865d6d)', 'public.verify_admin(text,text)', md5(pg_get_functiondef('public.verify_admin(text,text)'::regprocedure));
  end if;
  if md5(pg_get_functiondef('public.unlock_with_backup_code(text,text,text)'::regprocedure)) <> 'ecb6acfdceca2b288bb5390a5a1c4163' then
    raise exception 'signin_accurate_answers: % changed since this migration was written (installed %, expected ecb6acfdceca2b288bb5390a5a1c4163)', 'public.unlock_with_backup_code(text,text,text)', md5(pg_get_functiondef('public.unlock_with_backup_code(text,text,text)'::regprocedure));
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
  v_ok boolean;
  v_why text;
begin
  -- 20261115100000 (owner rulings 2026-11-12: every error is accurate): each refusal answers its real reason. v_th, the
  -- network limit, never decides a sign-in (a right password signs in from a blocked network too: decision #22), so it
  -- is only logged (the throttled flag), never answered.
  -- Every typed name queues on its own advisory key before the lookup, whether or not the account exists (review #5:
  -- a row lock taken only for existing names leaked their existence through lock-wait timing). Lock order: IP throttle
  -- row (the check above), then this advisory lock, then the account row.
  perform pg_advisory_xact_lock(hashtextextended('proxima-signin:' || lower(coalesce(p_username, '')), 0));
  select * into v_u from proxima_auth.users u where lower(u.username) = lower(p_username) for no key update;
  if not found or v_u.deleted_at is not null or v_u.disabled_at is not null or v_u.password_hash is null
     or v_u.login_locked_at is not null then
    v_why := case when v_u.id is null then 'unknown' when v_u.deleted_at is not null then 'deleted' when v_u.disabled_at is not null then 'disabled' when v_u.login_locked_at is not null then 'locked' else 'no_password' end;
    perform extensions.crypt(coalesce(p_password, ''), (select c.dummy_hash from proxima_auth.auth_config c where c.id));
    perform proxima_auth._throttle(p_username, true);
    perform proxima_auth._log_signin(v_u.id, 'signin', v_why, coalesce((v_th->>'blocked')::boolean, false));
    -- No password is checked here: a locked account answers a right and a wrong one alike, so the lock confirms no guess.
    -- A name no account has (or a deleted account's) is a wrong username.
    return json_build_object('ok', false, 'reason', case when v_why in ('unknown', 'deleted') then 'invalid' else v_why end);
  end if;
  -- Exactly one bcrypt for every input (round 16 #1): a NULL or empty password pays it too, then answers as a wrong one.
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
  -- The wrong password that locks the account says so: from now on even the right one is refused until a backup code
  -- unlocks it.
  if v_u.login_failed + 1 >= 3 then
    return json_build_object('ok', false, 'reason', 'locked', 'locked_now', true);
  end if;
  return json_build_object('ok', false, 'reason', 'invalid');
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
  v_ok boolean;
  v_why text;
begin
  if p_new_password is not null and length(p_new_password) < 8 then
    perform proxima_auth._log_signin(null, 'unlock', 'weak_password', false);
    return json_build_object('ok', false, 'reason', 'weak_password');
  end if;
  -- 20261115100000 (owner rulings 2026-11-12: every error is accurate): each refusal answers its real reason. v_th, the
  -- network limit, never decides an unlock (the code is checked from a blocked network too), so it is only logged.
  v_th := proxima_auth._throttle(p_username, false);
  -- Every typed name queues on its own advisory key before the lookup, whether or not the account exists (review #5:
  -- a row lock taken only for existing names leaked their existence through lock-wait timing). Lock order: IP throttle
  -- row (the check above), then this advisory lock, then the account row.
  perform pg_advisory_xact_lock(hashtextextended('proxima-signin:' || lower(coalesce(p_username, '')), 0));
  select * into v_u from proxima_auth.users u where lower(u.username) = lower(p_username) for no key update;
  if not found or v_u.deleted_at is not null or v_u.disabled_at is not null or v_u.backup_code_hash is null
     or v_u.backup_locked_until > now() then
    v_why := case when v_u.id is null then 'unknown' when v_u.deleted_at is not null then 'deleted' when v_u.disabled_at is not null then 'disabled' when v_u.backup_code_hash is null then 'no_backup_code' else 'paused' end;
    perform extensions.crypt(coalesce(trim(p_code), ''), (select c.dummy_hash from proxima_auth.auth_config c where c.id));
    perform proxima_auth._throttle(p_username, true);
    perform proxima_auth._log_signin(v_u.id, 'unlock', v_why, coalesce((v_th->>'blocked')::boolean, false));
    -- No code is checked here: a running pause answers a right and a wrong code alike, so the pause confirms no guess.
    -- A name no account has (or a deleted account's) is a wrong username.
    if v_why = 'paused' then
      return json_build_object('ok', false, 'reason', 'backup_locked',
        'retry_after', greatest(1, ceil(extract(epoch from v_u.backup_locked_until - now())))::int);
    end if;
    return json_build_object('ok', false, 'reason', case when v_why in ('unknown', 'deleted') then 'invalid' else v_why end);
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
    -- The 5th wrong code says so: unlocking is paused for the 15 minutes set above, a right code included.
    if v_failed >= 5 then
      return json_build_object('ok', false, 'reason', 'backup_locked', 'retry_after', 900, 'paused_now', true);
    end if;
    return json_build_object('ok', false, 'reason', 'invalid');
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
