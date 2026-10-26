-- Backups hold their account row (P4, follow-up to 20261025800000; a race older than 800000 that its review round 9
-- found, c1): create_auto_backup() and snapshot_my_data_phase2 read the account's scope before taking any lock, so a
-- rename of that account committing while their INSERT was uncommitted (or, for the 2-day run, after the run's account
-- query began) left the new backup under the old scope: no account sees it, no scrub reaches it (deleted generations
-- stay in it) and the old name stays taken. Now each takes FOR KEY SHARE on the account row before its INSERT and
-- writes under the scope that row has then; the snapshot also checks its session again (a rename revokes it). Lock
-- order stays account row, then data tables, as in rename_my_account, so neither waits on the other in the opposite
-- order (no deadlock).
-- Cost: FOR KEY SHARE blocks only FOR UPDATE, and since the other session's 20261025920000 (applied 2026-10-26 00:37:12
-- UTC) only rename_my_account takes it: sign-in, unlock, password checks and key saves take FOR NO KEY UPDATE, and
-- set_auto_backups and session revokes update without either, so none of them waits. A rename of an account waits while
-- that account's backup transaction is open: one snapshot (about 65 ms at the snapshot limits of 500 tasks and 1000
-- History entries, measured 2026-10-25), or the rest of a 2-day run once that account is backed up (the run holds every
-- backed-up account's row until it commits: about 65 ms per account at the limits, so up to about 3.3 s at 50 such
-- accounts, plus the rest of any rename of a later account the run itself waits on; today one account with a few dozen
-- rows, a few ms). A browser call (anon) is cancelled after 3 s: the rename
-- fails and can be retried. A skipped pre-* snapshot (switch off) takes no lock, and the owner's switch is off, so the
-- 2-day run never holds the owner's row. No deadlock: a waiting rename holds no other row yet (it locks the account row
-- first), and a backup needs nothing it holds.
-- Both functions belong to the lockdown session (backup area); it agreed this change (2026-10-25). Only the lines below
-- change, and the migration refuses unless both bodies are the ones 20261025800000 installed.
-- Rollback: supabase/rollback/20261025820000_backups_hold_account_row.rollback.sql (roll this back before 800000's)
set local lock_timeout = '2s';   -- an apply that cannot take its locks within 2 s stops; a browser call is cancelled after 3 s

do $guard$
begin
  if md5(pg_get_functiondef('public.create_auto_backup()'::regprocedure)) = '2ffb6515b113604f6fbc1ff7a1ba9ee4'
     and md5(pg_get_functiondef('public.snapshot_my_data_phase2(text,text,text)'::regprocedure)) = '63d01fb0d9717f0b445bde46fc3b3f2a' then
    raise exception '20261025820000 is already applied (both bodies are the ones it installs)';
  end if;
  if md5(pg_get_functiondef('public.create_auto_backup()'::regprocedure)) <> '47ed1202174aef4a2ec7ff4c0322b5f3'
     or md5(pg_get_functiondef('public.snapshot_my_data_phase2(text,text,text)'::regprocedure)) <> '62f80166c1500e10b54c7ced6a6b7552' then
    raise exception 'a backup function is not the one 20261025800000 installed: apply 800000 first, or rebase this migration';
  end if;
end $guard$;

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
$function$;

set local lock_timeout to default;   -- for this file's statements only (apply-migration.mjs then records it in the same transaction)
