-- 20261027200000: the 2-day backup commits one account at a time, and a snapshot reads its account in one statement.
-- Rolled back by sql-tx. Before the apply: node scripts/tools/sql-tx.mjs <migration> --test <this file>; after it, this
-- file alone. Fixtures: accounts '__bj_<txid>*' with no password (the one token is minted here and never printed), rows
-- 'bj-*'. The two bodies 20261027200000 replaced are copied below (md5-checked against the ones its guard pins) and
-- created under fixture names, so B7 and B10 compare the new bodies with them on the same data.
--   B1  cron 'auto-backup-2day' (0 3 */2 * *, active, as postgres) calls public._auto_backup_job()
--   B2  the procedure: SECURITY INVOKER, no SET clause, owned by postgres; _auto_backup_one(uuid): SECURITY DEFINER with
--       search_path pinned, owned by postgres; anon, authenticated and PUBLIC can run neither; create_auto_backup and
--       snapshot_my_data_phase2 keep SECURITY DEFINER and their exact search_path (review round 25, c2 L3)
--   B3  whole bodies: the procedure, per account (create_auto_backup's account query, the same text) a 10 s lock wait,
--       _auto_backup_one in a block that logs a failure by the account id and goes on, COMMIT; then a 10 s lock wait,
--       every name's 2-day backups trimmed to its 30 newest, COMMIT. create_auto_backup: the same query, then
--       _auto_backup_one per account in the same kind of block, then every name trimmed
--   B4  _auto_backup_one's whole body: the account row under FOR KEY SHARE with the switch, disabled and deleted
--       re-checked, nothing else before its INSERT, which is 20261025820000's statement unchanged; then that account's
--       retention
--   B5  _auto_backup_one(account) backs up exactly that account's rows under its scope (form drafts left out) and answers
--       true; an account switched off, disabled, deleted or unknown gets nothing and the call answers false
--   B6  retention: the backed-up account keeps its 30 newest 2-day backups (its manual ones stay); another account's 31
--       stay until create_auto_backup's last step trims every name to 30
--   B7  create_auto_backup backs up the same accounts, with the same backups and count, as 20261025820000's body
--   B8  the procedure writes the first account's backup (one row inserted into data_backups, read from
--       pg_stat_xact_user_tables, which keeps counting what a rolled-back subtransaction inserted) and then reaches its
--       per-account COMMIT (inside this transaction a procedure cannot commit: 2D000 at that line, its first COMMIT,
--       not its last) (review round 25, c2 L1)
--   B11 one account's failing 2-day backup (a trigger on its INSERT) never stops the others: create_auto_backup still
--       backs up the rest, and with every 2-day backup failing the procedure's handler catches the first account's
--       failure and the call still reaches that account's COMMIT (review round 25, c2 L2)
--   B9  snapshot_my_data_phase2 reads the data in one statement, its INSERT, right after its scope check
--   B10 a snapshot holds what 20261025820000's body wrote on the same data (502 tasks, 1002 History entries: the limits
--       and the order), which is the newest 500 and 1000; a pre-* snapshot with the switch off writes nothing, as before
--   live, before the migration: B1-B6, B8, B9 and B11 FAIL; B7 and B10 pass (they compare the live bodies with copies
--   of themselves) and must still pass after it.
do $t$
declare
  r text[] := '{}'; p constant text := '__bj_' || txid_current();
  cab_old constant text := $old$CREATE OR REPLACE FUNCTION public.create_auto_backup()
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
$old$;
  snap_old constant text := $old$CREATE OR REPLACE FUNCTION public.snapshot_my_data_phase2(p_session_token text, p_type text, p_note text DEFAULT NULL::text)
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
$old$;
  id_a uuid := gen_random_uuid(); id_b uuid := gen_random_uuid(); id_off uuid := gen_random_uuid();
  id_dis uuid := gen_random_uuid(); id_del uuid := gen_random_uuid(); id_none uuid := gen_random_uuid();
  id_s uuid := gen_random_uuid(); id_q uuid := gen_random_uuid(); id_w uuid := gen_random_uuid();
  ua text; ub text; uoff text; udis text; udel text; unone text; us text; uq text; uw text;
  src text; v text; ins text; ok boolean; ok2 boolean; ok3 boolean; ok4 boolean; ok5 boolean; st text; ctx text; job record;
  n int; m int; k int; x int; y int; n2 int; m2 int; y2 int; ids uuid[]; names text[]; lines text[]; l1 int; l2 int;
  tok text; j1 json; j2 json; j3 json; j4 json; i int; id_f uuid := gen_random_uuid(); uf text; ins0 bigint; ins1 bigint;
begin
  ua := 'user:' || p || 'a'; ub := 'user:' || p || 'b'; uoff := 'user:' || p || 'off'; udis := 'user:' || p || 'dis';
  udel := 'user:' || p || 'del'; unone := 'user:' || p || 'none'; us := 'user:' || p || 's'; uq := 'user:' || p || 'q';
  uw := 'user:' || p || 'w';
  insert into proxima_auth.users (id, username, role, scope, password_hash) values
    (id_a, p || 'a', 'member', ua, null), (id_b, p || 'b', 'member', ub, null), (id_off, p || 'off', 'member', uoff, null),
    (id_dis, p || 'dis', 'member', udis, null), (id_del, p || 'del', 'member', udel, null),
    (id_none, p || 'none', 'member', unone, null), (id_s, p || 's', 'member', us, null), (id_q, p || 'q', 'member', uq, null),
    (id_w, p || 'w', 'member', uw, null);
  -- Switched on: A, B, Q (each has a generation: the 2-day run's accounts), DIS (disabled), DEL (deleted), NONE (no
  -- generation, so no run picks it). OFF, S and W stay off.
  update proxima_auth.users set auto_backups = true where id in (id_a, id_b, id_q, id_dis, id_del, id_none);
  update proxima_auth.users set disabled_at = now() where id = id_dis;
  update proxima_auth.users set deleted_at = now() where id = id_del;
  insert into public.tasks (id, device_id, status, start_time, outputs) values
    ('bj-a1-' || p, ua, 'completed', 1, '[]'), ('bj-a2-' || p, ua, 'completed', 2, '[]'), ('bj-b1-' || p, ub, 'completed', 1, '[]'),
    ('bj-off1-' || p, uoff, 'completed', 1, '[]'), ('bj-dis1-' || p, udis, 'completed', 1, '[]'),
    ('bj-del1-' || p, udel, 'completed', 1, '[]'), ('bj-q1-' || p, uq, 'completed', 1, '[]');
  insert into public.history (id, device_id, timestamp, tasks) values ('bj-ah1-' || p, ua, 1, '[]');
  insert into public.settings (device_id, key, value) values (ua, 'bj-k', '1'::jsonb), (ua, 'form-inputs:bj', '1'::jsonb);
  insert into public.favorites (id, device_id, prompt) values ('bj-af1-' || p, ua, 'a');
  -- S: more rows than a snapshot keeps (500 generations, 1000 History entries), two settings, a form draft, two favorites.
  insert into public.tasks (id, device_id, status, start_time, outputs)
    select 'bj-s-' || p || '-' || g, us, 'completed', g, '[]' from generate_series(1, 502) g;
  insert into public.history (id, device_id, timestamp, tasks)
    select 'bj-sh-' || p || '-' || g, us, g, '[]'::jsonb from generate_series(1, 1002) g;
  insert into public.settings (device_id, key, value) values (us, 'bj-k1', '1'::jsonb), (us, 'bj-k2', '"x"'::jsonb),
    (us, 'form-inputs:bj', '1'::jsonb);
  insert into public.favorites (id, device_id, prompt) values ('bj-sf1-' || p, us, 's1'), ('bj-sf2-' || p, us, 's2');

  -- Bodies are read with comments and string literals (also E'') removed and whitespace collapsed (a copy in a comment
  -- or a string cannot pass); the literals are checked on their own, in order.
  execute $n$create function pg_temp.bj_norm(t text) returns text language sql immutable as $b$
    select btrim(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(lower(t),
             '--[^\n]*', ' ', 'g'), '/\*.*?\*/', ' ', 'g'), '\me''(?:[^''\\]|\\.|'''')*''', '''''', 'g'),
             '''(?:[^'']|'''')*''', '''''', 'g'), '\s+', ' ', 'g'))
  $b$$n$;
  execute $n$create function pg_temp.bj_strs(t text) returns text[] language sql immutable as $b$
    select coalesce(array_agg(x.m[1] order by x.o), '{}')
      from regexp_matches(regexp_replace(regexp_replace(t, '--[^\n]*', ' ', 'g'), '/\*.*?\*/', ' ', 'g'),
                          '''((?:[^'']|'''')*)''', 'g') with ordinality x(m, o)
  $b$$n$;

  -- B1
  select j.schedule, j.command, j.active, j.username into job from cron.job j where j.jobname = 'auto-backup-2day';
  r := r || format('%s B1 cron auto-backup-2day calls the per-account procedure (%s, %s, active %s, as %s)',
                   case when job.command = 'call public._auto_backup_job()' and job.schedule = '0 3 */2 * *' and job.active
                             and job.username = 'postgres' then 'PASS' else 'FAIL' end,
                   coalesce(job.command, 'no job'), job.schedule, job.active, job.username);

  -- B2
  begin
    select p2.prokind = 'p' and not p2.prosecdef and p2.proconfig is null and p2.proowner = 'postgres'::regrole
           and not has_function_privilege('anon', p2.oid, 'execute') and not has_function_privilege('authenticated', p2.oid, 'execute')
           and not exists (select 1 from aclexplode(coalesce(p2.proacl, acldefault('f', p2.proowner))) a where a.grantee = 0)
      into ok from pg_proc p2 where p2.oid = 'public._auto_backup_job()'::regprocedure;
    select p2.prokind = 'f' and p2.prosecdef and p2.proconfig = array['search_path=public, pg_catalog'] and p2.proowner = 'postgres'::regrole
           and not has_function_privilege('anon', p2.oid, 'execute') and not has_function_privilege('authenticated', p2.oid, 'execute')
           and not exists (select 1 from aclexplode(coalesce(p2.proacl, acldefault('f', p2.proowner))) a where a.grantee = 0)
      into ok2 from pg_proc p2 where p2.oid = 'public._auto_backup_one(uuid)'::regprocedure;
    select p2.prosecdef and p2.proconfig = array['search_path=public, pg_catalog'] into ok3
      from pg_proc p2 where p2.oid = 'public.create_auto_backup()'::regprocedure;
    select p2.prosecdef and p2.proconfig = array['search_path=public, extensions, pg_catalog'] into ok4
      from pg_proc p2 where p2.oid = 'public.snapshot_my_data_phase2(text,text,text)'::regprocedure;
    r := r || format('%s B2 the procedure is SECURITY INVOKER without SET clauses, _auto_backup_one SECURITY DEFINER with its search_path, both owned by postgres and closed to anon, authenticated and PUBLIC; create_auto_backup and the snapshot keep SECURITY DEFINER and their search_path (%s, %s, %s, %s)',
                     case when ok and ok2 and ok3 and ok4 then 'PASS' else 'FAIL' end, ok, ok2, ok3, ok4);
  exception when others then r := r || format('FAIL B2 %s %s', sqlstate, sqlerrm); end;

  -- B3: the procedure's and create_auto_backup's whole bodies; the literals in order.
  begin
    src := (select prosrc from pg_proc where oid = 'public._auto_backup_job()'::regprocedure);
    v := (select prosrc from pg_proc where oid = 'public.create_auto_backup()'::regprocedure);
    ok := pg_temp.bj_norm(src) =
            'declare v_id uuid; begin for v_id in select u.id from proxima_auth.users u where u.auto_backups and u.disabled_at is null '
         || 'and u.deleted_at is null and exists (select 1 from public.tasks t where t.device_id = u.scope) order by u.scope loop '
         || 'begin perform pg_catalog.set_config('''', '''', true); perform public._auto_backup_one(v_id); '
         || 'exception when others then raise warning '''', v_id, sqlstate, sqlerrm; end; commit; end loop; '
         || 'perform pg_catalog.set_config('''', '''', true); delete from public.data_backups where id in (select s.id from '
         || '(select b.id, row_number() over (partition by b.username order by b.created_at desc) as rn from public.data_backups b '
         || 'where b.backup_type = '''') s where s.rn > 30); commit; end'
      and pg_temp.bj_strs(src) = array['lock_timeout', '10s', '_auto_backup_job: account % failed: % %', 'lock_timeout', '10s', 'auto-2day'];
    ok2 := pg_temp.bj_norm(v) =
            'declare rec record; backup_count integer := 0; begin for rec in select u.id from proxima_auth.users u where u.auto_backups '
         || 'and u.disabled_at is null and u.deleted_at is null and exists (select 1 from public.tasks t where t.device_id = u.scope) '
         || 'order by u.scope loop begin if public._auto_backup_one(rec.id) then backup_count := backup_count + 1; end if; '
         || 'exception when others then raise warning '''', rec.id, sqlstate, sqlerrm; end; end loop; delete from public.data_backups '
         || 'where id in (select id from (select id, row_number() over (partition by username order by created_at desc) as rn '
         || 'from public.data_backups where backup_type = '''') s where rn > 30); return backup_count; end;'
      and pg_temp.bj_strs(v) = array['create_auto_backup: account % failed: % %', 'auto-2day'];
    -- The two runs pick the same accounts: the same account query, word for word.
    ok3 := substring(pg_temp.bj_norm(src) from 'for v_id in (.*) loop begin perform')
           = substring(pg_temp.bj_norm(v) from 'for rec in (.*) loop begin if');
    r := r || format('%s B3 the procedure commits after each account (10 s lock wait, failure logged by id) and trims every name at the end; create_auto_backup runs _auto_backup_one per account the same way; both pick accounts with one query (procedure %s, function %s, same query %s)',
                     case when ok and ok2 and ok3 then 'PASS' else 'FAIL' end, ok, ok2, ok3);
  exception when others then r := r || format('FAIL B3 %s %s', sqlstate, sqlerrm); end;

  -- B4: _auto_backup_one's whole body, its INSERT being 20261025820000's (taken from the md5-checked copy).
  begin
    if md5(cab_old) <> '2ffb6515b113604f6fbc1ff7a1ba9ee4' then raise exception 'the copy of create_auto_backup is not the pinned body'; end if;
    v := pg_temp.bj_norm(substring(cab_old from position('$function$' in cab_old)));
    ins := substring(v from position('insert into public.data_backups' in v)
                       for position('; backup_count := backup_count + 1' in v) - position('insert into public.data_backups' in v) + 1);
    src := (select prosrc from pg_proc where oid = 'public._auto_backup_one(uuid)'::regprocedure);
    ok := length(ins) > 100 and pg_temp.bj_norm(src) =
            'declare v_scope text; begin select u.scope into v_scope from proxima_auth.users u where u.id = p_account '
         || 'and u.auto_backups and u.disabled_at is null and u.deleted_at is null for key share; '
         || 'if v_scope is null then return false; end if; ' || ins || ' '
         || 'delete from public.data_backups where id in (select id from (select id, row_number() over (order by created_at desc) as rn '
         || 'from public.data_backups where username = v_scope and backup_type = '''') s where rn > 30); return true; end;'
      and pg_temp.bj_strs(src) = array['auto-2day', 'form-inputs:%', '{}', '[]', '[]', '[]', 'auto-2day'];
    r := r || format('%s B4 _auto_backup_one holds the account row (switch, disabled, deleted re-checked) right before its INSERT, which is 20261025820000''s unchanged, then trims that account (%s)',
                     case when ok then 'PASS' else 'FAIL' end, ok);
  exception when others then r := r || format('FAIL B4 %s %s', sqlstate, sqlerrm); end;

  -- B5 (undone at its end, like B6 and B7)
  begin
    ok := public._auto_backup_one(id_a);
    ok2 := public._auto_backup_one(id_off); ok3 := public._auto_backup_one(id_dis); ok4 := public._auto_backup_one(id_del);
    ok5 := public._auto_backup_one(gen_random_uuid());
    select count(*), count(*) filter (where z.exact) into n, m
      from (select bk.task_count = 2 and bk.history_count = 1
                   and (select array_agg(el->>'id' order by el->>'id') from jsonb_array_elements(bk.tasks_snapshot) el) = array['bj-a1-' || p, 'bj-a2-' || p]
                   and (select array_agg(el->>'id' order by el->>'id') from jsonb_array_elements(bk.history_snapshot) el) = array['bj-ah1-' || p]
                   and (select array_agg(el->>'id' order by el->>'id') from jsonb_array_elements(bk.favorites_snapshot) el) = array['bj-af1-' || p]
                   and (select array_agg(ky order by ky) from jsonb_object_keys(bk.settings_snapshot) ky) = array['bj-k'] as exact
              from public.data_backups bk where bk.username = ua and bk.backup_type = 'auto-2day') z;
    select count(*) into k from public.data_backups where username in (uoff, udis, udel);
    r := r || format('%s B5 _auto_backup_one backs up exactly the account''s rows (form draft left out) and answers true; switched off, disabled, deleted and unknown accounts get nothing and false (A %s: %s backup, %s exact; off %s, disabled %s, deleted %s, unknown %s, their backups %s)',
                     case when ok and n = 1 and m = 1 and not ok2 and not ok3 and not ok4 and not ok5 and k = 0 then 'PASS' else 'FAIL' end,
                     ok, n, m, ok2, ok3, ok4, ok5, k);
    raise exception 'bj-undo';
  exception when others then if sqlerrm <> 'bj-undo' then r := r || format('FAIL B5 %s %s', sqlstate, sqlerrm); end if; end;

  -- B6
  begin
    insert into public.data_backups (username, backup_type, task_count, tasks_snapshot, created_at)
      select uq, 'auto-2day', 0, '[]'::jsonb, now() - make_interval(hours => g) from generate_series(1, 30) g;
    insert into public.data_backups (username, backup_type, task_count, tasks_snapshot, created_at)
      select uq, 'manual', 0, '[]'::jsonb, now() - make_interval(hours => 100 + g) from generate_series(1, 2) g;
    insert into public.data_backups (username, backup_type, task_count, tasks_snapshot, created_at)
      select uw, 'auto-2day', 0, '[]'::jsonb, now() - make_interval(hours => g) from generate_series(1, 31) g;
    ok := public._auto_backup_one(id_q);
    select count(*) filter (where backup_type = 'auto-2day'), count(*) filter (where backup_type = 'manual'),
           count(*) filter (where backup_type = 'auto-2day' and created_at = now()),
           count(*) filter (where backup_type = 'auto-2day' and created_at = now() - interval '30 hours')
      into n, m, k, x from public.data_backups where username = uq;
    select count(*) into y from public.data_backups where username = uw and backup_type = 'auto-2day';
    perform public.create_auto_backup();
    select count(*) filter (where backup_type = 'auto-2day'), count(*) filter (where backup_type = 'manual')
      into n2, m2 from public.data_backups where username = uq;
    select count(*), count(*) filter (where created_at = now() - interval '31 hours') into y2, i
      from public.data_backups where username = uw and backup_type = 'auto-2day';
    r := r || format('%s B6 retention: Q keeps its 30 newest 2-day backups and its manual ones, W''s 31 wait for the run''s last step, which trims W to 30 (Q after its backup: %s 2-day, new %s, 30 h one %s, %s manual; W %s; after the run: Q %s + %s manual, W %s, W''s oldest %s)',
                     case when ok and n = 30 and k = 1 and x = 0 and m = 2 and y = 31 and n2 = 30 and m2 = 2 and y2 = 30 and i = 0 then 'PASS' else 'FAIL' end,
                     n, k, x, m, y, n2, m2, y2, i);
    raise exception 'bj-undo';
  exception when others then if sqlerrm <> 'bj-undo' then r := r || format('FAIL B6 %s %s', sqlstate, sqlerrm); end if; end;

  -- B7: 20261025820000's create_auto_backup (the copy, under a fixture name), then the live one, on the same data.
  begin
    if md5(cab_old) <> '2ffb6515b113604f6fbc1ff7a1ba9ee4' then raise exception 'the copy of create_auto_backup is not the pinned body'; end if;
    execute replace(cab_old, 'FUNCTION public.create_auto_backup()', format('FUNCTION public.%I()', p || '_cab_old'));
    execute format('select public.%I()', p || '_cab_old') into x;
    select array_agg(d.id), array_agg(d.username order by d.username) into ids, names
      from public.data_backups d where d.backup_type = 'auto-2day' and starts_with(d.username, 'user:' || p);
    y := public.create_auto_backup();
    select count(*) filter (where o.id is null or nw.id is null),
           count(*) filter (where o.id is not null and nw.id is not null
                              and (o.task_count, o.history_count, o.settings_snapshot, o.favorites_snapshot, o.tasks_snapshot, o.history_snapshot, o.note)
                                  is not distinct from (nw.task_count, nw.history_count, nw.settings_snapshot, nw.favorites_snapshot, nw.tasks_snapshot, nw.history_snapshot, nw.note)),
           count(*)
      into n, m, k
      from (select * from public.data_backups d where d.id = any(ids)) o
      full join (select * from public.data_backups d where d.backup_type = 'auto-2day' and starts_with(d.username, 'user:' || p)
                    and d.id <> all(ids)) nw on nw.username = o.username;
    r := r || format('%s B7 create_auto_backup backs up what 20261025820000''s body did: the same accounts (%s), equal backups (%s of %s, %s unmatched), the same count (%s, %s)',
                     case when names = array[ua, ub, uq] and n = 0 and m = 3 and k = 3 and x = y then 'PASS' else 'FAIL' end,
                     array_to_string(array(select right(z, 1) from unnest(names) z), ','), m, k, n, x, y);
    raise exception 'bj-undo';
  exception when others then if sqlerrm <> 'bj-undo' then r := r || format('FAIL B7 %s %s', sqlstate, sqlerrm); end if; end;

  -- B8: accounts A, B and Q are due, so the loop runs; the call fails at the first COMMIT it reaches.
  begin
    src := (select prosrc from pg_proc where oid = 'public._auto_backup_job()'::regprocedure);
    lines := string_to_array(src, E'\n');
    select min(g), max(g) into l1, l2 from generate_subscripts(lines, 1) g where lines[g] ~ '^\s*commit;\s*$';
    select coalesce(sum(s.n_tup_ins), 0) into ins0 from pg_stat_xact_user_tables s where s.relid = 'public.data_backups'::regclass;
    begin
      call public._auto_backup_job();
      st := 'returned';
    exception when others then
      get stacked diagnostics st = returned_sqlstate, ctx = pg_exception_context;
    end;
    select coalesce(sum(s.n_tup_ins), 0) into ins1 from pg_stat_xact_user_tables s where s.relid = 'public.data_backups'::regclass;
    r := r || format('%s B8 with accounts due, the call writes the first account''s backup (%s row) and reaches the COMMIT after it (inside this transaction: %s at %s; the per-account COMMIT is line %s, the last one %s)',
                     case when ins1 - ins0 = 1 and st = '2D000' and l1 < l2 and ctx ~ ('_auto_backup_job\(\) line ' || l1 || ' at COMMIT') then 'PASS' else 'FAIL' end,
                     ins1 - ins0, st, coalesce(substring(ctx from '_auto_backup_job\(\) line \d+ at [A-Z ]+'), left(ctx, 80)), l1, l2);
  exception when others then r := r || format('FAIL B8 %s %s', sqlstate, sqlerrm); end;

  -- B11: F's 2-day backup fails (a trigger on its INSERT); then every 2-day backup fails (bj.fail_all), so whichever
  --      account the procedure takes first fails inside its block.
  begin
    uf := 'user:' || p || 'f';
    insert into proxima_auth.users (id, username, role, scope, password_hash) values (id_f, p || 'f', 'member', uf, null);
    update proxima_auth.users set auto_backups = true where id = id_f;
    insert into public.tasks (id, device_id, status, start_time, outputs) values ('bj-f1-' || p, uf, 'completed', 1, '[]');
    execute format($f$create function public.%I() returns trigger language plpgsql as $b$
      begin
        if new.backup_type = 'auto-2day' and (new.username = %L or coalesce(current_setting('bj.fail_all', true), '') = 'on') then
          raise exception 'bj-planted';
        end if;
        return new;
      end $b$$f$, p || '_fail', uf);
    execute format('create trigger %I before insert on public.data_backups for each row execute function public.%I()', p || '_fail', p || '_fail');
    n := public.create_auto_backup();
    select count(*) filter (where username = uf), count(*) filter (where username in (ua, ub, uq)) into m, k
      from public.data_backups where backup_type = 'auto-2day';
    perform set_config('bj.fail_all', 'on', true);
    st := null; ctx := null;
    begin
      call public._auto_backup_job();
      st := 'returned';
    exception when others then
      get stacked diagnostics st = returned_sqlstate, ctx = pg_exception_context;
    end;
    r := r || format('%s B11 a failing backup never stops the others: create_auto_backup backs up A, B and Q but not F (returned %s; F %s, A/B/Q %s); with every backup failing the procedure still reaches the first account''s COMMIT (%s at %s)',
                     case when m = 0 and k = 3 and st = '2D000' and ctx ~ ('_auto_backup_job\(\) line ' || l1 || ' at COMMIT') then 'PASS' else 'FAIL' end,
                     n, m, k, st, coalesce(substring(ctx from '_auto_backup_job\(\) line \d+ at [A-Z ]+'), left(ctx, 80)));
    raise exception 'bj-undo';
  exception when others then if sqlerrm <> 'bj-undo' then r := r || format('FAIL B11 %s %s', sqlstate, sqlerrm); end if; end;

  -- B9
  begin
    src := pg_temp.bj_norm((select prosrc from pg_proc where oid = 'public.snapshot_my_data_phase2(text,text,text)'::regprocedure));
    select count(*) into n from unnest(string_to_array(src, ';')) s where s ~ '\m(from|join)\s+(public\.)?(tasks|history|settings|favorites)\M';
    select count(*) into m from unnest(string_to_array(src, ';')) s
     where s ~ '^\s*insert into data_backups \('
       and position('(select count(*) from tasks where device_id = v_username)' in s) > 0
       and position('(select count(*) from history where device_id = v_username)' in s) > 0
       and position('from settings where device_id = v_username and key not like ''''' in s) > 0
       and position('from (select * from favorites where device_id = v_username) f' in s) > 0
       and position('from (select * from tasks where device_id = v_username order by start_time desc limit 500) t' in s) > 0
       and position('from (select * from history where device_id = v_username order by timestamp desc limit 1000) h' in s) > 0;
    k := position('if (proxima_auth.current_account(p_session_token)).scope is distinct from v_username then raise exception ''''; end if; insert into data_backups (' in src);
    r := r || format('%s B9 a snapshot reads the data in one statement, its INSERT of all six parts, right after its scope check (%s reading statements, %s such INSERT, at %s)',
                     case when n = 1 and m = 1 and k > 0 then 'PASS' else 'FAIL' end, n, m, k);
  exception when others then r := r || format('FAIL B9 %s %s', sqlstate, sqlerrm); end;

  -- B10: 20261025820000's snapshot (the copy, under a fixture name), then the live one, with S's session, as the app calls.
  begin
    if md5(snap_old) <> '63d01fb0d9717f0b445bde46fc3b3f2a' then raise exception 'the copy of snapshot_my_data_phase2 is not the pinned body'; end if;
    execute replace(snap_old, 'FUNCTION public.snapshot_my_data_phase2(', format('FUNCTION public.%I(', p || '_snap_old'));
    tok := proxima_auth.mint_token(id_s);
    execute 'set local role anon';
    perform set_config('request.headers', json_build_object('x-forwarded-for', '192.0.2.91', 'cf-connecting-ip', '192.0.2.91',
                                                            'x-proxima-session', tok)::text, true);
    execute format('select public.%I($1, $2, $3)', p || '_snap_old') into j1 using tok, 'manual', 'bj-note';
    j2 := public.snapshot_my_data_phase2(tok, 'manual', 'bj-note');
    execute format('select public.%I($1, $2, $3)', p || '_snap_old') into j3 using tok, 'pre-delete', null::text;
    j4 := public.snapshot_my_data_phase2(tok, 'pre-delete', null);
    execute 'reset role';
    select count(*) into n from public.data_backups o, public.data_backups nw
     where o.id = (j1->>'id')::uuid and nw.id = (j2->>'id')::uuid
       and (o.username, o.backup_type, o.task_count, o.history_count, o.settings_snapshot, o.favorites_snapshot, o.tasks_snapshot, o.history_snapshot, o.note)
           is not distinct from (nw.username, nw.backup_type, nw.task_count, nw.history_count, nw.settings_snapshot, nw.favorites_snapshot, nw.tasks_snapshot, nw.history_snapshot, nw.note);
    select count(*) into m from public.data_backups nw
     where nw.id = (j2->>'id')::uuid and nw.username = us and nw.backup_type = 'manual' and nw.note = 'bj-note'
       and nw.task_count = 502 and nw.history_count = 1002
       and jsonb_array_length(nw.tasks_snapshot) = 500 and (nw.tasks_snapshot->0->>'start_time')::bigint = 502
       and (nw.tasks_snapshot->499->>'start_time')::bigint = 3
       and jsonb_array_length(nw.history_snapshot) = 1000 and (nw.history_snapshot->0->>'timestamp')::bigint = 1002
       and (nw.history_snapshot->999->>'timestamp')::bigint = 3
       and (select array_agg(ky order by ky) from jsonb_object_keys(nw.settings_snapshot) ky) = array['bj-k1', 'bj-k2']
       and (select array_agg(el->>'id' order by el->>'id') from jsonb_array_elements(nw.favorites_snapshot) el) = array['bj-sf1-' || p, 'bj-sf2-' || p];
    select count(*) into k from public.data_backups where username = us;
    r := r || format('%s B10 a snapshot holds what 20261025820000''s body wrote on the same data (%s equal), the newest 500 generations and 1000 History entries with the counts, settings without the form draft (%s); pre-* with the switch off writes nothing, as before (%s, %s; %s backups)',
                     case when n = 1 and m = 1 and (j3->>'skipped')::boolean and (j4->>'skipped')::boolean and k = 2 then 'PASS' else 'FAIL' end,
                     n, m, j3->>'skipped', j4->>'skipped', k);
  exception when others then execute 'reset role'; r := r || format('FAIL B10 %s %s', sqlstate, sqlerrm); end;

  raise exception 'RESULT: % PASS, % FAIL :: %', (select count(*) from unnest(r) q where q like 'PASS%'),
    (select count(*) from unnest(r) q where q like 'FAIL%'), array_to_string(r, ' | ');
end $t$;
