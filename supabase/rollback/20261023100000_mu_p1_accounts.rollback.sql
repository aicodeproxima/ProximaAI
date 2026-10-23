-- Rollback of supabase/migrations/20261023100000_mu_p1_accounts.sql (design §7, M1 part). Kept OUT of
-- supabase/migrations/. One transaction: 0) guards, 0b) M1's frozen guard (its two triggers on app_secrets and
-- proxima_auth.m1_frozen_guard) is dropped FIRST, so the copy-back can write (DROP TRIGGER holds app_secrets in ACCESS
-- EXCLUSIVE mode until the commit, a fraction of a second: reads wait too), 1) the owner row is copied back into the
-- frozen app_secrets rows (only fields that differ are written, so an untouched account leaves app_secrets
-- byte-identical), 2) every function
-- M1 replaced is recreated from its pre-M1 pg_get_functiondef text, verbatim, except one added line in
-- _verify_session_token that refuses 'u:' subjects ('session token revoked': those devices sign in again), 3) the P1
-- objects are dropped. Proof: scripts/test-mu-rollback.sql. Roll back M2 (RLS session) and M1b first. It runs whether
-- or not M4 already dropped the guard and m1_seed_snapshot (M4's rollback does not recreate them; review round 18 #2).
-- Precondition (like M1's apply checklist): both owner devices idle: off the Account screen, no sign-in or unlock in
-- progress. The rollback also locks proxima_auth.users (EXCLUSIVE: reads go on, every new-code write waits and then
-- fails against the dropped table, and the client retries against the restored functions), so no rename, password,
-- code, email or counter write can commit between the copy-back and the drop (review #1).
-- 4) M1's own migration record is deleted (supabase_migrations.schema_migrations, version 20261023100000, name
-- mu_p1_accounts), in this same transaction: apply-migration.mjs skips a version recorded under the same name, so
-- without this a later re-apply of M1 through it would print "already recorded" and change nothing (review m3crit
-- #1/#3). Zero rows is fine (M1 applied by a tool that does not record). A re-apply while a newer record is left
-- (M2's rollback keeps its own) is refused-old by apply-migration.mjs unless --allow-old is given.

-- ── 0. Guards ──
do $guard$
declare
  v_post constant jsonb := '{
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
  v_set constant text[] := array['public._verify_session_token(text)', 'public.verify_admin(text,text)', 'public.unlock_admin_with_backup_code(text,text)', 'public.change_my_password(text,text,text)', 'public.rename_my_account(text,text,text)', 'public.set_admin_backup_code(text,text,text)', 'public.set_admin_credentials_rehash(text,text)', 'public.get_my_account(text)', 'public.set_my_account(text,text,boolean,bigint)', 'public.get_my_wavespeed_key(text)', 'public.set_my_wavespeed_key(text,text)', 'public.get_auto_backups(text)', 'public.set_auto_backups(text,boolean)', 'public._rows_keep_owner()', 'public.clear_queued_rows(text,text,bigint,text[])', 'public.delete_queued_rows(text,text,text[],bigint)', 'public.generations_live(text,text[])', 'public.paths_in_use(text,text[])', 'public.reset_queued_rows(text,bigint,text[],text[],bigint)', 'public.upsert_queued_history(text,jsonb,bigint)', 'public.server_time_ms(text)', 'public.list_my_backups_phase2(text,integer)', 'public.delete_my_backup_phase2(text,uuid)', 'public.purge_my_backups_of(text,text[],text[])', 'public.restore_my_backup_phase2(text,uuid)', 'public.snapshot_my_data_phase2(text,text,text)', 'proxima_auth.current_account(text)', 'proxima_auth.issue_session(uuid)', 'proxima_auth.mint_token(uuid)', 'proxima_auth._revoke_sessions(uuid)', 'proxima_auth._reauth(uuid,text)', 'proxima_auth._throttle(text,boolean)', 'public.unlock_with_backup_code(text,text,text)', 'proxima_auth.m1_frozen_guard()'];
  v_bad text;
begin
  if to_regclass('proxima_auth.users') is null then raise exception 'M1 rollback: proxima_auth.users does not exist (M1 not applied)'; end if;
  -- Anything outside this rollback's set that references the P1 objects (M2 still live, or anything new): refuse.
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
    from pg_proc p
   where p.pronamespace not in ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)
     and p.prosrc ~ '(proxima_auth\.users|current_account|auth_config|issue_session)'
     and not (p.oid = any (array(select to_regprocedure(x) from unnest(v_set) x)));
  if v_bad is not null then raise exception 'M1 rollback: still referenced outside the rollback set: % (roll back M2 first)', v_bad; end if;
  select string_agg(format('%s.%s.%s', schemaname, tablename, policyname), ', ') into v_bad from pg_policies
   where coalesce(qual, '') || coalesce(with_check, '') ~ '(proxima_auth\.users|current_account|auth_config|issue_session)';
  if v_bad is not null then raise exception 'M1 rollback: policies reference P1 objects: %', v_bad; end if;
  -- Compare-and-swap against M1's post-apply bodies: a function changed during P1 must be re-captured first.
  -- proxima_auth.m1_frozen_guard() alone may be absent (M4 dropped it with its triggers and m1_seed_snapshot, and M4's
  -- rollback does not recreate them: review round 18 #2); when present it must still match.
  select string_agg(e.k, ', ' order by e.k) into v_bad from jsonb_each_text(v_post) e(k, m)
   where (to_regprocedure(e.k) is null and e.k <> 'proxima_auth.m1_frozen_guard()')
      or (to_regprocedure(e.k) is not null and md5(pg_get_functiondef(to_regprocedure(e.k))) <> e.m);
  if v_bad is not null then raise exception 'M1 rollback compare-and-swap: body differs from M1''s post-apply text: %', v_bad; end if;
end $guard$;

lock table public.app_secrets in share row exclusive mode;
lock table proxima_auth.users in exclusive mode;

-- ── 0b. The frozen guard goes first: from here the copy-back below may write the account rows (review round 17).
--      IF EXISTS: after M4 (which drops the guard and m1_seed_snapshot) they are already gone (review round 18 #2) ──
drop trigger if exists app_secrets_m1_frozen on public.app_secrets;
drop trigger if exists app_secrets_m1_frozen_truncate on public.app_secrets;
drop function if exists proxima_auth.m1_frozen_guard();

-- ── 1. Copy the owner row back (a password, code, name, email or lockout change made during P1 survives) ──
do $copy$
declare o proxima_auth.users;
begin
  select * into o from proxima_auth.users where role = 'owner';
  if not found then raise exception 'M1 rollback: no owner row'; end if;
  insert into public.app_secrets (key, value, updated_at) values ('admin_username', jsonb_build_object('username', o.username), now())
    on conflict (key) do update set value = excluded.value, updated_at = now()
    where app_secrets.value->>'username' is distinct from o.username;
  if o.password_hash is not null then
    insert into public.app_secrets (key, value, updated_at) values ('admin_password_hash', jsonb_build_object('password_hash', o.password_hash), now())
      on conflict (key) do update set value = excluded.value, updated_at = now()
      where app_secrets.value->>'password_hash' is distinct from o.password_hash;
  end if;
  if o.backup_code_hash is not null then
    insert into public.app_secrets (key, value, updated_at) values ('admin_backup_code_hash', jsonb_build_object('hash', o.backup_code_hash), now())
      on conflict (key) do update set value = excluded.value, updated_at = now()
      where app_secrets.value->>'hash' is distinct from o.backup_code_hash;
  end if;
  if o.email is not null then
    insert into public.app_secrets (key, value, updated_at) values ('admin_email', jsonb_build_object('email', o.email), now())
      on conflict (key) do update set value = excluded.value, updated_at = now()
      where app_secrets.value->>'email' is distinct from o.email;
  end if;
  if coalesce((select (value->>'verified')::boolean from public.app_secrets where key = 'admin_email_verified'), false) is distinct from o.email_verified then
    insert into public.app_secrets (key, value, updated_at) values ('admin_email_verified', jsonb_build_object('verified', o.email_verified), now())
      on conflict (key) do update set value = excluded.value, updated_at = now();
  end if;
  if o.last_verified_at is not null then
    insert into public.app_secrets (key, value, updated_at) values ('admin_last_verified_at', jsonb_build_object('at', o.last_verified_at), now())
      on conflict (key) do update set value = excluded.value, updated_at = now()
      where (app_secrets.value->>'at')::bigint is distinct from o.last_verified_at;
  end if;
  -- The inverse of the seed's '- 1'.
  insert into public.app_secrets (key, value, updated_at) values ('admin_sessions_valid_after', jsonb_build_object('at', o.sessions_valid_after + 1), now())
    on conflict (key) do update set value = excluded.value, updated_at = now()
    where (app_secrets.value->>'at')::bigint is distinct from o.sessions_valid_after + 1;
  if (select (coalesce((value->>'failed')::int, 0), coalesce((value->>'locked')::boolean, false))
        from public.app_secrets where key = 'admin_login_lockout') is distinct from (o.login_failed, o.login_locked_at is not null) then
    insert into public.app_secrets (key, value, updated_at)
      values ('admin_login_lockout', jsonb_build_object('failed', o.login_failed, 'locked', o.login_locked_at is not null, 'locked_at', o.login_locked_at), now())
      on conflict (key) do update set value = excluded.value, updated_at = now();
  end if;
  if (select (coalesce((value->>'failed')::int, 0), nullif(value->>'locked_until', '')::timestamptz)
        from public.app_secrets where key = 'admin_backup_attempts') is distinct from (o.backup_failed, o.backup_locked_until) then
    insert into public.app_secrets (key, value, updated_at)
      values ('admin_backup_attempts', jsonb_build_object('failed', o.backup_failed)
                || case when o.backup_locked_until is not null then jsonb_build_object('locked_until', o.backup_locked_until) else '{}'::jsonb end, now())
      on conflict (key) do update set value = excluded.value, updated_at = now();
  end if;
end $copy$;

-- ── 2. The pre-M1 bodies (pg_get_functiondef, 2026-10-23), verbatim; create or replace keeps each ACL ──
CREATE OR REPLACE FUNCTION public._verify_session_token(p_token text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
declare
  v_parts text[]; v_subject text; v_exp bigint; v_sig text; v_msg text;
  v_key text; v_key_prev text; v_ok boolean := false; v_after bigint;
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
  if v_subject like 'u:%' then raise exception 'session token revoked'; end if;   -- P1 rollback: u: holders sign in again
  if v_subject like 'admin:%' then
    if substring(v_subject from 7) is distinct from (select value->>'username' from app_secrets where key = 'admin_username') then
      raise exception 'session token revoked';
    end if;
    select (value->>'at')::bigint into v_after from app_secrets where key = 'admin_sessions_valid_after';
    if v_after is not null and v_exp - 43200 < v_after then raise exception 'session token revoked'; end if;
  end if;
  return v_subject;
end $function$
;

CREATE OR REPLACE FUNCTION public.verify_admin(p_username text, p_password text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
declare
  v_user   text := (select value->>'username' from app_secrets where key = 'admin_username');
  v_bcrypt text := (select value->>'password_hash' from app_secrets where key = 'admin_password_hash');
  v_legacy text := (select value->>'hash' from app_secrets where key = 'admin_password_hash_legacy_sha256');
  v_lock   jsonb;
  v_failed int;
  v_ok     boolean := false;
  v_rehash boolean := false;
  v_exp    timestamptz := now() + interval '12 hours';
begin
  if v_user is null then return json_build_object('ok', false, 'reason', 'not_provisioned'); end if;
  insert into app_secrets (key, value, updated_at) values ('admin_login_lockout', '{"failed":0,"locked":false}', now())
    on conflict (key) do nothing;
  select value into v_lock from app_secrets where key = 'admin_login_lockout' for update;
  if coalesce((v_lock->>'locked')::boolean, false) then
    return json_build_object('ok', false, 'reason', 'locked');
  end if;
  if p_username = v_user and p_password is not null then
    if v_bcrypt is not null and crypt(p_password, v_bcrypt) = v_bcrypt then
      v_ok := true;
    elsif v_legacy is not null and encode(digest(p_password, 'sha256'), 'hex') = v_legacy then
      v_ok := true; v_rehash := true;
    end if;
  end if;
  if not v_ok then
    v_failed := coalesce((v_lock->>'failed')::int, 0) + 1;
    update app_secrets set updated_at = now(),
      value = jsonb_build_object('failed', v_failed, 'locked', v_failed >= 3, 'locked_at', case when v_failed >= 3 then now() end)
      where key = 'admin_login_lockout';
    if v_failed >= 3 then return json_build_object('ok', false, 'reason', 'locked'); end if;
    return json_build_object('ok', false, 'reason', 'invalid', 'attempts_left', 3 - v_failed);
  end if;
  update app_secrets set value = '{"failed":0,"locked":false}', updated_at = now() where key = 'admin_login_lockout';
  return json_build_object('ok', true, 'token', _sign_session_token('admin:' || v_user, v_exp),
    'expires_at', extract(epoch from v_exp)::bigint, 'rehash_required', v_rehash, 'username', v_user);
end $function$
;

CREATE OR REPLACE FUNCTION public.unlock_admin_with_backup_code(p_code text, p_new_password text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
declare
  v_hash text := (select value->>'hash' from app_secrets where key = 'admin_backup_code_hash');
  v_bk   jsonb;
  v_failed int;
  v_until timestamptz;
begin
  if v_hash is null then return json_build_object('ok', false, 'reason', 'no_backup_code'); end if;
  if p_new_password is not null and length(p_new_password) < 8 then
    return json_build_object('ok', false, 'reason', 'weak_password');
  end if;
  insert into app_secrets (key, value, updated_at) values ('admin_backup_attempts', '{"failed":0}', now())
    on conflict (key) do nothing;
  select value into v_bk from app_secrets where key = 'admin_backup_attempts' for update;
  v_until := nullif(v_bk->>'locked_until', '')::timestamptz;
  if v_until is not null and v_until > now() then
    return json_build_object('ok', false, 'reason', 'backup_locked', 'retry_after', ceil(extract(epoch from v_until - now()))::int);
  end if;
  if p_code is null or crypt(trim(p_code), v_hash) <> v_hash then
    v_failed := case when v_until is not null then 0 else coalesce((v_bk->>'failed')::int, 0) end + 1;
    if v_failed >= 5 then
      update app_secrets set updated_at = now(),
        value = jsonb_build_object('failed', 0, 'locked_until', now() + interval '15 minutes') where key = 'admin_backup_attempts';
      return json_build_object('ok', false, 'reason', 'backup_locked', 'retry_after', 900);
    end if;
    update app_secrets set updated_at = now(), value = jsonb_build_object('failed', v_failed) where key = 'admin_backup_attempts';
    return json_build_object('ok', false, 'reason', 'invalid', 'attempts_left', 5 - v_failed);
  end if;
  update app_secrets set value = '{"failed":0}', updated_at = now() where key = 'admin_backup_attempts';
  update app_secrets set value = '{"failed":0,"locked":false}', updated_at = now() where key = 'admin_login_lockout';
  if p_new_password is not null then
    insert into app_secrets (key, value, updated_at)
      values ('admin_password_hash', jsonb_build_object('password_hash', crypt(p_new_password, gen_salt('bf', 12))), now())
      on conflict (key) do update set value = excluded.value, updated_at = now();
    delete from app_secrets where key = 'admin_password_hash_legacy_sha256';
  end if;
  perform _revoke_admin_sessions();
  return json_build_object('ok', true, 'password_changed', p_new_password is not null);
end $function$
;

CREATE OR REPLACE FUNCTION public.change_my_password(p_session_token text, p_current_password text, p_new_password text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
declare
  v_subject text := _verify_session_token(p_session_token); v_auth text;
  v_exp timestamptz := now() + interval '12 hours';
begin
  if v_subject not like 'admin:%' then return json_build_object('ok', false, 'reason', 'forbidden'); end if;
  if p_new_password is null or length(p_new_password) < 8 then return json_build_object('ok', false, 'reason', 'weak_password'); end if;
  v_auth := _reauth_admin(p_current_password);
  if v_auth <> 'ok' then return json_build_object('ok', false, 'reason', v_auth); end if;
  insert into app_secrets (key, value, updated_at)
    values ('admin_password_hash', jsonb_build_object('password_hash', crypt(p_new_password, gen_salt('bf', 12))), now())
    on conflict (key) do update set value = excluded.value, updated_at = now();
  delete from app_secrets where key = 'admin_password_hash_legacy_sha256';
  perform _revoke_admin_sessions();
  return json_build_object('ok', true, 'username', substring(v_subject from 7),
    'token', _sign_session_token(v_subject, v_exp), 'expires_at', extract(epoch from v_exp)::bigint);
end $function$
;

CREATE OR REPLACE FUNCTION public.rename_my_account(p_session_token text, p_current_password text, p_new_username text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
declare
  v_subject text := _verify_session_token(p_session_token);
  v_old text; v_new text := trim(p_new_username); v_exp timestamptz := now() + interval '12 hours'; v_auth text;
begin
  if v_subject not like 'admin:%' then return json_build_object('ok', false, 'reason', 'forbidden'); end if;
  v_old := substring(v_subject from 7);
  if v_new is null or length(v_new) < 2 or length(v_new) > 64 or v_new ~ '[.:/\s]' then
    return json_build_object('ok', false, 'reason', 'invalid_username');
  end if;
  v_auth := _reauth_admin(p_current_password);
  if v_auth <> 'ok' then return json_build_object('ok', false, 'reason', v_auth); end if;
  if v_new <> v_old then
    perform set_config('proxima.rescope', 'on', true);
    -- Restores and replayed deletes take this account's restore marker before its rows (20261022230000); so does a
    -- rename, so no two of them wait on each other in opposite orders (review round 5).
    insert into settings (device_id, key, value) values ('user:' || v_old, 'last_restore_at', '0'::jsonb)
      on conflict (device_id, key) do nothing;
    perform 1 from settings where device_id = 'user:' || v_old and key = 'last_restore_at' for update;
    perform public._verify_session_token(p_session_token);   -- again, now that the marker is held: another rename may have run
    update app_secrets set value = jsonb_build_object('username', v_new), updated_at = now() where key = 'admin_username';
    update tasks set device_id = 'user:' || v_new where device_id = 'user:' || v_old;
    update history set device_id = 'user:' || v_new where device_id = 'user:' || v_old;
    update favorites set device_id = 'user:' || v_new where device_id = 'user:' || v_old;
    update presets set device_id = 'user:' || v_new where device_id = 'user:' || v_old;
    delete from settings where device_id = 'user:' || v_new and key = 'last_restore_at';   -- a leftover marker of the target name
    update settings set device_id = 'user:' || v_new where device_id = 'user:' || v_old;
    update sync_tombstones set device_id = 'user:' || v_new where device_id = 'user:' || v_old;
    update user_secrets set device_id = 'user:' || v_new where device_id = 'user:' || v_old;
    update data_backups set username = 'user:' || v_new where username = 'user:' || v_old;
    perform set_config('proxima.rescope', 'off', true);
  end if;
  return json_build_object('ok', true, 'username', v_new,
    'token', _sign_session_token('admin:' || v_new, v_exp), 'expires_at', extract(epoch from v_exp)::bigint);
end $function$
;

CREATE OR REPLACE FUNCTION public.set_admin_backup_code(p_session_token text, p_current_password text, p_code text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
declare v_subject text := _verify_session_token(p_session_token); v_auth text;
begin
  if v_subject not like 'admin:%' then return json_build_object('ok', false, 'reason', 'forbidden'); end if;
  if p_code is null or length(trim(p_code)) < 12 then return json_build_object('ok', false, 'reason', 'too_short'); end if;
  v_auth := _reauth_admin(p_current_password);
  if v_auth <> 'ok' then return json_build_object('ok', false, 'reason', v_auth); end if;
  insert into app_secrets (key, value, updated_at)
    values ('admin_backup_code_hash', jsonb_build_object('hash', crypt(trim(p_code), gen_salt('bf', 12))), now())
    on conflict (key) do update set value = excluded.value, updated_at = now();
  delete from app_secrets where key = 'admin_backup_attempts';
  return json_build_object('ok', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.set_admin_credentials_rehash(p_session_token text, p_plain_password text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
declare
  v_subject text := _verify_session_token(p_session_token);
  v_legacy  text := (select value->>'hash' from app_secrets where key = 'admin_password_hash_legacy_sha256');
begin
  if v_subject not like 'admin:%' then return json_build_object('ok', false, 'reason', 'forbidden'); end if;
  if v_legacy is null or p_plain_password is null or encode(digest(p_plain_password, 'sha256'), 'hex') <> v_legacy then
    return json_build_object('ok', false, 'reason', 'not_legacy');
  end if;
  insert into app_secrets (key, value, updated_at)
    values ('admin_password_hash', jsonb_build_object('password_hash', crypt(p_plain_password, gen_salt('bf', 12))), now())
    on conflict (key) do update set value = excluded.value, updated_at = now();
  delete from app_secrets where key = 'admin_password_hash_legacy_sha256';
  return json_build_object('ok', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.get_my_account(p_session_token text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
declare v_subject text := _verify_session_token(p_session_token);
begin
  if v_subject not like 'admin:%' then return json_build_object('ok', false, 'reason', 'forbidden'); end if;
  return json_build_object('ok', true,
    'username',          (select value->>'username' from app_secrets where key = 'admin_username'),
    'email',             (select value->>'email' from app_secrets where key = 'admin_email'),
    'email_verified',    coalesce((select (value->>'verified')::boolean from app_secrets where key = 'admin_email_verified'), false),
    'last_verified_at',  (select (value->>'at')::bigint from app_secrets where key = 'admin_last_verified_at'),
    'has_backup_code',   exists (select 1 from app_secrets where key = 'admin_backup_code_hash'),
    'password_is_bcrypt', exists (select 1 from app_secrets where key = 'admin_password_hash'),
    'sync_topic',        proxima_auth.sync_topic());
end $function$
;

CREATE OR REPLACE FUNCTION public.set_my_account(p_session_token text, p_email text DEFAULT NULL::text, p_email_verified boolean DEFAULT NULL::boolean, p_last_verified_at bigint DEFAULT NULL::bigint)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
declare v_subject text := _verify_session_token(p_session_token);
begin
  if v_subject not like 'admin:%' then return json_build_object('ok', false, 'reason', 'forbidden'); end if;
  if p_email is not null then
    insert into app_secrets (key, value, updated_at) values ('admin_email', jsonb_build_object('email', p_email), now())
      on conflict (key) do update set value = excluded.value, updated_at = now();
  end if;
  if p_email_verified is not null then
    insert into app_secrets (key, value, updated_at) values ('admin_email_verified', jsonb_build_object('verified', p_email_verified), now())
      on conflict (key) do update set value = excluded.value, updated_at = now();
  end if;
  if p_last_verified_at is not null then
    insert into app_secrets (key, value, updated_at) values ('admin_last_verified_at', jsonb_build_object('at', p_last_verified_at), now())
      on conflict (key) do update set value = excluded.value, updated_at = now();
  end if;
  return json_build_object('ok', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.get_my_wavespeed_key(p_session_token text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_subject text;
  v_device_id text;
  v_key text;
BEGIN
  v_subject := public._verify_session_token(p_session_token);
  -- subject is "admin:<username>" in Phase 2; Phase 3 will be the auth.uid()
  IF v_subject LIKE 'admin:%' THEN
    v_device_id := 'user:' || substring(v_subject FROM 7);
  ELSE
    v_device_id := v_subject;
  END IF;
  SELECT value->>'value' INTO v_key
    FROM user_secrets
    WHERE device_id = v_device_id AND key = 'wavespeed_api_key';
  RETURN v_key;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.set_my_wavespeed_key(p_session_token text, p_key text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_subject text;
  v_device_id text;
BEGIN
  IF p_key IS NULL OR length(trim(p_key)) < 8 THEN
    RAISE EXCEPTION 'WaveSpeed key looks invalid (too short)';
  END IF;
  v_subject := public._verify_session_token(p_session_token);
  IF v_subject LIKE 'admin:%' THEN
    v_device_id := 'user:' || substring(v_subject FROM 7);
  ELSE
    v_device_id := v_subject;
  END IF;
  INSERT INTO user_secrets (device_id, key, value)
    VALUES (v_device_id, 'wavespeed_api_key', jsonb_build_object('value', p_key))
  ON CONFLICT (device_id, key) DO UPDATE
    SET value = EXCLUDED.value, updated_at = now();
  RETURN json_build_object('ok', true, 'device_id', v_device_id);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_auto_backups(p_session_token text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
begin
  perform public._verify_session_token(p_session_token);
  return public._auto_backups_on();
end $function$
;

CREATE OR REPLACE FUNCTION public.set_auto_backups(p_session_token text, p_enabled boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
begin
  perform public._verify_session_token(p_session_token);
  insert into app_secrets (key, value, updated_at) values ('auto_backups', jsonb_build_object('enabled', coalesce(p_enabled, false)), now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
  if not coalesce(p_enabled, false) then
    -- The switch is global (app_secrets): every account's backups lose what that account deleted so far.
    insert into backup_scrub_queue (username, all_tombstones)
    select distinct b.username, true from data_backups b;
  end if;
  return public._auto_backups_on();
end $function$
;

CREATE OR REPLACE FUNCTION public._rows_keep_owner()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_live text := 'user:' || (select value->>'username' from app_secrets where key = 'admin_username');
begin
  if new.device_id is distinct from old.device_id
     and coalesce(current_setting('proxima.rescope', true), '') <> 'on'
     and not (new.device_id = v_live and old.device_id is distinct from v_live) then
    new.device_id := old.device_id;
  end if;
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION public.clear_queued_rows(p_session_token text, p_kind text, p_queued_at bigint, p_ids text[] DEFAULT NULL::text[])
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_subject text := public._verify_session_token(p_session_token);
  v_user    text;
  v_restore bigint;
begin
  if v_subject not like 'admin:%' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  v_user := 'user:' || substring(v_subject from 7);
  if p_kind not in ('task', 'history', 'settings', 'favorites') then
    raise exception 'clear_queued_rows: unknown kind %', p_kind;
  end if;
  insert into settings (device_id, key, value) values (v_user, 'last_restore_at', '0'::jsonb) on conflict (device_id, key) do nothing;
  select coalesce((value #>> '{}')::bigint, 0) into v_restore
    from settings where device_id = v_user and key = 'last_restore_at' for share;
  perform public._verify_session_token(p_session_token);   -- again, now that the marker is held: a rename may have run
  if coalesce(p_queued_at, 0) < coalesce(v_restore, 0) then
    return json_build_object('ok', true, 'voided', true, 'deleted', 0);
  end if;
  return json_build_object('ok', true, 'voided', false,
    'deleted', public._clear_kind(v_user, p_kind, to_timestamp(coalesce(p_queued_at, 0) / 1000.0), p_ids));
end $function$
;

CREATE OR REPLACE FUNCTION public.delete_queued_rows(p_session_token text, p_kind text, p_ids text[], p_queued_at bigint)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_subject text := public._verify_session_token(p_session_token);
  v_user    text;
  v_restore bigint;
  v_n       int := 0;
begin
  if v_subject not like 'admin:%' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  v_user := 'user:' || substring(v_subject from 7);
  if p_kind not in ('task', 'history') then
    raise exception 'delete_queued_rows: unknown kind %', p_kind;
  end if;
  if p_ids is null or cardinality(p_ids) = 0 then
    return json_build_object('ok', true, 'voided', false, 'deleted', 0);
  end if;
  if cardinality(p_ids) > 200 then
    raise exception 'delete_queued_rows: at most 200 ids, got %', cardinality(p_ids);
  end if;
  insert into settings (device_id, key, value) values (v_user, 'last_restore_at', '0'::jsonb) on conflict (device_id, key) do nothing;
  select coalesce((value #>> '{}')::bigint, 0) into v_restore
    from settings where device_id = v_user and key = 'last_restore_at' for share;
  perform public._verify_session_token(p_session_token);   -- again, now that the marker is held: a rename may have moved the account
  if coalesce(p_queued_at, 0) < coalesce(v_restore, 0) then
    return json_build_object('ok', true, 'voided', true, 'deleted', 0);
  end if;
  if p_kind = 'task' then
    delete from tasks where device_id = v_user and id = any(p_ids);
  else
    delete from history where device_id = v_user and id = any(p_ids);
  end if;
  get diagnostics v_n = row_count;
  if p_kind = 'task' then
    -- A user delete of a generation without a tasks row (History-only, e.g. after a restore) records a user tombstone
    -- too, so other devices drop its History item and uploads are stripped of it; a restore's tombstone of it becomes a
    -- user one (review round 6). Only ids a live History item of this account holds, or a tombstone already names.
    update sync_tombstones set by_restore = false, deleted_at = now()
     where device_id = v_user and kind = 'task' and id = any(p_ids) and coalesce(by_restore, false);
    insert into sync_tombstones (id, kind, device_id, deleted_at, by_restore)
    select x, 'task', v_user, now(), false from unnest(p_ids) x
     where not exists (select 1 from sync_tombstones st where st.id = x)
       and not exists (select 1 from tasks t where t.id = x)
       and x in (select e.item->>'id' from history h,
                   jsonb_array_elements(case when jsonb_typeof(h.tasks) = 'array' then h.tasks else '[]'::jsonb end) e(item)
                  where h.device_id = v_user and coalesce(e.item->>'id', '') <> '')
    on conflict (id) do nothing;
    -- The History half of the delete, in this same transaction (review round 8): touching the entries that hold these
    -- ids lets history_strip_deleted_items remove their items (they now carry user tombstones) and recompute the cost,
    -- history_drop_emptied delete an entry left empty, and the scrub triggers queue what left. A restore can no longer
    -- land between the row delete and the History change, and no client upload of a trimmed copy is needed.
    update history h set tasks = h.tasks
     where h.device_id = v_user and jsonb_typeof(h.tasks) = 'array'
       and exists (select 1 from jsonb_array_elements(h.tasks) e where e->>'id' = any(p_ids));
  end if;
  return json_build_object('ok', true, 'voided', false, 'deleted', v_n);
end $function$
;

CREATE OR REPLACE FUNCTION public.generations_live(p_session_token text, p_ids text[])
 RETURNS text[]
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_subject text := public._verify_session_token(p_session_token);
  v_user    text;
begin
  if v_subject not like 'admin:%' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  v_user := 'user:' || substring(v_subject from 7);
  if p_ids is null or cardinality(p_ids) = 0 then
    return '{}';
  end if;
  if cardinality(p_ids) > 200 then
    raise exception 'generations_live: at most 200 ids, got %', cardinality(p_ids);
  end if;
  return coalesce(array(
    select x from unnest(p_ids) x
     where coalesce(x, '') <> ''
       and (exists (select 1 from tasks t where t.device_id = v_user and t.id = x)
            or (x in (select e.item->>'id' from history h,
                        jsonb_array_elements(case when jsonb_typeof(h.tasks) = 'array' then h.tasks else '[]'::jsonb end) e(item)
                       where h.device_id = v_user and coalesce(e.item->>'id', '') <> '')
                and not exists (select 1 from sync_tombstones st where st.device_id = v_user and st.kind = 'task'
                                   and st.id = x and not coalesce(st.by_restore, false))))
  ), '{}');
end $function$
;

CREATE OR REPLACE FUNCTION public.paths_in_use(p_session_token text, p_paths text[])
 RETURNS text[]
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_subject text := public._verify_session_token(p_session_token);
  v_user    text;
begin
  if v_subject not like 'admin:%' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  v_user := 'user:' || substring(v_subject from 7);
  if p_paths is null or cardinality(p_paths) = 0 then
    return '{}';
  end if;
  if cardinality(p_paths) > 200 then
    raise exception 'paths_in_use: at most 200 paths, got %', cardinality(p_paths);
  end if;
  return coalesce(array(
    select p from unnest(p_paths) p
     where coalesce(p, '') <> ''
       and (exists (select 1 from tasks t
                     where t.device_id = v_user
                       and (position(p in concat_ws(' ', t.source_image_url, t.source_image_urls::text, t.outputs::text,
                                                    t.end_frame_url, t.source_audio_url, t.source_video_url, t.ref_video_url)) > 0
                            or position(replace(p, ' ', '%20') in concat_ws(' ', t.source_image_url, t.source_image_urls::text, t.outputs::text,
                                                    t.end_frame_url, t.source_audio_url, t.source_video_url, t.ref_video_url)) > 0))
            or exists (select 1 from history h
                        where h.device_id = v_user
                          and (position(p in concat_ws(' ', h.source_image_url, h.source_image_urls::text, h.tasks::text)) > 0
                               or position(replace(p, ' ', '%20') in concat_ws(' ', h.source_image_url, h.source_image_urls::text, h.tasks::text)) > 0)))
  ), '{}');
end $function$
;

CREATE OR REPLACE FUNCTION public.reset_queued_rows(p_session_token text, p_queued_at bigint, p_task_ids text[] DEFAULT NULL::text[], p_history_ids text[] DEFAULT NULL::text[], p_prefs_at bigint DEFAULT NULL::bigint)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_subject text := public._verify_session_token(p_session_token);
  v_user    text;
  v_restore bigint;
  v_upto    timestamptz := to_timestamp(coalesce(p_queued_at, 0) / 1000.0);
  v_prefs   timestamptz := to_timestamp(coalesce(p_prefs_at, p_queued_at, 0) / 1000.0);
  v_h int; v_t int; v_s int; v_f int;
begin
  if v_subject not like 'admin:%' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  v_user := 'user:' || substring(v_subject from 7);
  insert into settings (device_id, key, value) values (v_user, 'last_restore_at', '0'::jsonb) on conflict (device_id, key) do nothing;
  select coalesce((value #>> '{}')::bigint, 0) into v_restore
    from settings where device_id = v_user and key = 'last_restore_at' for share;
  perform public._verify_session_token(p_session_token);   -- again, now that the marker is held: a rename may have run
  if coalesce(p_queued_at, 0) < coalesce(v_restore, 0) then
    return json_build_object('ok', true, 'voided', true);
  end if;
  -- Tasks first, as every other path (delete_queued_rows, clear_queued_rows): tasks rows, then History rows.
  v_t := public._clear_kind(v_user, 'task', v_upto, p_task_ids);
  v_h := public._clear_kind(v_user, 'history', v_upto, p_history_ids);
  v_s := public._clear_kind(v_user, 'settings', v_prefs, null);
  v_f := public._clear_kind(v_user, 'favorites', v_prefs, null);
  return json_build_object('ok', true, 'voided', false,
    'deleted', json_build_object('history', v_h, 'task', v_t, 'settings', v_s, 'favorites', v_f));
end $function$
;

CREATE OR REPLACE FUNCTION public.upsert_queued_history(p_session_token text, p_entries jsonb, p_queued_at bigint)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_subject text := public._verify_session_token(p_session_token);
  v_user    text;
  v_restore bigint;
  v_n       int := 0;
begin
  if v_subject not like 'admin:%' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  v_user := 'user:' || substring(v_subject from 7);
  if jsonb_typeof(p_entries) is distinct from 'array' then
    raise exception 'upsert_queued_history: entries must be an array';
  end if;
  if jsonb_array_length(p_entries) = 0 then
    return json_build_object('ok', true, 'voided', false, 'upserted', 0);
  end if;
  if jsonb_array_length(p_entries) > 100 then
    raise exception 'upsert_queued_history: at most 100 entries, got %', jsonb_array_length(p_entries);
  end if;
  insert into settings (device_id, key, value) values (v_user, 'last_restore_at', '0'::jsonb) on conflict (device_id, key) do nothing;
  select coalesce((value #>> '{}')::bigint, 0) into v_restore
    from settings where device_id = v_user and key = 'last_restore_at' for share;
  perform public._verify_session_token(p_session_token);   -- again, now that the marker is held: a rename may have run
  if coalesce(p_queued_at, 0) < coalesce(v_restore, 0) then
    return json_build_object('ok', true, 'voided', true, 'upserted', 0);
  end if;
  insert into history (id, device_id, timestamp, prompt, neg_prompt, gen_type, models, resolution, duration, seed,
                       aspect_ratio, source_image_url, source_image_urls, num_images, tasks, total_cost)
  select r.id, v_user, r.timestamp, r.prompt, r.neg_prompt, r.gen_type, coalesce(r.models, '[]'), r.resolution, r.duration,
         r.seed, r.aspect_ratio, r.source_image_url, coalesce(r.source_image_urls, '[]'), coalesce(r.num_images, 1),
         coalesce(r.tasks, '[]'), coalesce(r.total_cost, 0)
    from jsonb_populate_recordset(null::public.history, p_entries) r
   where coalesce(r.id, '') <> ''
  on conflict (id) do update set
    timestamp = excluded.timestamp, prompt = excluded.prompt, neg_prompt = excluded.neg_prompt, gen_type = excluded.gen_type,
    models = excluded.models, resolution = excluded.resolution, duration = excluded.duration, seed = excluded.seed,
    aspect_ratio = excluded.aspect_ratio, source_image_url = excluded.source_image_url,
    source_image_urls = excluded.source_image_urls, num_images = excluded.num_images, tasks = excluded.tasks,
    total_cost = excluded.total_cost
   where history.device_id = v_user;
  get diagnostics v_n = row_count;
  return json_build_object('ok', true, 'voided', false, 'upserted', v_n);
end $function$
;

CREATE OR REPLACE FUNCTION public.server_time_ms(p_session_token text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_subject text := public._verify_session_token(p_session_token);
begin
  if v_subject not like 'admin:%' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return (extract(epoch from clock_timestamp()) * 1000)::bigint;
end $function$
;

CREATE OR REPLACE FUNCTION public.list_my_backups_phase2(p_session_token text, p_limit integer DEFAULT 20)
 RETURNS TABLE(id uuid, backup_type text, task_count integer, history_count integer, note text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_subject text := _verify_session_token(p_session_token);
  v_username text := case when v_subject like 'admin:%' then 'user:' || substring(v_subject from 7) else v_subject end;
begin
  return query select b.id, b.backup_type, b.task_count, b.history_count, b.note, b.created_at
    from data_backups b where b.username = v_username order by b.created_at desc limit least(greatest(p_limit, 1), 100);
end $function$
;

CREATE OR REPLACE FUNCTION public.delete_my_backup_phase2(p_session_token text, p_backup_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_subject text;
  v_username text;
  v_deleted int;
BEGIN
  v_subject := public._verify_session_token(p_session_token);
  v_username := CASE WHEN v_subject LIKE 'admin:%' THEN 'user:' || substring(v_subject FROM 7) ELSE v_subject END;
  DELETE FROM data_backups WHERE id = p_backup_id AND username = v_username;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN json_build_object('ok', true, 'deleted_rows', v_deleted);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.purge_my_backups_of(p_session_token text, p_task_ids text[], p_log_ids text[])
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_subject  text := public._verify_session_token(p_session_token);
  v_username text := case when v_subject like 'admin:%' then 'user:' || substring(v_subject from 7) else v_subject end;
begin
  return json_build_object('ok', true, 'backups', public._scrub_backups(v_username, p_task_ids, p_log_ids, '{}'));
end $function$
;

CREATE OR REPLACE FUNCTION public.restore_my_backup_phase2(p_session_token text, p_backup_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
declare
  v_subject  text := _verify_session_token(p_session_token);
  v_username text := case when v_subject like 'admin:%' then 'user:' || substring(v_subject from 7) else v_subject end;
  v_backup   record;
  v_tasks int := 0; v_history int := 0; v_favorites int := 0;
  v_rt text[]; v_rl text[]; v_prev_items text[];
begin
  -- Restores and replayed deletes take this account's restore marker first (delete_queued_rows): a delete queued before
  -- this restore waits for it and is then refused; it can never run in the middle of it.
  insert into settings (device_id, key, value) values (v_username, 'last_restore_at', '0'::jsonb) on conflict (device_id, key) do nothing;
  perform 1 from settings where device_id = v_username and key = 'last_restore_at' for update;
  perform public._verify_session_token(p_session_token);   -- again, now that the marker is held: a rename may have moved the account
  perform public._drain_backup_scrubs(v_username);
  if exists (select 1 from backup_scrub_queue q where q.username = v_username) then
    return json_build_object('ok', false, 'reason', 'Deleted items are still being removed from your backups. Try again in a minute.');
  end if;
  select * into v_backup from data_backups where id = p_backup_id and username = v_username;
  if not found then return json_build_object('ok', false, 'reason', 'backup_not_found'); end if;
  begin
    if public._auto_backups_on() then
      insert into data_backups (id, username, backup_type, task_count, history_count, settings_snapshot,
                                favorites_snapshot, tasks_snapshot, history_snapshot, note)
      select gen_random_uuid(), v_username, 'pre-restore',
        (select count(*) from tasks where device_id = v_username),
        (select count(*) from history where device_id = v_username),
        coalesce((select jsonb_object_agg(key, value) from settings where device_id = v_username and key not like 'form-inputs:%'), '{}'::jsonb),
        coalesce((select jsonb_agg(row_to_json(f)) from (select * from favorites where device_id = v_username) f), '[]'::jsonb),
        coalesce((select jsonb_agg(row_to_json(t)) from (select * from tasks where device_id = v_username order by start_time desc limit 500) t), '[]'::jsonb),
        coalesce((select jsonb_agg(row_to_json(h)) from (select * from history where device_id = v_username order by timestamp desc limit 1000) h), '[]'::jsonb),
        'auto safety snapshot before restoring backup ' || p_backup_id::text;
    end if;
    perform set_config('proxima.restore', 'on', true);
    delete from tasks where device_id = v_username;
    -- The History item ids before the replacement (a History-only generation the restore drops is replaced too).
    v_prev_items := array(select distinct e.item->>'id' from history h,
                      jsonb_array_elements(case when jsonb_typeof(h.tasks) = 'array' then h.tasks else '[]'::jsonb end) e(item)
                     where h.device_id = v_username and coalesce(e.item->>'id', '') <> '');
    delete from history where device_id = v_username;
    delete from favorites where device_id = v_username;
    delete from settings where device_id = v_username and key not like 'form-inputs:%' and key <> 'last_restore_at';
    insert into tasks select * from jsonb_populate_recordset(null::tasks, (
      select coalesce(jsonb_agg(e || jsonb_build_object('device_id', v_username)), '[]'::jsonb)
        from jsonb_array_elements(case when jsonb_typeof(v_backup.tasks_snapshot) = 'array' then v_backup.tasks_snapshot else '[]'::jsonb end) e));
    get diagnostics v_tasks = row_count;
    insert into history select * from jsonb_populate_recordset(null::history, (
      select coalesce(jsonb_agg(e || jsonb_build_object('device_id', v_username)), '[]'::jsonb)
        from jsonb_array_elements(case when jsonb_typeof(v_backup.history_snapshot) = 'array' then v_backup.history_snapshot else '[]'::jsonb end) e));
    get diagnostics v_history = row_count;
    -- A generation this restore brings back in History is the restore's decision, not a user delete: an older user
    -- tombstone of its id becomes a restore removal (by_restore), so the backup scrub and the History strip treat
    -- it as live while History holds it (review round 5).
    update sync_tombstones st set by_restore = true
     where st.device_id = v_username and st.kind = 'task' and not coalesce(st.by_restore, false)
       and st.id in (select e.item->>'id' from history h,
                      jsonb_array_elements(case when jsonb_typeof(h.tasks) = 'array' then h.tasks else '[]'::jsonb end) e(item)
                     where h.device_id = v_username);
    perform set_config('proxima.restore', 'off', true);
    insert into favorites select * from jsonb_populate_recordset(null::favorites, (
      select coalesce(jsonb_agg(e || jsonb_build_object('device_id', v_username)), '[]'::jsonb)
        from jsonb_array_elements(case when jsonb_typeof(v_backup.favorites_snapshot) = 'array' then v_backup.favorites_snapshot else '[]'::jsonb end) e));
    get diagnostics v_favorites = row_count;
    insert into settings (device_id, key, value)
      select v_username, k.key, k.value from jsonb_each(coalesce(v_backup.settings_snapshot, '{}'::jsonb)) k where k.key <> 'apiKey' and k.key not like 'form-inputs:%' and k.key <> 'last_restore_at'
      on conflict (device_id, key) do update set value = excluded.value, updated_at = now();
    -- When this restore happened (epoch ms; after the snapshot's own settings, so an older value in it never wins):
    -- every device drops delete intents it queued before it (review round 2), so a clear still pending on the other
    -- device cannot delete what this restore brought back.
    insert into settings (device_id, key, value) values (v_username, 'last_restore_at', to_jsonb((extract(epoch from clock_timestamp()) * 1000)::bigint))
      on conflict (device_id, key) do update set value = excluded.value, updated_at = now();
  exception when others then
    perform set_config('proxima.restore', 'off', true);
    return json_build_object('ok', false, 'reason', sqlerrm);
  end;
  -- Owner ruling on review wf_ec400a67-988 #11 (2026-10-22, "Scrub them right away"): with Automatic backups off, the
  -- rows this restore replaced (its by_restore tombstones, stamped in this transaction, not live again) leave every
  -- backup now, as any delete would; the result never depends on a later toggle of the switch.
  if not public._auto_backups_on() then
    v_rt := array(select st.id from sync_tombstones st where st.device_id = v_username and st.kind = 'task'
                    and st.by_restore and st.deleted_at = now() and not exists (select 1 from tasks t where t.id = st.id));
    v_rt := v_rt || array(select x from unnest(coalesce(v_prev_items, '{}')) x
                          where not exists (select 1 from tasks t where t.id = x) and not (x = any(v_rt)));
    v_rl := array(select st.id from sync_tombstones st where st.device_id = v_username and st.kind = 'history'
                    and st.by_restore and st.deleted_at = now() and not exists (select 1 from history h where h.id = st.id));
    if cardinality(v_rt) > 0 or cardinality(v_rl) > 0 then
      insert into backup_scrub_queue (username, task_ids, log_ids) values (v_username, v_rt, v_rl);
      perform public._drain_backup_scrubs(v_username);
    end if;
  end if;
  -- The clock at the restore's end (review round 8): intents queued while it ran are voided too.
  update settings set value = to_jsonb((extract(epoch from clock_timestamp()) * 1000)::bigint), updated_at = now()
   where device_id = v_username and key = 'last_restore_at';
  return json_build_object('ok', true, 'tasks_restored', v_tasks, 'history_restored', v_history, 'favorites_restored', v_favorites);
end $function$
;

CREATE OR REPLACE FUNCTION public.snapshot_my_data_phase2(p_session_token text, p_type text, p_note text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
DECLARE
  v_subject text;
  v_username text;
  v_id uuid := gen_random_uuid();
  v_tasks  jsonb;
  v_hist   jsonb;
  v_set    jsonb;
  v_fav    jsonb;
  v_ct     int;
  v_ch     int;
BEGIN
  v_subject := public._verify_session_token(p_session_token);
  v_username := CASE WHEN v_subject LIKE 'admin:%' THEN 'user:' || substring(v_subject FROM 7) ELSE v_subject END;
  IF coalesce(p_type, '') LIKE 'pre-%' AND NOT public._auto_backups_on() THEN
    RETURN json_build_object('ok', true, 'skipped', true);
  END IF;

  SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
    INTO v_tasks
    FROM (SELECT * FROM tasks WHERE device_id = v_username ORDER BY start_time DESC LIMIT 500) t;
  SELECT COALESCE(jsonb_agg(row_to_json(h)), '[]'::jsonb)
    INTO v_hist
    FROM (SELECT * FROM history WHERE device_id = v_username ORDER BY timestamp DESC LIMIT 1000) h;
  SELECT COALESCE(jsonb_object_agg(key, value), '{}'::jsonb)
    INTO v_set
    FROM settings WHERE device_id = v_username AND key NOT LIKE 'form-inputs:%';
  SELECT COALESCE(jsonb_agg(row_to_json(f)), '[]'::jsonb)
    INTO v_fav
    FROM (SELECT * FROM favorites WHERE device_id = v_username) f;   -- aliased now

  SELECT count(*) INTO v_ct FROM tasks WHERE device_id = v_username;
  SELECT count(*) INTO v_ch FROM history WHERE device_id = v_username;

  INSERT INTO data_backups (
    id, username, backup_type, task_count, history_count,
    settings_snapshot, favorites_snapshot, tasks_snapshot, history_snapshot, note
  ) VALUES (
    v_id, v_username, p_type, v_ct, v_ch,
    v_set, v_fav, v_tasks, v_hist, p_note
  );

  RETURN json_build_object('ok', true, 'id', v_id);
END;
$function$
;

-- ── 3. Drop the P1 objects ──
drop function proxima_auth.current_account(text);
drop function proxima_auth.issue_session(uuid);
drop function proxima_auth.mint_token(uuid);
drop function proxima_auth._revoke_sessions(uuid);
drop function proxima_auth._reauth(uuid,text);
drop function proxima_auth._throttle(text,boolean);
drop function public.unlock_with_backup_code(text,text,text);
drop table if exists proxima_auth.m1_seed_snapshot;   -- already gone after M4 (review round 18 #2)
drop table proxima_auth.signin_throttle;
drop table proxima_auth.auth_config;
drop table proxima_auth.users;
drop type proxima_auth.account;

-- ── 4. M1's own migration record, so a re-apply through apply-migration.mjs really applies ──
delete from supabase_migrations.schema_migrations where version = '20261023100000' and name = 'mu_p1_accounts';
