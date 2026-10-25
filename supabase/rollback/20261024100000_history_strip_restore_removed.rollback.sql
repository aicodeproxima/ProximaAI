-- Rollback of supabase/migrations/20261024100000_history_strip_restore_removed.sql: the definition of
-- public._history_strip_deleted_items() live before it (captured from the live database 2026-10-23, = 20261023500000's),
-- with one change: the History tombstone's conflict target is (device_id, id), the key sync_tombstones has had since
-- 20261025300000_mu_p4_tombstone_key (P4, applied 2026-10-25 20:20:13 UTC). The 2026-10-23 text named the id column
-- alone, which fails with 42P10 on the P4 key (review round 30 #4/#5).
-- Refuses unless the live function is the one P4 left (K2's body with P4's conflict target, md5 0a136484): roll back
-- anything applied after P4 that changed this function first. To roll back P4 itself, use P4's own rollback (it restores
-- K2's body and the id-only key), then this file no longer applies.
-- It also removes the migration's schema_migrations record. Run with sb-query.mjs --write -f (one transaction).
-- Proof (rolled back): node scripts/tools/sql-tx.mjs supabase/rollback/20261024100000_history_strip_restore_removed.rollback.sql --test scripts/test-history-emptied-db.sql
do $guard$
declare got text := md5(pg_get_functiondef('public._history_strip_deleted_items()'::regprocedure));
begin
  if got is distinct from '0a136484d6d3e9f4bed82d04221fe401' then
    raise exception '20261024100000 rollback: _history_strip_deleted_items is not the body P4 left (live %, expected 0a136484)', got;
  end if;
end $guard$;
CREATE OR REPLACE FUNCTION public._history_strip_deleted_items()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_tasks jsonb;
begin
  if coalesce(current_setting('proxima.restore', true), '') = 'on' or coalesce(jsonb_typeof(new.tasks), '') <> 'array' then
    return new;
  end if;
  if not exists (select 1 from jsonb_array_elements(new.tasks) e
                   join sync_tombstones st on st.id = e->>'id' and st.kind = 'task' and not st.by_restore
                                          and st.device_id = new.device_id) then
    return new;
  end if;
  select coalesce(jsonb_agg(x.e order by x.o), '[]'::jsonb) into v_tasks
    from jsonb_array_elements(new.tasks) with ordinality x(e, o)
   where not exists (select 1 from sync_tombstones st where st.id = x.e->>'id' and st.kind = 'task' and not st.by_restore
                        and st.device_id = new.device_id);
  if tg_op = 'INSERT' and jsonb_array_length(v_tasks) = 0 and not exists (select 1 from history h where h.id = new.id) then
    insert into sync_tombstones (id, kind, device_id, deleted_at, by_restore)
      values (new.id, 'history', new.device_id, now(), false)
      on conflict (device_id, id) do update set kind = excluded.kind, device_id = excluded.device_id, deleted_at = excluded.deleted_at,
                                     by_restore = false
        where sync_tombstones.device_id = excluded.device_id;
    return null;
  end if;
  new.tasks := v_tasks;
  new.total_cost := (select coalesce(sum(case when jsonb_typeof(e->'cost') = 'number' then (e->>'cost')::numeric else 0 end), 0)
                       from jsonb_array_elements(v_tasks) e where e->>'status' = 'completed');
  return new;
end $function$;

delete from supabase_migrations.schema_migrations where version = '20261024100000' and name = 'history_strip_restore_removed';
