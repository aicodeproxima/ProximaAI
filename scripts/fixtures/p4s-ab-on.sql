-- Fixture for the P4 rollback proofs (scripts/test-mu-p4-rollback.sql, scripts/test-mu-p4-ab-rollback.sql): the global
-- Automatic backups switch ON before 20261025800000, so the migration seeds every account on (rolled back with the rest).
update public.app_secrets set value = '{"enabled": true}'::jsonb where key = 'auto_backups';
