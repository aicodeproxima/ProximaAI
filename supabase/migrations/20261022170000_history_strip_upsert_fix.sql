-- Review round 2 (wf_31b1b0e0-bbb, 2026-10-22): the app saves History with PostgREST upserts (INSERT ... ON CONFLICT
-- DO UPDATE), which fire the BEFORE INSERT trigger first even when the row exists. 20261022150000's "every item
-- deleted: skip and tombstone" branch therefore ran on an existing entry: it tombstoned a LIVE row and skipped the
-- write, and the drop-emptied path never ran. Now it skips and tombstones only a brand-new row; for an existing one
-- the emptied payload goes on to the ON CONFLICT update, and history_drop_emptied deletes the row the normal way
-- (tombstone and backup-scrub triggers included).
create or replace function public._history_strip_deleted_items() returns trigger
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_tasks jsonb;
begin
  if coalesce(current_setting('proxima.restore', true), '') = 'on' or coalesce(jsonb_typeof(new.tasks), '') <> 'array' then
    return new;
  end if;
  if not exists (select 1 from jsonb_array_elements(new.tasks) e
                   join sync_tombstones st on st.id = e->>'id' and st.kind = 'task' and not st.by_restore) then
    return new;
  end if;
  select coalesce(jsonb_agg(x.e order by x.o), '[]'::jsonb) into v_tasks
    from jsonb_array_elements(new.tasks) with ordinality x(e, o)
   where not exists (select 1 from sync_tombstones st where st.id = x.e->>'id' and st.kind = 'task' and not st.by_restore);
  if tg_op = 'INSERT' and jsonb_array_length(v_tasks) = 0 and not exists (select 1 from history h where h.id = new.id) then
    insert into sync_tombstones (id, kind, device_id, deleted_at, by_restore)
      values (new.id, 'history', new.device_id, now(), false)
      on conflict (id) do update set kind = excluded.kind, device_id = excluded.device_id, deleted_at = excluded.deleted_at,
                                     by_restore = false;
    return null;
  end if;
  new.tasks := v_tasks;
  new.total_cost := (select coalesce(sum(case when jsonb_typeof(e->'cost') = 'number' then (e->>'cost')::numeric else 0 end), 0)
                       from jsonb_array_elements(v_tasks) e where e->>'status' = 'completed');
  return new;
end $$;
revoke execute on function public._history_strip_deleted_items() from public, anon, authenticated;
