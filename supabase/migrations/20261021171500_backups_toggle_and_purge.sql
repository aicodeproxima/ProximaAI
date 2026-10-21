-- Owner, 2026-10-21: "when i delete generations, thats supposed to reflect everywhere possible in one button. it
-- should not be recoverable anywhere so create a toggle for automatic backups and keep it off for now while still
-- giving me the option to turn it on and it function normally when on."
--
-- 1. An "Automatic backups" switch (app_secrets 'auto_backups', OFF by default). When off: the 2-day cron job, the
--    app's pre-* safety snapshots (before deletes / clears / resets) and the restore's pre-restore snapshot take no
--    copy. Manual snapshots the owner asks for still work. When on: everything behaves as before.
-- 2. purge_my_backups_of: removes deleted generations (and their History entries / items) from backups that already
--    exist, so a delete leaves no copy behind when the switch is off.
-- 3. Deleting a task row also deletes the webhook delivery kept for its prediction (outputs URLs), except during a
--    backup restore (which deletes and re-inserts every row).

insert into public.app_secrets (key, value, updated_at)
values ('auto_backups', jsonb_build_object('enabled', false), now())
on conflict (key) do nothing;

create or replace function public._auto_backups_on() returns boolean
language sql stable security definer set search_path = public, pg_catalog as $$
  select coalesce((select (value->>'enabled')::boolean from app_secrets where key = 'auto_backups'), false)
$$;
revoke execute on function public._auto_backups_on() from public, anon, authenticated;

create or replace function public.get_auto_backups(p_session_token text) returns boolean
language plpgsql security definer set search_path = public, pg_catalog as $$
begin
  perform public._verify_session_token(p_session_token);
  return public._auto_backups_on();
end $$;

create or replace function public.set_auto_backups(p_session_token text, p_enabled boolean) returns boolean
language plpgsql security definer set search_path = public, pg_catalog as $$
begin
  perform public._verify_session_token(p_session_token);
  insert into app_secrets (key, value, updated_at) values ('auto_backups', jsonb_build_object('enabled', coalesce(p_enabled, false)), now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
  return public._auto_backups_on();
end $$;
revoke execute on function public.get_auto_backups(text) from public;
revoke execute on function public.set_auto_backups(text, boolean) from public;
grant execute on function public.get_auto_backups(text) to anon, authenticated;
grant execute on function public.set_auto_backups(text, boolean) to anon, authenticated;

-- Removes the given tasks and History entries from every backup of the caller's account; History entries that are
-- kept lose the items of the given tasks. Counts are refreshed.
create or replace function public.purge_my_backups_of(p_session_token text, p_task_ids text[], p_log_ids text[])
returns json language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_subject  text := public._verify_session_token(p_session_token);
  v_username text := case when v_subject like 'admin:%' then 'user:' || substring(v_subject from 7) else v_subject end;
  v_tasks    text[] := coalesce(p_task_ids, '{}');
  v_logs     text[] := coalesce(p_log_ids, '{}');
  v_n        int;
begin
  update data_backups b set
    tasks_snapshot = coalesce((
      select jsonb_agg(e order by o) from jsonb_array_elements(case when jsonb_typeof(b.tasks_snapshot) = 'array' then b.tasks_snapshot else '[]'::jsonb end) with ordinality x(e, o)
       where not coalesce(e->>'id' = any(v_tasks), false)), '[]'::jsonb),
    history_snapshot = coalesce((
      select jsonb_agg(
               case when jsonb_typeof(e->'tasks') = 'array'
                 then jsonb_set(e, '{tasks}', coalesce((select jsonb_agg(i order by io) from jsonb_array_elements(e->'tasks') with ordinality y(i, io)
                                                         where not coalesce(i->>'id' = any(v_tasks), false)), '[]'::jsonb))
                 else e end
             order by o)
        from jsonb_array_elements(case when jsonb_typeof(b.history_snapshot) = 'array' then b.history_snapshot else '[]'::jsonb end) with ordinality x(e, o)
       where not coalesce(e->>'id' = any(v_logs), false)), '[]'::jsonb)
  where b.username = v_username;
  get diagnostics v_n = row_count;
  update data_backups b set
    task_count = jsonb_array_length(b.tasks_snapshot),
    history_count = jsonb_array_length(b.history_snapshot)
  where b.username = v_username;
  return json_build_object('ok', true, 'backups', v_n);
end $$;
revoke execute on function public.purge_my_backups_of(text, text[], text[]) from public;
grant execute on function public.purge_my_backups_of(text, text[], text[]) to anon, authenticated;

-- 2-day cron job: nothing while the switch is off.
CREATE OR REPLACE FUNCTION public.create_auto_backup()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$ DECLARE rec RECORD; backup_count integer := 0; BEGIN
  IF NOT public._auto_backups_on() THEN RETURN 0; END IF;
  FOR rec IN SELECT DISTINCT device_id AS username FROM public.tasks WHERE device_id LIKE 'user:%' LOOP INSERT INTO public.data_backups (username, backup_type, task_count, history_count, settings_snapshot, favorites_snapshot, tasks_snapshot, history_snapshot) VALUES (rec.username, 'auto-2day', (SELECT count(*) FROM public.tasks WHERE device_id = rec.username), (SELECT count(*) FROM public.history WHERE device_id = rec.username), COALESCE((SELECT jsonb_object_agg(key, value) FROM public.settings WHERE device_id = rec.username), '{}'::jsonb), COALESCE((SELECT jsonb_agg(row_to_json(f.*)) FROM public.favorites f WHERE device_id = rec.username), '[]'::jsonb), COALESCE((SELECT jsonb_agg(row_to_json(t.*)) FROM (SELECT * FROM public.tasks WHERE device_id = rec.username ORDER BY start_time DESC LIMIT 500) t), '[]'::jsonb), COALESCE((SELECT jsonb_agg(row_to_json(h.*)) FROM (SELECT * FROM public.history WHERE device_id = rec.username ORDER BY timestamp DESC LIMIT 1000) h), '[]'::jsonb)); backup_count := backup_count + 1; END LOOP; DELETE FROM public.data_backups WHERE id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY username ORDER BY created_at DESC) AS rn FROM public.data_backups WHERE backup_type = 'auto-2day') s WHERE rn > 30); RETURN backup_count; END; $function$;

-- App snapshots: the automatic pre-* ones (before deletes, clears, resets) only while the switch is on.
CREATE OR REPLACE FUNCTION public.snapshot_my_data_phase2(p_session_token text, p_type text, p_note text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
DECLARE
  v_subject text;
  v_username text;
  v_id uuid := gen_random_uuid();
  v_tasks  jsonb;
  v_hist   jsonb;
  v_set    jsonb;
  v_fav    jsonb;
  v_ct     int;
  v_ch     int;
BEGIN
  v_subject := public._verify_session_token(p_session_token);
  v_username := CASE WHEN v_subject LIKE 'admin:%' THEN 'user:' || substring(v_subject FROM 7) ELSE v_subject END;
  IF coalesce(p_type, '') LIKE 'pre-%' AND NOT public._auto_backups_on() THEN
    RETURN json_build_object('ok', true, 'skipped', true);
  END IF;

  SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
    INTO v_tasks
    FROM (SELECT * FROM tasks WHERE device_id = v_username ORDER BY start_time DESC LIMIT 500) t;
  SELECT COALESCE(jsonb_agg(row_to_json(h)), '[]'::jsonb)
    INTO v_hist
    FROM (SELECT * FROM history WHERE device_id = v_username ORDER BY timestamp DESC LIMIT 1000) h;
  SELECT COALESCE(jsonb_object_agg(key, value), '{}'::jsonb)
    INTO v_set
    FROM settings WHERE device_id = v_username;
  SELECT COALESCE(jsonb_agg(row_to_json(f)), '[]'::jsonb)
    INTO v_fav
    FROM (SELECT * FROM favorites WHERE device_id = v_username) f;   -- aliased now

  SELECT count(*) INTO v_ct FROM tasks WHERE device_id = v_username;
  SELECT count(*) INTO v_ch FROM history WHERE device_id = v_username;

  INSERT INTO data_backups (
    id, username, backup_type, task_count, history_count,
    settings_snapshot, favorites_snapshot, tasks_snapshot, history_snapshot, note
  ) VALUES (
    v_id, v_username, p_type, v_ct, v_ch,
    v_set, v_fav, v_tasks, v_hist, p_note
  );

  RETURN json_build_object('ok', true, 'id', v_id);
END;
$function$;

-- Restore: the pre-restore safety snapshot only while the switch is on; proxima.restore now covers the deletes too
-- (the webhook-delivery purge below must not run for a restore's delete-and-reinsert).
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
    if public._auto_backups_on() then
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
    end if;
    perform set_config('proxima.restore', 'on', true);
    delete from tasks where device_id = v_username;
    delete from history where device_id = v_username;
    delete from favorites where device_id = v_username;
    delete from settings where device_id = v_username;
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

-- A deleted generation leaves no webhook delivery behind (it holds the outputs' URLs).
create or replace function public._tasks_purge_webhook_events() returns trigger
language plpgsql security definer set search_path = public, pg_catalog as $$
begin
  if old.task_id is not null and coalesce(current_setting('proxima.restore', true), '') <> 'on' then
    delete from ws_webhook_events where task_id = old.task_id;
  end if;
  return old;
end $$;
revoke execute on function public._tasks_purge_webhook_events() from public, anon, authenticated;
drop trigger if exists tasks_purge_webhook_events on public.tasks;
create trigger tasks_purge_webhook_events after delete on public.tasks
  for each row execute function public._tasks_purge_webhook_events();
