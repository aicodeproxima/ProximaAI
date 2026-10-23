-- The restore-checked delete RPCs (lockdown session: 20261022300000, 20261022310000, 20261022320000) and the clock they
-- queue by (server_time_ms), called as anon the way the app calls them: every bad token is refused before anything
-- changes, a valid token reaches only its own scope (with a positive control: its own probes really go), and the
-- invoker helper _clear_kind is closed to browser roles. Everything rolls back, the valid-token clears included.
-- Run alone (live), like the other test-rls-*.sql files.
do $pt$
declare
  u text; tk text; sub text;   -- the owner's name, a fresh session token and its subject, set first thing below
  p text := '__rls_qrpc_' || txid_current();
  s text; o text; r text[] := '{}'; res json; j int; k int; ok boolean; ms bigint;
  t_good text; t_forged text; t_exp text; t_other text; t_nonadmin text; bad text[];
  lbl text[] := array['null','forged','expired','other-subject','non-admin','garbage'];
  msg text[] := array[null,'invalid signature','session token expired','session token revoked','forbidden','malformed session token'];
  rpcs text[] := array['delete_queued_rows','clear_queued_rows','reset_queued_rows','upsert_queued_history','server_time_ms'];
  qat bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint + 60000;   -- a queue time after any restore
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
  o := 'user:__rls_other_' || txid_current();
  t_good     := tk;
  t_forged   := left(t_good, -1) || case right(t_good, 1) when '0' then '1' else '0' end;
  t_exp      := public._sign_session_token(sub, now() - interval '1 minute');
  t_other    := public._sign_session_token('admin:__rls_not_admin', now() + interval '12 hours');
  t_nonadmin := public._sign_session_token('svc:__rls', now() + interval '12 hours');
  bad := array[null, t_forged, t_exp, t_other, t_nonadmin, 'garbage'];

  -- Seeds (owner role): a task and a History entry in the session's scope and in another scope.
  insert into public.tasks (id, device_id, status) values (p || '_t', s, 'completed'), (p || '_to', o, 'completed');
  insert into public.history (id, device_id) values (p || '_h', s), (p || '_ho', o);

  -- A. MUST REFUSE: every bad token, every RPC (the verifier's message, 'forbidden' for a non-admin subject, or ok:false).
  execute 'set local role anon';
  perform set_config('request.headers', json_build_object('x-proxima-session', t_good)::text, true);
  for k in 1..5 loop
    for j in 1..6 loop
      begin
        if k = 5 then   -- returns a bigint, not json: any answer at all is a refusal that did not happen
          ms := public.server_time_ms(bad[j]);
          r := r || format('FAIL %s %s: returned a time', rpcs[k], lbl[j]);
          continue;
        end if;
        res := case k
          when 1 then public.delete_queued_rows(bad[j], 'task', array[p || '_t'], qat)
          when 2 then public.clear_queued_rows(bad[j], 'task', qat, array[p || '_t'])
          when 3 then public.reset_queued_rows(bad[j], qat, array[p || '_t'], array[p || '_h'])
          else public.upsert_queued_history(bad[j], '[]'::jsonb, qat) end;
        r := r || format('%s %s %s: returned %s', case when coalesce((res->>'ok')::boolean, false) then 'FAIL' else 'PASS' end,
                         rpcs[k], lbl[j], left(res::text, 80));
      exception when others then
        r := r || format('%s %s %s: %s', case when msg[j] is null or sqlerrm = msg[j] or (lbl[j] = 'non-admin' and sqlerrm = 'malformed session token') then 'PASS' else 'FAIL' end,
                         rpcs[k], lbl[j], sqlerrm);
      end;
    end loop;
  end loop;
  ms := public.server_time_ms(t_good);   -- positive control: a valid session gets the database clock
  execute 'reset role';
  r := r || format('%s server_time_ms with a valid session is the database clock (off by %s ms)',
    case when abs(ms - (extract(epoch from clock_timestamp()) * 1000)::bigint) < 60000 then 'PASS' else 'FAIL' end,
    abs(ms - (extract(epoch from clock_timestamp()) * 1000)::bigint));
  r := r || format('%s refusals changed nothing (own seeds still there)',
    case when exists (select 1 from public.tasks where id = p || '_t')
          and exists (select 1 from public.history where id = p || '_h') then 'PASS' else 'FAIL' end);

  -- B. A valid token reaches only its own scope: another scope's named ids survive each path; its own probes go.
  execute 'set local role anon';
  res := public.delete_queued_rows(t_good, 'task', array[p || '_t', p || '_to'], qat);
  res := public.delete_queued_rows(t_good, 'history', array[p || '_h', p || '_ho'], qat);
  execute 'reset role';
  r := r || format('%s delete_queued_rows: own task + entry gone, other scope''s kept',
    case when not exists (select 1 from public.tasks where id = p || '_t') and not exists (select 1 from public.history where id = p || '_h')
          and exists (select 1 from public.tasks where id = p || '_to') and exists (select 1 from public.history where id = p || '_ho')
         then 'PASS' else 'FAIL' end);

  insert into public.tasks (id, device_id, status) values (p || '_t2', s, 'completed');
  insert into public.history (id, device_id) values (p || '_h2', s);
  execute 'set local role anon';
  res := public.clear_queued_rows(t_good, 'task', qat, array[p || '_to']);
  res := public.clear_queued_rows(t_good, 'history', qat, array[p || '_ho']);
  execute 'reset role';
  r := r || format('%s clear_queued_rows: own rows cleared, other scope''s named ids kept',
    case when not exists (select 1 from public.tasks where id = p || '_t2') and not exists (select 1 from public.history where id = p || '_h2')
          and exists (select 1 from public.tasks where id = p || '_to') and exists (select 1 from public.history where id = p || '_ho')
         then 'PASS' else 'FAIL' end);

  insert into public.tasks (id, device_id, status) values (p || '_t3', s, 'completed');
  insert into public.history (id, device_id) values (p || '_h3', s);
  execute 'set local role anon';
  res := public.reset_queued_rows(t_good, qat, array[p || '_to'], array[p || '_ho']);
  execute 'reset role';
  r := r || format('%s reset_queued_rows (voided=%s): own rows cleared, other scope''s named ids kept',
    case when coalesce((res->>'voided')::boolean, true) = false
          and not exists (select 1 from public.tasks where id = p || '_t3') and not exists (select 1 from public.history where id = p || '_h3')
          and exists (select 1 from public.tasks where id = p || '_to') and exists (select 1 from public.history where id = p || '_ho')
         then 'PASS' else 'FAIL' end, res->>'voided');

  -- C. The helper is closed to browser roles; the RPCs are not PUBLIC and pin search_path.
  select not prosecdef and not has_function_privilege('anon', oid, 'EXECUTE') and not has_function_privilege('authenticated', oid, 'EXECUTE')
         and not coalesce((select bool_or(a.grantee = 0) from aclexplode(proacl) a where a.privilege_type = 'EXECUTE'), true)
    into ok from pg_proc where oid = 'public._clear_kind(text,text,timestamptz,text[])'::regprocedure;
  r := r || format('%s _clear_kind: invoker, no EXECUTE for anon / authenticated / PUBLIC', case when ok then 'PASS' else 'FAIL' end);
  select count(*) = 0 into ok from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname = any (rpcs)
     and (coalesce((select bool_or(a.grantee = 0) from aclexplode(p.proacl) a where a.privilege_type = 'EXECUTE'), true)
          or not coalesce(p.proconfig::text like '%search_path=%', false));
  r := r || format('%s the %s RPCs: no PUBLIC EXECUTE, search_path pinned', case when ok then 'PASS' else 'FAIL' end, cardinality(rpcs));
  foreach o in array array['anon', 'authenticated'] loop
    execute format('set local role %I', o);
    begin
      perform public._clear_kind(s, 'task', now(), array[p || '_t3']);
      r := r || format('FAIL _clear_kind callable by %s', o);
    exception when sqlstate '42501' then   -- the function grant must stop it (the DELETE revoke alone would also raise 42501)
      r := r || format('%s _clear_kind refused for %s: %s', case when sqlerrm like 'permission denied for function%' then 'PASS' else 'FAIL' end, o, sqlerrm);
    end;
    execute 'reset role';
  end loop;

  raise exception 'RESULT: % PASS, % FAIL :: %',
    (select count(*) from unnest(r) x where x like 'PASS%'), (select count(*) from unnest(r) x where x like 'FAIL%'),
    array_to_string(r, ' | ');
end $pt$;
