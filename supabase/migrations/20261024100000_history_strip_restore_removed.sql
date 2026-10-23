-- A restore wins over History uploads queued before it (simulator K2; review rounds 28-29 notes).
--
-- A History entry a device queued before a restore can land after it (the device was frozen, offline, or its upload was
-- still on the wire) and name generations the restore removed (their rows got by_restore tombstones). Those items came
-- back as History-only generations, after other devices had already decided the restore's outcome (owner ruling
-- 2026-10-23: a cancelled delete whose generation did not come back loses its files and WaveSpeed result): the item
-- showed a generation without its pictures.
--
-- _history_strip_deleted_items (the BEFORE INSERT/UPDATE trigger on history; restores bypass it with proxima.restore) now
-- also strips an item whose generation the restore removed (a by_restore task tombstone in the entry's scope) when the
-- stored copy of that entry does not hold it already: the upload is re-adding what the restore took away. An item the
-- stored entry already holds stays (round 5's rule: a restore that brought a generation back History-only keeps it on
-- every later write; scripts/test-history-strip-db.sql case 5). A NEW entry whose items were all stripped is not
-- inserted and gets a History tombstone, a restore's one (by_restore) when only restore removals stripped it (a user's
-- delete stays a user's).
--
-- The RLS session's review of this migration (2026-10-23) added two guards to the emptied-new-entry branch, which returns
-- NULL (so the row policies' WITH CHECK never runs for it): a browser role naming a scope other than its session's gets no
-- History tombstone written there (before, an unauthenticated caller could write them into any scope and learn which of
-- its ids were tombstoned: the History twin of the tasks oracle 20261023500000 closed), and the "no stored entry" check
-- is scoped (h.device_id = new.device_id), as every definer statement is per account.
--
-- Everything else is unchanged: user tombstones strip as before, the scope guard (st.device_id = new.device_id, from
-- 20261023500000), the total recomputation, SECURITY DEFINER, the trigger and its order.
--
-- Rollback: supabase/rollback/20261024100000_history_strip_restore_removed.rollback.sql (the definition live before it).
-- Tests: node scripts/tools/sql-tx.mjs supabase/migrations/20261024100000_history_strip_restore_removed.sql --test
--   scripts/test-history-strip-restore-db.sql   (and scripts/test-history-strip-db.sql must stay green with it)

create or replace function public._history_strip_deleted_items()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_catalog'
as $function$
declare
  v_tasks jsonb;
  v_have  text[];
  v_user  boolean;
begin
  if coalesce(current_setting('proxima.restore', true), '') = 'on' or coalesce(jsonb_typeof(new.tasks), '') <> 'array' then
    return new;
  end if;
  -- 20261024100000: the item ids the stored copy of this entry holds (an upsert's BEFORE INSERT sees the row it updates).
  -- Id-less items are left out (a NULL in the set made `id = any(...)` NULL: the strip was skipped; migration review).
  select coalesce(array_agg(e->>'id'), '{}') into v_have
    from history h,
         jsonb_array_elements(case when jsonb_typeof(h.tasks) = 'array' then h.tasks else '[]'::jsonb end) e
   where h.id = new.id and h.device_id = new.device_id and coalesce(e->>'id', '') <> '';
  -- Stripped: an item of a user's delete, or (20261024100000) of a restore's removal the stored entry does not hold.
  if not exists (select 1 from jsonb_array_elements(new.tasks) e
                   join sync_tombstones st on st.id = e->>'id' and st.kind = 'task' and st.device_id = new.device_id
                  where not st.by_restore or not ((e->>'id') = any (v_have))) then
    return new;
  end if;
  v_user := exists (select 1 from jsonb_array_elements(new.tasks) e
                      join sync_tombstones st on st.id = e->>'id' and st.kind = 'task' and not st.by_restore
                                             and st.device_id = new.device_id);
  select coalesce(jsonb_agg(x.e order by x.o), '[]'::jsonb) into v_tasks
    from jsonb_array_elements(new.tasks) with ordinality x(e, o)
   where not exists (select 1 from sync_tombstones st
                      where st.id = x.e->>'id' and st.kind = 'task' and st.device_id = new.device_id
                        and (not st.by_restore or not ((x.e->>'id') = any (v_have))));
  if tg_op = 'INSERT' and jsonb_array_length(v_tasks) = 0
     and not exists (select 1 from history h where h.id = new.id and h.device_id = new.device_id) then
    -- 20261024100000 (RLS session's review): this branch returns NULL, so the row policies' WITH CHECK never runs for it.
    -- A browser role (the role GUC: inside SECURITY DEFINER current_user is the owner) naming a scope other than its
    -- session's gets nothing written: it is refused with the policies' own errors (28000 / 42501). Before,
    -- any caller could write History tombstones into another scope and learn which of its ids are tombstoned there.
    -- It raises what the row policies would (28000 without a valid header, else 42501, same message), so a direct insert
    -- gets the same answer as any other refused row, and a SECURITY DEFINER caller (upsert_queued_history, where no
    -- policy runs) fails instead of storing an empty entry (migration review #2/#3).
    if coalesce(current_setting('role', true), 'none') in ('anon', 'authenticated')
       and new.device_id is distinct from proxima_auth.session_scope(false) then
      perform proxima_auth.session_scope(true);
      raise exception using errcode = '42501', message = 'new row violates row-level security policy for table "history"';
    end if;
    insert into sync_tombstones (id, kind, device_id, deleted_at, by_restore)
      values (new.id, 'history', new.device_id, now(), not v_user)
      on conflict (id) do update set kind = excluded.kind, device_id = excluded.device_id, deleted_at = excluded.deleted_at,
                                     by_restore = excluded.by_restore and sync_tombstones.by_restore
        where sync_tombstones.device_id = excluded.device_id;
    return null;
  end if;
  new.tasks := v_tasks;
  new.total_cost := (select coalesce(sum(case when jsonb_typeof(e->'cost') = 'number' then (e->>'cost')::numeric else 0 end), 0)
                       from jsonb_array_elements(v_tasks) e where e->>'status' = 'completed');
  return new;
end $function$;
