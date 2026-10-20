-- Secrets lockdown, step 2: a stolen 12-hour session token must not be enough to take the account over.
-- Changing the password, the username or the backup code now needs the current password, and every wrong
-- password counts toward the same 3-attempt sign-in lockout. Also: backup listing returns summaries only,
-- and the WaveSpeed key can no longer land in the anon-readable settings table or in a backup snapshot.

-- ─── Re-auth helper (not callable by clients) ─────────────────────────────────────────────────────────
create or replace function public._reauth_admin(p_password text) returns text   -- 'ok' | 'invalid' | 'locked'
language plpgsql security definer set search_path = public, extensions, pg_catalog as $$
declare
  v_bcrypt text := (select value->>'password_hash' from app_secrets where key = 'admin_password_hash');
  v_legacy text := (select value->>'hash' from app_secrets where key = 'admin_password_hash_legacy_sha256');
  v_lock   jsonb;
  v_failed int;
begin
  insert into app_secrets (key, value, updated_at) values ('admin_login_lockout', '{"failed":0,"locked":false}', now())
    on conflict (key) do nothing;
  select value into v_lock from app_secrets where key = 'admin_login_lockout' for update;
  if coalesce((v_lock->>'locked')::boolean, false) then return 'locked'; end if;
  if p_password is not null and (
       (v_bcrypt is not null and crypt(p_password, v_bcrypt) = v_bcrypt)
    or (v_bcrypt is null and v_legacy is not null and encode(digest(p_password, 'sha256'), 'hex') = v_legacy)) then
    update app_secrets set value = '{"failed":0,"locked":false}', updated_at = now() where key = 'admin_login_lockout';
    return 'ok';
  end if;
  v_failed := coalesce((v_lock->>'failed')::int, 0) + 1;
  update app_secrets set updated_at = now(),
    value = jsonb_build_object('failed', v_failed, 'locked', v_failed >= 3, 'locked_at', case when v_failed >= 3 then now() end)
    where key = 'admin_login_lockout';
  return case when v_failed >= 3 then 'locked' else 'invalid' end;
end $$;
revoke all on function public._reauth_admin(text) from public, anon, authenticated;

-- ─── Change password (needs the current one) ───────────────────────────────────────────────────────────
create or replace function public.change_my_password(p_session_token text, p_current_password text, p_new_password text)
returns json language plpgsql security definer set search_path = public, extensions, pg_catalog as $$
declare v_subject text := _verify_session_token(p_session_token); v_auth text;
begin
  if v_subject not like 'admin:%' then return json_build_object('ok', false, 'reason', 'forbidden'); end if;
  if p_new_password is null or length(p_new_password) < 8 then return json_build_object('ok', false, 'reason', 'weak_password'); end if;
  v_auth := _reauth_admin(p_current_password);
  if v_auth <> 'ok' then return json_build_object('ok', false, 'reason', v_auth); end if;
  insert into app_secrets (key, value, updated_at)
    values ('admin_password_hash', jsonb_build_object('password_hash', crypt(p_new_password, gen_salt('bf', 12))), now())
    on conflict (key) do update set value = excluded.value, updated_at = now();
  delete from app_secrets where key = 'admin_password_hash_legacy_sha256';
  return json_build_object('ok', true);
end $$;

-- The sign-in upgrade path may only re-store the SAME password as bcrypt; it can no longer set a new one.
create or replace function public.set_admin_credentials_rehash(p_session_token text, p_plain_password text)
returns json language plpgsql security definer set search_path = public, extensions, pg_catalog as $$
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
end $$;

-- ─── Backup code and rename now need the current password ──────────────────────────────────────────────
drop function if exists public.set_admin_backup_code(text, text);
create function public.set_admin_backup_code(p_session_token text, p_current_password text, p_code text) returns json
language plpgsql security definer set search_path = public, extensions, pg_catalog as $$
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
end $$;

drop function if exists public.rename_my_account(text, text);
create function public.rename_my_account(p_session_token text, p_current_password text, p_new_username text) returns json
language plpgsql security definer set search_path = public, extensions, pg_catalog as $$
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

-- ─── Backup list: summaries only (the old version returned whole snapshots) ───────────────────────────
drop function if exists public.list_my_backups_phase2(text, integer);
create function public.list_my_backups_phase2(p_session_token text, p_limit integer default 20)
returns table (id uuid, backup_type text, task_count integer, history_count integer, note text, created_at timestamptz)
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_subject text := _verify_session_token(p_session_token);
  v_username text := case when v_subject like 'admin:%' then 'user:' || substring(v_subject from 7) else v_subject end;
begin
  return query select b.id, b.backup_type, b.task_count, b.history_count, b.note, b.created_at
    from data_backups b where b.username = v_username order by b.created_at desc limit least(greatest(p_limit, 1), 100);
end $$;

grant execute on function public.change_my_password(text, text, text) to anon, authenticated;
grant execute on function public.set_admin_backup_code(text, text, text) to anon, authenticated;
grant execute on function public.rename_my_account(text, text, text) to anon, authenticated;
grant execute on function public.list_my_backups_phase2(text, integer) to anon, authenticated;

-- ─── The WaveSpeed key never lands in settings or in a snapshot again ─────────────────────────────────
-- A cached old client still syncs it; the row is skipped (no error, so its retry queue settles).
create or replace function public._settings_drop_secrets() returns trigger language plpgsql as $$
begin
  if new.key = 'apiKey' then return null; end if;
  return new;
end $$;
drop trigger if exists settings_drop_secrets on public.settings;
create trigger settings_drop_secrets before insert or update on public.settings
  for each row execute function public._settings_drop_secrets();

create or replace function public._backups_strip_secrets() returns trigger language plpgsql as $$
begin
  new.settings_snapshot := coalesce(new.settings_snapshot, '{}'::jsonb) - 'apiKey';
  return new;
end $$;
drop trigger if exists backups_strip_secrets on public.data_backups;
create trigger backups_strip_secrets before insert or update on public.data_backups
  for each row execute function public._backups_strip_secrets();
