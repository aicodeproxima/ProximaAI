-- Marks the last run of a multi-step rollback proof (scripts/test-mu-p4-rollback.sql): that run reports.
select set_config('p4s.final', 'on', true);
