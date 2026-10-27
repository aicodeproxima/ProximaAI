-- Guard fixture (rolled back by sql-tx): snapshot_my_data_phase2's definition changes (a SET clause, which
-- pg_get_functiondef shows). After 20261027200000, before its rollback: the rollback must refuse (something changed).
alter function public.snapshot_my_data_phase2(text, text, text) set work_mem = '4MB';
