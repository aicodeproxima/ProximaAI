-- Review round 9 (2026-10-22), three findings on clear_queued_rows (20261022290000):
-- 1. It cleared every row of the account with no time bound: a generation another device started between the clear's
--    queue time and its RPC (or a frozen tab sending it on thaw) was deleted and tombstoned, though it was never part of
--    the clear. Now a clear takes the rows that existed when it was queued (created_at, server clock) plus every id the
--    clearing device named (p_ids: its clock estimate can trail the server's, and its own uploads may still have been in
--    flight). A row created later stays; the next explicit delete takes it.
-- 2. Clear Outputs left a History item in the cloud when this device held the task but its tasks row never reached the
--    cloud: no row was deleted, so no tombstone, so the strip trigger kept it. For tasks, a named id without a row that a
--    live History item of this account holds now gets a user tombstone (as delete_queued_rows), and the History touch
--    covers the entries holding any cleared or named id (instead of every entry).
-- 3. Reset cleared settings and favorites with plain REST deletes after its restore-checked clears: a restore landing
--    between them was wiped, restore marker included, and the reset's older intents then deleted what it restored. Kinds
--    'settings' and 'favorites' are restore-checked here; the settings clear keeps the restore marker and the form holds
--    (form-inputs:*), which are the server's and the other device's.
-- The old (text, text, bigint) signature is replaced: an older bundle's three named arguments resolve to this one (p_ids
-- defaults to null). Tests: test-queued-deletes-db.sql cases clear-queued, clear-bounded, clear-prefs.
drop function if exists public.clear_queued_rows(text, text, bigint);
create or replace function public.clear_queued_rows(p_session_token text, p_kind text, p_queued_at bigint, p_ids text[] default null)
returns json language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_subject text := public._verify_session_token(p_session_token);
  v_user    text;
  v_restore bigint;
  v_n       int := 0;
  v_upto    timestamptz := to_timestamp(coalesce(p_queued_at, 0) / 1000.0);
  v_ids     text[] := coalesce(p_ids, '{}');
  v_gone    text[];
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
  if p_kind = 'task' then
    with d as (delete from tasks where device_id = v_user and (created_at <= v_upto or id = any(v_ids)) returning id)
    select coalesce(array_agg(id), '{}') into v_gone from d;
    v_n := cardinality(v_gone);
    -- Named generations without a tasks row that live History holds: user tombstones, as delete_queued_rows records them.
    update sync_tombstones set by_restore = false, deleted_at = now()
     where device_id = v_user and kind = 'task' and id = any(v_ids) and coalesce(by_restore, false);
    insert into sync_tombstones (id, kind, device_id, deleted_at, by_restore)
    select x, 'task', v_user, now(), false from unnest(v_ids) x
     where not exists (select 1 from sync_tombstones st where st.id = x)
       and not exists (select 1 from tasks t where t.id = x)
       and x in (select e.item->>'id' from history h,
                   jsonb_array_elements(case when jsonb_typeof(h.tasks) = 'array' then h.tasks else '[]'::jsonb end) e(item)
                  where h.device_id = v_user and coalesce(e.item->>'id', '') <> '')
    on conflict (id) do nothing;
    -- Their History items go in this transaction too (strip + drop emptied), only in the entries that hold them.
    update history h set tasks = h.tasks
     where h.device_id = v_user and jsonb_typeof(h.tasks) = 'array'
       and exists (select 1 from jsonb_array_elements(h.tasks) e where e->>'id' = any(v_gone || v_ids));
  elsif p_kind = 'history' then
    delete from history where device_id = v_user and (created_at <= v_upto or id = any(v_ids));
    get diagnostics v_n = row_count;
  elsif p_kind = 'settings' then
    delete from settings where device_id = v_user and key <> 'last_restore_at' and key not like 'form-inputs:%';
    get diagnostics v_n = row_count;
  else
    delete from favorites where device_id = v_user and (created_at <= v_upto or id = any(v_ids));
    get diagnostics v_n = row_count;
  end if;
  return json_build_object('ok', true, 'voided', false, 'deleted', v_n);
end $$;
revoke execute on function public.clear_queued_rows(text, text, bigint, text[]) from public;
grant execute on function public.clear_queued_rows(text, text, bigint, text[]) to anon, authenticated, service_role;
notify pgrst, 'reload schema';
