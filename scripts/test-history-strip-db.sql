-- Tests for supabase/migrations/20261021175300_history_strip_deleted_items.sql: the server strips items of deleted tasks
-- from every History insert and update, so a stale device or the closed->open guard can never bring them back (review
-- #4, 2026-10-22). Same harness as test-backup-scrub-db.sql (one DO block, always rolled back). Run as "begin;" + the
-- migration + this file before it is applied; afterwards this file alone. Needs 175200 (sync_tombstones.by_restore).
-- Fixtures only: 'user:__strip_test', ids 'hs-'. Each case catches its own errors.
do $t$
declare
  out text := '';
  u constant text := 'user:__strip_test';
  h record; ok boolean;
begin
  insert into tasks (id, device_id, status, start_time, outputs) values
    ('hs-t1', u, 'completed', 1000, '[]'), ('hs-t2', u, 'completed', 1000, '[]'),
    ('hs-t3', u, 'completed', 1000, '[]'), ('hs-t4', u, 'completed', 1000, '[]');
  insert into history (id, device_id, timestamp, tasks, total_cost) values
    ('hs-L1', u, 1000, '[{"id":"hs-t1","status":"completed","cost":1},{"id":"hs-t2","status":"completed","cost":2},{"id":"hs-t3","status":"pending","cost":3}]', 3),
    ('hs-L2', u, 1000, '[{"id":"hs-t1","status":"completed","cost":1},{"id":"hs-t3","status":"completed","cost":3}]', 4),
    ('hs-L4', u, 1000, '[{"id":"hs-t4","status":"completed","cost":4}]', 4);
  delete from tasks where id in ('hs-t1', 'hs-t2');

  -- 1. A stale device finishes the entry with the deleted items in it: they are stripped.
  begin
    update history set tasks = '[{"id":"hs-t1","status":"completed","cost":1},{"id":"hs-t2","status":"completed","cost":2},{"id":"hs-t3","status":"completed","cost":3}]', total_cost = 6
     where id = 'hs-L1';
    select * into h from history where id = 'hs-L1';
    ok := (select array_agg(e->>'id') from jsonb_array_elements(h.tasks) e) = '{hs-t3}' and h.total_cost = 3;
    out := out || case when ok then 'ok stale-finish; ' else format('FAIL stale-finish %s %s; ', h.tasks, h.total_cost) end;
  exception when others then out := out || format('FAIL stale-finish %s; ', sqlstate); end;

  -- 2. The closed->open guard keeps the old (closed) content; the strip still runs on it.
  begin
    update history set tasks = '[{"id":"hs-t3","status":"pending","cost":3}]', total_cost = 0 where id = 'hs-L2';
    select * into h from history where id = 'hs-L2';
    ok := (select array_agg(e->>'id') from jsonb_array_elements(h.tasks) e) = '{hs-t3}'
      and h.tasks->0->>'status' = 'completed' and h.total_cost = 3;
    out := out || case when ok then 'ok closed-guard; ' else format('FAIL closed-guard %s %s; ', h.tasks, h.total_cost) end;
  exception when others then out := out || format('FAIL closed-guard %s; ', sqlstate); end;

  -- 3. An insert carrying a deleted item keeps only the rest (an id-less item stays).
  begin
    insert into history (id, device_id, timestamp, tasks, total_cost) values
      ('hs-L3', u, 1000, '[{"id":"hs-t1","status":"completed","cost":1},{"status":"completed","cost":5,"outputs":["x"]}]', 6);
    select * into h from history where id = 'hs-L3';
    ok := jsonb_array_length(h.tasks) = 1 and h.tasks->0->>'id' is null and h.total_cost = 5;
    out := out || case when ok then 'ok insert; ' else format('FAIL insert %s %s; ', h.tasks, h.total_cost) end;
  exception when others then out := out || format('FAIL insert %s; ', sqlstate); end;

  -- 4. A restore re-inserts its snapshot as it was.
  begin
    perform set_config('proxima.restore', 'on', true);
    insert into history (id, device_id, timestamp, tasks, total_cost) values
      ('hs-L5', u, 1000, '[{"id":"hs-t1","status":"completed","cost":1}]', 1);
    perform set_config('proxima.restore', 'off', true);
    select * into h from history where id = 'hs-L5';
    out := out || case when h.tasks->0->>'id' = 'hs-t1' then 'ok restore-exempt; ' else format('FAIL restore-exempt %s; ', h.tasks) end;
  exception when others then out := out || format('FAIL restore-exempt %s; ', sqlstate); end;

  -- 5. A task a restore removed is not a deletion: later writes keep its item.
  begin
    perform set_config('proxima.restore', 'on', true);
    delete from tasks where id = 'hs-t4';
    perform set_config('proxima.restore', 'off', true);
    update history set total_cost = 4.5 where id = 'hs-L4';
    select * into h from history where id = 'hs-L4';
    out := out || case when h.tasks->0->>'id' = 'hs-t4' then 'ok by-restore-kept; ' else format('FAIL by-restore-kept %s; ', h.tasks) end;
  exception when others then out := out || format('FAIL by-restore-kept %s; ', sqlstate); end;

  -- 6. Runs as its owner, after the other BEFORE triggers on history.
  begin
    ok := (select prosecdef from pg_proc where proname = '_history_strip_deleted_items')
      and exists (select 1 from pg_trigger where tgname = 'history_strip_deleted_items' and tgrelid = 'public.history'::regclass)
      and 'history_strip_deleted_items' > 'history_not_tombstoned' and 'history_strip_deleted_items' > 'history_keep_owner';
    out := out || case when ok then 'ok secdef-order; ' else 'FAIL secdef-order; ' end;
  exception when others then out := out || format('FAIL secdef-order %s; ', sqlstate); end;

  raise exception 'RESULT: %', out;
end $t$;
