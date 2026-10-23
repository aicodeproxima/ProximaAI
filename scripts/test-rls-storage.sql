-- Tests for supabase/migrations/20261022120000_rls_session_header.sql on storage.objects (bucket 'generations'), as the
-- roles the Storage API uses for browser requests. Everything rolls back. Setting storage.allow_delete_query lets SQL past
-- storage.protect_delete; the API path itself is checked live with an isolated probe bucket. Run like test-rls-tables.sql.
do $pt$
declare
  u text; tk text; sub text;   -- the owner's name, a fresh session token and its subject, set first thing below
  p text := '__rls_probe_' || txid_current();
  t_good text; t_forged text; t_exp text; t_other text; t_nonadmin text;
  bad text[]; bad_lbl text[] := array['forged','expired','other-subject','non-admin','garbage'];
  bad_msg text[] := array['invalid signature','session token expired','session token revoked','not admin-scoped','malformed session token'];
  total int; r text[] := '{}'; n int; j int; stmt text; verb text;
begin
  -- The owner: proxima_auth.users from P1's M1 on, app_secrets before it (this suite runs in every P1 state). From M1
  -- the session is minted by proxima_auth.mint_token the way the app's sign-in mints it ('u:' from M3), so the suite
  -- keeps working after M4 retires 'admin:' tokens.
  if to_regclass('proxima_auth.users') is not null then
    execute 'select username, proxima_auth.mint_token(id), ''u:'' || id from proxima_auth.users where role = ''owner'''
      into u, tk, sub;
  else
    u := (select value->>'username' from public.app_secrets where key = 'admin_username');
    sub := 'admin:' || u;
    tk := public._sign_session_token(sub, now() + interval '12 hours');
  end if;
  t_good     := tk;
  t_forged   := left(t_good, -1) || case right(t_good, 1) when '0' then '1' else '0' end;
  t_exp      := public._sign_session_token(sub, now() - interval '1 minute');
  t_other    := public._sign_session_token('admin:__rls_not_admin', now() + interval '12 hours');
  t_nonadmin := public._sign_session_token('svc:__rls', now() + interval '12 hours');
  bad := array[t_forged, t_exp, t_other, t_nonadmin, 'garbage'];
  perform set_config('storage.allow_delete_query', 'true', true);
  insert into storage.objects (bucket_id, name) values ('generations', p || '/seed');
  select count(*) into total from storage.objects where bucket_id = 'generations';
  execute 'set local role anon';
  -- MUST DENY without a header: the list is empty (lenient read); upload, overwrite and delete raise 28000
  perform set_config('request.headers', '{}', true);
  select count(*) into n from storage.objects where bucket_id = 'generations';
  r := r || format('%s storage no-header select=%s', case when n = 0 then 'PASS' else 'FAIL' end, n);
  foreach stmt in array array[
      format('insert into storage.objects (bucket_id, name) values (%L, %L)', 'generations', p || '/x'),
      format('update storage.objects set metadata = %L::jsonb where bucket_id = %L and name = %L', '{}', 'generations', p || '/seed'),
      format('delete from storage.objects where bucket_id = %L and name = %L', 'generations', p || '/seed')] loop
    verb := split_part(stmt, ' ', 1);
    begin
      execute stmt;
      get diagnostics n = row_count;
      r := r || format('FAIL storage no-header %s allowed rows=%s', verb, n);
    exception when sqlstate '28000' then r := r || format('PASS storage no-header %s', verb);
              when others then r := r || format('FAIL storage no-header %s: %s %s', verb, sqlstate, sqlerrm); end;
  end loop;
  -- MUST DENY: bad tokens raise 28000 with the right message on read and write
  for j in 1..5 loop
    perform set_config('request.headers', json_build_object('x-proxima-session', bad[j])::text, true);
    foreach stmt in array array[
        'select count(*) from storage.objects where bucket_id = ''generations''',
        format('insert into storage.objects (bucket_id, name) values (%L, %L)', 'generations', p || '/x'),
        format('delete from storage.objects where bucket_id = %L and name = %L', 'generations', p || '/seed')] loop
      verb := split_part(stmt, ' ', 1);
      begin execute stmt; r := r || format('FAIL storage %s %s allowed', bad_lbl[j], verb);
      exception when sqlstate '28000' then r := r || format('%s storage %s %s: %s',
                  case when sqlerrm = bad_msg[j] or (bad_lbl[j] = 'non-admin' and sqlerrm = 'malformed session token') then 'PASS' else 'FAIL' end, bad_lbl[j], verb, sqlerrm);
                when others then r := r || format('FAIL storage %s %s: %s %s', bad_lbl[j], verb, sqlstate, sqlerrm); end;
    end loop;
  end loop;
  -- MUST ALLOW with a valid token: list, upload, overwrite (archive upsert path), delete
  perform set_config('request.headers', json_build_object('x-proxima-session', t_good)::text, true);
  begin
    select count(*) into n from storage.objects where bucket_id = 'generations';
    r := r || format('%s storage valid select=%s expected=%s', case when n = total then 'PASS' else 'FAIL' end, n, total);
    insert into storage.objects (bucket_id, name) values ('generations', p || '/new');
    update storage.objects set metadata = '{"probe":1}'::jsonb where bucket_id = 'generations' and name = p || '/new';
    get diagnostics n = row_count;
    r := r || format('%s storage valid insert+update rows=%s', case when n = 1 then 'PASS' else 'FAIL' end, n);
    delete from storage.objects where bucket_id = 'generations' and name in (p || '/new', p || '/seed');
    get diagnostics n = row_count;
    r := r || format('%s storage valid delete rows=%s', case when n = 2 then 'PASS' else 'FAIL' end, n);
  exception when others then r := r || format('FAIL storage valid raised %s %s', sqlstate, sqlerrm);
  end;
  -- Other buckets are untouched by these policies (none exist today; a valid session gets nothing outside 'generations')
  begin
    insert into storage.objects (bucket_id, name) values ('__rls_other_bucket', p || '/o');
    r := r || text 'FAIL storage insert into another bucket allowed';
  exception when others then r := r || format('PASS storage insert into another bucket refused (%s)', sqlstate);
  end;
  execute 'reset role';
  execute 'set local role authenticated';
  perform set_config('request.headers', json_build_object('x-proxima-session', t_good)::text, true);
  select count(*) into n from storage.objects where bucket_id = 'generations';
  r := r || format('%s storage authenticated valid select=%s', case when n = total - 1 then 'PASS' else 'FAIL' end, n);
  perform set_config('request.headers', '{}', true);
  begin insert into storage.objects (bucket_id, name) values ('generations', p || '/a'); r := r || text 'FAIL storage authenticated no-header insert allowed';
  exception when sqlstate '28000' then r := r || text 'PASS storage authenticated no-header insert refused';
            when others then r := r || format('FAIL storage authenticated no-header insert: %s %s', sqlstate, sqlerrm); end;
  execute 'reset role';
  raise exception 'RESULT: % PASS, % FAIL :: %',
    (select count(*) from unnest(r) x where x like 'PASS%'), (select count(*) from unnest(r) x where x like 'FAIL%'),
    array_to_string(r, ' | ');
end $pt$;
