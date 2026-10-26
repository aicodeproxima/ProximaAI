-- Rollback proof for supabase/migrations/20261025820000_backups_hold_account_row.sql, in one sql-tx call each:
--   AB=supabase/migrations/20261025800000_mu_p4_auto_backups_per_account.sql  LK=supabase/migrations/20261025820000_backups_hold_account_row.sql
--   RBab / RBlk = their supabase/rollback/*.rollback.sql; F=scripts/fixtures/p4s-lk-  T=scripts/test-backup-account-lock-rollback.sql
--   $AB $LK ${F}record.sql $RBlk --test $T                              both bodies are 800000's again, 820000's record gone
--   $AB $LK ${F}record.sql $RBlk $RBab ${F}stage-live.sql --test $T     both bodies are today's again
-- Guards (each run must stop with the quoted refusal; the probe is never reached; N=scripts/fixtures/p4s-ab-guard-noop.sql):
--   $LK --test $N                                        "a backup function is not the one 20261025800000 installed"
--   $AB ${F}guard-snap-changed.sql $LK --test $N         "a backup function is not the one 20261025800000 installed"
--   $AB $LK ${F}guard-cron-changed.sql $RBlk --test $N   "refusing the 20261025820000 rollback"
--   $AB $LK ${F}guard-snap-changed.sql $RBlk --test $N   "refusing the 20261025820000 rollback"
--   $AB $LK $RBab --test $N                             "refusing the 20261025800000 rollback: a function it restores changed"
do $t$
declare r text[] := '{}'; stage text := current_setting('lk.stage', true);
  ca text := md5(pg_get_functiondef('public.create_auto_backup()'::regprocedure));
  sn text := md5(pg_get_functiondef('public.snapshot_my_data_phase2(text,text,text)'::regprocedure));
begin
  if stage = 'live' then
    r := r || format('%s both bodies are today''s again (%s, %s)', case when ca = '0b09301b4fdb8aad58d13a1624f8b42f' and sn = 'cd5cfa09ae0b77204709bc230e287069' then 'PASS' else 'FAIL' end, left(ca, 8), left(sn, 8));
  else
    r := r || format('%s both bodies are the ones 20261025800000 installs (%s, %s)', case when ca = '47ed1202174aef4a2ec7ff4c0322b5f3' and sn = '62f80166c1500e10b54c7ced6a6b7552' then 'PASS' else 'FAIL' end, left(ca, 8), left(sn, 8));
  end if;
  r := r || format('%s no record of 20261025820000', case when not exists (select 1 from supabase_migrations.schema_migrations where version = '20261025820000') then 'PASS' else 'FAIL' end);
  raise exception 'RESULT: % PASS, % FAIL :: %', (select count(*) from unnest(r) q where q like 'PASS%'), (select count(*) from unnest(r) q where q like 'FAIL%'), array_to_string(r, ' | ');
end $t$;
