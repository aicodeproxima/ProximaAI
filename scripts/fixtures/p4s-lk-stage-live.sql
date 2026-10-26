-- Fixture for scripts/test-backup-account-lock-rollback.sql: the state is back to before 20261025800000 (both rollbacks ran).
select set_config('lk.stage', 'live', true);
