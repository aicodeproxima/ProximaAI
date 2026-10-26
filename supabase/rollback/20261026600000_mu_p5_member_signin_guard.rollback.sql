-- Rollback for supabase/migrations/20261026600000_mu_p5_member_signin_guard.sql: verify_admin and the legacy unlock as they
-- were before it, verbatim, and the helper dropped. Refuses unless the live bodies are the ones the migration installed.
-- Proof (rolled back): node scripts/tools/sql-tx.mjs supabase/migrations/20261026600000_mu_p5_member_signin_guard.sql supabase/rollback/20261026600000_mu_p5_member_signin_guard.rollback.sql --test scripts/test-member-signin-guard-db.sql   (must FAIL)

do $guard$
declare
  want constant jsonb := '{
    "public.verify_admin(text,text)": "caf7cc8b38b8c82beb5ff118e1e48a75",
    "public.unlock_admin_with_backup_code(text,text)": "b1fc2c51f8845b777219498820f72dd7"
  }';
  k text; got text;
begin
  for k in select jsonb_object_keys(want) loop
    select md5(pg_get_functiondef(k::regprocedure)) into got;
    if got is distinct from want->>k then
      raise exception '20261026600000 rollback: % changed (live %, expected %)', k, got, want->>k;
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
  return public.unlock_with_backup_code((select u.username from proxima_auth.users u where u.role = 'owner'), p_code, p_new_password);
end $function$;

drop function proxima_auth._client_guard();

delete from supabase_migrations.schema_migrations where version = '20261026600000' and name = 'mu_p5_member_signin_guard';
