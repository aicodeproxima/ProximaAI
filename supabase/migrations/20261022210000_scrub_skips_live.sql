-- Review round 3 (2026-10-22): the backup scrub must never remove what is still live. history_queue_item_scrub queues
-- every item an update drops, so a stale History rewrite (queued on a device before a restore brought the generation
-- back) made the drain scrub a live generation from every backup. The drain now skips queued task ids whose tasks row
-- exists, History entry ids whose row exists, and outputs a live task or History entry of the account still names. A
-- real delete loses nothing: the delete itself removes the row before the drain runs (the tasks/history delete
-- triggers queue in the delete's own transaction). As 20261021175200 otherwise. Tests: scripts/test-scrub-live-db.sql.
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
      -- Only what is gone: a live generation, entry or output keeps its backup copies.
      v_t := array(select x from unnest(v_t) x where not exists (select 1 from tasks t where t.id = x));
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
