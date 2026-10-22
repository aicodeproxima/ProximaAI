-- Tests for supabase/migrations/20261021175000_ws_webhook_deleted_predictions.sql: a WaveSpeed delivery for a deleted
-- prediction keeps nothing. Same harness as test-ws-webhook-db.sql: one DO block that always ends in an exception whose
-- message is the result line, so everything rolls back. Run before the migration exists by sending "begin;" + the
-- migration + this file in one query (node scripts/tools/sb-query.mjs --write -f <file>); after it is applied, this file
-- alone. Fixtures only: device_id 'webhook-test', task ids 'whd-*'. Each case catches its own errors (a missing table or
-- function at HEAD is a FAIL with its SQLSTATE, not an aborted run).
do $t$
declare
  out text := '';
  r text;
  n int;
  t record;
begin
  insert into tasks (id, device_id, status, start_time, task_id, outputs) values
    ('whd-run',  'webhook-test', 'processing', 1000, 'whd-pred-1', '[]'),
    ('whd-live', 'webhook-test', 'processing', 1000, 'whd-pred-6', '[]'),
    ('whd-rest', 'webhook-test', 'processing', 1000, 'whd-pred-3', '[]'),
    ('whd-back', 'webhook-test', 'processing', 1000, 'whd-pred-4', '[]');

  -- 1. Deleted while running; the result arrives afterwards: nothing is stored.
  begin
    delete from tasks where id = 'whd-run';
    set local role service_role;
    r := ws_webhook_apply('whd-m1', 'whd-pred-1', 'completed', '["https://cdn.example/d1.png"]', null, 5000);
    reset role;
    n := (select count(*) from ws_webhook_events where task_id = 'whd-pred-1');
    out := out || case when r = 'deleted' and n = 0 then 'ok late-result; ' else format('FAIL late-result %s %s; ', r, n) end;
  exception when others then out := out || format('FAIL late-result %s; ', sqlstate); end;

  -- 2. WaveSpeed's retry of the same delivery gets the same answer.
  begin
    set local role service_role;
    r := ws_webhook_apply('whd-m1', 'whd-pred-1', 'completed', '["https://cdn.example/d1.png"]', null, 5000);
    reset role;
    n := (select count(*) from ws_webhook_events where task_id = 'whd-pred-1');
    out := out || case when r = 'deleted' and n = 0 then 'ok late-replay; ' else format('FAIL late-replay %s %s; ', r, n) end;
  exception when others then out := out || format('FAIL late-replay %s; ', sqlstate); end;

  -- 3. A generation whose row never reached the cloud: the proxy records its delete, the stored delivery goes, and a
  --    later one is not kept.
  begin
    set local role service_role;
    r := ws_webhook_apply('whd-m2', 'whd-pred-2', 'completed', '["https://cdn.example/d2.png"]', null, 5500);
    perform ws_predictions_deleted(array['whd-pred-2']);
    n := (select count(*) from ws_webhook_events where task_id = 'whd-pred-2');
    reset role;
    if r <> 'queued' or n <> 0 then
      out := out || format('FAIL never-uploaded first %s %s; ', r, n);
    else
      set local role service_role;
      r := ws_webhook_apply('whd-m3', 'whd-pred-2', 'failed', null, 'boom', 6000);
      reset role;
      n := (select count(*) from ws_webhook_events where task_id = 'whd-pred-2');
      out := out || case when r = 'deleted' and n = 0 then 'ok never-uploaded; ' else format('FAIL never-uploaded %s %s; ', r, n) end;
    end if;
  exception when others then out := out || format('FAIL never-uploaded %s; ', sqlstate); end;

  -- 4. A recorded id whose row still exists is applied as before; the row's own delete then purges the delivery.
  begin
    set local role service_role;
    perform ws_predictions_deleted(array['whd-pred-6']);
    r := ws_webhook_apply('whd-m6', 'whd-pred-6', 'completed', '["https://cdn.example/d6.png"]', null, 7000);
    reset role;
    select * into t from tasks where id = 'whd-live';
    if r <> 'applied' or t.status <> 'completed' then
      out := out || format('FAIL row-still-there apply %s %s; ', r, t.status);
    else
      delete from tasks where id = 'whd-live';
      n := (select count(*) from ws_webhook_events where task_id = 'whd-pred-6');
      out := out || case when n = 0 then 'ok row-still-there; ' else format('FAIL row-still-there events %s; ', n) end;
    end if;
  exception when others then out := out || format('FAIL row-still-there %s; ', sqlstate); end;

  -- 5. A restore keeps deliveries for the rows it puts back; the sweep removes the ones for rows it did not.
  begin
    insert into ws_webhook_events (webhook_id, task_id, status, outputs, end_time) values
      ('whd-m3r', 'whd-pred-3', 'completed', '["https://cdn.example/d3.png"]', 8000),
      ('whd-m4r', 'whd-pred-4', 'completed', '["https://cdn.example/d4.png"]', 8000);
    perform set_config('proxima.restore', 'on', true);
    delete from tasks where id in ('whd-rest', 'whd-back');
    insert into tasks (id, device_id, status, start_time, task_id, outputs) values
      ('whd-back', 'webhook-test', 'processing', 1000, 'whd-pred-4', '[]');
    perform set_config('proxima.restore', 'off', true);
    perform ws_webhook_sweep();
    n := (select count(*) from ws_webhook_events where task_id = 'whd-pred-3');
    select * into t from tasks where id = 'whd-back';
    out := out || case when n = 0 and t.status = 'completed' and t.outputs = '["https://cdn.example/d4.png"]'
      and (select count(*) from ws_webhook_events where task_id = 'whd-pred-4' and applied_at is not null) = 1
      and (select count(*) from ws_webhook_events where task_id = 'whd-pred-4') = 1
      then 'ok restore-sweep; ' else format('FAIL restore-sweep %s %s; ', n, t.status) end;
  exception when others then out := out || format('FAIL restore-sweep %s; ', sqlstate); end;

  -- 6. Deletes are forgotten after 7 days; recent ones stay.
  begin
    insert into ws_deleted_predictions (task_id, deleted_at) values ('whd-old', now() - interval '8 days');
    perform ws_webhook_sweep();
    out := out || case when not exists (select 1 from ws_deleted_predictions where task_id = 'whd-old')
      and exists (select 1 from ws_deleted_predictions where task_id = 'whd-pred-1')
      then 'ok prune; ' else 'FAIL prune; ' end;
  exception when others then out := out || format('FAIL prune %s; ', sqlstate); end;

  -- 7. A delivery waiting for a row that has not been uploaded yet is untouched (and survives a sweep while fresh).
  begin
    set local role service_role;
    r := ws_webhook_apply('whd-m5', 'whd-pred-5', 'completed', '["https://cdn.example/d5.png"]', null, 9000);
    reset role;
    perform ws_webhook_sweep();
    n := (select count(*) from ws_webhook_events where task_id = 'whd-pred-5' and outputs is not null);
    out := out || case when r = 'queued' and n = 1 then 'ok untouched-waiting; ' else format('FAIL untouched-waiting %s %s; ', r, n) end;
  exception when others then out := out || format('FAIL untouched-waiting %s; ', sqlstate); end;

  -- 8. Owner ruling 2026-10-22: a delivery that has waited more than 2 days for a row that never came is removed by every
  --    sweep, not kept 30 days; one waiting a little over a day is not.
  begin
    insert into ws_webhook_events (webhook_id, task_id, status, outputs, end_time, received_at) values
      ('whd-m7', 'whd-pred-7', 'completed', '["https://cdn.example/d7.png"]', 9000, now() - interval '3 days'),
      ('whd-m8', 'whd-pred-8', 'completed', '["https://cdn.example/d8.png"]', 9000, now() - interval '25 hours');
    perform ws_webhook_sweep();
    out := out || case when not exists (select 1 from ws_webhook_events where task_id = 'whd-pred-7')
      and exists (select 1 from ws_webhook_events where task_id = 'whd-pred-8')
      then 'ok orphan-2-days; ' else 'FAIL orphan-2-days; ' end;
  exception when others then out := out || format('FAIL orphan-2-days %s; ', sqlstate); end;

  -- 9. Browser roles reach neither the list nor the recording function.
  set local role anon;
  begin perform 1 from ws_deleted_predictions; out := out || 'FAIL anon-read; ';
  exception when insufficient_privilege then out := out || 'ok anon-read; ';
            when others then out := out || format('FAIL anon-read %s; ', sqlstate); end;
  begin perform ws_predictions_deleted(array['x']); out := out || 'FAIL anon-exec; ';
  exception when insufficient_privilege then out := out || 'ok anon-exec; ';
            when others then out := out || format('FAIL anon-exec %s; ', sqlstate); end;
  reset role; set local role authenticated;
  begin perform 1 from ws_deleted_predictions; out := out || 'FAIL auth-read; ';
  exception when insufficient_privilege then out := out || 'ok auth-read; ';
            when others then out := out || format('FAIL auth-read %s; ', sqlstate); end;
  begin perform ws_predictions_deleted(array['x']); out := out || 'FAIL auth-exec; ';
  exception when insufficient_privilege then out := out || 'ok auth-exec; ';
            when others then out := out || format('FAIL auth-exec %s; ', sqlstate); end;
  reset role;

  raise exception 'RESULT: %', out;
end $t$;
