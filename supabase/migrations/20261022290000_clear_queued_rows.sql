-- Review round 8 (2026-10-22): Clear Logs, Clear Outputs and Reset cleared the account with plain scoped deletes
-- (clearTasksRemote / clearHistoryRemote), unchecked against restores: a restore landing between queueing the clear and
-- sending it was wiped again. clear_queued_rows clears every row of one kind of this account under the same rules as a
-- replayed delete (delete_queued_rows): the account's restore marker is taken first (FOR SHARE), the session checked
-- again, and a clear queued before the last restore is voided. For tasks, the History half runs in the same
-- transaction (the strip and drop-emptied triggers, as in 20261022280000). Tests: test-queued-deletes-db.sql case
-- clear-queued.
create or replace function public.clear_queued_rows(p_session_token text, p_kind text, p_queued_at bigint)
returns json language plpgsql security definer set search_path = public, pg_catalog as $$
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
    raise exception 'clear_queued_rows: unknown kind %', p_kind;
  end if;
  insert into settings (device_id, key, value) values (v_user, 'last_restore_at', '0'::jsonb) on conflict (device_id, key) do nothing;
  select coalesce((value #>> '{}')::bigint, 0) into v_restore
    from settings where device_id = v_user and key = 'last_restore_at' for share;
  perform public._verify_session_token(p_session_token);   -- again, now that the marker is held: a rename may have run
  if coalesce(p_queued_at, 0) < coalesce(v_restore, 0) then
    return json_build_object('ok', true, 'voided', true, 'deleted', 0);
  end if;
  if p_kind = 'task' then
    delete from tasks where device_id = v_user;
    get diagnostics v_n = row_count;
    -- Every generation is gone: their History items go in this transaction too (strip + drop emptied).
    update history h set tasks = h.tasks where h.device_id = v_user and jsonb_typeof(h.tasks) = 'array';
  else
    delete from history where device_id = v_user;
    get diagnostics v_n = row_count;
  end if;
  return json_build_object('ok', true, 'voided', false, 'deleted', v_n);
end $$;
revoke execute on function public.clear_queued_rows(text, text, bigint) from public;
grant execute on function public.clear_queued_rows(text, text, bigint) to anon, authenticated, service_role;
