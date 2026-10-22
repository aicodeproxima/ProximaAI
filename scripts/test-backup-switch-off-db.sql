-- Tests for supabase/migrations/20261021175200_scrub_backups_when_switch_off.sql: switching Automatic backups OFF
-- scrubs every existing backup of everything deleted so far, rows a restore replaced included ("Scrub them too"), and
-- trims a backed-up History entry to the items its live version still has ("Yes, remove them"; owner rulings
-- 2026-10-22). Same harness as test-backup-scrub-db.sql. Run as "begin;" + 175100 (if not applied) + 175200 + this
-- file; after both are applied, this file alone. Fixtures only: 'user:__scrub_test', ids 'sz-'.
do $t$
declare
  out text := '';
  u constant text := 'user:__scrub_test';
  v_tok text; v_b uuid; v_p uuid; v_q uuid; r json; n int; ok boolean; h jsonb;
begin
  insert into app_secrets (key, value) values ('auto_backups', '{"enabled": true}')
    on conflict (key) do update set value = excluded.value;
  insert into tasks (id, device_id, status, start_time, outputs) values
    ('sz-a', u, 'completed', 1000, '["https://h/a.png"]'),
    ('sz-x', u, 'completed', 1000, '["https://h/x.png"]');
  insert into data_backups (username, backup_type, task_count, history_count, tasks_snapshot, history_snapshot)
    values (u, 'manual', 1, 0, (select jsonb_agg(row_to_json(t)) from tasks t where t.id = 'sz-a'), '[]')
    returning id into v_b;
  v_tok := _sign_session_token(u, now() + interval '5 minutes');

  -- 1. A restore (switch on) keeps a pre-restore backup and marks the tombstones it left.
  begin
    r := restore_my_backup_phase2(v_tok, v_b);
    select id into v_p from data_backups where username = u and backup_type = 'pre-restore';
    ok := r->>'ok' = 'true' and v_p is not null
      and (select array_agg(e->>'id' order by e->>'id') from data_backups b, jsonb_array_elements(b.tasks_snapshot) e where b.id = v_p) = '{sz-a,sz-x}'
      and (select by_restore from sync_tombstones where id = 'sz-x')
      and (select array_agg(id order by id) from tasks where device_id = u) = '{sz-a}';
    out := out || case when ok then 'ok restore-marks; ' else format('FAIL restore-marks %s; ', r) end;
  exception when others then out := out || format('FAIL restore-marks %s; ', sqlstate); end;

  -- 2. A real delete with the switch on queues nothing and is not marked as a restore's.
  begin
    delete from tasks where id = 'sz-a';
    out := out || case when not exists (select 1 from backup_scrub_queue where username = u)
      and (select by_restore from sync_tombstones where id = 'sz-a') = false
      then 'ok real-delete-on; ' else 'FAIL real-delete-on; ' end;
  exception when others then out := out || format('FAIL real-delete-on %s; ', sqlstate); end;

  -- 3. Switching off answers false.
  begin
    out := out || case when set_auto_backups(v_tok, false) = false then 'ok switch-off; ' else 'FAIL switch-off; ' end;
  exception when others then out := out || format('FAIL switch-off %s; ', sqlstate); end;

  -- 4. It queues one all-tombstones scrub for the account.
  begin
    n := (select count(*) from backup_scrub_queue where username = u and all_tombstones);
    out := out || case when n = 1 and (select count(*) from backup_scrub_queue where username = u) = 1
      then 'ok queued-all; ' else format('FAIL queued-all %s; ', n) end;
  exception when others then out := out || format('FAIL queued-all %s; ', sqlstate); end;

  -- 5. The drain removes the deleted generation from both backups, and the restore-replaced one from the pre-restore
  --    backup too ("Scrub them too").
  begin
    perform _drain_backup_scrubs(u);
    out := out || case when not exists (select 1 from data_backups b, jsonb_array_elements(b.tasks_snapshot) e
                                         where b.username = u and e->>'id' in ('sz-a', 'sz-x'))
      and not exists (select 1 from backup_scrub_queue where username = u)
      then 'ok scrubbed-all; ' else 'FAIL scrubbed-all; ' end;
  exception when others then out := out || format('FAIL scrubbed-all %s; ', sqlstate); end;

  -- 6. A second drain has nothing to do.
  begin
    n := _drain_backup_scrubs(u);
    out := out || case when n = 0 then 'ok idle; ' else format('FAIL idle %s; ', n) end;
  exception when others then out := out || format('FAIL idle %s; ', sqlstate); end;

  -- 7. Items deleted while the switch was on that left no tombstone (a task that never reached the cloud, an item
  --    without an id) leave a backed-up entry that is still live when the switch goes off ("Yes, remove them").
  begin
    update app_secrets set value = '{"enabled": true}' where key = 'auto_backups';
    insert into history (id, device_id, timestamp, tasks, total_cost) values
      ('sz-H', u, 1000, '[{"id":"sz-k","status":"completed","cost":1,"outputs":["https://h/k1.png"]},{"id":"sz-lost","status":"completed","cost":2,"outputs":["https://h/l.png"]},{"status":"completed","cost":3,"outputs":["https://h/z1.png"]}]', 6),
      ('sz-G', u, 1000, '[{"status":"completed","cost":4,"outputs":["https://h/g.png"]}]', 4);
    insert into data_backups (username, backup_type, task_count, history_count, tasks_snapshot, history_snapshot)
      values (u, 'manual', 0, 2, '[]', (select jsonb_agg(row_to_json(x)) from history x where x.id in ('sz-H', 'sz-G')))
      returning id into v_q;
    update history set tasks = '[{"id":"sz-k","status":"completed","cost":1,"outputs":["https://h/k1.png"]}]', total_cost = 1 where id = 'sz-H';
    perform set_auto_backups(v_tok, false);
    perform _drain_backup_scrubs(u);
    select history_snapshot into h from data_backups where id = v_q;
    out := out || case when (select jsonb_array_length(e->'tasks') from jsonb_array_elements(h) e where e->>'id' = 'sz-H') = 1
      and (select e->'tasks'->0->>'id' from jsonb_array_elements(h) e where e->>'id' = 'sz-H') = 'sz-k'
      and (select (e->>'total_cost')::numeric from jsonb_array_elements(h) e where e->>'id' = 'sz-H') = 1
      and (select jsonb_array_length(e->'tasks') from jsonb_array_elements(h) e where e->>'id' = 'sz-G') = 1
      and (select history_count from data_backups where id = v_q) = 2
      then 'ok live-items; ' else 'FAIL live-items; ' end;
  exception when others then out := out || format('FAIL live-items %s; ', sqlstate); end;

  raise exception 'RESULT: %', out;
end $t$;
