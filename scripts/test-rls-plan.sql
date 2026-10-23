-- Plan shape under the phase-2 policies: the session check is an InitPlan / one-time filter, never a per-row SubPlan.
-- Send after phase 0 + phase 2 (or with them prepended), rolled back.
do $pt$
declare
  u text; tk text; sub text;   -- the owner's name, a fresh session token and its subject, set first thing below
  s text; t_good text; ln text; plan text; stmt text; r text[] := '{}';
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
  s := 'user:' || u;
  t_good := tk;
  execute 'set local role anon';
  perform set_config('request.headers', json_build_object('x-proxima-session', t_good)::text, true);
  foreach stmt in array array[
      format('insert into public.tasks (id, device_id) values (%L, %L) on conflict (id) do update set device_id = excluded.device_id', '__rls_explain', s),
      format('select id from public.tasks where device_id = %L order by id limit 1000', s),
      format('select id from public.sync_tombstones where device_id = %L and kind = %L order by id limit 1000', s, 'task'),
      format('update public.tasks set status = status where id = any (%L::text[]) and device_id = %L', '{__rls_explain}', s),
      'select name from storage.objects where bucket_id = ''generations'' limit 100'] loop
    plan := '';
    for ln in execute 'explain (costs off) ' || stmt loop plan := plan || ln || ' / '; end loop;
    r := r || format('%s %s :: %s', case when plan !~ 'SubPlan' and (split_part(stmt, ' ', 1) = 'insert' or plan ~ 'InitPlan|One-Time Filter')
                                    then 'PASS' else 'FAIL' end, split_part(stmt, ' ', 1), plan);
  end loop;
  execute 'reset role';
  raise exception 'RESULT: % PASS, % FAIL :: %',
    (select count(*) from unnest(r) x where x like 'PASS%'), (select count(*) from unnest(r) x where x like 'FAIL%'),
    array_to_string(r, ' || ');
end $pt$;
