-- Rollback test: supabase/rollback/20261022120000_rls_session_header.rollback.sql must restore today's policies, grants
-- and Realtime publication EXACTLY. Send as ONE query, everything rolled back:
--   [phase-0 migration if not applied] + test-rls-rollback-before.sql + phase-2 migration + phase-2 rollback + this file
do $pt$
declare r text[] := '{}'; n int; snap text;
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
  r := r || format('%s policies + grants + publication identical after rollback (%s chars)',
                   case when snap = current_setting('pt.before') then 'PASS' else 'FAIL' end, length(snap));
  execute 'set local role anon';
  perform set_config('request.headers', '{}', true);
  select count(*) into n from public.settings;
  r := r || format('%s anon read restored', case when n = current_setting('pt.n_settings')::int then 'PASS' else 'FAIL' end);
  select count(*) into n from storage.objects where bucket_id = 'generations';
  r := r || format('%s anon storage list restored', case when n = current_setting('pt.n_objects')::int then 'PASS' else 'FAIL' end);
  begin insert into public.settings (device_id, key) values ('user:__rls_rb', '__rls_rb'); r := r || text 'PASS anon write restored';
  exception when others then r := r || format('FAIL anon write: %s %s', sqlstate, sqlerrm); end;
  execute 'reset role';
  raise exception 'RESULT: % PASS, % FAIL :: %',
    (select count(*) from unnest(r) x where x like 'PASS%'), (select count(*) from unnest(r) x where x like 'FAIL%'),
    array_to_string(r, ' | ');
end $pt$;
