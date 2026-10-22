-- Part 1 of the rollback test (scripts/test-rls-rollback.sql has the order). Captures today's policies, table grants and
-- Realtime publication, plus what anon can see, into transaction-local settings.
select set_config('pt.before', (select concat_ws(E'\n',
  (select string_agg(concat_ws('|', schemaname, tablename, policyname, permissive, roles::text, cmd, qual, with_check), E'\n'
                     order by schemaname, tablename, policyname) from pg_policies where schemaname in ('public','storage')),
  (select string_agg(format('%s:%s:%s', c.relname, a.grantee::regrole, a.privilege_type), ','
                     order by c.relname, a.grantee::regrole::text, a.privilege_type)
     from pg_class c cross join lateral aclexplode(c.relacl) a
    where c.relnamespace = 'public'::regnamespace
      and c.relname in ('tasks','history','settings','favorites','presets','sync_tombstones')),
  (select string_agg(tablename, ',' order by tablename) from pg_publication_tables where pubname = 'supabase_realtime'))), true);
select set_config('pt.n_settings', (select count(*) from public.settings)::text, true);
select set_config('pt.n_objects', (select count(*) from storage.objects where bucket_id = 'generations')::text, true);
