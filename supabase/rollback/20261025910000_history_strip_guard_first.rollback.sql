-- Rollback for supabase/migrations/20261025910000_history_strip_guard_first.sql: drops history_0_scope_guard and its
-- function, and restores _history_strip_deleted_items as it was live before it (P4's, md5 0a136484), verbatim. Refuses
-- unless the live strip function is the one the migration installed.
-- Proof (rolled back): node scripts/tools/sql-tx.mjs supabase/migrations/20261025910000_history_strip_guard_first.sql supabase/rollback/20261025910000_history_strip_guard_first.rollback.sql --test scripts/test-history-strip-guard-rollback.sql
do $guard$
declare got text := md5(pg_get_functiondef('public._history_strip_deleted_items()'::regprocedure));
begin
  if got is distinct from '39186d4a0019a02770ca80d23c8c76bd' then
    raise exception '20261025910000 rollback: _history_strip_deleted_items is not the body the migration installed (live %)', got;
  end if;
end $guard$;

drop trigger history_0_scope_guard on public.history;
drop function public._history_browser_scope_guard();

CREATE OR REPLACE FUNCTION public._history_strip_deleted_items()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
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
      on conflict (device_id, id) do update set kind = excluded.kind, device_id = excluded.device_id, deleted_at = excluded.deleted_at,
                                     by_restore = excluded.by_restore and sync_tombstones.by_restore
        where sync_tombstones.device_id = excluded.device_id;
    return null;
  end if;
  new.tasks := v_tasks;
  new.total_cost := (select coalesce(sum(case when jsonb_typeof(e->'cost') = 'number' then (e->>'cost')::numeric else 0 end), 0)
                       from jsonb_array_elements(v_tasks) e where e->>'status' = 'completed');
  return new;
end $function$;

delete from supabase_migrations.schema_migrations where version = '20261025910000' and name = 'history_strip_guard_first';
