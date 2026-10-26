-- Rollback of supabase/migrations/20261025820000_backups_hold_account_row.sql (exact inverse: the two bodies below are
-- the ones 20261025800000 installs). Kept OUT of supabase/migrations/. Run it before 20261025800000's rollback (whose md5
-- guard refuses while these bodies are in place).
set local lock_timeout = '2s';   -- a rollback that cannot take its locks within 2 s stops; a browser call is cancelled after 3 s

-- md5 guard: the bodies this file replaces must still be the ones 20261025820000 installed.
do $rbguard$
begin
  if md5(pg_get_functiondef('public.create_auto_backup()'::regprocedure)) = '47ed1202174aef4a2ec7ff4c0322b5f3'
     and md5(pg_get_functiondef('public.snapshot_my_data_phase2(text,text,text)'::regprocedure)) = '62f80166c1500e10b54c7ced6a6b7552' then
    raise exception 'refusing the 20261025820000 rollback: 20261025820000 is not applied (both bodies are the ones 20261025800000 installs)';
  end if;
  if md5(pg_get_functiondef('public.create_auto_backup()'::regprocedure)) <> '2ffb6515b113604f6fbc1ff7a1ba9ee4'
     or md5(pg_get_functiondef('public.snapshot_my_data_phase2(text,text,text)'::regprocedure)) <> '63d01fb0d9717f0b445bde46fc3b3f2a' then
    raise exception 'refusing the 20261025820000 rollback: a function it restores changed since the migration (write a new rollback from the live body)';
  end if;
end $rbguard$;

CREATE OR REPLACE FUNCTION public.create_auto_backup()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$ DECLARE rec RECORD; backup_count integer := 0; BEGIN
  -- 20261025800000: every account whose own switch is on (and that has generations), one at a time; one account's
  -- failure is logged and never stops the others' backups.
  FOR rec IN SELECT u.id, u.scope AS username FROM proxima_auth.users u WHERE u.auto_backups AND u.disabled_at IS NULL AND u.deleted_at IS NULL
    AND EXISTS (SELECT 1 FROM public.tasks t WHERE t.device_id = u.scope) ORDER BY u.scope LOOP BEGIN INSERT INTO public.data_backups (username, backup_type, task_count, history_count, settings_snapshot, favorites_snapshot, tasks_snapshot, history_snapshot) VALUES (rec.username, 'auto-2day', (SELECT count(*) FROM public.tasks WHERE device_id = rec.username), (SELECT count(*) FROM public.history WHERE device_id = rec.username), COALESCE((SELECT jsonb_object_agg(key, value) FROM public.settings WHERE device_id = rec.username AND key NOT LIKE 'form-inputs:%'), '{}'::jsonb), COALESCE((SELECT jsonb_agg(row_to_json(f.*)) FROM public.favorites f WHERE device_id = rec.username), '[]'::jsonb), COALESCE((SELECT jsonb_agg(row_to_json(t.*)) FROM (SELECT * FROM public.tasks WHERE device_id = rec.username ORDER BY start_time DESC LIMIT 500) t), '[]'::jsonb), COALESCE((SELECT jsonb_agg(row_to_json(h.*)) FROM (SELECT * FROM public.history WHERE device_id = rec.username ORDER BY timestamp DESC LIMIT 1000) h), '[]'::jsonb)); backup_count := backup_count + 1;
    EXCEPTION WHEN OTHERS THEN RAISE WARNING 'create_auto_backup: account % failed: % %', rec.id, sqlstate, sqlerrm; END; END LOOP; DELETE FROM public.data_backups WHERE id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY username ORDER BY created_at DESC) AS rn FROM public.data_backups WHERE backup_type = 'auto-2day') s WHERE rn > 30); RETURN backup_count; END; $function$;

CREATE OR REPLACE FUNCTION public.snapshot_my_data_phase2(p_session_token text, p_type text, p_note text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
DECLARE
  v_username text;
  v_id uuid := gen_random_uuid();
  v_tasks  jsonb;
  v_hist   jsonb;
  v_set    jsonb;
  v_fav    jsonb;
  v_ct     int;
  v_ch     int;
BEGIN
  v_username := (proxima_auth.current_account(p_session_token)).scope;
  IF v_username IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  IF coalesce(p_type, '') LIKE 'pre-%' AND NOT public._auto_backups_on(v_username) THEN   -- 20261025800000: this account's switch
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
    FROM settings WHERE device_id = v_username AND key NOT LIKE 'form-inputs:%';
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

set local lock_timeout to default;   -- for this file's statements only; run this rollback on its own

-- The migration's own record goes with it, in the same transaction, so a later apply re-applies it.
delete from supabase_migrations.schema_migrations where version = '20261025820000' and name = 'backups_hold_account_row';
