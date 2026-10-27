-- 20261026200000's rollback proof: after the rollback, everything the migration touched is as it was before it. All
-- rolled back. Before the apply: node scripts/tools/sql-tx.mjs supabase/migrations/20261026200000_*.sql
-- supabase/rollback/20261026200000_*.rollback.sql --test <this file>; after it: the rollback alone, then this file.
do $t$
declare
  r text[] := '{}'; v text; job record;
begin
  v := md5(pg_get_functiondef('public._scrub_backups_to_live_items(text)'::regprocedure));
  r := r || format('%s R1 _scrub_backups_to_live_items is the loop again (%s)', case when v = '44eebc31f7ab83d9cd36c18b647a680a' then 'PASS' else 'FAIL' end, left(v, 8));
  v := md5(pg_get_functiondef('public.rename_my_account(text,text,text)'::regprocedure));
  r := r || format('%s R2 rename_my_account is the 20261025100000 body again (%s)', case when v = '28e9c3cafe8b1cf735caba095ef6f060' then 'PASS' else 'FAIL' end, left(v, 8));
  v := md5(pg_get_functiondef('public._drain_backup_scrubs(text)'::regprocedure));
  r := r || format('%s R3 _drain_backup_scrubs untouched (%s)', case when v = 'c79e4b229c4897d5a2d15dea856668f1' then 'PASS' else 'FAIL' end, left(v, 8));
  r := r || format('%s R4 the procedure is gone', case when to_regprocedure('public._drain_backup_scrubs_job()') is null then 'PASS' else 'FAIL' end);
  select j.schedule, j.command, j.active into job from cron.job j where j.jobname = 'backup-scrub-drain';
  r := r || format('%s R5 the drain job selects _drain_backup_scrubs() every minute again (%s, %s, active %s)',
                   case when job.command = 'select public._drain_backup_scrubs()' and job.schedule = '* * * * *' and job.active then 'PASS' else 'FAIL' end,
                   job.command, job.schedule, job.active);
  r := r || format('%s R6 privileges as before: the scrub closed to anon and authenticated, rename open to them',
                   case when not has_function_privilege('anon', 'public._scrub_backups_to_live_items(text)', 'execute')
                             and not has_function_privilege('authenticated', 'public._scrub_backups_to_live_items(text)', 'execute')
                             and has_function_privilege('anon', 'public.rename_my_account(text,text,text)', 'execute') then 'PASS' else 'FAIL' end);
  raise exception 'RESULT: % PASS, % FAIL :: %', (select count(*) from unnest(r) q where q like 'PASS%'),
    (select count(*) from unnest(r) q where q like 'FAIL%'), array_to_string(r, ' | ');
end $t$;
