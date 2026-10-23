-- Tests for supabase/migrations/20261020211205_ws_webhook_events.sql, as the roles that really call it (anon = the
-- app, service_role = api/ws-webhook.ts). Everything rolls back: the block always ends in an exception whose message
-- is the result line. Run before the migration exists by sending "begin;" + the migration + this file in one query;
-- after it is applied, this file alone. Upserts are written the way PostgREST sends the app's rows: every column
-- from `excluded`. Since RLS phase 2 (20261022120000) the app writes as a signed-in device: the block mints a session
-- token for the owner (never printed) and sends it as x-proxima-session, and fixtures live in that account's scope
-- (ids 'wh-*'; everything rolls back, so no device ever sees them). The owner comes from proxima_auth.users from P1's
-- M1 on (a rename then writes only that row), from app_secrets before it.
do $t$
declare
  scope text;
  tok text;
  out text := '';
  r text;
  t record;
  ev record;
begin
  if to_regclass('proxima_auth.users') is not null then
    execute 'select scope, proxima_auth.mint_token(id) from proxima_auth.users where role = ''owner''' into scope, tok;
  else
    scope := 'user:' || (select value->>'username' from app_secrets where key = 'admin_username');
    tok := _sign_session_token('admin:' || (select value->>'username' from app_secrets where key = 'admin_username'), now() + interval '12 hours');
  end if;
  perform set_config('request.headers', json_build_object('x-proxima-session', tok)::text, true);
  insert into tasks (id, device_id, status, start_time, task_id, outputs) values
    ('wh-run',  scope, 'processing', 1000, 'wh-pred-run',  '[]'),
    ('wh-done', scope, 'completed',  1000, 'wh-pred-done', '["https://perm.example/a.png"]'),
    ('wh-fail', scope, 'processing', 1000, 'wh-pred-fail', '[]'),
    ('wh-orph', scope, 'pending',    3000, null,           '[]');

  -- Browser roles reach neither the table nor the function.
  set local role anon;
  begin perform 1 from ws_webhook_events; out := out || 'FAIL anon-read; ';
  exception when insufficient_privilege then out := out || 'ok anon-read; '; end;
  begin perform ws_webhook_apply('m0', 'wh-pred-run', 'completed', '["x"]', null, 5000); out := out || 'FAIL anon-exec; ';
  exception when insufficient_privilege then out := out || 'ok anon-exec; '; end;
  reset role; set local role authenticated;
  begin perform ws_webhook_apply('m0', 'wh-pred-run', 'completed', '["x"]', null, 5000); out := out || 'FAIL auth-exec; ';
  exception when insufficient_privilege then out := out || 'ok auth-exec; '; end;

  -- Service role: a running row finishes with the delivery.
  reset role; set local role service_role;
  r := ws_webhook_apply('m1', 'wh-pred-run', 'completed', '["https://cdn.example/r.png"]', null, 61000, 1500, '[false]');
  reset role;
  select * into t from tasks where id = 'wh-run';
  select * into ev from ws_webhook_events where webhook_id = 'm1';
  out := out || case when r = 'applied' and t.status = 'completed' and t.outputs = '["https://cdn.example/r.png"]'
    and t.end_time = 61000 and t.wall_clock_ms = 60000 and t.inference_ms = 1500 and t.nsfw = '[false]' and t.error is null
    and ev.applied_at is not null and ev.outputs is null
    then 'ok apply; ' else format('FAIL apply %s %s %s; ', r, t.status, t.wall_clock_ms) end;

  -- Replay of the same webhook id after the archive swapped in permanent URLs: nothing changes.
  update tasks set outputs = '["https://perm.example/r.png"]' where id = 'wh-run';
  set local role service_role;
  r := ws_webhook_apply('m1', 'wh-pred-run', 'completed', '["https://cdn.example/r.png"]', null, 99000);
  reset role;
  select * into t from tasks where id = 'wh-run';
  out := out || case when r = 'duplicate' and t.outputs = '["https://perm.example/r.png"]' and t.end_time = 61000
    then 'ok replay; ' else format('FAIL replay %s %s; ', r, t.outputs) end;

  -- A finished row is never overwritten, not even by a different delivery.
  set local role service_role;
  r := ws_webhook_apply('m2', 'wh-pred-done', 'failed', null, 'late failure', 70000);
  reset role;
  select * into t from tasks where id = 'wh-done';
  select * into ev from ws_webhook_events where webhook_id = 'm2';
  out := out || case when r = 'finished' and t.status = 'completed' and t.outputs = '["https://perm.example/a.png"]' and t.error is null
    and ev.applied_at is not null
    then 'ok finished; ' else format('FAIL finished %s %s; ', r, t.status) end;

  -- A failure keeps the row's outputs and records WaveSpeed's error.
  set local role service_role;
  r := ws_webhook_apply('m3', 'wh-pred-fail', 'failed', null, 'NSFW content detected', 4000);
  reset role;
  select * into t from tasks where id = 'wh-fail';
  out := out || case when r = 'applied' and t.status = 'failed' and t.error = 'NSFW content detected' and t.outputs = '[]'
    and t.end_time = 4000 and t.wall_clock_ms = 3000 and t.inference_ms = 3000
    then 'ok fail; ' else format('FAIL fail %s %s %s; ', r, t.status, t.error) end;

  -- The delivery beats the row: it waits, and the app's later "processing" upsert (anon) lands finished.
  set local role service_role;
  r := ws_webhook_apply('m4', 'wh-pred-late', 'completed', '["https://cdn.example/late.png"]', null, 12000, 800, null);
  out := out || case when r = 'queued' then 'ok queued; ' else format('FAIL queued %s; ', r) end;
  set local role anon;
  insert into tasks (id, device_id, status, start_time, task_id, outputs, error, end_time, wall_clock_ms, inference_ms, nsfw)
    values ('wh-late', scope, 'processing', 2000, 'wh-pred-late', '[]', null, null, 0, 0, null)
    on conflict (id) do update set status = excluded.status, task_id = excluded.task_id, outputs = excluded.outputs, error = excluded.error,
      start_time = excluded.start_time, end_time = excluded.end_time, wall_clock_ms = excluded.wall_clock_ms,
      inference_ms = excluded.inference_ms, nsfw = excluded.nsfw;
  reset role;
  select * into t from tasks where id = 'wh-late';
  select * into ev from ws_webhook_events where webhook_id = 'm4';
  out := out || case when t.status = 'completed' and t.outputs = '["https://cdn.example/late.png"]' and t.end_time = 12000
    and t.wall_clock_ms = 10000 and t.inference_ms = 800 and ev.applied_at is not null and ev.outputs is null
    then 'ok late-insert; ' else format('FAIL late-insert %s %s; ', t.status, t.outputs) end;

  -- A lost submit adopted later (pending row, no task_id, gets the id by the history lookup): the update path applies it.
  set local role service_role;
  r := ws_webhook_apply('m5', 'wh-pred-orph', 'completed', '["https://cdn.example/o.png"]', null, 9000);
  set local role anon;
  insert into tasks (id, device_id, status, start_time, task_id, outputs, error, end_time, wall_clock_ms, inference_ms, nsfw)
    values ('wh-orph', scope, 'processing', 3000, 'wh-pred-orph', '[]', null, null, 0, 0, null)
    on conflict (id) do update set status = excluded.status, task_id = excluded.task_id, outputs = excluded.outputs, error = excluded.error,
      start_time = excluded.start_time, end_time = excluded.end_time, wall_clock_ms = excluded.wall_clock_ms,
      inference_ms = excluded.inference_ms, nsfw = excluded.nsfw;
  reset role;
  select * into t from tasks where id = 'wh-orph';
  out := out || case when r = 'queued' and t.status = 'completed' and t.outputs = '["https://cdn.example/o.png"]' and t.wall_clock_ms = 6000
    then 'ok adopt; ' else format('FAIL adopt %s %s; ', r, t.status) end;

  -- A stale "processing" upload of the finished row stays finished (tasks_keep_finished runs first).
  set local role anon;
  insert into tasks (id, device_id, status, start_time, task_id, outputs, error, end_time, wall_clock_ms, inference_ms, nsfw)
    values ('wh-run', scope, 'processing', 1000, 'wh-pred-run', '[]', null, null, 0, 0, null)
    on conflict (id) do update set status = excluded.status, task_id = excluded.task_id, outputs = excluded.outputs, error = excluded.error,
      start_time = excluded.start_time, end_time = excluded.end_time, wall_clock_ms = excluded.wall_clock_ms,
      inference_ms = excluded.inference_ms, nsfw = excluded.nsfw;
  reset role;
  select * into t from tasks where id = 'wh-run';
  out := out || case when t.status = 'completed' and t.outputs = '["https://perm.example/r.png"]'
    then 'ok keep-finished; ' else format('FAIL keep-finished %s %s; ', t.status, t.outputs) end;

  -- An applied delivery is not applied again to another running row with the same id; rows with no delivery and
  -- pending rows without an id are untouched.
  set local role anon;
  insert into tasks (id, device_id, status, start_time, task_id, outputs) values
    ('wh-copy',  scope, 'processing', 1000, 'wh-pred-run',  '[]'),
    ('wh-plain', scope, 'processing', 1000, 'wh-pred-none', '[]'),
    ('wh-pend',  scope, 'pending',    1000, null,           '[]');
  reset role;
  out := out || case when (select count(*) from tasks where id in ('wh-copy', 'wh-plain') and status = 'processing') = 2
    and (select status from tasks where id = 'wh-pend') = 'pending'
    then 'ok untouched; ' else 'FAIL untouched; ' end;

  -- Adoption by a plain UPDATE of the id (no upsert): the waiting delivery applies on the update path.
  set local role service_role;
  r := ws_webhook_apply('m7', 'wh-pred-upd', 'failed', null, 'Generation failed', 8000);
  set local role anon;
  update tasks set task_id = 'wh-pred-upd', status = 'processing' where id = 'wh-pend';
  reset role;
  select * into t from tasks where id = 'wh-pend';
  select * into ev from ws_webhook_events where webhook_id = 'm7';
  out := out || case when r = 'queued' and t.status = 'failed' and t.error = 'Generation failed' and t.end_time = 8000
    and ev.applied_at is not null
    then 'ok adopt-update; ' else format('FAIL adopt-update %s %s; ', r, t.status) end;

  -- The device's own poll answer lands first: it stays, and it settles the waiting delivery.
  set local role service_role;
  r := ws_webhook_apply('m8', 'wh-pred-own', 'completed', '["https://cdn.example/hook.png"]', null, 5000);
  set local role anon;
  insert into tasks (id, device_id, status, start_time, task_id, outputs, end_time)
    values ('wh-own', scope, 'completed', 1000, 'wh-pred-own', '["https://cdn.example/poll.png"]', 4500);
  reset role;
  select * into t from tasks where id = 'wh-own';
  select * into ev from ws_webhook_events where webhook_id = 'm8';
  out := out || case when r = 'queued' and t.outputs = '["https://cdn.example/poll.png"]' and t.end_time = 4500
    and ev.applied_at is not null and ev.outputs is null
    then 'ok own-first; ' else format('FAIL own-first %s %s; ', r, t.outputs) end;

  -- A result replaces a failure (as everywhere else: tasks_keep_finished, planTaskSync): a cloud row a device failed
  -- with "Poll error" (or a cancel) takes the completed delivery; a failed delivery never replaces anything finished.
  insert into tasks (id, device_id, status, start_time, task_id, outputs, error) values
    ('wh-pe',  scope, 'failed', 1000, 'wh-pred-pe',  '[]', 'Poll error'),
    ('wh-pe2', scope, 'failed', 1000, 'wh-pred-pe2', '[]', 'Poll error');
  set local role service_role;
  r := ws_webhook_apply('m9', 'wh-pred-pe', 'completed', '["https://cdn.example/pe.png"]', null, 7000);
  reset role;
  select * into t from tasks where id = 'wh-pe';
  out := out || case when r = 'applied' and t.status = 'completed' and t.outputs = '["https://cdn.example/pe.png"]' and t.error is null
    then 'ok completed-over-failed; ' else format('FAIL completed-over-failed %s %s; ', r, t.status) end;
  set local role service_role;
  r := ws_webhook_apply('m10', 'wh-pred-pe2', 'failed', null, 'Generation failed', 7000);
  reset role;
  select * into t from tasks where id = 'wh-pe2';
  out := out || case when r = 'finished' and t.status = 'failed' and t.error = 'Poll error'
    then 'ok failed-keeps-failed; ' else format('FAIL failed-keeps-failed %s %s; ', r, t.error) end;

  -- Queued result, then the device's failed (cancelled) row lands: it takes the result. Queued failure, then the
  -- device's completed row lands: it stays completed, and the delivery is settled.
  set local role service_role;
  r := ws_webhook_apply('m11', 'wh-pred-cx', 'completed', '["https://cdn.example/cx.png"]', null, 6000);
  perform ws_webhook_apply('m12', 'wh-pred-ok', 'failed', null, 'Generation failed', 6000);
  set local role anon;
  insert into tasks (id, device_id, status, start_time, task_id, outputs, error, end_time, wall_clock_ms, inference_ms, nsfw)
    values ('wh-cx', scope, 'failed', 1000, 'wh-pred-cx', '[]', 'Cancelled', 5000, 4000, 4000, null),
           ('wh-ok', scope, 'completed', 1000, 'wh-pred-ok', '["https://cdn.example/ok.png"]', null, 5000, 4000, 4000, null)
    on conflict (id) do update set status = excluded.status, task_id = excluded.task_id, outputs = excluded.outputs, error = excluded.error,
      start_time = excluded.start_time, end_time = excluded.end_time, wall_clock_ms = excluded.wall_clock_ms,
      inference_ms = excluded.inference_ms, nsfw = excluded.nsfw;
  reset role;
  out := out || case when (select status = 'completed' and outputs = '["https://cdn.example/cx.png"]' and error is null from tasks where id = 'wh-cx')
    and (select applied_at is not null from ws_webhook_events where webhook_id = 'm11')
    and (select status = 'completed' and outputs = '["https://cdn.example/ok.png"]' from tasks where id = 'wh-ok')
    and (select applied_at is not null from ws_webhook_events where webhook_id = 'm12')
    then 'ok queued-vs-finished; ' else 'FAIL queued-vs-finished; ' end;

  -- The sweep heals a delivery that missed its row (both committed at the same instant, neither saw the other):
  -- simulated by a waiting delivery next to a running row, and one next to a row the device already finished.
  insert into tasks (id, device_id, status, start_time, task_id, outputs) values
    ('wh-sw',  scope, 'processing', 1000, 'wh-pred-sw',  '[]'),
    ('wh-sw2', scope, 'completed',  1000, 'wh-pred-sw2', '["https://cdn.example/own.png"]');
  insert into ws_webhook_events (webhook_id, task_id, status, outputs, error, end_time) values
    ('m13', 'wh-pred-sw',  'completed', '["https://cdn.example/sw.png"]', null, 3000),
    ('m14', 'wh-pred-sw2', 'completed', '["https://cdn.example/sw2.png"]', null, 3000);
  begin
    perform ws_webhook_sweep();
    out := out || case when (select status = 'completed' and outputs = '["https://cdn.example/sw.png"]' and end_time = 3000 from tasks where id = 'wh-sw')
      and (select outputs = '["https://cdn.example/own.png"]' from tasks where id = 'wh-sw2')
      and (select count(*) from ws_webhook_events where webhook_id in ('m13', 'm14') and applied_at is not null) = 2
      then 'ok sweep; ' else 'FAIL sweep; ' end;
  exception when undefined_function then out := out || 'FAIL sweep (missing); '; end;
  set local role anon;
  begin perform ws_webhook_sweep(); out := out || 'FAIL anon-sweep; ';
  exception when insufficient_privilege or undefined_function then out := out || 'ok anon-sweep; '; end;
  reset role;
  out := out || case when (select count(*) from cron.job where jobname = 'ws-webhook-sweep' and active) = 1
    then 'ok sweep-scheduled; ' else 'FAIL sweep-scheduled; ' end;

  -- No per-row advisory locks: a batch upload must not fill the shared lock table (64 x max_connections slots) or
  -- deadlock against the webhook (20261020212826 removed per-row locks: 56 were held for 50 rows). Since
  -- 20261023500000 the insert path takes ONE shared lock per (kind, scope) (_rows_not_tombstoned, against
  -- delete_queued_rows / _clear_kind's exclusive one), so 0 before that migration and 1 after it both pass; per-row
  -- locking shows as ~50, and an exclusive lock on the upload path fails.
  set local role anon;
  insert into tasks (id, device_id, status, start_time, task_id, outputs)
    select 'wh-batch-' || g, scope, case when g % 2 = 0 then 'completed' else 'processing' end, 1000, 'wh-pred-batch-' || g, '[]'
    from generate_series(1, 50) g;
  reset role;
  out := out || case when (select count(*) from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()) <= 1
      and (select count(*) from pg_locks where locktype = 'advisory' and pid = pg_backend_pid() and mode <> 'ShareLock') = 0
    then 'ok no-per-row-locks; '
    else format('FAIL no-per-row-locks %s; ', (select string_agg(mode, ',') from pg_locks where locktype = 'advisory' and pid = pg_backend_pid())) end;

  -- Only completed / failed are accepted.
  set local role service_role;
  begin perform ws_webhook_apply('m6', 'wh-pred-x', 'processing', null, null, 1); out := out || 'FAIL bad-status; ';
  exception when raise_exception then out := out || 'ok bad-status; '; end;
  reset role;

  raise exception 'RESULT: %', out;
end $t$;
