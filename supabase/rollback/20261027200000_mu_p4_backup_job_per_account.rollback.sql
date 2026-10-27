-- Rollback of supabase/migrations/20261027200000_mu_p4_backup_job_per_account.sql (exact inverse: the two function bodies
-- below are the live ones it replaced, saved byte for byte before it; the 2-day job gets its old command back, the
-- procedure and _auto_backup_one go, and so does the migration's record). Kept OUT of supabase/migrations/.
set local lock_timeout = '2s';   -- a rollback that cannot take its locks within 2 s stops; a browser call is cancelled after 3 s

-- md5 guard: what this file restores or removes must still be what 20261027200000 installed.
do $rbguard$
begin
  if to_regprocedure('public._auto_backup_job()') is null or to_regprocedure('public._auto_backup_one(uuid)') is null then
    raise exception 'refusing the 20261027200000 rollback: 20261027200000 is not applied (no public._auto_backup_job() or public._auto_backup_one(uuid))';
  end if;
  if md5(pg_get_functiondef('public._auto_backup_one(uuid)'::regprocedure)) <> '71cb213e018ea57ffae6842a5f123e08'
     or md5(pg_get_functiondef('public._auto_backup_job()'::regprocedure)) <> 'a321466c100e3d84384e678350ceb354'
     or md5(pg_get_functiondef('public.create_auto_backup()'::regprocedure)) <> '087fadb162e19d6cdd22ff690c85be20'
     or md5(pg_get_functiondef('public.snapshot_my_data_phase2(text,text,text)'::regprocedure)) <> '2de2e8f07c043d7c02a7f40da03eb9e3'
     or (select count(*) from cron.job where jobname = 'auto-backup-2day') <> 1
     or (select command from cron.job where jobname = 'auto-backup-2day') <> 'call public._auto_backup_job()' then
    raise exception 'refusing the 20261027200000 rollback: something it restores changed since the migration (write a new rollback from the live state)';
  end if;
end $rbguard$;

select cron.alter_job(j.jobid, command := 'SELECT public.create_auto_backup()') from cron.job j where j.jobname = 'auto-backup-2day';
drop procedure public._auto_backup_job();

CREATE OR REPLACE FUNCTION public.create_auto_backup()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$ DECLARE rec RECORD; backup_count integer := 0; v_scope text; BEGIN
  -- 20261025800000: every account whose own switch is on (and that has generations), one at a time; one account's
  -- failure is logged and never stops the others' backups.
  -- 20261025820000: each account's row is held (FOR KEY SHARE) from just before its backup until this run commits,
  -- and the backup is written under the scope that row has then: a rename of the account (FOR UPDATE) waits for the
  -- run instead of committing between the INSERT and the commit, and one that committed after the loop's query began
  -- is seen (either way the backup used to stay under the old name: no account saw it, no scrub reached it).
  FOR rec IN SELECT u.id FROM proxima_auth.users u WHERE u.auto_backups AND u.disabled_at IS NULL AND u.deleted_at IS NULL
    AND EXISTS (SELECT 1 FROM public.tasks t WHERE t.device_id = u.scope) ORDER BY u.scope LOOP BEGIN
    SELECT u.scope INTO v_scope FROM proxima_auth.users u
     WHERE u.id = rec.id AND u.auto_backups AND u.disabled_at IS NULL AND u.deleted_at IS NULL FOR KEY SHARE;
    IF v_scope IS NOT NULL THEN INSERT INTO public.data_backups (username, backup_type, task_count, history_count, settings_snapshot, favorites_snapshot, tasks_snapshot, history_snapshot) VALUES (v_scope, 'auto-2day', (SELECT count(*) FROM public.tasks WHERE device_id = v_scope), (SELECT count(*) FROM public.history WHERE device_id = v_scope), COALESCE((SELECT jsonb_object_agg(key, value) FROM public.settings WHERE device_id = v_scope AND key NOT LIKE 'form-inputs:%'), '{}'::jsonb), COALESCE((SELECT jsonb_agg(row_to_json(f.*)) FROM public.favorites f WHERE device_id = v_scope), '[]'::jsonb), COALESCE((SELECT jsonb_agg(row_to_json(t.*)) FROM (SELECT * FROM public.tasks WHERE device_id = v_scope ORDER BY start_time DESC LIMIT 500) t), '[]'::jsonb), COALESCE((SELECT jsonb_agg(row_to_json(h.*)) FROM (SELECT * FROM public.history WHERE device_id = v_scope ORDER BY timestamp DESC LIMIT 1000) h), '[]'::jsonb)); backup_count := backup_count + 1; END IF;
    EXCEPTION WHEN OTHERS THEN RAISE WARNING 'create_auto_backup: account % failed: % %', rec.id, sqlstate, sqlerrm; END; END LOOP; DELETE FROM public.data_backups WHERE id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY username ORDER BY created_at DESC) AS rn FROM public.data_backups WHERE backup_type = 'auto-2day') s WHERE rn > 30); RETURN backup_count; END; $function$
;
drop function public._auto_backup_one(uuid);

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
  -- 20261025820000: hold the account row (FOR KEY SHARE) until this backup commits, so a rename of the account (FOR
  -- UPDATE) waits instead of committing between the INSERT below and the commit (the backup stayed under the old name:
  -- no account saw it, no scrub reached it); then check the session again, since a rename that committed first revoked it.
  PERFORM 1 FROM proxima_auth.users u WHERE u.scope = v_username FOR KEY SHARE;
  PERFORM public._verify_session_token(p_session_token);   -- again, now that the account row is held: a rename may have moved the account
  IF (proxima_auth.current_account(p_session_token)).scope IS DISTINCT FROM v_username THEN RAISE EXCEPTION 'session token revoked'; END IF;

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
$function$
;

delete from supabase_migrations.schema_migrations where version = '20261027200000' and name = 'mu_p4_backup_job_per_account';
