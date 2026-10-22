-- Review round 4 (2026-10-22): a generation is live while its tasks row exists, OR a live History entry still holds its
-- item and no user delete tombstoned it (a delete leaves its History item until a client rewrites the entry; a restore's
-- removals are tombstoned by_restore). A restore keeps at most 500 tasks rows but up to 1000 History entries, so older generations come back
-- History-only; the drain (20261022210000) checked only tasks and scrubbed them from every backup, the restored one
-- included, while live History still showed them. The drain now also skips ids a live History item holds. So that a
-- skipped id is never stranded, deleting a whole History entry now queues its item ids as well as the entry id (an item
-- rewrite already queues them, history_queue_item_scrub): when nothing live holds the generation any more, the next
-- drain scrubs it; a generation whose tasks row lives (Clear Logs) keeps its backup copies. Tests:
-- scripts/test-scrub-live-db.sql cases 4-6.

create or replace function public._drain_backup_scrubs(p_username text default null) returns integer
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_user text; v_t text[]; v_l text[]; v_o text[]; v_all boolean; v_n int := 0;
begin
  for v_user in select distinct q.username from backup_scrub_queue q where p_username is null or q.username = p_username loop
    begin
      with taken as (
        delete from backup_scrub_queue q where q.username = v_user
        returning q.task_ids, q.log_ids, q.outputs, q.all_tombstones)
      select coalesce((select array_agg(distinct x) from taken, unnest(taken.task_ids) x), '{}'),
             coalesce((select array_agg(distinct x) from taken, unnest(taken.log_ids) x), '{}'),
             coalesce((select array_agg(distinct x) from taken, unnest(taken.outputs) x), '{}'),
             coalesce((select bool_or(taken.all_tombstones) from taken), false)
        into v_t, v_l, v_o, v_all;
      if v_all then
        v_t := v_t || array(select st.id from sync_tombstones st
                             where st.device_id = v_user and st.kind = 'task'
                               and not exists (select 1 from tasks t where t.id = st.id));
        v_l := v_l || array(select st.id from sync_tombstones st
                             where st.device_id = v_user and st.kind = 'history'
                               and not exists (select 1 from history h where h.id = st.id));
      end if;
      -- Only what is gone: a generation (its tasks row, or an item of a live History entry), an entry or an output that
      -- is still live keeps its backup copies.
      v_t := array(select x from unnest(v_t) x where not exists (select 1 from tasks t where t.id = x)
                    and not (exists (select 1 from history h where h.device_id = v_user
                                             and h.tasks @> jsonb_build_array(jsonb_build_object('id', x)))
                             and not exists (select 1 from sync_tombstones st where st.device_id = v_user and st.kind = 'task'
                                                and st.id = x and not coalesce(st.by_restore, false))));
      v_l := array(select x from unnest(v_l) x where not exists (select 1 from history h where h.id = x));
      v_o := array(select o from unnest(v_o) o
                    where not exists (select 1 from tasks t where t.device_id = v_user and position(o in t.outputs::text) > 0)
                      and not exists (select 1 from history h where h.device_id = v_user and position(o in h.tasks::text) > 0));
      v_n := v_n + public._scrub_backups(v_user, v_t, v_l, v_o);
      if v_all then
        v_n := v_n + public._scrub_backups_to_live_items(v_user);
      end if;
    exception when others then
      update backup_scrub_queue set attempts = attempts + 1, last_error = left(sqlerrm, 500) where username = v_user;
    end;
  end loop;
  return v_n;
end $$;

create or replace function public._history_queue_backup_scrub() returns trigger
language plpgsql security definer set search_path = public, pg_catalog as $$
begin
  if coalesce(current_setting('proxima.restore', true), '') = 'on' or public._auto_backups_on() then return null; end if;
  insert into backup_scrub_queue (username, log_ids, task_ids)
  select g.device_id, array_agg(distinct g.id),
         coalesce(array_agg(distinct nullif(e.item->>'id', '')) filter (where coalesce(e.item->>'id', '') <> ''), '{}')
    from gone g
    left join lateral jsonb_array_elements(case when jsonb_typeof(g.tasks) = 'array' then g.tasks else '[]'::jsonb end) e(item) on true
   where g.device_id like 'user:%'
   group by g.device_id;
  return null;
end $$;
