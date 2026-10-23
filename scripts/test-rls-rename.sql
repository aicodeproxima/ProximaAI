-- Rename dry run under RLS phase 2 (rename_my_account itself needs the owner's password): do what it does as postgres,
-- then act as the app. Before P1's M1 that is a new admin_username plus the rows moved with proxima.rescope; from M1 it
-- is the owner row's name and scope, the same rows moved, and the owner's epoch bumped (M1 never writes the frozen
-- app_secrets rows). The new token reads and writes in the new scope; the old token is revoked; the reloaded app's
-- writes land in the new scope. The topic rotates with the rename before M1 and from M2 (sync_topic reads the owner
-- row); in the M1-only window it does not (sync_topic still hashes the frozen rows), and the suite asserts that.
-- All rolled back.
do $pt$
declare
  u text;    -- the owner's name, set first thing below
  o uuid;    -- the owner's id, from M1 on
  nu text := '__rls_renamed';
  t_old text; t_new text; n_live int; n int; topic_old text; rr text[] := '{}';
  m1 boolean := to_regclass('proxima_auth.users') is not null;
  m2 boolean;
begin
  -- The owner: proxima_auth.users from P1's M1 on, app_secrets before it (this suite runs in every state).
  m2 := m1 and pg_get_functiondef('proxima_auth.sync_topic()'::regprocedure) ~ 'proxima_auth\.users';
  if m1 then
    execute 'select id, username, proxima_auth.mint_token(id) from proxima_auth.users where role = ''owner''' into o, u, t_old;
  else
    u := (select value->>'username' from public.app_secrets where key = 'admin_username');
    t_old := public._sign_session_token('admin:' || u, now() + interval '12 hours');
  end if;
  topic_old := proxima_auth.sync_topic();
  select count(*) into n_live from public.tasks where device_id = 'user:' || u;
  -- what rename_my_account does (same statements, same flag)
  perform set_config('proxima.rescope', 'on', true);
  if m1 then   -- from M1 the owner row is the account: name and scope together, and the rename bumps its epoch
    execute 'update proxima_auth.users set username = $1, scope = $2 where id = $3' using nu, 'user:' || nu, o;
    execute 'select proxima_auth._revoke_sessions($1)' using o;
  else
    update public.app_secrets set value = jsonb_build_object('username', nu) where key = 'admin_username';
  end if;
  update public.tasks set device_id = 'user:' || nu where device_id = 'user:' || u;
  update public.history set device_id = 'user:' || nu where device_id = 'user:' || u;
  update public.settings set device_id = 'user:' || nu where device_id = 'user:' || u;
  update public.sync_tombstones set device_id = 'user:' || nu where device_id = 'user:' || u;
  perform set_config('proxima.rescope', 'off', true);
  if m1 then
    execute 'select proxima_auth.mint_token($1)' using o into t_new;
  else
    t_new := public._sign_session_token('admin:' || nu, now() + interval '12 hours');
  end if;
  if m1 and not m2 then
    rr := rr || format('%s topic unchanged until M2 (sync_topic still hashes the frozen rows)', case when proxima_auth.sync_topic() = topic_old then 'PASS' else 'FAIL' end);
  else
    rr := rr || format('%s topic rotates with the rename', case when proxima_auth.sync_topic() <> topic_old then 'PASS' else 'FAIL' end);
  end if;
  execute 'set local role anon';
  perform set_config('request.headers', json_build_object('x-proxima-session', t_new)::text, true);
  select count(*) into n from public.tasks where device_id = 'user:' || nu;
  rr := rr || format('%s new token reads the moved rows (%s/%s)', case when n = n_live then 'PASS' else 'FAIL' end, n, n_live);
  insert into public.settings (device_id, key, value) values ('user:' || nu, '__rls_rename', '1'::jsonb)
    on conflict (device_id, key) do update set value = excluded.value;
  rr := rr || text 'PASS new token writes in the new scope';
  begin
    insert into public.settings (device_id, key, value) values ('user:' || u, '__rls_rename_old', '1'::jsonb);
    rr := rr || text 'FAIL a stale write into the old scope was allowed';
  exception when sqlstate '42501' then rr := rr || text 'PASS a stale write into the old scope is refused (queued, not lost)'; end;
  perform set_config('request.headers', json_build_object('x-proxima-session', t_old)::text, true);
  begin
    select count(*) into n from public.tasks;
    rr := rr || text 'FAIL the old name''s token still reads';
  exception when sqlstate '28000' then rr := rr || format('%s old token refused: %s', case when sqlerrm = 'session token revoked' then 'PASS' else 'FAIL' end, sqlerrm); end;
  execute 'reset role';
  raise exception 'RESULT: % PASS, % FAIL :: %',
    (select count(*) from unnest(rr) x where x like 'PASS%'), (select count(*) from unnest(rr) x where x like 'FAIL%'),
    array_to_string(rr, ' | ');
end $pt$;
