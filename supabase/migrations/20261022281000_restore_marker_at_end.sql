-- Review round 8 (2026-10-22): the restore stamped last_restore_at with now(), the transaction's START. A delete queued
-- while a long restore ran (verify, marker wait, pre-restore snapshot, replacing up to 500 tasks and 1000 entries) was
-- stamped after that value, so delete_queued_rows, waiting on the marker, did not void it and deleted what the restore
-- had just brought back. The marker is now stamped with clock_timestamp(), and stamped again as the restore's last
-- statement (after the backups-OFF scrub), so any intent queued before the restore finished its work is voided. Body:
-- the live definition with only these edits; grants kept. Test: test-restore-scrub-db.sql case marker-at-commit.

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
  v_rt text[]; v_rl text[]; v_prev_items text[];
begin
  -- Restores and replayed deletes take this account's restore marker first (delete_queued_rows): a delete queued before
  -- this restore waits for it and is then refused; it can never run in the middle of it.
  insert into settings (device_id, key, value) values (v_username, 'last_restore_at', '0'::jsonb) on conflict (device_id, key) do nothing;
  perform 1 from settings where device_id = v_username and key = 'last_restore_at' for update;
  perform public._verify_session_token(p_session_token);   -- again, now that the marker is held: a rename may have moved the account
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
    -- The History item ids before the replacement (a History-only generation the restore drops is replaced too).
    v_prev_items := array(select distinct e.item->>'id' from history h,
                      jsonb_array_elements(case when jsonb_typeof(h.tasks) = 'array' then h.tasks else '[]'::jsonb end) e(item)
                     where h.device_id = v_username and coalesce(e.item->>'id', '') <> '');
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
    insert into settings (device_id, key, value) values (v_username, 'last_restore_at', to_jsonb((extract(epoch from clock_timestamp()) * 1000)::bigint))
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
    v_rt := v_rt || array(select x from unnest(coalesce(v_prev_items, '{}')) x
                          where not exists (select 1 from tasks t where t.id = x) and not (x = any(v_rt)));
    v_rl := array(select st.id from sync_tombstones st where st.device_id = v_username and st.kind = 'history'
                    and st.by_restore and st.deleted_at = now() and not exists (select 1 from history h where h.id = st.id));
    if cardinality(v_rt) > 0 or cardinality(v_rl) > 0 then
      insert into backup_scrub_queue (username, task_ids, log_ids) values (v_username, v_rt, v_rl);
      perform public._drain_backup_scrubs(v_username);
    end if;
  end if;
  -- The clock at the restore's end (review round 8): intents queued while it ran are voided too.
  update settings set value = to_jsonb((extract(epoch from clock_timestamp()) * 1000)::bigint), updated_at = now()
   where device_id = v_username and key = 'last_restore_at';
  return json_build_object('ok', true, 'tasks_restored', v_tasks, 'history_restored', v_history, 'favorites_restored', v_favorites);
end $function$;
