-- Rollback for supabase/migrations/20261025920000_signin_locks_no_key.sql: the five bodies live before it, verbatim
-- (FOR UPDATE on the account row). Refuses unless the live bodies are the ones the migration installed.
-- Proof (rolled back): node scripts/tools/sql-tx.mjs supabase/migrations/20261025920000_signin_locks_no_key.sql supabase/rollback/20261025920000_signin_locks_no_key.rollback.sql --test scripts/test-signin-locks-db.sql   (must FAIL: the old clauses are back)

do $guard$
declare
  want constant jsonb := '{
    "public.verify_admin(text,text)": "d24ceca1b96d053ebb05babd99d87cf0",
    "public.unlock_with_backup_code(text,text,text)": "76a6bfd209a85355573a0fa5ae58939c",
    "proxima_auth._reauth(uuid,text)": "ec17bbba2915e4cffb07b8bd42e13285",
    "public.set_my_provider_key(text,text,text)": "e26b2b27cca971f9c20783d3a399105a",
    "public.clear_my_provider_key(text,text)": "f56a4698d344bfe0e730093fbea503ae"
  }';
  k text; got text;
begin
  for k in select jsonb_object_keys(want) loop
    select md5(pg_get_functiondef(k::regprocedure)) into got;
    if got is distinct from want->>k then
      raise exception '20261025920000 rollback: % changed (live %, expected %)', k, got, want->>k;
    end if;
  end loop;
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
  select * into v_u from proxima_auth.users u where lower(u.username) = lower(p_username) for update;
  if not found or v_u.deleted_at is not null or v_u.disabled_at is not null or v_u.password_hash is null
     or v_u.login_locked_at is not null then
    perform extensions.crypt(coalesce(p_password, ''), (select c.dummy_hash from proxima_auth.auth_config c where c.id));
    perform proxima_auth._throttle(p_username, true);
    return v_fail;
  end if;
  -- Exactly one bcrypt for every input (round 16 #1): a NULL or empty password pays it too, then answers generically.
  v_ok := extensions.crypt(coalesce(p_password, ''), v_u.password_hash) = v_u.password_hash and p_password is not null;
  if v_ok then
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
  select * into v_u from proxima_auth.users u where lower(u.username) = lower(p_username) for update;
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
end $function$;

CREATE OR REPLACE FUNCTION proxima_auth._reauth(p_account uuid, p_password text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_u proxima_auth.users; v_failed int;
begin
  select * into v_u from proxima_auth.users u where u.id = p_account for update;
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
end $function$;

CREATE OR REPLACE FUNCTION public.set_my_provider_key(p_session_token text, p_provider text, p_key text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_acc proxima_auth.account := proxima_auth.current_account(p_session_token);
  v_key text := btrim(p_key);
  v_fp  text;
begin
  if v_acc.id is null then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_provider is null or p_provider not in ('wavespeed', 'kie') then
    raise exception 'unknown provider' using errcode = '22023';
  end if;
  if not proxima_auth._provider_key_ok(v_key) then
    raise exception 'That key does not look right (8 to 512 characters, no spaces).' using errcode = '22023';
  end if;
  perform 1 from proxima_auth.users u where u.id = v_acc.id for update;   -- one key write per account at a time
  v_fp := proxima_auth._store_provider_key(v_acc.id, p_provider, v_key);
  if p_provider = 'wavespeed' then
    delete from user_secrets where device_id = v_acc.scope and key = 'wavespeed_api_key';   -- no clear-text copy left
  end if;
  return json_build_object('ok', true, 'provider', p_provider, 'fingerprint', v_fp);
end $function$;

CREATE OR REPLACE FUNCTION public.clear_my_provider_key(p_session_token text, p_provider text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_acc proxima_auth.account := proxima_auth.current_account(p_session_token);
  v_secret uuid;
  v_n int := 0;
begin
  if v_acc.id is null then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_provider is null or p_provider not in ('wavespeed', 'kie') then
    raise exception 'unknown provider' using errcode = '22023';
  end if;
  perform 1 from proxima_auth.users u where u.id = v_acc.id for update;
  delete from proxima_auth.provider_keys k where k.account_id = v_acc.id and k.provider = p_provider returning k.secret_id into v_secret;
  if v_secret is not null then
    delete from vault.secrets s where s.id = v_secret;
    v_n := 1;
  end if;
  if p_provider = 'wavespeed' then
    delete from user_secrets where device_id = v_acc.scope and key = 'wavespeed_api_key';
  end if;
  return json_build_object('ok', true, 'removed', v_n = 1);
end $function$;

delete from supabase_migrations.schema_migrations where version = '20261025920000' and name = 'signin_locks_no_key';
