-- Tests for supabase/migrations/20261021175100_backup_scrub_on_delete.sql: while Automatic backups is off, deleted
-- generations, History entries and History items leave every backup (queued in the change's own transaction, drained by
-- cron and before any restore). Same harness as test-ws-webhook-db.sql: one DO block that always ends in an exception
-- whose message is the result line, so everything rolls back. Run before the migration exists as "begin;" + migration +
-- this file (node scripts/tools/sb-query.mjs --write -f <file>); after it is applied, this file alone. Fixtures only:
-- 'user:__scrub_test', ids 'sx-'. Each case catches its own errors (a missing object at HEAD is a FAIL with its SQLSTATE).
do $t$
declare
  out text := '';
  u constant text := 'user:__scrub_test';
  v_bk uuid; v_bk2 uuid; v_ctid tid; n int; r json; h jsonb; ok boolean;
begin
  insert into app_secrets (key, value) values ('auto_backups', '{"enabled": false}')
    on conflict (key) do update set value = excluded.value;
  insert into tasks (id, device_id, status, start_time, outputs) values
    ('sx-1', u, 'completed', 1000, '["https://h/1.png"]'),
    ('sx-2', u, 'completed', 1000, '["https://h/2.png"]'),
    ('sx-keep', u, 'completed', 1000, '[]');
  insert into history (id, device_id, timestamp, tasks, total_cost) values
    ('sx-L1', u, 1000, '[{"id":"sx-1","status":"completed","cost":1,"outputs":["https://h/1.png"]}]', 1),
    ('sx-L2', u, 1000, '[{"status":"completed","cost":2,"outputs":["https://h/2.png"]},{"status":"completed","cost":3,"outputs":["https://h/k.png"]}]', 5),
    ('sx-L3', u, 1000, '[{"id":"sx-keep","status":"completed","cost":1,"outputs":[]},{"id":"sx-u","status":"completed","cost":4,"outputs":["https://h/u.png"]}]', 5);
  insert into data_backups (username, backup_type, task_count, history_count, tasks_snapshot, history_snapshot)
    values (u, 'manual', 3, 3,
            (select jsonb_agg(row_to_json(t)) from tasks t where t.device_id = u),
            (select jsonb_agg(row_to_json(x)) from history x where x.device_id = u))
    returning id into v_bk;

  -- 1. Browser roles reach neither the queue nor the helpers.
  begin
    set local role anon;
    begin perform 1 from backup_scrub_queue; out := out || 'FAIL lock anon-read; ';
    exception when insufficient_privilege then null; end;
    begin perform _drain_backup_scrubs(); out := out || 'FAIL lock anon-drain; ';
    exception when insufficient_privilege then null; end;
    begin perform _scrub_backups('x', '{}', '{}', '{}'); out := out || 'FAIL lock anon-scrub; ';
    exception when insufficient_privilege then null; end;
    begin perform _jlen('[]'); out := out || 'FAIL lock anon-jlen; ';
    exception when insufficient_privilege then null; end;
    reset role; set local role authenticated;
    begin perform 1 from backup_scrub_queue; out := out || 'FAIL lock auth-read; ';
    exception when insufficient_privilege then null; end;
    begin perform _drain_backup_scrubs(); out := out || 'FAIL lock auth-drain; ';
    exception when insufficient_privilege then null; end;
    reset role;
    out := out || 'ok lock; ';
  exception when others then out := out || format('FAIL lock %s; ', sqlstate); end;

  -- 2. The trigger functions and the scrub run as their owner.
  begin
    select count(*) = 5 and bool_and(p.prosecdef) into ok from pg_proc p join pg_namespace s on s.oid = p.pronamespace
     where s.nspname = 'public' and p.proname in ('_tasks_queue_backup_scrub', '_history_queue_backup_scrub',
                                                  '_history_queue_item_scrub', '_drain_backup_scrubs', '_scrub_backups');
    out := out || case when ok then 'ok secdef; ' else 'FAIL secdef; ' end;
  exception when others then out := out || format('FAIL secdef %s; ', sqlstate); end;

  -- 3. One delete statement queues one row with the ids and the deleted rows' outputs.
  begin
    delete from tasks where id in ('sx-1', 'sx-2');
    n := (select count(*) from backup_scrub_queue where username = u
            and task_ids @> '{sx-1,sx-2}' and outputs @> '{https://h/2.png}');
    out := out || case when n = 1 and (select count(*) from backup_scrub_queue where username = u) = 1
      then 'ok delete-trigger; ' else format('FAIL delete-trigger %s; ', n) end;
  exception when others then out := out || format('FAIL delete-trigger %s; ', sqlstate); end;

  -- 4. The drain scrubs tasks by id, entries left empty, and id-less items by their outputs; total_cost recomputed.
  begin
    perform _drain_backup_scrubs(u);
    select history_snapshot into h from data_backups where id = v_bk;
    out := out || case when not exists (select 1 from backup_scrub_queue where username = u)
      and (select array_agg(e->>'id' order by e->>'id') from data_backups b, jsonb_array_elements(b.tasks_snapshot) e where b.id = v_bk) = '{sx-keep}'
      and not exists (select 1 from jsonb_array_elements(h) e where e->>'id' = 'sx-L1')
      and (select jsonb_array_length(e->'tasks') from jsonb_array_elements(h) e where e->>'id' = 'sx-L2') = 1
      and (select e->'tasks'->0->'outputs'->>0 from jsonb_array_elements(h) e where e->>'id' = 'sx-L2') = 'https://h/k.png'
      and (select (e->>'total_cost')::numeric from jsonb_array_elements(h) e where e->>'id' = 'sx-L2') = 3
      and (select jsonb_array_length(e->'tasks') from jsonb_array_elements(h) e where e->>'id' = 'sx-L3') = 2
      and (select task_count from data_backups where id = v_bk) = 1
      then 'ok drain; ' else 'FAIL drain; ' end;
  exception when others then out := out || format('FAIL drain %s; ', sqlstate); end;

  -- 5. A History rewrite that drops an item (here one whose task never reached the cloud) queues and scrubs it.
  begin
    update history set tasks = '[{"id":"sx-keep","status":"completed","cost":1,"outputs":[]}]', total_cost = 1 where id = 'sx-L3';
    n := (select count(*) from backup_scrub_queue where username = u and task_ids @> '{sx-u}');
    perform _drain_backup_scrubs(u);
    select history_snapshot into h from data_backups where id = v_bk;
    out := out || case when n = 1
      and (select jsonb_array_length(e->'tasks') from jsonb_array_elements(h) e where e->>'id' = 'sx-L3') = 1
      and (select (e->>'total_cost')::numeric from jsonb_array_elements(h) e where e->>'id' = 'sx-L3') = 1
      then 'ok update-trigger; ' else format('FAIL update-trigger %s; ', n) end;
  exception when others then out := out || format('FAIL update-trigger %s; ', sqlstate); end;

  -- 6. A deleted History entry leaves the backups.
  begin
    delete from history where id = 'sx-L2';
    perform _drain_backup_scrubs(u);
    out := out || case when not exists (select 1 from data_backups b, jsonb_array_elements(b.history_snapshot) e where b.id = v_bk and e->>'id' = 'sx-L2')
      then 'ok history-delete; ' else 'FAIL history-delete; ' end;
  exception when others then out := out || format('FAIL history-delete %s; ', sqlstate); end;

  -- 7. A restore's own deletes queue nothing.
  begin
    perform set_config('proxima.restore', 'on', true);
    delete from tasks where id = 'sx-keep';
    perform set_config('proxima.restore', 'off', true);
    out := out || case when not exists (select 1 from backup_scrub_queue where username = u)
      then 'ok restore-exempt; ' else 'FAIL restore-exempt; ' end;
  exception when others then out := out || format('FAIL restore-exempt %s; ', sqlstate); end;

  -- 8. With the switch on nothing is queued (the safety backup keeps the copy by design).
  begin
    update app_secrets set value = '{"enabled": true}' where key = 'auto_backups';
    insert into tasks (id, device_id, status, start_time, outputs) values ('sx-3', u, 'completed', 1000, '[]');
    delete from tasks where id = 'sx-3';
    update history set tasks = '[]', total_cost = 0 where id = 'sx-L1';
    out := out || case when not exists (select 1 from backup_scrub_queue where username = u)
      then 'ok switch-on; ' else 'FAIL switch-on; ' end;
    update app_secrets set value = '{"enabled": false}' where key = 'auto_backups';
  exception when others then out := out || format('FAIL switch-on %s; ', sqlstate); end;

  -- 9. An idle drain writes nothing.
  begin
    select ctid into v_ctid from data_backups where id = v_bk;
    n := _drain_backup_scrubs(u);
    out := out || case when n = 0 and (select ctid from data_backups where id = v_bk) = v_ctid
      then 'ok idle-drain; ' else format('FAIL idle-drain %s; ', n) end;
  exception when others then out := out || format('FAIL idle-drain %s; ', sqlstate); end;

  -- 10. Restore applies this account's queued scrubs first: a deleted generation never comes back through a backup.
  begin
    insert into tasks (id, device_id, status, start_time, outputs) values ('sx-r', u, 'completed', 1000, '[]');
    insert into data_backups (username, backup_type, task_count, history_count, tasks_snapshot, history_snapshot)
      values (u, 'manual', 1, 0, (select jsonb_agg(row_to_json(t)) from tasks t where t.device_id = u), '[]')
      returning id into v_bk2;
    insert into backup_scrub_queue (username, task_ids) values (u, '{sx-r}');
    r := restore_my_backup_phase2(_sign_session_token(u, now() + interval '5 minutes'), v_bk2);
    out := out || case when r->>'ok' = 'true' and not exists (select 1 from backup_scrub_queue where username = u)
      and not exists (select 1 from tasks where id = 'sx-r')
      then 'ok restore-drains-first; ' else format('FAIL restore-drains-first %s; ', r) end;
  exception when others then out := out || format('FAIL restore-drains-first %s; ', sqlstate); end;

  -- 11. A rename moves the account's backups; its queued scrubs follow.
  begin
    insert into backup_scrub_queue (username, task_ids) values (u, '{sx-z}');
    update data_backups set username = 'user:__scrub_test2' where username = u;
    out := out || case when exists (select 1 from backup_scrub_queue where username = 'user:__scrub_test2' and task_ids = '{sx-z}')
      and not exists (select 1 from backup_scrub_queue where username = u)
      then 'ok rename-follows; ' else 'FAIL rename-follows; ' end;
  exception when others then out := out || format('FAIL rename-follows %s; ', sqlstate); end;

  -- 12. Regression guard (passes at HEAD too): cached app builds can still call purge_my_backups_of.
  begin
    out := out || case when has_function_privilege('anon', 'public.purge_my_backups_of(text,text[],text[])', 'execute')
      then 'ok legacy-rpc; ' else 'FAIL legacy-rpc; ' end;
  exception when others then out := out || format('FAIL legacy-rpc %s; ', sqlstate); end;

  raise exception 'RESULT: %', out;
end $t$;
