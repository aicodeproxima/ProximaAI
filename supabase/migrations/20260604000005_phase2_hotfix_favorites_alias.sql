-- Phase 2 hotfix #3: alias `favorites` in snapshot/restore RPCs.
--
-- The previous migration's snapshot_my_data_phase2 and restore_my_backup_phase2
-- referenced `row_to_json(f)` against `FROM favorites` with NO alias, so `f`
-- was unresolvable. Smoke test caught it:
--   ERROR: 42703: column "f" does not exist
--
-- Tasks and history work fine because they use `FROM (SELECT ... FROM tasks)
-- t` and the alias is established. Fix favorites the same way for symmetry,
-- or just alias the direct FROM. We choose explicit alias for symmetry with
-- tasks/history.
--
-- This redefines the two functions wholesale. ALTER FUNCTION cannot change
-- function bodies.

CREATE OR REPLACE FUNCTION public.snapshot_my_data_phase2(
  p_session_token text,
  p_type          text,
  p_note          text DEFAULT NULL
) RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_catalog
AS $$
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
$$;

CREATE OR REPLACE FUNCTION public.restore_my_backup_phase2(
  p_session_token text,
  p_backup_id     uuid
) RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_catalog
AS $$
DECLARE
  v_subject text;
  v_username text;
  v_backup record;
  v_restored_tasks int := 0;
  v_restored_history int := 0;
  v_restored_favorites int := 0;
BEGIN
  v_subject := public._verify_session_token(p_session_token);
  v_username := CASE WHEN v_subject LIKE 'admin:%' THEN 'user:' || substring(v_subject FROM 7) ELSE v_subject END;

  SELECT * INTO v_backup FROM data_backups WHERE id = p_backup_id AND username = v_username;
  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'reason', 'backup_not_found');
  END IF;

  -- Take a safety snapshot of current state before destructive restore (F.4.2).
  INSERT INTO data_backups (id, username, backup_type, task_count, history_count,
                            settings_snapshot, favorites_snapshot, tasks_snapshot,
                            history_snapshot, note)
  SELECT gen_random_uuid(), v_username, 'pre-restore',
         (SELECT count(*) FROM tasks WHERE device_id = v_username),
         (SELECT count(*) FROM history WHERE device_id = v_username),
         COALESCE((SELECT jsonb_object_agg(key, value) FROM settings WHERE device_id = v_username), '{}'::jsonb),
         COALESCE((SELECT jsonb_agg(row_to_json(f)) FROM (SELECT * FROM favorites WHERE device_id = v_username) f), '[]'::jsonb),
         COALESCE((SELECT jsonb_agg(row_to_json(t)) FROM (SELECT * FROM tasks WHERE device_id = v_username ORDER BY start_time DESC LIMIT 500) t), '[]'::jsonb),
         COALESCE((SELECT jsonb_agg(row_to_json(h)) FROM (SELECT * FROM history WHERE device_id = v_username ORDER BY timestamp DESC LIMIT 1000) h), '[]'::jsonb),
         'auto safety snapshot before restoring backup ' || p_backup_id::text;

  -- Destructive restore.
  DELETE FROM tasks WHERE device_id = v_username;
  DELETE FROM history WHERE device_id = v_username;
  DELETE FROM favorites WHERE device_id = v_username;
  DELETE FROM settings WHERE device_id = v_username AND key <> 'apiKey';

  INSERT INTO tasks
    SELECT * FROM jsonb_populate_recordset(NULL::tasks, v_backup.tasks_snapshot);
  GET DIAGNOSTICS v_restored_tasks = ROW_COUNT;

  INSERT INTO history
    SELECT * FROM jsonb_populate_recordset(NULL::history, v_backup.history_snapshot);
  GET DIAGNOSTICS v_restored_history = ROW_COUNT;

  INSERT INTO favorites
    SELECT * FROM jsonb_populate_recordset(NULL::favorites, v_backup.favorites_snapshot);
  GET DIAGNOSTICS v_restored_favorites = ROW_COUNT;

  INSERT INTO settings (device_id, key, value)
    SELECT v_username, k.key, k.value
      FROM jsonb_each(v_backup.settings_snapshot) k
      WHERE k.key <> 'apiKey'
    ON CONFLICT (device_id, key) DO UPDATE
      SET value = EXCLUDED.value, updated_at = now();

  RETURN json_build_object(
    'ok', true,
    'tasks_restored', v_restored_tasks,
    'history_restored', v_restored_history,
    'favorites_restored', v_restored_favorites
  );
EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('ok', false, 'reason', SQLERRM);
END;
$$;
