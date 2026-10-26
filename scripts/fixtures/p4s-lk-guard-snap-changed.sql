-- Fixture for scripts/test-backup-account-lock-db.sql's guard runs: someone changed snapshot_my_data_phase2 only (a
-- comment). Before 820000, its forward guard must refuse; after 820000, its rollback must refuse.
do $m$ begin execute replace(pg_get_functiondef('public.snapshot_my_data_phase2(text,text,text)'::regprocedure), 'BEGIN', E'BEGIN\n  -- changed'); end $m$;
