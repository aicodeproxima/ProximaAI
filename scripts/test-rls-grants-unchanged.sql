-- Exact-inverse check for a grants/policies migration and its rollback. Send as ONE query (all rolled back):
--   scripts/test-rls-rollback-before.sql + <migration> + <its rollback> + this file
-- Compares the policies, table grants and Realtime publication captured before with the state after.
do $pt$
declare snap text; r text[] := '{}';
begin
  snap := (select concat_ws(E'\n',
    (select string_agg(concat_ws('|', schemaname, tablename, policyname, permissive, roles::text, cmd, qual, with_check), E'\n'
                       order by schemaname, tablename, policyname) from pg_policies where schemaname in ('public','storage')),
    (select string_agg(format('%s:%s:%s', c.relname, a.grantee::regrole, a.privilege_type), ','
                       order by c.relname, a.grantee::regrole::text, a.privilege_type)
       from pg_class c cross join lateral aclexplode(c.relacl) a
      where c.relnamespace = 'public'::regnamespace
        and c.relname in ('tasks','history','settings','favorites','presets','sync_tombstones')),
    (select string_agg(tablename, ',' order by tablename) from pg_publication_tables where pubname = 'supabase_realtime')));
  r := r || format('%s policies + grants + publication identical after migration + rollback (%s chars)',
                   case when snap = current_setting('pt.before') then 'PASS' else 'FAIL' end, length(snap));
  raise exception 'RESULT: % PASS, % FAIL :: %',
    (select count(*) from unnest(r) x where x like 'PASS%'), (select count(*) from unnest(r) x where x like 'FAIL%'),
    array_to_string(r, ' | ');
end $pt$;
