-- "Delete means delete" (owner, 2026-10-21), review #4 (2026-10-22). A History entry that keeps an item whose task this
-- device lacks is rewritten instead of removed (batchLog.js purgeLogsForDeleted), so it has no tombstone. Without this
-- guard, a device waking with stale local tasks could finish it with the deleted items in it (open -> closed is allowed),
-- or the closed -> open guard of _history_keep_finished could keep the old copy, and the deleted items would return.
-- This trigger drops every item whose task was deleted (a kind='task' tombstone not left by a restore) from any History
-- insert or update, and recomputes total_cost as batchLog totalOf does. It fires after history_keep_finished,
-- history_keep_owner and history_not_tombstoned (BEFORE triggers run in name order). A restore re-inserts its snapshot
-- as it was: entries can list tasks beyond the backup's 500, which the restore tombstoned.
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
  new.tasks := v_tasks;
  new.total_cost := (select coalesce(sum(case when jsonb_typeof(e->'cost') = 'number' then (e->>'cost')::numeric else 0 end), 0)
                       from jsonb_array_elements(v_tasks) e where e->>'status' = 'completed');
  return new;
end $$;
revoke execute on function public._history_strip_deleted_items() from public, anon, authenticated;

drop trigger if exists history_strip_deleted_items on public.history;
create trigger history_strip_deleted_items before insert or update on public.history
  for each row execute function public._history_strip_deleted_items();
