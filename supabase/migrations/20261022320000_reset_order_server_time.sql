-- Review round 11 (2026-10-22), on 20261022310000:
-- 1. Clear Outputs / Reset took their snapshot from the device's clock estimate less 3 s. A stale offset (no fresh
--    sample on a slow link) could put it after the server's real time, so rows written during the read were cleared
--    unread; and the margin let a Reset keep settings this device wrote in those 3 s. server_time_ms gives the
--    server's time; the client snapshots from it (less 1 s for rows still being written, which the read cannot see),
--    and Reset bounds settings and favorites by the exact time (p_prefs_at): nothing else purges them, so no slack.
-- 2. reset_queued_rows cleared History before tasks, while every other path deletes tasks, then touches History: two
--    concurrent calls could deadlock. Tasks first now (which also tombstones the History-only generations of the
--    entries it then deletes).
-- Tests: test-queued-deletes-db.sql cases server-time, reset-order-prefs.
create or replace function public.server_time_ms(p_session_token text)
returns bigint language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_subject text := public._verify_session_token(p_session_token);
begin
  if v_subject not like 'admin:%' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return (extract(epoch from clock_timestamp()) * 1000)::bigint;
end $$;
revoke execute on function public.server_time_ms(text) from public;
grant execute on function public.server_time_ms(text) to anon, authenticated, service_role;

drop function if exists public.reset_queued_rows(text, bigint, text[], text[]);
create or replace function public.reset_queued_rows(p_session_token text, p_queued_at bigint, p_task_ids text[] default null,
                                                    p_history_ids text[] default null, p_prefs_at bigint default null)
returns json language plpgsql security definer set search_path = public, pg_catalog as $$
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
end $$;
revoke execute on function public.reset_queued_rows(text, bigint, text[], text[], bigint) from public;
grant execute on function public.reset_queued_rows(text, bigint, text[], text[], bigint) to anon, authenticated, service_role;
notify pgrst, 'reload schema';
