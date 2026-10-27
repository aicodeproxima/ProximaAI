-- The 2-day backup commits one account at a time; a snapshot reads its account in one statement (P4: plan item 11, and
-- review round 20's nit).
-- 1. _auto_backup_one(account id) writes one account's 2-day backup with 20261025820000's rules, unchanged: it holds
--    the account row (FOR KEY SHARE, which a rename waits for), re-checks the switch, disabled and deleted, and writes
--    under the scope the row has then. A switch-off committing during that one backup (about 0.1 s) does not wait for
--    it: the window set_auto_backups accepts, the whole run before. Then that account keeps its 30 newest 2-day
--    backups. create_auto_backup() still runs it for every account in one transaction (tests and manual runs). Cron 'auto-backup-2day' now calls the procedure
--    _auto_backup_job(), which commits after each account, waiting at most 10 s for a lock, then trims every name to 30
--    as before. Before, one transaction backed up every account: each account's row stayed held until the last one was
--    done (a rename of it waited, and a browser call is cancelled after 3 s), and one account's lock wait held up all
--    the accounts after it. Past about 60 switched-on accounts its one subtransaction per account also overflowed the
--    64-entry subtransaction cache for the rest of the run. pg_cron 1.6.4 sends each job as a top-level statement
--    (cron.use_background_workers is off), so the procedure may commit (as 20261026200000's drain does).
-- 2. snapshot_my_data_phase2 reads the account's tasks, History, settings, favorites and both counts inside its INSERT:
--    one statement, so one snapshot of the data. The six statements it replaces each took their own, so a change that
--    committed between them (a generation finishing, a History save) made a backup whose parts or counts disagree.
-- Rollback: supabase/rollback/20261027200000_mu_p4_backup_job_per_account.rollback.sql
set local lock_timeout = '2s';   -- an apply that cannot take its locks within 2 s stops; a browser call is cancelled after 3 s

do $guard$
begin
  if to_regprocedure('public._auto_backup_one(uuid)') is not null or to_regprocedure('public._auto_backup_job()') is not null then
    raise exception '20261027200000 is already applied (public._auto_backup_one(uuid) or public._auto_backup_job() exists)';
  end if;
  if md5(pg_get_functiondef('public.create_auto_backup()'::regprocedure)) <> '2ffb6515b113604f6fbc1ff7a1ba9ee4'
     or md5(pg_get_functiondef('public.snapshot_my_data_phase2(text,text,text)'::regprocedure)) <> '63d01fb0d9717f0b445bde46fc3b3f2a'
     or (select count(*) from cron.job where jobname = 'auto-backup-2day') <> 1
     or (select command from cron.job where jobname = 'auto-backup-2day') <> 'SELECT public.create_auto_backup()' then
    raise exception 'a function or the 2-day job is not the one 20261027200000 was written against: rebase this migration';
  end if;
end $guard$;

CREATE FUNCTION public._auto_backup_one(p_account uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$ DECLARE v_scope text; BEGIN
  -- 20261027200000: one account's 2-day backup, for create_auto_backup and the cron procedure _auto_backup_job.
  -- 20261025820000: the account's row is held (FOR KEY SHARE) from just before its backup until the caller commits, and
  -- the backup is written under the scope that row has then: a rename of the account (FOR UPDATE) waits instead of
  -- committing between the INSERT and the commit, and one that committed after the caller's account query began is seen
  -- (either way the backup used to stay under the old name: no account saw it, no scrub reached it).
  SELECT u.scope INTO v_scope FROM proxima_auth.users u
   WHERE u.id = p_account AND u.auto_backups AND u.disabled_at IS NULL AND u.deleted_at IS NULL FOR KEY SHARE;
  IF v_scope IS NULL THEN RETURN false; END IF;
  INSERT INTO public.data_backups (username, backup_type, task_count, history_count, settings_snapshot, favorites_snapshot, tasks_snapshot, history_snapshot) VALUES (v_scope, 'auto-2day', (SELECT count(*) FROM public.tasks WHERE device_id = v_scope), (SELECT count(*) FROM public.history WHERE device_id = v_scope), COALESCE((SELECT jsonb_object_agg(key, value) FROM public.settings WHERE device_id = v_scope AND key NOT LIKE 'form-inputs:%'), '{}'::jsonb), COALESCE((SELECT jsonb_agg(row_to_json(f.*)) FROM public.favorites f WHERE device_id = v_scope), '[]'::jsonb), COALESCE((SELECT jsonb_agg(row_to_json(t.*)) FROM (SELECT * FROM public.tasks WHERE device_id = v_scope ORDER BY start_time DESC LIMIT 500) t), '[]'::jsonb), COALESCE((SELECT jsonb_agg(row_to_json(h.*)) FROM (SELECT * FROM public.history WHERE device_id = v_scope ORDER BY timestamp DESC LIMIT 1000) h), '[]'::jsonb));
  -- This account keeps its 30 newest 2-day backups (the callers' last step still trims every name).
  DELETE FROM public.data_backups WHERE id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY created_at DESC) AS rn FROM public.data_backups WHERE username = v_scope AND backup_type = 'auto-2day') s WHERE rn > 30);
  RETURN true;
END; $function$;
revoke execute on function public._auto_backup_one(uuid) from public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.create_auto_backup()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$ DECLARE rec RECORD; backup_count integer := 0; BEGIN
  -- 20261025800000: every account whose own switch is on (and that has generations), one at a time; one account's
  -- failure is logged and never stops the others' backups.
  -- 20261027200000: each account's backup is _auto_backup_one(id) (20261025820000's account-row lock and re-check moved
  -- there, with that account's retention). This function keeps every backed-up account's row held until it commits, in
  -- one transaction (tests, manual runs); cron runs the procedure _auto_backup_job(), which commits after each account.
  FOR rec IN SELECT u.id FROM proxima_auth.users u WHERE u.auto_backups AND u.disabled_at IS NULL AND u.deleted_at IS NULL
    AND EXISTS (SELECT 1 FROM public.tasks t WHERE t.device_id = u.scope) ORDER BY u.scope LOOP BEGIN
    IF public._auto_backup_one(rec.id) THEN backup_count := backup_count + 1; END IF;
    EXCEPTION WHEN OTHERS THEN RAISE WARNING 'create_auto_backup: account % failed: % %', rec.id, sqlstate, sqlerrm; END; END LOOP; DELETE FROM public.data_backups WHERE id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY username ORDER BY created_at DESC) AS rn FROM public.data_backups WHERE backup_type = 'auto-2day') s WHERE rn > 30); RETURN backup_count; END; $function$;

-- The 2-day run, one account per transaction. A procedure that commits can have neither SECURITY DEFINER nor a SET
-- clause, so every name in it is schema-qualified; only postgres (the cron job's user) may run it. One account's failure
-- is logged by its id and never stops the others. The lock wait is 10 s, not the drain's 2 s: a browser call holds its
-- locks at most 3 s (8 s for a server call) before it is cancelled, and an account skipped here waits two days for its
-- next backup (a drain skipped retries the next minute).
CREATE PROCEDURE public._auto_backup_job()
 LANGUAGE plpgsql
AS $procedure$
declare
  v_id uuid;
begin
  for v_id in select u.id from proxima_auth.users u where u.auto_backups and u.disabled_at is null and u.deleted_at is null
                 and exists (select 1 from public.tasks t where t.device_id = u.scope) order by u.scope loop
    begin
      perform pg_catalog.set_config('lock_timeout', '10s', true);
      perform public._auto_backup_one(v_id);
    exception when others then
      raise warning '_auto_backup_job: account % failed: % %', v_id, sqlstate, sqlerrm;
    end;
    commit;
  end loop;
  perform pg_catalog.set_config('lock_timeout', '10s', true);
  delete from public.data_backups where id in (select s.id from (select b.id, row_number() over (partition by b.username order by b.created_at desc) as rn
                                                                   from public.data_backups b where b.backup_type = 'auto-2day') s where s.rn > 30);
  commit;
end $procedure$;
revoke execute on procedure public._auto_backup_job() from public, anon, authenticated;
select cron.alter_job(j.jobid, command := 'call public._auto_backup_job()') from cron.job j where j.jobname = 'auto-backup-2day';

CREATE OR REPLACE FUNCTION public.snapshot_my_data_phase2(p_session_token text, p_type text, p_note text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
DECLARE
  v_username text;
  v_id uuid := gen_random_uuid();
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

  -- 20261027200000: every part and both counts are read in this one statement, so from one snapshot of the data (the
  -- six statements before it each took their own: a change committed between them made parts or counts disagree).
  INSERT INTO data_backups (
    id, username, backup_type, task_count, history_count,
    settings_snapshot, favorites_snapshot, tasks_snapshot, history_snapshot, note
  ) VALUES (
    v_id, v_username, p_type,
    (SELECT count(*) FROM tasks WHERE device_id = v_username),
    (SELECT count(*) FROM history WHERE device_id = v_username),
    (SELECT COALESCE(jsonb_object_agg(key, value), '{}'::jsonb) FROM settings WHERE device_id = v_username AND key NOT LIKE 'form-inputs:%'),
    (SELECT COALESCE(jsonb_agg(row_to_json(f)), '[]'::jsonb) FROM (SELECT * FROM favorites WHERE device_id = v_username) f),
    (SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb) FROM (SELECT * FROM tasks WHERE device_id = v_username ORDER BY start_time DESC LIMIT 500) t),
    (SELECT COALESCE(jsonb_agg(row_to_json(h)), '[]'::jsonb) FROM (SELECT * FROM history WHERE device_id = v_username ORDER BY timestamp DESC LIMIT 1000) h),
    p_note
  );

  RETURN json_build_object('ok', true, 'id', v_id);
END;
$function$;
