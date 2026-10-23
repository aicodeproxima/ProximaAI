-- Tests for supabase/migrations/20261022100000_rls_phase0_session_helpers.sql, run as the roles that really call it.
-- Everything rolls back: the block always ends in an exception whose message is the result line. Before the migration
-- is applied, send the migration + this file as ONE query (one Management API call is one transaction); after, this
-- file alone. Tokens are minted inside the block and never printed. Fixtures use ids starting '__rls_probe_'.
do $pt$
declare
  u text;   -- the owner's name, set first thing below
  s text; p text := '__rls_probe_' || txid_current();
  t_good text; t_forged text; t_exp text; t_nonadmin text; v_topic text; v text;
  m0 int; m1 int; pl jsonb; r text[] := '{}';
  msgs int;
  users_live boolean := to_regclass('proxima_auth.users') is not null;   -- P1's M1 is applied
  topic_on_users boolean;                                                -- P1's M2 is applied
begin
  -- The owner: proxima_auth.users from P1's M1 on, app_secrets before it (this suite runs in both states).
  if to_regclass('proxima_auth.users') is not null then
    execute 'select username from proxima_auth.users where role = ''owner''' into u;
  else
    u := (select value->>'username' from public.app_secrets where key = 'admin_username');
  end if;
  s := 'user:' || u;
  t_good     := public._sign_session_token('admin:' || u, now() + interval '12 hours');
  t_forged   := left(t_good, -1) || case right(t_good, 1) when '0' then '1' else '0' end;
  t_exp      := public._sign_session_token('admin:' || u, now() - interval '1 minute');
  t_nonadmin := public._sign_session_token('svc:__rls', now() + interval '12 hours');
  v_topic    := proxima_auth.sync_topic();
  r := r || format('%s topic shape', case when v_topic ~ '^proxima-sync-[0-9a-f]{64}$' then 'PASS' else 'FAIL' end);
  r := r || format('%s get_my_account returns the topic', case when public.get_my_account(t_good)->>'sync_topic' = v_topic then 'PASS' else 'FAIL' end);
  r := r || format('%s get_my_account keeps its fields', case when (public.get_my_account(t_good)->>'username') = u
    and (public.get_my_account(t_good)->>'ok')::boolean then 'PASS' else 'FAIL' end);

  -- The helper as the app's role.
  execute 'set local role anon';
  perform set_config('request.headers', '{}', true);
  r := r || format('%s no header, lenient -> NULL', case when proxima_auth.session_scope(false) is null then 'PASS' else 'FAIL' end);
  begin perform proxima_auth.session_scope(true); r := r || text 'FAIL no header, strict returned';
  exception when sqlstate '28000' then r := r || format('%s no header, strict: %s', case when sqlerrm = 'session token missing' then 'PASS' else 'FAIL' end, sqlerrm); end;
  perform set_config('request.headers', 'not json', true);
  r := r || format('%s unparsable headers -> NULL', case when proxima_auth.session_scope(false) is null then 'PASS' else 'FAIL' end);
  perform set_config('request.headers', json_build_object('x-proxima-session', t_forged)::text, true);
  begin perform proxima_auth.session_scope(false); r := r || text 'FAIL forged returned';
  exception when sqlstate '28000' then r := r || format('%s forged: %s', case when sqlerrm = 'invalid signature' then 'PASS' else 'FAIL' end, sqlerrm); end;
  perform set_config('request.headers', json_build_object('x-proxima-session', t_exp)::text, true);
  begin perform proxima_auth.session_scope(false); r := r || text 'FAIL expired returned';
  exception when sqlstate '28000' then r := r || format('%s expired: %s', case when sqlerrm = 'session token expired' then 'PASS' else 'FAIL' end, sqlerrm); end;
  perform set_config('request.headers', json_build_object('x-proxima-session', t_nonadmin)::text, true);
  begin perform proxima_auth.session_scope(false); r := r || text 'FAIL non-admin returned';
  exception when sqlstate '28000' then r := r || format('%s non-admin: %s', case when sqlerrm in ('not admin-scoped', 'malformed session token') then 'PASS' else 'FAIL' end, sqlerrm); end;
  perform set_config('request.headers', json_build_object('x-proxima-session', t_good)::text, true);
  r := r || format('%s valid -> live scope', case when proxima_auth.session_scope(true) = s and proxima_auth.session_scope(false) = s then 'PASS' else 'FAIL' end);
  begin perform proxima_auth.sync_topic(); r := r || text 'FAIL anon can call sync_topic';
  exception when sqlstate '42501' then r := r || text 'PASS anon cannot call sync_topic'; end;
  execute 'reset role';
  execute 'set local role authenticated';
  perform set_config('request.headers', json_build_object('x-proxima-session', t_good)::text, true);
  r := r || format('%s authenticated valid -> live scope', case when proxima_auth.session_scope(true) = s then 'PASS' else 'FAIL' end);
  execute 'reset role';

  -- Pings: one per statement that changed rows, none for a statement that changed nothing; content-free.
  select count(*) into m0 from realtime.messages m where m.topic = v_topic;
  -- Browser roles write as anon; since 20261022350000 deletes run as the owner role (the delete RPCs do the same).
  execute 'set local role anon';
  insert into public.tasks (id, device_id, status) values (p || '_t', s, 'processing');                          -- +1
  update public.tasks set status = status where id = p || '_no_such_row';                                        -- +0
  execute 'reset role';
  delete from public.tasks where id = p || '_no_such_row';                                                       -- +0
  execute 'set local role anon';
  insert into public.tasks (id, device_id, status) values (p || '_t', s, 'completed')
    on conflict (id) do update set status = excluded.status;                                                     -- +1 (update part)
  insert into public.history (id, device_id) values (p || '_h', s);                                              -- +1
  execute 'reset role';
  delete from public.history where id = p || '_h';                                                               -- +1
  execute 'set local role anon';
  insert into public.history (id, device_id) values (p || '_h', s);                                              -- +0 (tombstoned: skipped)
  execute 'reset role';
  delete from public.tasks where id = p || '_t';                                                                 -- +1
  select count(*) into m1 from realtime.messages m where m.topic = v_topic;
  r := r || format('%s pings per changing statement (%s -> %s, want +5)', case when m1 = m0 + 5 then 'PASS' else 'FAIL' end, m0, m1);
  select count(*) into msgs from realtime.messages m where m.topic = v_topic and m.event = 'changed' and not m.private;
  r := r || format('%s pings are public "changed" events', case when msgs = m1 then 'PASS' else 'FAIL' end);
  select m.payload into pl from realtime.messages m where m.topic = v_topic order by m.inserted_at desc limit 1;
  r := r || format('%s ping is content-free (%s)', case when coalesce(pl, '{}'::jsonb) - 'id' = '{}'::jsonb then 'PASS' else 'FAIL' end, coalesce(pl::text, 'null'));
  select count(*) into msgs from public.tasks where id = p || '_t';
  r := r || format('%s writes still land and delete', case when msgs = 0 and exists (select 1 from public.sync_tombstones where id = p || '_t') then 'PASS' else 'FAIL' end);

  -- The topic rotates with a password change / backup unlock (valid_after bump); the old token is then revoked too.
  -- The epoch is app_secrets' admin_sessions_valid_after before P1's M1 and the owner row's from M1 (M1 freezes the
  -- app_secrets rows: a write raises 55000). sync_topic hashes the owner row only from M2, so in the M1-only window the
  -- topic stays until M2, and the suite asserts that.
  topic_on_users := users_live and pg_get_functiondef('proxima_auth.sync_topic()'::regprocedure) ~ 'proxima_auth\.users';
  if users_live then   -- from M1 the verifier reads the owner row's epoch
    execute 'update proxima_auth.users set sessions_valid_after = $1 where role = ''owner'''
      using extract(epoch from now())::bigint + 60;
  else
    insert into public.app_secrets (key, value)
      values ('admin_sessions_valid_after', jsonb_build_object('at', extract(epoch from now())::bigint + 60))
      on conflict (key) do update set value = excluded.value;
  end if;
  if users_live and not topic_on_users then
    r := r || format('%s valid_after bump leaves the topic until M2 (sync_topic still hashes the frozen rows)', case when proxima_auth.sync_topic() = v_topic then 'PASS' else 'FAIL' end);
  else
    r := r || format('%s valid_after bump rotates the topic', case when proxima_auth.sync_topic() <> v_topic then 'PASS' else 'FAIL' end);
  end if;
  execute 'set local role anon';
  perform set_config('request.headers', json_build_object('x-proxima-session', t_good)::text, true);
  begin perform proxima_auth.session_scope(false); r := r || text 'FAIL revoked returned';
  exception when sqlstate '28000' then r := r || format('%s revoked: %s', case when sqlerrm = 'session token revoked' then 'PASS' else 'FAIL' end, sqlerrm); end;
  execute 'reset role';

  raise exception 'RESULT: % PASS, % FAIL :: %',
    (select count(*) from unnest(r) x where x like 'PASS%'), (select count(*) from unnest(r) x where x like 'FAIL%'),
    array_to_string(r, ' | ');
end $pt$;
