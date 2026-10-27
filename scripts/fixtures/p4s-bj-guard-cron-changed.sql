-- Guard fixture (rolled back by sql-tx): the 2-day job's command changes (a trailing semicolon). Before 20261027200000
-- the migration must refuse (rebase); after it, before its rollback, the rollback must refuse (something changed).
select cron.alter_job(j.jobid, command := j.command || ';') from cron.job j where j.jobname = 'auto-backup-2day';
