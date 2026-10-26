-- Fixture for scripts/test-backup-account-lock-db.sql's guard runs: after 20261025820000, someone changed
-- create_auto_backup (a comment). 820000's rollback must refuse.
do $m$ begin execute replace(pg_get_functiondef('public.create_auto_backup()'::regprocedure), 'BEGIN', E'BEGIN\n  -- changed after 20261025820000'); end $m$;
