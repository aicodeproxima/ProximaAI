-- Rollback of supabase/migrations/20261027100000_signin_history.sql: the five auth functions get back the bodies they
-- had before it (verbatim from the live database when the migration was generated), the reader, the writer, the prune job
-- and the events table go. The events are lost (they exist only here).
-- Refuses unless the five installed bodies are the ones the migration installed (md5s measured by applying it in a
-- rolled-back transaction when the migration was generated), and while any other function names the writer or the table
-- (it would fail at its next call, not at this drop).

set local lock_timeout = '2s';

do $guard$
declare v_other text;
begin
  if to_regclass('proxima_auth.signin_events') is null then raise exception 'signin_history rollback: not applied'; end if;
  if md5(pg_get_functiondef('public.verify_admin(text,text)'::regprocedure)) <> '72a9e250ac84c226b7d771158d865d6d'
     or md5(pg_get_functiondef('public.unlock_with_backup_code(text,text,text)'::regprocedure)) <> 'ecb6acfdceca2b288bb5390a5a1c4163'
     or md5(pg_get_functiondef('public.unlock_admin_with_backup_code(text,text)'::regprocedure)) <> '8b061d9c1d1cd26a8ee230b13cf97453'
     or md5(pg_get_functiondef('public.join_with_invite(text,text,text)'::regprocedure)) <> '3397c225ff9e7b52d9ad9fc72a726457'
     or md5(pg_get_functiondef('proxima_auth._reauth(uuid,text)'::regprocedure)) <> '971a28c1d73e52c69ac38f48e79c3da9' then
    raise exception 'signin_history rollback: an auth function changed after the migration; rebase this rollback first';
  end if;
  select string_agg(p.oid::regprocedure::text, ', ') into v_other from pg_proc p
   where (strpos(p.prosrc, '_log_signin') > 0 or strpos(p.prosrc, 'signin_events') > 0)
     and p.oid not in ('public.verify_admin(text,text)'::regprocedure,
                       'public.unlock_with_backup_code(text,text,text)'::regprocedure,
                       'public.unlock_admin_with_backup_code(text,text)'::regprocedure,
                       'public.join_with_invite(text,text,text)'::regprocedure,
                       'proxima_auth._reauth(uuid,text)'::regprocedure,
                       'proxima_auth._log_signin(uuid,text,text,boolean)'::regprocedure,
                       'public.list_signins(text,integer,bigint,text)'::regprocedure);
  if v_other is not null then
    raise exception 'signin_history rollback: other functions still use the sign-in log (%); change them first', v_other;
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
end $function$
;

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
  return json_build_object('ok', true, 'password_changed', p_new_password is not null, 'token', v_s->>'token',
    'expires_at', (v_s->>'expires_at')::bigint, 'username', v_u.username, 'account_id', v_u.id, 'role', v_u.role,
    'scope', v_u.scope);
end $function$
;

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
end $function$
;

CREATE OR REPLACE FUNCTION public.join_with_invite(p_code text, p_username text, p_password text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
declare
  v_name text := btrim(p_username);
  v_th jsonb; v_inv proxima_auth.invites; v_id uuid; v_backup text; v_s jsonb; v_pw_hash text; v_bk_hash text;
begin
  if not coalesce((select c.members_open from proxima_auth.auth_config c where c.id), false) then
    return json_build_object('ok', false, 'reason', 'closed');
  end if;
  -- Shapes first: nothing is looked up for a request that could not create an account.
  -- Review r6 (security #3): letters, digits, '_' and '-' only, 2 to 64 (an allow-list: no invisible, direction, variation,
  -- tag or look-alike character can make a name that looks like another account's; a subset of users_username_shape).
  if v_name is null or v_name !~ '^[A-Za-z0-9_-]{2,64}$' then
    return json_build_object('ok', false, 'reason', 'invalid_username');
  end if;
  if p_password is null or length(p_password) < 8 then
    return json_build_object('ok', false, 'reason', 'weak_password');
  end if;
  v_th := proxima_auth._throttle('join', false);
  if coalesce((v_th->>'blocked')::boolean, false) then
    return json_build_object('ok', false, 'reason', 'throttled', 'retry_after', (v_th->>'retry_after')::int);
  end if;
  perform pg_advisory_xact_lock(hashtextextended('proxima-signin:' || lower(v_name), 0));
  select * into v_inv from proxima_auth.invites i
   where p_code is not null and i.code_hash = proxima_auth._invite_code_hash(p_code)
     and i.used_at is null and i.revoked_at is null and i.expires_at > now()
     and exists (select 1 from proxima_auth.users o where o.id = i.created_by and o.role = 'owner'
                   and o.deleted_at is null and o.disabled_at is null)
   for update of i;
  if not found then
    perform proxima_auth._throttle('join', true);
    return json_build_object('ok', false, 'reason', 'invalid');
  end if;
  -- Review r5 (security #1): a code answers at most 5 taken names; the next try voids it, so a leaked code cannot list the
  -- accounts' names (the IP throttle follows the sign-in mode, which may be 'observe': this cap holds in every mode).
  if v_inv.taken_count >= 5 then
    update proxima_auth.invites set revoked_at = now() where id = v_inv.id;
    perform proxima_auth._throttle('join', true);
    return json_build_object('ok', false, 'reason', 'invalid');
  end if;
  -- The two bcrypt hashes (about half a second) are made now, before the creator's row is held, so that row is held for
  -- milliseconds (review r6).
  v_backup := proxima_auth._random_code(20);
  v_pw_hash := crypt(p_password, gen_salt('bf', 12));
  v_bk_hash := crypt(v_backup, gen_salt('bf', 12));
  -- Review r5 (security #3) and r6 (security #4): the creator's row is held FOR SHARE before the name check, and its state
  -- re-checked under that lock: an owner renaming to this name meanwhile is waited for (no deadlock on the new name's index
  -- entry), and so is an owner disabled, demoted or deleted meanwhile (those updates take FOR NO KEY UPDATE, which FOR
  -- SHARE waits for and FOR KEY SHARE would not); once they commit, the code no longer works. The price, deliberate: a join
  -- also waits while any owner-row update runs (a sign-in or key save: milliseconds; a backups switch-on that drains a
  -- queued switch-off scrub inline: as long as that drain, 20261025800000/20261026200000), and fails at the 3 s statement
  -- limit if that drain runs past about 2.5 s; trying again works. Joins and switch toggles are both rare.
  perform 1 from proxima_auth.users o where o.id = v_inv.created_by and o.role = 'owner' and o.deleted_at is null
     and o.disabled_at is null for share;
  if not found then
    perform proxima_auth._throttle('join', true);
    return json_build_object('ok', false, 'reason', 'invalid');
  end if;
  if proxima_auth._username_taken(v_name) then
    update proxima_auth.invites set taken_count = taken_count + 1 where id = v_inv.id;
    return json_build_object('ok', false, 'reason', 'username_taken');
  end if;
  begin
    insert into proxima_auth.users (username, role, scope, password_hash, backup_code_hash, invited_by)
      values (v_name, 'member', 'user:' || v_name, v_pw_hash, v_bk_hash, v_inv.created_by)
      returning id into v_id;
  exception when unique_violation then   -- a name taken meanwhile, or its folder (users_keep_folder)
    return json_build_object('ok', false, 'reason', 'username_taken');
  end;
  update proxima_auth.invites set used_at = now(), used_by = v_id where id = v_inv.id;
  v_s := proxima_auth.issue_session(v_id);
  return json_build_object('ok', true, 'token', v_s->>'token', 'expires_at', (v_s->>'expires_at')::bigint,
    'username', v_name, 'account_id', v_id, 'role', 'member', 'scope', 'user:' || v_name, 'backup_code', v_backup);
end $function$
;

CREATE OR REPLACE FUNCTION proxima_auth._reauth(p_account uuid, p_password text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_u proxima_auth.users; v_failed int;
begin
  select * into v_u from proxima_auth.users u where u.id = p_account for no key update;
  if not found then return 'forbidden'; end if;
  if v_u.login_locked_at is not null then return 'locked'; end if;
  if p_password is not null and v_u.password_hash is not null
     and extensions.crypt(p_password, v_u.password_hash) = v_u.password_hash then
    if v_u.login_failed <> 0 then
      update proxima_auth.users set login_failed = 0, updated_at = now() where id = p_account;
    end if;
    return 'ok';
  end if;
  v_failed := v_u.login_failed + 1;
  update proxima_auth.users
     set login_failed = v_failed, login_locked_at = case when v_failed >= 3 then now() end, updated_at = now()
   where id = p_account;
  return case when v_failed >= 3 then 'locked' else 'invalid' end;
end $function$
;

select cron.unschedule(j.jobid) from cron.job j where j.jobname = 'signin-events-prune';
drop function public.list_signins(text, integer, bigint, text);
drop function proxima_auth._log_signin(uuid, text, text, boolean);
drop table proxima_auth.signin_events;
