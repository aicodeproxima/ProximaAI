-- An upsert must not move an existing row to another scope (review wf_8443c1d0-93e, 2026-10-20). After a rename on
-- device A moved every row to "user:<new>", device B — still signed in under the old name until its next
-- token-checked call — saw its scope empty and re-uploaded its local rows with device_id "user:<old>". The
-- upsert (ON CONFLICT (id) DO UPDATE) took them away from the new scope, A uploaded them back, and the two
-- devices moved the same rows back and forth. Only rename_my_account may change a row's scope; it sets the
-- transaction-local flag proxima.rescope. (Restore uses delete + insert and is unaffected.)

create or replace function public._rows_keep_owner() returns trigger
language plpgsql set search_path = public, pg_catalog as $$
begin
  if new.device_id is distinct from old.device_id and coalesce(current_setting('proxima.rescope', true), '') <> 'on' then
    new.device_id := old.device_id;   -- silent: the caller's upsert still succeeds, so its retry queue settles
  end if;
  return new;
end $$;
revoke execute on function public._rows_keep_owner() from public, anon, authenticated;

drop trigger if exists tasks_keep_owner on public.tasks;
create trigger tasks_keep_owner before update on public.tasks for each row execute function public._rows_keep_owner();
drop trigger if exists history_keep_owner on public.history;
create trigger history_keep_owner before update on public.history for each row execute function public._rows_keep_owner();
drop trigger if exists favorites_keep_owner on public.favorites;
create trigger favorites_keep_owner before update on public.favorites for each row execute function public._rows_keep_owner();

-- rename_my_account: same as 20261020000005 plus the rescope flag.
create or replace function public.rename_my_account(p_session_token text, p_current_password text, p_new_username text) returns json
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
    perform set_config('proxima.rescope', 'on', true);
    update app_secrets set value = jsonb_build_object('username', v_new), updated_at = now() where key = 'admin_username';
    update tasks set device_id = 'user:' || v_new where device_id = 'user:' || v_old;
    update history set device_id = 'user:' || v_new where device_id = 'user:' || v_old;
    update favorites set device_id = 'user:' || v_new where device_id = 'user:' || v_old;
    update presets set device_id = 'user:' || v_new where device_id = 'user:' || v_old;
    update settings set device_id = 'user:' || v_new where device_id = 'user:' || v_old;
    update sync_tombstones set device_id = 'user:' || v_new where device_id = 'user:' || v_old;
    update user_secrets set device_id = 'user:' || v_new where device_id = 'user:' || v_old;
    update data_backups set username = 'user:' || v_new where username = 'user:' || v_old;
    perform set_config('proxima.rescope', 'off', true);
  end if;
  return json_build_object('ok', true, 'username', v_new,
    'token', _sign_session_token('admin:' || v_new, v_exp), 'expires_at', extract(epoch from v_exp)::bigint);
end $$;
