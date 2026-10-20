-- Review wf_d4a468a3-746 (2026-10-20), findings #2 and #3. Since running tasks travel between devices (7d7449a):
--
-- #2 A task (or History entry) deleted on one device came back when another device finished it before reconciling:
--    its upsert re-inserted the row and the untombstone trigger cleared the tombstone. A tombstoned id is now never
--    re-inserted, except by restore_my_backup_phase2, which sets proxima.restore for its own transaction (the same
--    pattern as rename_my_account's proxima.rescope). Silent (the row is skipped), so the caller's retry queue settles.
-- #3 A second device's late outcome overwrote the result another device had saved: a cancel or stale failure replaced
--    "completed", and a late poll swapped archived outputs (our storage) back to WaveSpeed's temporary URLs. Now a
--    completed row stays completed, and archived outputs stay archived.

create or replace function public._rows_not_tombstoned() returns trigger
language plpgsql security definer set search_path = public, pg_catalog as $$
begin
  if coalesce(current_setting('proxima.restore', true), '') <> 'on'
     and exists (select 1 from sync_tombstones where id = new.id and kind = tg_argv[0]) then
    return null;
  end if;
  return new;
end $$;
revoke execute on function public._rows_not_tombstoned() from public, anon, authenticated;

drop trigger if exists tasks_not_tombstoned on public.tasks;
create trigger tasks_not_tombstoned before insert on public.tasks
  for each row execute function public._rows_not_tombstoned('task');
drop trigger if exists history_not_tombstoned on public.history;
create trigger history_not_tombstoned before insert on public.history
  for each row execute function public._rows_not_tombstoned('history');

-- Outputs that point at our own archive (the "generations" bucket) instead of WaveSpeed's temporary URLs.
create or replace function public._outputs_archived(o jsonb) returns boolean
language sql immutable set search_path = public, pg_catalog as $$
  select case when jsonb_typeof(o) = 'array'
    then exists (select 1 from jsonb_array_elements_text(o) u where u like '%/storage/v1/object/public/generations/%')
    else false end
$$;

create or replace function public._tasks_keep_finished() returns trigger
language plpgsql set search_path = public, pg_catalog as $$
begin
  if old.status in ('completed', 'failed') and new.status in ('pending', 'processing') then
    return old;
  end if;
  -- A result stands: a cancel or a late failure from another device never replaces it.
  if old.status = 'completed' and new.status = 'failed' then
    return old;
  end if;
  -- Archived outputs are never swapped back to WaveSpeed's temporary URLs by a late poll.
  if old.status = 'completed' and new.status = 'completed'
     and public._outputs_archived(old.outputs) and not public._outputs_archived(new.outputs) then
    new.outputs := old.outputs;
  end if;
  return new;
end $$;
revoke execute on function public._tasks_keep_finished() from public, anon, authenticated;

-- Same body as before (20261020000006), plus the proxima.restore flag around its re-inserts.
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
begin
  select * into v_backup from data_backups where id = p_backup_id and username = v_username;
  if not found then return json_build_object('ok', false, 'reason', 'backup_not_found'); end if;
  begin
    insert into data_backups (id, username, backup_type, task_count, history_count, settings_snapshot,
                              favorites_snapshot, tasks_snapshot, history_snapshot, note)
    select gen_random_uuid(), v_username, 'pre-restore',
      (select count(*) from tasks where device_id = v_username),
      (select count(*) from history where device_id = v_username),
      coalesce((select jsonb_object_agg(key, value) from settings where device_id = v_username), '{}'::jsonb),
      coalesce((select jsonb_agg(row_to_json(f)) from (select * from favorites where device_id = v_username) f), '[]'::jsonb),
      coalesce((select jsonb_agg(row_to_json(t)) from (select * from tasks where device_id = v_username order by start_time desc limit 500) t), '[]'::jsonb),
      coalesce((select jsonb_agg(row_to_json(h)) from (select * from history where device_id = v_username order by timestamp desc limit 1000) h), '[]'::jsonb),
      'auto safety snapshot before restoring backup ' || p_backup_id::text;
    delete from tasks where device_id = v_username;
    delete from history where device_id = v_username;
    delete from favorites where device_id = v_username;
    delete from settings where device_id = v_username;
    -- The deletes above tombstone every row; the restore deliberately brings them back.
    perform set_config('proxima.restore', 'on', true);
    insert into tasks select * from jsonb_populate_recordset(null::tasks, (
      select coalesce(jsonb_agg(e || jsonb_build_object('device_id', v_username)), '[]'::jsonb)
        from jsonb_array_elements(case when jsonb_typeof(v_backup.tasks_snapshot) = 'array' then v_backup.tasks_snapshot else '[]'::jsonb end) e));
    get diagnostics v_tasks = row_count;
    insert into history select * from jsonb_populate_recordset(null::history, (
      select coalesce(jsonb_agg(e || jsonb_build_object('device_id', v_username)), '[]'::jsonb)
        from jsonb_array_elements(case when jsonb_typeof(v_backup.history_snapshot) = 'array' then v_backup.history_snapshot else '[]'::jsonb end) e));
    get diagnostics v_history = row_count;
    perform set_config('proxima.restore', 'off', true);
    insert into favorites select * from jsonb_populate_recordset(null::favorites, (
      select coalesce(jsonb_agg(e || jsonb_build_object('device_id', v_username)), '[]'::jsonb)
        from jsonb_array_elements(case when jsonb_typeof(v_backup.favorites_snapshot) = 'array' then v_backup.favorites_snapshot else '[]'::jsonb end) e));
    get diagnostics v_favorites = row_count;
    insert into settings (device_id, key, value)
      select v_username, k.key, k.value from jsonb_each(coalesce(v_backup.settings_snapshot, '{}'::jsonb)) k where k.key <> 'apiKey'
      on conflict (device_id, key) do update set value = excluded.value, updated_at = now();
  exception when others then
    perform set_config('proxima.restore', 'off', true);
    return json_build_object('ok', false, 'reason', sqlerrm);
  end;
  return json_build_object('ok', true, 'tasks_restored', v_tasks, 'history_restored', v_history, 'favorites_restored', v_favorites);
end $function$;
