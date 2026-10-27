-- 20261027200000's rollback proof: after the rollback, everything the migration touched is as it was before it. All
-- rolled back. Before the apply (M = the migration, RB = its rollback, F = scripts/fixtures/p4s-bj-):
--   node scripts/tools/sql-tx.mjs $M ${F}record.sql $RB --test <this file>
-- after it: node scripts/tools/sql-tx.mjs $RB --test <this file>. Guard runs (each must stop with the quoted refusal;
-- N = scripts/fixtures/p4s-ab-guard-noop.sql is never reached):
--   $RB --test $N                              "refusing the 20261027200000 rollback: 20261027200000 is not applied"
--   $M $M --test $N                            "20261027200000 is already applied"
--   ${F}guard-cab-changed.sql $M --test $N     "rebase this migration"
--   ${F}guard-cron-changed.sql $M --test $N    "rebase this migration"
--   $M ${F}guard-snap-changed.sql $RB --test $N  "refusing the 20261027200000 rollback: something it restores changed"
--   $M ${F}guard-cron-changed.sql $RB --test $N  "refusing the 20261027200000 rollback: something it restores changed"
do $t$
declare
  r text[] := '{}'; v text; job record;
begin
  v := md5(pg_get_functiondef('public.create_auto_backup()'::regprocedure));
  r := r || format('%s R1 create_auto_backup is 20261025820000''s body again (%s)', case when v = '2ffb6515b113604f6fbc1ff7a1ba9ee4' then 'PASS' else 'FAIL' end, left(v, 8));
  v := md5(pg_get_functiondef('public.snapshot_my_data_phase2(text,text,text)'::regprocedure));
  r := r || format('%s R2 snapshot_my_data_phase2 is 20261025820000''s body again (%s)', case when v = '63d01fb0d9717f0b445bde46fc3b3f2a' then 'PASS' else 'FAIL' end, left(v, 8));
  r := r || format('%s R3 _auto_backup_one and the procedure are gone',
                   case when to_regprocedure('public._auto_backup_one(uuid)') is null and to_regprocedure('public._auto_backup_job()') is null then 'PASS' else 'FAIL' end);
  select j.schedule, j.command, j.active, j.username into job from cron.job j where j.jobname = 'auto-backup-2day';
  r := r || format('%s R4 the 2-day job selects create_auto_backup() again (%s, %s, active %s, as %s)',
                   case when job.command = 'SELECT public.create_auto_backup()' and job.schedule = '0 3 */2 * *' and job.active and job.username = 'postgres'
                        and (select count(*) from cron.job where jobname = 'auto-backup-2day') = 1 then 'PASS' else 'FAIL' end,
                   job.command, job.schedule, job.active, job.username);
  r := r || format('%s R5 privileges as before: create_auto_backup closed to anon, authenticated and PUBLIC; the snapshot open to anon and authenticated',
                   case when not has_function_privilege('anon', 'public.create_auto_backup()', 'execute')
                             and not has_function_privilege('authenticated', 'public.create_auto_backup()', 'execute')
                             and not exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                                              where p.oid = 'public.create_auto_backup()'::regprocedure and a.grantee = 0)
                             and has_function_privilege('anon', 'public.snapshot_my_data_phase2(text,text,text)', 'execute')
                             and has_function_privilege('authenticated', 'public.snapshot_my_data_phase2(text,text,text)', 'execute') then 'PASS' else 'FAIL' end);
  r := r || format('%s R6 no record of 20261027200000',
                   case when not exists (select 1 from supabase_migrations.schema_migrations where version = '20261027200000') then 'PASS' else 'FAIL' end);
  raise exception 'RESULT: % PASS, % FAIL :: %', (select count(*) from unnest(r) q where q like 'PASS%'),
    (select count(*) from unnest(r) q where q like 'FAIL%'), array_to_string(r, ' | ');
end $t$;
