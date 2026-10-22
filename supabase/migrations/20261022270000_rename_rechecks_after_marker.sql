-- Review round 7 (2026-10-22): rename_my_account verified the session only before taking the account's restore marker.
-- Two renames submitted from two devices at about the same time: the second waited behind the first, then moved the
-- (already moved, so now absent) rows and set the login to its own new name, leaving the data under the first new name.
-- Like delete_queued_rows and the restore (20261022260000), the rename now verifies the session again once the marker is
-- held (the first rename revoked the old name's tokens), so the second fails and rolls back. Body: the live definition
-- with only this edit; grants kept. Test: test-queued-deletes-db.sql case recheck-after-lock.

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
end $function$;
