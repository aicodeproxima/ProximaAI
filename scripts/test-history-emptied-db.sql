-- Tests for supabase/migrations/20261022150000_history_drop_emptied_entries.sql: a History entry left with no items is
-- gone, not kept as an empty shell (review wf_ec400a67-988 #8). Same harness as test-history-strip-db.sql (one DO
-- block, always rolled back). Run as "begin;" + the migration + this file before it is applied; afterwards this file
-- alone. Fixtures only: 'user:__empty_test', ids 'he-'. Each case catches its own errors.
do $t$
declare
  out text := '';
  u constant text := 'user:__empty_test';
begin
  insert into tasks (id, device_id, status, start_time, outputs) values
    ('he-a', u, 'completed', 1000, '[]'), ('he-b', u, 'completed', 1000, '[]'), ('he-c', u, 'completed', 1000, '[]');
  insert into history (id, device_id, timestamp, tasks, total_cost) values
    ('he-E', u, 1000, '[{"id":"he-a","status":"completed","cost":1},{"id":"he-b","status":"completed","cost":2}]', 3),
    ('he-F', u, 1000, '[{"id":"he-c","status":"completed","cost":1}]', 1),
    ('he-R', u, 1000, '[{"id":"he-c","status":"completed","cost":1}]', 1),
    ('he-K', u, 1000, '[{"id":"he-c","status":"completed","cost":1},{"id":"he-b","status":"completed","cost":2}]', 3);
  delete from tasks where id in ('he-a', 'he-b');

  -- 1. An upload whose every item is a deleted generation is not stored, and is tombstoned.
  begin
    insert into history (id, device_id, timestamp, tasks, total_cost) values
      ('he-I', u, 1000, '[{"id":"he-a","status":"completed","cost":1}]', 1);
    out := out || case when not exists (select 1 from history where id = 'he-I')
      and exists (select 1 from sync_tombstones where id = 'he-I' and kind = 'history')
      then 'ok insert-emptied; ' else 'FAIL insert-emptied; ' end;
  exception when others then out := out || format('FAIL insert-emptied %s; ', sqlstate); end;

  -- 2. A stale device rewrites the entry to only deleted items: the strip empties it, and it is deleted.
  begin
    update history set tasks = '[{"id":"he-a","status":"completed","cost":1}]', total_cost = 1 where id = 'he-E';
    out := out || case when not exists (select 1 from history where id = 'he-E')
      and exists (select 1 from sync_tombstones where id = 'he-E' and kind = 'history')
      then 'ok update-emptied; ' else 'FAIL update-emptied; ' end;
  exception when others then out := out || format('FAIL update-emptied %s; ', sqlstate); end;

  -- 3. A client writing [] (another device's sync dropped the last item) deletes it too.
  begin
    update history set tasks = '[]', total_cost = 0 where id = 'he-F';
    out := out || case when not exists (select 1 from history where id = 'he-F') then 'ok client-empty; ' else 'FAIL client-empty; ' end;
  exception when others then out := out || format('FAIL client-empty %s; ', sqlstate); end;

  -- 4. A restore writes its snapshot as it was.
  begin
    perform set_config('proxima.restore', 'on', true);
    update history set tasks = '[]', total_cost = 0 where id = 'he-R';
    perform set_config('proxima.restore', 'off', true);
    out := out || case when exists (select 1 from history where id = 'he-R') then 'ok restore-exempt; ' else 'FAIL restore-exempt; ' end;
  exception when others then out := out || format('FAIL restore-exempt %s; ', sqlstate); end;

  -- 5. A partial strip keeps the entry with its live item (regression guard).
  begin
    update history set total_cost = 3.5 where id = 'he-K';
    out := out || case when (select tasks from history where id = 'he-K') = '[{"id":"he-c","status":"completed","cost":1}]'
      then 'ok partial-kept; ' else 'FAIL partial-kept; ' end;
  exception when others then out := out || format('FAIL partial-kept %s; ', sqlstate); end;

  -- 6. The app's upsert (PostgREST: INSERT ... ON CONFLICT DO UPDATE) of an existing entry with only deleted items:
  --    the BEFORE INSERT strip must not tombstone the live row and skip the write (review round 2); the update runs
  --    and the emptied row is deleted the normal way.
  begin
    insert into history (id, device_id, timestamp, tasks, total_cost) values
      ('he-U', u, 1000, '[{"id":"he-c","status":"completed","cost":1}]', 1);
    insert into history (id, device_id, timestamp, tasks, total_cost) values
      ('he-U', u, 1000, '[{"id":"he-a","status":"completed","cost":1}]', 1)
      on conflict (device_id, id) do update set tasks = excluded.tasks, total_cost = excluded.total_cost;
    out := out || case when not exists (select 1 from history where id = 'he-U')
      and exists (select 1 from sync_tombstones where id = 'he-U' and kind = 'history')
      then 'ok upsert-emptied; ' else format('FAIL upsert-emptied live=%s; ', exists (select 1 from history where id = 'he-U')) end;
  exception when others then out := out || format('FAIL upsert-emptied %s; ', sqlstate); end;

  raise exception 'RESULT: %', out;
end $t$;
