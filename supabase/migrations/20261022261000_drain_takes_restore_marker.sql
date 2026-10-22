-- Review round 6 (2026-10-22): the backup-scrub drain (cron every minute, and inside restore and set_auto_backups)
-- deleted from backup_scrub_queue and updated data_backups before anything else, while rename_my_account (which takes
-- the account's restore marker first, 20261022250000) moves data_backups and the queue in the other order: the two
-- could deadlock. The drain now takes each account's restore marker (FOR SHARE) before touching its queue or backups,
-- the same order as restore, rename and replayed deletes. Inside a restore the marker is already held (FOR UPDATE), so
-- nothing waits. Body: the live definition with only this edit; grants kept. Test: scripts/test-queued-deletes-db.sql
-- case drain-marker-first.

CREATE OR REPLACE FUNCTION public._drain_backup_scrubs(p_username text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_user text; v_t text[]; v_l text[]; v_o text[]; v_all boolean; v_n int := 0;
begin
  for v_user in select distinct q.username from backup_scrub_queue q where p_username is null or q.username = p_username loop
    begin
      insert into settings (device_id, key, value) values (v_user, 'last_restore_at', '0'::jsonb) on conflict (device_id, key) do nothing;
      perform 1 from settings where device_id = v_user and key = 'last_restore_at' for share;   -- the account's restore marker first
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
                    and not (x in (select e.item->>'id' from history h,
                                     jsonb_array_elements(case when jsonb_typeof(h.tasks) = 'array' then h.tasks else '[]'::jsonb end) e(item)
                                    where h.device_id = v_user and coalesce(e.item->>'id', '') <> '')   -- no NULLs: x in (.., null) is never false
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
end $function$;
