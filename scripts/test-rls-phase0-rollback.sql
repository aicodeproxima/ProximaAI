-- Rollback test for phase 0. Send as ONE query: phase-0 migration + phase-0 rollback + this file (all rolled back).
do $pt$
declare r text[] := '{}'; n int;
begin
  select count(*) into n from pg_namespace where nspname = 'proxima_auth';
  r := r || format('%s proxima_auth gone', case when n = 0 then 'PASS' else 'FAIL' end);
  select count(*) into n from pg_trigger where tgname like '%sync_ping%';
  r := r || format('%s ping triggers gone', case when n = 0 then 'PASS' else 'FAIL' end);
  r := r || format('%s get_my_account body restored', case when md5(pg_get_functiondef('public.get_my_account(text)'::regprocedure))
    = 'cd1d77c0bc45dd6a273e4643115f8076' then 'PASS' else 'FAIL' end);
  select count(*) into n from pg_default_acl d join pg_namespace s on s.oid = d.defaclnamespace where s.nspname = 'proxima_auth';
  r := r || format('%s no default ACL left for proxima_auth', case when n = 0 then 'PASS' else 'FAIL' end);
  raise exception 'RESULT: % PASS, % FAIL :: %',
    (select count(*) from unnest(r) x where x like 'PASS%'), (select count(*) from unnest(r) x where x like 'FAIL%'),
    array_to_string(r, ' | ');
end $pt$;
