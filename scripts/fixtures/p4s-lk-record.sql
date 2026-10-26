-- Fixture for scripts/test-backup-account-lock-rollback.sql: 20261025820000 recorded as apply-migration.mjs records it,
-- so the test can see the rollback delete its own record. Rolled back with the rest.
insert into supabase_migrations.schema_migrations (version, name, statements)
  values ('20261025820000', 'backups_hold_account_row', array['(recorded by the test fixture)']);
