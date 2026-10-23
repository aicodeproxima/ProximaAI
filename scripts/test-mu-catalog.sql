-- Multi-user P4 gate, catalog half (docs/MULTI-USER-PLAN.md §5 P4): no second account may exist until this reports 0
-- FAIL. Reads only the catalog (policies, grants, function definitions): no table rows. Run alone, like test-rls-*.sql.
-- Expected until P4 ships: G1 (row USING admits any valid session) and G2 (no per-account storage folder) FAIL; the
-- rest PASS. The two-account behaviour half is scripts/test-mu-matrix.sql (P4).
do $pt$
declare
  r text[] := '{}'; n int; v text;
  data_tables text[] := array['tasks','history','settings','favorites','presets','sync_tombstones'];
  own text := 'device_id = \( SELECT proxima_auth\.session_scope\(';     -- the own-scope predicate, as pg_policies prints it
  -- Run before a session exists, by design (P1 adds unlock_with_backup_code; M4 drops the legacy unlock).
  pre_session text[] := array['verify_admin','unlock_with_backup_code','unlock_admin_with_backup_code'];
begin
  -- G1. Rows: every read / update / delete policy admits only the session's own rows.
  select count(*), string_agg(tablename || '.' || cmd, ', ' order by tablename, cmd) into n, v
    from pg_policies
   where schemaname = 'public' and tablename = any (data_tables) and cmd in ('SELECT','UPDATE','DELETE')
     and coalesce(qual, '') !~ own;
  r := r || format('%s G1 row policies scoped to the own account (%s admit any valid session%s)',
                   case when n = 0 then 'PASS' else 'FAIL' end, n, case when n > 0 then ': ' || v else '' end);

  -- G2. Files: every generations policy checks the account's own folder.
  select count(*), string_agg(cmd, ', ' order by cmd) into n, v
    from pg_policies
   where schemaname = 'storage' and tablename = 'objects' and policyname ilike 'generations%'
     and coalesce(qual, '') || coalesce(with_check, '') !~ 'storage\.foldername';
  r := r || format('%s G2 storage policies check the account folder (%s without%s)',
                   case when n = 0 then 'PASS' else 'FAIL' end, n, case when n > 0 then ': ' || v else '' end);

  -- G3. Every write lands in the session's own scope; tombstones have no browser write policy at all.
  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = any (data_tables) and tablename <> 'sync_tombstones'
     and cmd in ('INSERT','UPDATE') and coalesce(with_check, '') !~ own;
  r := r || format('%s G3 INSERT/UPDATE WITH CHECK pins the own scope (%s without)', case when n = 0 then 'PASS' else 'FAIL' end, n);
  select count(*) into n from pg_policies where schemaname = 'public' and tablename = 'sync_tombstones' and cmd <> 'SELECT';
  r := r || format('%s G3b sync_tombstones read-only for browsers (%s write policies)', case when n = 0 then 'PASS' else 'FAIL' end, n);

  -- G4. No definer function is executable through PUBLIC.
  select count(*), string_agg(p.proname, ', ') into n, v from pg_proc p
   where p.pronamespace in ('public'::regnamespace, 'proxima_auth'::regnamespace) and p.prosecdef
     and coalesce((select bool_or(a.grantee = 0) from aclexplode(p.proacl) a where a.privilege_type = 'EXECUTE'), true);
  r := r || format('%s G4 no definer function executable by PUBLIC (%s%s)', case when n = 0 then 'PASS' else 'FAIL' end, n, case when n > 0 then ': ' || v else '' end);

  -- G5. Every definer function pins search_path.
  select count(*), string_agg(p.proname, ', ') into n, v from pg_proc p
   where p.pronamespace in ('public'::regnamespace, 'proxima_auth'::regnamespace) and p.prosecdef
     and not coalesce(p.proconfig::text like '%search_path=%', false);
  r := r || format('%s G5 every definer function pins search_path (%s%s)', case when n = 0 then 'PASS' else 'FAIL' end, n, case when n > 0 then ': ' || v else '' end);

  -- G6. A definer function a browser can call verifies the session itself (or runs before one exists, by design).
  select count(*), string_agg(p.proname, ', ') into n, v from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.prosecdef and p.prokind = 'f'
     and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
     and p.proname <> all (pre_session)
     and pg_get_functiondef(p.oid) !~ '_verify_session_token|session_scope|current_account';
  r := r || format('%s G6 browser-callable definer functions check the session (%s do not%s)', case when n = 0 then 'PASS' else 'FAIL' end, n, case when n > 0 then ': ' || v else '' end);

  -- G7. No browser-callable definer function takes the account from its arguments (sign-in by name excepted).
  select count(*), string_agg(p.proname, ', ') into n, v from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.prosecdef and p.prokind = 'f'
     and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
     and p.proname <> all (array['verify_admin','unlock_with_backup_code'])   -- sign-in by name
     and pg_get_function_identity_arguments(p.oid) ~* 'p_username|p_device_id|p_scope|p_owner|p_user\M';
  r := r || format('%s G7 no browser-callable function takes an account argument (%s%s)', case when n = 0 then 'PASS' else 'FAIL' end, n, case when n > 0 then ': ' || v else '' end);

  -- G8. Views over account tables run with the caller's rights.
  select count(*), string_agg(c.relname, ', ') into n, v from pg_class c
   where c.relkind = 'v' and c.relnamespace in ('public'::regnamespace, 'proxima_auth'::regnamespace)
     and not coalesce('security_invoker=true' = any (c.reloptions), false);
  r := r || format('%s G8 every view is security_invoker (%s not%s)', case when n = 0 then 'PASS' else 'FAIL' end, n, case when n > 0 then ': ' || v else '' end);

  -- G9. Browser roles hold no DELETE / TRUNCATE / REFERENCES / TRIGGER on the data tables (deletes go through RPCs).
  select count(*) into n from unnest(data_tables) t, unnest(array['anon','authenticated']) g, unnest(array['DELETE','TRUNCATE','REFERENCES','TRIGGER']) pr
   where has_table_privilege(g, 'public.' || t, pr);
  r := r || format('%s G9 no DELETE/TRUNCATE/REFERENCES/TRIGGER for browser roles (%s grants)', case when n = 0 then 'PASS' else 'FAIL' end, n);

  -- G10. Row security is on for every data table, and tasks/history stay out of the Realtime publication.
  select count(*) into n from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname = any (data_tables) and not c.relrowsecurity;
  r := r || format('%s G10 row security enabled on the data tables (%s without)', case when n = 0 then 'PASS' else 'FAIL' end, n);
  select count(*) into n from pg_publication_tables where pubname = 'supabase_realtime' and tablename in ('tasks','history');
  r := r || format('%s G10b tasks/history not in supabase_realtime (%s)', case when n = 0 then 'PASS' else 'FAIL' end, n);

  -- G11. Every policy names its roles (never the implicit PUBLIC).
  select count(*) into n from pg_policies
   where ((schemaname = 'public' and tablename = any (data_tables))
          or (schemaname = 'storage' and tablename = 'objects' and policyname ilike 'generations%'))
     and roles::text like '%public%';
  r := r || format('%s G11 every policy names its roles (%s use PUBLIC)', case when n = 0 then 'PASS' else 'FAIL' end, n);

  raise exception 'RESULT: % PASS, % FAIL :: %',
    (select count(*) from unnest(r) x where x like 'PASS%'), (select count(*) from unnest(r) x where x like 'FAIL%'),
    array_to_string(r, ' | ');
end $pt$;
