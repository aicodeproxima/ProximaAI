-- Tests for supabase/migrations/20261022120000_rls_session_header.sql: every trigger path still works for the app's role
-- (anon with a valid token) under the new policies. Everything rolls back. Run like test-rls-tables.sql.
-- Since 20261022350000 browser roles have no DELETE: deletes go through delete_queued_rows, as the app's do.
do $pt$
declare
  u text;   -- the owner's name, set first thing below
  s text; p text := '__rls_probe_' || txid_current(); t_good text; r text[] := '{}'; n int; v text;
  qat bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint + 60000;   -- a queue time after any restore
begin
  -- The owner: proxima_auth.users from P1's M1 on, app_secrets before it (this suite runs in both states).
  if to_regclass('proxima_auth.users') is not null then
    execute 'select username from proxima_auth.users where role = ''owner''' into u;
  else
    u := (select value->>'username' from public.app_secrets where key = 'admin_username');
  end if;
  s := 'user:' || u;
  t_good := public._sign_session_token('admin:' || u, now() + interval '12 hours');
  insert into public.tasks (id, device_id)     values (p || '_orphan',  'user:__rls_orphan');   -- what a rename can leave behind
  insert into public.favorites (id, device_id) values (p || '_forphan', 'user:__rls_orphan');
  insert into public.history (id, device_id)   values (p || '_horphan', 'user:__rls_orphan');
  execute 'set local role anon';
  perform set_config('request.headers', json_build_object('x-proxima-session', t_good)::text, true);
  begin
    -- T1 upsert of an existing row updates it (keep_finished allows processing -> completed)
    insert into public.tasks (id, device_id, status) values (p || '_t', s, 'processing') on conflict (id) do update set status = excluded.status;
    insert into public.tasks (id, device_id, status) values (p || '_t', s, 'completed')  on conflict (id) do update set status = excluded.status;
    select status into v from public.tasks where id = p || '_t';
    r := r || format('%s T1 upsert existing row -> %s', case when v = 'completed' then 'PASS' else 'FAIL' end, v);
    -- T1b keep_finished: a stale 'processing' upsert never reopens a completed row
    insert into public.tasks (id, device_id, status) values (p || '_t', s, 'processing') on conflict (id) do update set status = excluded.status;
    select status into v from public.tasks where id = p || '_t';
    r := r || format('%s T1b completed row stays completed -> %s', case when v = 'completed' then 'PASS' else 'FAIL' end, v);
    -- T2 keep_owner rescue INTO the live scope: the existing row is another scope's; USING lets the conflict update through
    insert into public.tasks (id, device_id)     values (p || '_orphan',  s) on conflict (id) do update set device_id = excluded.device_id;
    insert into public.favorites (id, device_id) values (p || '_forphan', s) on conflict (id) do update set device_id = excluded.device_id;
    select count(*) into n from (select device_id from public.tasks where id = p || '_orphan'
                                 union all select device_id from public.favorites where id = p || '_forphan') x where x.device_id = s;
    r := r || format('%s T2 rescue into live scope (%s/2)', case when n = 2 then 'PASS' else 'FAIL' end, n);
    -- T3 PATCH-style move OUT: keep_owner restores the owner, WITH CHECK passes, the row stays in the live scope
    update public.tasks set device_id = 'user:__rls_other' where id = p || '_t';
    select device_id into v from public.tasks where id = p || '_t';
    r := r || format('%s T3 move-out kept owner', case when v = s then 'PASS' else 'FAIL' end);
  exception when others then r := r || format('FAIL T1-T3 raised %s %s', sqlstate, sqlerrm);
  end;
  -- T4 MUST DENY: an upsert proposing another scope for a NEW row fails the INSERT check
  begin
    insert into public.tasks (id, device_id) values (p || '_t4', 'user:__rls_other') on conflict (id) do update set device_id = excluded.device_id;
    r := r || text 'FAIL T4 other-scope insert allowed';
  exception when sqlstate '42501' then r := r || text 'PASS T4 other-scope insert refused';
            when others then r := r || format('FAIL T4 %s %s', sqlstate, sqlerrm);
  end;
  begin
    -- T5 a plain DELETE is refused (privilege); the app's delete (delete_queued_rows) records the tombstone
    begin
      delete from public.tasks where id = p || '_t';
      r := r || text 'FAIL T5a plain delete allowed';
    exception when sqlstate '42501' then r := r || text 'PASS T5a plain delete refused (privilege)';
    end;
    perform public.delete_queued_rows(t_good, 'task', array[p || '_t'], qat);
    select count(*) into n from public.sync_tombstones where id = p || '_t' and kind = 'task';
    r := r || format('%s T5 tombstone recorded', case when n = 1 then 'PASS' else 'FAIL' end);
    -- T6 not_tombstoned skip: re-insert of a tombstoned id is skipped, with no error and no row
    insert into public.tasks (id, device_id) values (p || '_t', s) on conflict (id) do update set device_id = excluded.device_id;
    select count(*) into n from public.tasks where id = p || '_t';
    r := r || format('%s T6 tombstoned re-insert skipped', case when n = 0 then 'PASS' else 'FAIL' end);
    -- T7 tombstone clear: with proxima.restore=on (set by restore_my_backup_phase2) the insert lands and sync_tombstone_clear
    --    (DEFINER) removes the tombstone, although browser roles have no DELETE on sync_tombstones
    perform set_config('proxima.restore', 'on', true);
    insert into public.tasks (id, device_id) values (p || '_t', s);
    perform set_config('proxima.restore', '', true);
    select count(*) into n from public.sync_tombstones where id = p || '_t';
    r := r || format('%s T7 tombstone cleared on restore insert', case when n = 0 and exists (select 1 from public.tasks where id = p || '_t') then 'PASS' else 'FAIL' end);
    -- T8 history: record + skip
    insert into public.history (id, device_id) values (p || '_h', s);
    perform public.delete_queued_rows(t_good, 'history', array[p || '_h'], qat);
    insert into public.history (id, device_id) values (p || '_h', s) on conflict (id) do update set device_id = excluded.device_id;
    select count(*) into n from public.sync_tombstones where id = p || '_h' and kind = 'history';
    r := r || format('%s T8 history tombstone + skip', case when n = 1 and not exists (select 1 from public.history where id = p || '_h') then 'PASS' else 'FAIL' end);
    -- T9 webhook take/settle/purge triggers (DEFINER, ws_webhook_events) run under the new policies
    insert into public.tasks (id, device_id, task_id, status) values (p || '_w', s, '__rls_no_such_prediction', 'processing');
    update public.tasks set status = 'completed' where id = p || '_w';
    perform public.delete_queued_rows(t_good, 'task', array[p || '_w'], qat);
    r := r || text 'PASS T9 webhook take/settle/purge triggers ran';
    -- T10 settings_drop_secrets (INVOKER) still drops apiKey
    insert into public.settings (device_id, key, value) values (s, 'apiKey', '"x"'::jsonb) on conflict (device_id, key) do update set value = excluded.value;
    select count(*) into n from public.settings where device_id = s and key = 'apiKey';
    r := r || format('%s T10 apiKey dropped', case when n = 0 then 'PASS' else 'FAIL' end);
    -- T11 the app's delete is scoped: another scope's row is out of its reach
    perform public.delete_queued_rows(t_good, 'history', array[p || '_horphan'], qat);
    r := r || format('%s T11 another scope''s row untouched by the scoped delete',
           case when exists (select 1 from public.history where id = p || '_horphan') then 'PASS' else 'FAIL' end);
    -- T12 the client's keyset id read and its scope-filtered pulls see the live rows
    select count(*) into n from public.tasks where device_id = s and id > '' ;
    r := r || format('%s T12 scope read sees live rows (%s)', case when n >= 2 then 'PASS' else 'FAIL' end, n);
  exception when others then r := r || format('FAIL T5-T12 raised %s %s', sqlstate, sqlerrm);
  end;
  execute 'reset role';
  -- T13 the SECURITY DEFINER RPCs and the cron job bodies run as postgres (BYPASSRLS): unaffected by the policies
  select count(*) into n from pg_roles where rolname = 'postgres' and rolbypassrls;
  r := r || format('%s T13 postgres bypasses RLS (cron, DEFINER RPCs/triggers)', case when n = 1 then 'PASS' else 'FAIL' end);
  select count(*) into n from pg_roles where rolname = 'service_role' and rolbypassrls;
  r := r || format('%s T14 service_role bypasses RLS (proxy, webhook)', case when n = 1 then 'PASS' else 'FAIL' end);
  raise exception 'RESULT: % PASS, % FAIL :: %',
    (select count(*) from unnest(r) x where x like 'PASS%'), (select count(*) from unnest(r) x where x like 'FAIL%'),
    array_to_string(r, ' | ');
end $pt$;
