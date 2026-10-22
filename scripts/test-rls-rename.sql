-- Rename dry run under RLS phase 2 (rename_my_account itself needs the owner's password): do what it does as postgres
-- (new admin_username, rows moved with proxima.rescope), then act as the app. The new name's token reads and writes in
-- the new scope; the old name's token is revoked; the reloaded app's writes land in the new scope. All rolled back.
do $pt$
declare
  u text := (select value->>'username' from public.app_secrets where key = 'admin_username');
  nu text := '__rls_renamed';
  t_old text; t_new text; n_live int; n int; topic_old text; rr text[] := '{}';
begin
  t_old := public._sign_session_token('admin:' || u, now() + interval '12 hours');
  topic_old := proxima_auth.sync_topic();
  select count(*) into n_live from public.tasks where device_id = 'user:' || u;
  -- what rename_my_account does (same statements, same flag)
  perform set_config('proxima.rescope', 'on', true);
  update public.app_secrets set value = jsonb_build_object('username', nu) where key = 'admin_username';
  update public.tasks set device_id = 'user:' || nu where device_id = 'user:' || u;
  update public.history set device_id = 'user:' || nu where device_id = 'user:' || u;
  update public.settings set device_id = 'user:' || nu where device_id = 'user:' || u;
  update public.sync_tombstones set device_id = 'user:' || nu where device_id = 'user:' || u;
  perform set_config('proxima.rescope', 'off', true);
  t_new := public._sign_session_token('admin:' || nu, now() + interval '12 hours');
  rr := rr || format('%s topic rotates with the rename', case when proxima_auth.sync_topic() <> topic_old then 'PASS' else 'FAIL' end);
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
