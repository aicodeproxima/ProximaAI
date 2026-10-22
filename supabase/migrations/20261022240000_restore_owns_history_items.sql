-- Review round 5 (2026-10-22):
-- 1. A restore left the user tombstone of a generation it brought back History-only (the backup keeps 500 tasks rows but
--    up to 1000 entries). The backup scrub (20261022220000) then treated it as deleted, and switching Automatic backups
--    OFF, or the next History upload stripping it, erased it from every backup, the one just restored included. The
--    restore now turns those tombstones into restore removals (by_restore = true).
-- 2. The drain's live-History check ran a jsonb containment scan of the account's History per queued id (no index; the
--    restore drains inline under the anon 3 s statement timeout). It now reads the History item ids once per drain, as
--    a set (an uncorrelated IN, which Postgres hashes).
-- Bodies: the live restore (pg_get_functiondef) and the 20261022220000 drain, with only these edits. Grants are kept.
-- Tests: scripts/test-restore-scrub-db.sql case restored-history-only-kept; the drain suites.

CREATE OR REPLACE FUNCTION public.restore_my_backup_phase2(p_session_token text, p_backup_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
declare
  v_subject  text := _verify_session_token(p_session_token);
  v_username text := case when v_subject like 'admin:%' then 'user:' || substring(v_subject from 7) else v_subject end;
  v_backup   record;
  v_tasks int := 0; v_history int := 0; v_favorites int := 0;
  v_rt text[]; v_rl text[];
begin
  -- Restores and replayed deletes take this account's restore marker first (delete_queued_rows): a delete queued before
  -- this restore waits for it and is then refused; it can never run in the middle of it.
  insert into settings (device_id, key, value) values (v_username, 'last_restore_at', '0'::jsonb) on conflict (device_id, key) do nothing;
  perform 1 from settings where device_id = v_username and key = 'last_restore_at' for update;
  perform public._drain_backup_scrubs(v_username);
  if exists (select 1 from backup_scrub_queue q where q.username = v_username) then
    return json_build_object('ok', false, 'reason', 'Deleted items are still being removed from your backups. Try again in a minute.');
  end if;
  select * into v_backup from data_backups where id = p_backup_id and username = v_username;
  if not found then return json_build_object('ok', false, 'reason', 'backup_not_found'); end if;
  begin
    if public._auto_backups_on() then
      insert into data_backups (id, username, backup_type, task_count, history_count, settings_snapshot,
                                favorites_snapshot, tasks_snapshot, history_snapshot, note)
      select gen_random_uuid(), v_username, 'pre-restore',
        (select count(*) from tasks where device_id = v_username),
        (select count(*) from history where device_id = v_username),
        coalesce((select jsonb_object_agg(key, value) from settings where device_id = v_username and key not like 'form-inputs:%'), '{}'::jsonb),
        coalesce((select jsonb_agg(row_to_json(f)) from (select * from favorites where device_id = v_username) f), '[]'::jsonb),
        coalesce((select jsonb_agg(row_to_json(t)) from (select * from tasks where device_id = v_username order by start_time desc limit 500) t), '[]'::jsonb),
        coalesce((select jsonb_agg(row_to_json(h)) from (select * from history where device_id = v_username order by timestamp desc limit 1000) h), '[]'::jsonb),
        'auto safety snapshot before restoring backup ' || p_backup_id::text;
    end if;
    perform set_config('proxima.restore', 'on', true);
    delete from tasks where device_id = v_username;
    delete from history where device_id = v_username;
    delete from favorites where device_id = v_username;
    delete from settings where device_id = v_username and key not like 'form-inputs:%' and key <> 'last_restore_at';
    insert into tasks select * from jsonb_populate_recordset(null::tasks, (
      select coalesce(jsonb_agg(e || jsonb_build_object('device_id', v_username)), '[]'::jsonb)
        from jsonb_array_elements(case when jsonb_typeof(v_backup.tasks_snapshot) = 'array' then v_backup.tasks_snapshot else '[]'::jsonb end) e));
    get diagnostics v_tasks = row_count;
    insert into history select * from jsonb_populate_recordset(null::history, (
      select coalesce(jsonb_agg(e || jsonb_build_object('device_id', v_username)), '[]'::jsonb)
        from jsonb_array_elements(case when jsonb_typeof(v_backup.history_snapshot) = 'array' then v_backup.history_snapshot else '[]'::jsonb end) e));
    get diagnostics v_history = row_count;
    -- A generation this restore brings back in History is the restore's decision, not a user delete: an older user
    -- tombstone of its id becomes a restore removal (by_restore), so the backup scrub and the History strip treat
    -- it as live while History holds it (review round 5).
    update sync_tombstones st set by_restore = true
     where st.device_id = v_username and st.kind = 'task' and not coalesce(st.by_restore, false)
       and st.id in (select e.item->>'id' from history h,
                      jsonb_array_elements(case when jsonb_typeof(h.tasks) = 'array' then h.tasks else '[]'::jsonb end) e(item)
                     where h.device_id = v_username);
    perform set_config('proxima.restore', 'off', true);
    insert into favorites select * from jsonb_populate_recordset(null::favorites, (
      select coalesce(jsonb_agg(e || jsonb_build_object('device_id', v_username)), '[]'::jsonb)
        from jsonb_array_elements(case when jsonb_typeof(v_backup.favorites_snapshot) = 'array' then v_backup.favorites_snapshot else '[]'::jsonb end) e));
    get diagnostics v_favorites = row_count;
    insert into settings (device_id, key, value)
      select v_username, k.key, k.value from jsonb_each(coalesce(v_backup.settings_snapshot, '{}'::jsonb)) k where k.key <> 'apiKey' and k.key not like 'form-inputs:%' and k.key <> 'last_restore_at'
      on conflict (device_id, key) do update set value = excluded.value, updated_at = now();
    -- When this restore happened (epoch ms; after the snapshot's own settings, so an older value in it never wins):
    -- every device drops delete intents it queued before it (review round 2), so a clear still pending on the other
    -- device cannot delete what this restore brought back.
    insert into settings (device_id, key, value) values (v_username, 'last_restore_at', to_jsonb((extract(epoch from now()) * 1000)::bigint))
      on conflict (device_id, key) do update set value = excluded.value, updated_at = now();
  exception when others then
    perform set_config('proxima.restore', 'off', true);
    return json_build_object('ok', false, 'reason', sqlerrm);
  end;
  -- Owner ruling on review wf_ec400a67-988 #11 (2026-10-22, "Scrub them right away"): with Automatic backups off, the
  -- rows this restore replaced (its by_restore tombstones, stamped in this transaction, not live again) leave every
  -- backup now, as any delete would; the result never depends on a later toggle of the switch.
  if not public._auto_backups_on() then
    v_rt := array(select st.id from sync_tombstones st where st.device_id = v_username and st.kind = 'task'
                    and st.by_restore and st.deleted_at = now() and not exists (select 1 from tasks t where t.id = st.id));
    v_rl := array(select st.id from sync_tombstones st where st.device_id = v_username and st.kind = 'history'
                    and st.by_restore and st.deleted_at = now() and not exists (select 1 from history h where h.id = st.id));
    if cardinality(v_rt) > 0 or cardinality(v_rl) > 0 then
      insert into backup_scrub_queue (username, task_ids, log_ids) values (v_username, v_rt, v_rl);
      perform public._drain_backup_scrubs(v_username);
    end if;
  end if;
  return json_build_object('ok', true, 'tasks_restored', v_tasks, 'history_restored', v_history, 'favorites_restored', v_favorites);
end $function$;

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
end $$;
