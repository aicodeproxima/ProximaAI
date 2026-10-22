-- Review wf_ec400a67-988 #8 (2026-10-22): the History strip (20261021175300) could leave an entry with no items: a
-- stale device rewrote an entry to just its other deleted generation, or another device's sync dropped the last item.
-- The row stayed with tasks [] and no tombstone, so the deleted batch's prompt and models showed in History on every
-- device for good. An entry is its generations: with none left it goes.
--   INSERT whose every item was a deleted generation: not inserted, and tombstoned (no device may upload it again).
--   UPDATE that leaves no items (the strip, or a client writing []): the row is deleted after the update, so the usual
--   tombstone and backup-scrub triggers run.
-- A restore (proxima.restore) re-inserts its snapshot as it was, as before.

-- As 20261021175300, plus the INSERT case above.
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
  if tg_op = 'INSERT' and jsonb_array_length(v_tasks) = 0 then
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

-- An entry an update left without items is deleted (the tombstone and backup-scrub triggers then run as for any delete).
create or replace function public._history_drop_emptied() returns trigger
language plpgsql security definer set search_path = public, pg_catalog as $$
begin
  if coalesce(current_setting('proxima.restore', true), '') = 'on' then
    return null;
  end if;
  if jsonb_typeof(new.tasks) = 'array' and jsonb_array_length(new.tasks) = 0
     and jsonb_typeof(old.tasks) = 'array' and jsonb_array_length(old.tasks) > 0 then
    delete from history where id = new.id;
  end if;
  return null;
end $$;
revoke execute on function public._history_drop_emptied() from public, anon, authenticated;

drop trigger if exists history_drop_emptied on public.history;
create trigger history_drop_emptied after update on public.history
  for each row execute function public._history_drop_emptied();
