-- Guard fixture (rolled back by sql-tx): create_auto_backup's definition changes (a SET clause, which
-- pg_get_functiondef shows), so its md5 is no longer the one 20261027200000 pins: the migration must refuse (rebase).
alter function public.create_auto_backup() set work_mem = '4MB';
