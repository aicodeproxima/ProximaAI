-- Fixes from the adversarial review of the sign-in cut-over (2026-10-20).
--  * Sessions are revoked server-side: a token naming a renamed-away username, or issued before the last
--    password change / backup-code unlock, is refused everywhere (RPCs and, via get_my_wavespeed_key, the proxy).
--  * Five wrong backup codes now pause unlocking for 15 minutes instead of locking it until a database edit
--    (anyone can call the unlock RPC, so a permanent lock was a free way to lock the owner out for good).
--  * Restoring a backup re-scopes its rows to the current username (after a rename they used to land under the
--    old name, leaving the account empty), and a dead session reaches the client as an error, not {ok:false}.

-- ─── Token check with revocation ───────────────────────────────────────────────────────────────────────
create or replace function public._verify_session_token(p_token text) returns text
language plpgsql security definer set search_path = public, extensions, pg_catalog as $$
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
    -- previous signing key: 12 h grace window after a key rotation
    select value->>'key' into v_key_prev from app_secrets where key = 'session_signing_key_previous';
    if v_key_prev is not null and encode(hmac(v_msg, v_key_prev, 'sha256'), 'hex') = v_sig then v_ok := true; end if;
  end if;
  if not v_ok then raise exception 'invalid signature'; end if;

  -- Revocation. Tokens last 12 h, so issued-at = exp - 12 h.
  if v_subject like 'admin:%' then
    if substring(v_subject from 7) is distinct from (select value->>'username' from app_secrets where key = 'admin_username') then
      raise exception 'session token revoked';
    end if;
    select (value->>'at')::bigint into v_after from app_secrets where key = 'admin_sessions_valid_after';
    if v_after is not null and v_exp - 43200 < v_after then raise exception 'session token revoked'; end if;
  end if;
  return v_subject;
end $$;

create or replace function public._revoke_admin_sessions() returns void
language sql security definer set search_path = public, pg_catalog as $$
  insert into app_secrets (key, value, updated_at)
    values ('admin_sessions_valid_after', jsonb_build_object('at', extract(epoch from now())::bigint), now())
    on conflict (key) do update set value = excluded.value, updated_at = now();
$$;
revoke all on function public._revoke_admin_sessions() from public, anon, authenticated;

-- ─── Password change: signs out every other device, returns a fresh token for this one ─────────────────
create or replace function public.change_my_password(p_session_token text, p_current_password text, p_new_password text)
returns json language plpgsql security definer set search_path = public, extensions, pg_catalog as $$
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
end $$;

-- ─── Backup-code unlock: 5 wrong codes pause it for 15 minutes; success signs out every device ─────────
create or replace function public.unlock_admin_with_backup_code(p_code text, p_new_password text default null) returns json
language plpgsql security definer set search_path = public, extensions, pg_catalog as $$
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
end $$;

-- ─── Restore: rows re-scoped to the current user; token checked outside the catch-all ──────────────────
create or replace function public.restore_my_backup_phase2(p_session_token text, p_backup_id uuid)
returns json language plpgsql security definer set search_path = public, extensions, pg_catalog as $$
declare
  v_subject  text := _verify_session_token(p_session_token);   -- raises to the client (session expiry)
  v_username text := case when v_subject like 'admin:%' then 'user:' || substring(v_subject from 7) else v_subject end;
  v_backup   record;
  v_tasks int := 0; v_history int := 0; v_favorites int := 0;
begin
  select * into v_backup from data_backups where id = p_backup_id and username = v_username;
  if not found then return json_build_object('ok', false, 'reason', 'backup_not_found'); end if;
  begin
    -- Safety snapshot of the current state first (F.4.2).
    insert into data_backups (id, username, backup_type, task_count, history_count, settings_snapshot,
                              favorites_snapshot, tasks_snapshot, history_snapshot, note)
    select gen_random_uuid(), v_username, 'pre-restore',
      (select count(*) from tasks where device_id = v_username),
      (select count(*) from history where device_id = v_username),
      coalesce((select jsonb_object_agg(key, value) from settings where device_id = v_username), '{}'::jsonb),
      coalesce((select jsonb_agg(row_to_json(f)) from (select * from favorites where device_id = v_username) f), '[]'::jsonb),
      coalesce((select jsonb_agg(row_to_json(t)) from (select * from tasks where device_id = v_username order by start_time desc limit 500) t), '[]'::jsonb),
      coalesce((select jsonb_agg(row_to_json(h)) from (select * from history where device_id = v_username order by timestamp desc limit 1000) h), '[]'::jsonb),
      'auto safety snapshot before restoring backup ' || p_backup_id::text;

    delete from tasks where device_id = v_username;
    delete from history where device_id = v_username;
    delete from favorites where device_id = v_username;
    delete from settings where device_id = v_username;

    insert into tasks select * from jsonb_populate_recordset(null::tasks, (
      select coalesce(jsonb_agg(e || jsonb_build_object('device_id', v_username)), '[]'::jsonb)
        from jsonb_array_elements(case when jsonb_typeof(v_backup.tasks_snapshot) = 'array' then v_backup.tasks_snapshot else '[]'::jsonb end) e));
    get diagnostics v_tasks = row_count;
    insert into history select * from jsonb_populate_recordset(null::history, (
      select coalesce(jsonb_agg(e || jsonb_build_object('device_id', v_username)), '[]'::jsonb)
        from jsonb_array_elements(case when jsonb_typeof(v_backup.history_snapshot) = 'array' then v_backup.history_snapshot else '[]'::jsonb end) e));
    get diagnostics v_history = row_count;
    insert into favorites select * from jsonb_populate_recordset(null::favorites, (
      select coalesce(jsonb_agg(e || jsonb_build_object('device_id', v_username)), '[]'::jsonb)
        from jsonb_array_elements(case when jsonb_typeof(v_backup.favorites_snapshot) = 'array' then v_backup.favorites_snapshot else '[]'::jsonb end) e));
    get diagnostics v_favorites = row_count;
    insert into settings (device_id, key, value)
      select v_username, k.key, k.value from jsonb_each(coalesce(v_backup.settings_snapshot, '{}'::jsonb)) k where k.key <> 'apiKey'
      on conflict (device_id, key) do update set value = excluded.value, updated_at = now();
  exception when others then
    return json_build_object('ok', false, 'reason', sqlerrm);
  end;
  return json_build_object('ok', true, 'tasks_restored', v_tasks, 'history_restored', v_history, 'favorites_restored', v_favorites);
end $$;
