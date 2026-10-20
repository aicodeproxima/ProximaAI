-- Secrets lockdown, step 1 (additive; the current client keeps working until the cut-over ships).
-- Owner decisions 2026-10-20: server-side sign-in only (bcrypt), 12-hour sessions, max 3 failed sign-ins then
-- locked until unlocked with a backup code, account changes through token-checked RPCs, uploads through storage.
-- All state lives in app_secrets (RLS on, no policies: unreadable to anon).

-- ─── Sign-in with a 3-attempt lockout ───────────────────────────────────────────────────────────────────
-- Every failed attempt counts (wrong username included, so usernames can't be probed for free). While locked,
-- even the correct password is refused. The lockout row is locked FOR UPDATE so parallel guesses can't race
-- past the limit.
create or replace function public.verify_admin(p_username text, p_password text) returns json
language plpgsql security definer set search_path = public, extensions, pg_catalog as $$
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
end $$;

-- ─── Backup code: set (signed in) and unlock (signed out) ──────────────────────────────────────────────
create or replace function public.set_admin_backup_code(p_session_token text, p_code text) returns json
language plpgsql security definer set search_path = public, extensions, pg_catalog as $$
declare v_subject text := _verify_session_token(p_session_token);
begin
  if v_subject not like 'admin:%' then return json_build_object('ok', false, 'reason', 'forbidden'); end if;
  if p_code is null or length(trim(p_code)) < 12 then return json_build_object('ok', false, 'reason', 'too_short'); end if;
  insert into app_secrets (key, value, updated_at)
    values ('admin_backup_code_hash', jsonb_build_object('hash', crypt(trim(p_code), gen_salt('bf', 12))), now())
    on conflict (key) do update set value = excluded.value, updated_at = now();
  delete from app_secrets where key = 'admin_backup_attempts';
  return json_build_object('ok', true);
end $$;

-- Unlocks the sign-in lockout (and optionally sets a new password, for a forgotten one). Five wrong backup codes
-- lock this path too; only a direct database change can reset it then.
create or replace function public.unlock_admin_with_backup_code(p_code text, p_new_password text default null) returns json
language plpgsql security definer set search_path = public, extensions, pg_catalog as $$
declare
  v_hash text := (select value->>'hash' from app_secrets where key = 'admin_backup_code_hash');
  v_bk   jsonb;
  v_failed int;
begin
  if v_hash is null then return json_build_object('ok', false, 'reason', 'no_backup_code'); end if;
  if p_new_password is not null and length(p_new_password) < 8 then
    return json_build_object('ok', false, 'reason', 'weak_password');
  end if;
  insert into app_secrets (key, value, updated_at) values ('admin_backup_attempts', '{"failed":0,"locked":false}', now())
    on conflict (key) do nothing;
  select value into v_bk from app_secrets where key = 'admin_backup_attempts' for update;
  if coalesce((v_bk->>'locked')::boolean, false) then return json_build_object('ok', false, 'reason', 'backup_locked'); end if;
  if p_code is null or crypt(trim(p_code), v_hash) <> v_hash then
    v_failed := coalesce((v_bk->>'failed')::int, 0) + 1;
    update app_secrets set updated_at = now(), value = jsonb_build_object('failed', v_failed, 'locked', v_failed >= 5)
      where key = 'admin_backup_attempts';
    if v_failed >= 5 then return json_build_object('ok', false, 'reason', 'backup_locked'); end if;
    return json_build_object('ok', false, 'reason', 'invalid', 'attempts_left', 5 - v_failed);
  end if;
  update app_secrets set value = '{"failed":0,"locked":false}', updated_at = now() where key in ('admin_backup_attempts', 'admin_login_lockout');
  if p_new_password is not null then
    insert into app_secrets (key, value, updated_at)
      values ('admin_password_hash', jsonb_build_object('password_hash', crypt(p_new_password, gen_salt('bf', 12))), now())
      on conflict (key) do update set value = excluded.value, updated_at = now();
    delete from app_secrets where key = 'admin_password_hash_legacy_sha256';
  end if;
  return json_build_object('ok', true, 'password_changed', p_new_password is not null);
end $$;

-- ─── Account profile (replaces the anon-readable settings `_account` rows) ──────────────────────────────
create or replace function public.get_my_account(p_session_token text) returns json
language plpgsql security definer set search_path = public, extensions, pg_catalog as $$
declare v_subject text := _verify_session_token(p_session_token);
begin
  if v_subject not like 'admin:%' then return json_build_object('ok', false, 'reason', 'forbidden'); end if;
  return json_build_object('ok', true,
    'username',          (select value->>'username' from app_secrets where key = 'admin_username'),
    'email',             (select value->>'email' from app_secrets where key = 'admin_email'),
    'email_verified',    coalesce((select (value->>'verified')::boolean from app_secrets where key = 'admin_email_verified'), false),
    'last_verified_at',  (select (value->>'at')::bigint from app_secrets where key = 'admin_last_verified_at'),
    'has_backup_code',   exists (select 1 from app_secrets where key = 'admin_backup_code_hash'),
    'password_is_bcrypt', exists (select 1 from app_secrets where key = 'admin_password_hash'));
end $$;

create or replace function public.set_my_account(p_session_token text, p_email text default null,
  p_email_verified boolean default null, p_last_verified_at bigint default null) returns json
language plpgsql security definer set search_path = public, extensions, pg_catalog as $$
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
end $$;

-- Renames the account and moves every row scoped to it, in one transaction; returns a token for the new name.
-- (Previously a rename only changed the client's scope and stranded the data under the old name.)
create or replace function public.rename_my_account(p_session_token text, p_new_username text) returns json
language plpgsql security definer set search_path = public, extensions, pg_catalog as $$
declare
  v_subject text := _verify_session_token(p_session_token);
  v_old text; v_new text := trim(p_new_username); v_exp timestamptz := now() + interval '12 hours';
begin
  if v_subject not like 'admin:%' then return json_build_object('ok', false, 'reason', 'forbidden'); end if;
  v_old := substring(v_subject from 7);
  if v_new is null or length(v_new) < 2 or length(v_new) > 64 or v_new ~ '[.:/\s]' then
    return json_build_object('ok', false, 'reason', 'invalid_username');
  end if;
  if v_new <> v_old then
    update app_secrets set value = jsonb_build_object('username', v_new), updated_at = now() where key = 'admin_username';
    update tasks set device_id = 'user:' || v_new where device_id = 'user:' || v_old;
    update history set device_id = 'user:' || v_new where device_id = 'user:' || v_old;
    update favorites set device_id = 'user:' || v_new where device_id = 'user:' || v_old;
    update presets set device_id = 'user:' || v_new where device_id = 'user:' || v_old;
    update settings set device_id = 'user:' || v_new where device_id = 'user:' || v_old;
    update sync_tombstones set device_id = 'user:' || v_new where device_id = 'user:' || v_old;
    update user_secrets set device_id = 'user:' || v_new where device_id = 'user:' || v_old;
    update data_backups set username = 'user:' || v_new where username = 'user:' || v_old;
  end if;
  return json_build_object('ok', true, 'username', v_new,
    'token', _sign_session_token('admin:' || v_new, v_exp), 'expires_at', extract(epoch from v_exp)::bigint);
end $$;

grant execute on function public.verify_admin(text, text) to anon, authenticated;
grant execute on function public.unlock_admin_with_backup_code(text, text) to anon, authenticated;
grant execute on function public.set_admin_backup_code(text, text) to anon, authenticated;
grant execute on function public.get_my_account(text) to anon, authenticated;
grant execute on function public.set_my_account(text, text, boolean, bigint) to anon, authenticated;
grant execute on function public.rename_my_account(text, text) to anon, authenticated;

-- ─── Uploads go to the public `generations` bucket instead of WaveSpeed's key-gated upload API ─────────
update storage.buckets
   set allowed_mime_types = array(select distinct unnest(coalesce(allowed_mime_types, '{}') || array[
     'image/gif', 'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/mp4', 'audio/x-m4a',
     'audio/aac', 'audio/ogg', 'audio/webm', 'audio/flac', 'video/x-matroska']))
 where id = 'generations';
