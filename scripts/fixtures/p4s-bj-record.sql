-- Fixture for scripts/test-backup-job-rollback.sql: 20261027200000 recorded as apply-migration.mjs records it,
-- so the proof can see the rollback delete its own record. Rolled back with the rest.
insert into supabase_migrations.schema_migrations (version, name, statements)
  values ('20261027200000', 'mu_p4_backup_job_per_account', array['(recorded by the test fixture)']);
