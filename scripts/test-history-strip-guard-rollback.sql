-- Rollback proof for 20261025910000_history_strip_guard_first (after the migration and its rollback, in one rolled-back
-- transaction): the strip function is byte-identical to before (0a136484), upsert_queued_history untouched (9b577e07), and
-- the guard trigger and its function are gone.
--   node scripts/tools/sql-tx.mjs supabase/migrations/20261025910000_history_strip_guard_first.sql supabase/rollback/20261025910000_history_strip_guard_first.rollback.sql --test scripts/test-history-strip-guard-rollback.sql
do $t$
declare out text := '';
begin
  out := out || case when md5(pg_get_functiondef('public._history_strip_deleted_items()'::regprocedure)) = '0a136484d6d3e9f4bed82d04221fe401'
                     then 'ok B1 strip-identical; ' else 'FAIL B1 strip differs; ' end;
  out := out || case when md5(pg_get_functiondef('public.upsert_queued_history(text,jsonb,bigint)'::regprocedure)) = '9b577e07e025396952b78287aabf4891'
                     then 'ok B2 upsert-identical; ' else 'FAIL B2 upsert differs; ' end;
  out := out || case when not exists (select 1 from pg_trigger where tgname = 'history_0_scope_guard')
                       and to_regprocedure('public._history_browser_scope_guard()') is null
                     then 'ok B3 guard-gone; ' else 'FAIL B3 guard remains; ' end;
  raise exception 'RESULT: %', out;
end $t$;
