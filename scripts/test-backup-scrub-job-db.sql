-- 20261026200000: the per-minute backup scrub drain commits one account at a time; rolled back by sql-tx.
--   J1 cron 'backup-scrub-drain' (every minute, active, as postgres) calls public._drain_backup_scrubs_job()
--   J2 the procedure is SECURITY INVOKER with no SET clause (a procedure that commits can have neither), owned by
--      postgres, and anon, authenticated and PUBLIC cannot run it
--   J3 its loop: per queued account a 2 s lock wait, _drain_backup_scrubs(that account) in a block that logs a failure
--      and goes on, then COMMIT; every name in it schema-qualified (it has no search_path of its own)
--   J4 inside a transaction a procedure cannot commit, so a call with an account queued fails exactly at its COMMIT
--      (2D000): the per-account commit is reached (the cron job sends it as a top-level statement, where COMMIT works;
--      the apply's live check queues a probe scrub and watches the next run drain it)
--   live, before the migration: J1-J4 FAIL (no procedure; the job selects _drain_backup_scrubs())
do $t$
declare
  r text[] := '{}'; p constant text := '__sj' || txid_current();
  src text; ok boolean; st text; ctx text; job record;
begin
  -- J1
  select j.schedule, j.command, j.active, j.username into job from cron.job j where j.jobname = 'backup-scrub-drain';
  r := r || format('%s J1 cron backup-scrub-drain calls the per-account procedure (%s, %s, active %s, as %s)',
                   case when job.command = 'call public._drain_backup_scrubs_job()' and job.schedule = '* * * * *' and job.active
                             and job.username = 'postgres' then 'PASS' else 'FAIL' end,
                   coalesce(job.command, 'no job'), job.schedule, job.active, job.username);
  if to_regprocedure('public._drain_backup_scrubs_job()') is null then
    r := r || 'FAIL J2 no procedure public._drain_backup_scrubs_job()'::text || 'FAIL J3 (no procedure)'::text || 'FAIL J4 (no procedure)'::text;
  else
    -- J2
    select p.prokind = 'p' and not p.prosecdef and p.proconfig is null and p.proowner = 'postgres'::regrole
           and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('authenticated', p.oid, 'execute')
           and not exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0),
           p.prosrc
      into ok, src from pg_proc p where p.oid = 'public._drain_backup_scrubs_job()'::regprocedure;
    r := r || format('%s J2 a SECURITY INVOKER procedure without SET clauses, owned by postgres, closed to anon, authenticated and PUBLIC',
                     case when ok then 'PASS' else 'FAIL' end);
    -- J3: the statements of the loop, in order.
    ok := src ~ ('for v_user in select distinct q\.username from public\.backup_scrub_queue q order by 1 loop\s+begin\s+'
                 || 'perform pg_catalog\.set_config\(''lock_timeout'', ''2s'', true\);\s+'
                 || 'perform public\._drain_backup_scrubs\(v_user\);\s+'
                 || 'exception when others then\s+raise warning [^;]+;\s+end;\s+commit;\s+end loop;');
    r := r || format('%s J3 per queued account: a 2 s lock wait, its drain in a block that logs a failure and goes on, then COMMIT',
                     case when ok then 'PASS' else 'FAIL' end);
    -- J4: an account queued (sorted first: '0' before letters), then the call; the drain it runs is undone with the block.
    insert into public.backup_scrub_queue (username, task_ids) values ('user:00' || p, array[p || '_gone']);
    begin
      call public._drain_backup_scrubs_job();
      st := 'returned';
    exception when others then
      get stacked diagnostics st = returned_sqlstate, ctx = pg_exception_context;
    end;
    r := r || format('%s J4 with an account queued, the call reaches its COMMIT (inside this transaction: %s at %s)',
                     case when st = '2D000' and ctx ~ '_drain_backup_scrubs_job\(\) line \d+ at COMMIT' then 'PASS' else 'FAIL' end,
                     st, coalesce(substring(ctx from '_drain_backup_scrubs_job\(\) line \d+ at [A-Z ]+'), left(ctx, 80)));
  end if;
  raise exception 'RESULT: % PASS, % FAIL :: %', (select count(*) from unnest(r) q where q like 'PASS%'),
    (select count(*) from unnest(r) q where q like 'FAIL%'), array_to_string(r, ' | ');
end $t$;
