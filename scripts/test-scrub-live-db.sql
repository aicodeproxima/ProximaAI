-- Tests for supabase/migrations/20261022210000_scrub_skips_live.sql: the backup scrub never removes a generation, a
-- History entry or an output that is still live (review round 3: a stale History rewrite replayed after a restore
-- dropped a live item, history_queue_item_scrub queued it, and the drain scrubbed it from every backup). Same harness as
-- test-backup-scrub-db.sql: one DO block ending in an exception, so everything rolls back. Run before the migration
-- exists as "begin;" + migration + this file; afterwards this file alone. Fixtures: 'user:__live_scrub', ids 'ls-'.
do $t$
declare
  out text := '';
  u constant text := 'user:__live_scrub';
  v_bk uuid;
  has_task  constant text := 'select exists (select 1 from data_backups b, jsonb_array_elements(b.tasks_snapshot) e where b.id = $1 and e->>''id'' = $2)';
  has_item  constant text := 'select exists (select 1 from data_backups b, jsonb_array_elements(b.history_snapshot) h, jsonb_array_elements(h->''tasks'') i where b.id = $1 and i->>''id'' = $2)';
  has_entry constant text := 'select exists (select 1 from data_backups b, jsonb_array_elements(b.history_snapshot) h where b.id = $1 and h->>''id'' = $2)';
  has_out   constant text := 'select position($2 in (select b.history_snapshot::text from data_backups b where b.id = $1)) > 0';
  ok boolean; ok2 boolean;
begin
  insert into app_secrets (key, value) values ('auto_backups', '{"enabled": false}')
    on conflict (key) do update set value = excluded.value;
  insert into tasks (id, device_id, status, start_time, outputs) values
    ('ls-live', u, 'completed', 1000, '["https://h/live.png"]'),
    ('ls-also', u, 'completed', 1000, '[]'),
    ('ls-dead', u, 'completed', 1000, '[]');
  insert into history (id, device_id, timestamp, tasks, total_cost) values
    ('ls-E', u, 1000, '[{"id":"ls-live","status":"completed","cost":1,"outputs":["https://h/live.png"]},{"id":"ls-also","status":"completed","cost":1,"outputs":[]},{"id":"ls-dead","status":"completed","cost":1,"outputs":[]}]', 3),
    ('ls-F', u, 1000, '[{"status":"completed","cost":1,"outputs":["https://h/live.png"]},{"id":"ls-also","status":"completed","cost":1,"outputs":[]}]', 2);
  insert into data_backups (username, backup_type, task_count, history_count, tasks_snapshot, history_snapshot)
    values (u, 'manual', 3, 2,
            (select jsonb_agg(row_to_json(t)) from tasks t where t.device_id = u),
            (select jsonb_agg(row_to_json(x)) from history x where x.device_id = u))
    returning id into v_bk;

  -- 1. A stale rewrite drops the live generation's item: the backup keeps that generation and its item.
  begin
    update history set tasks = '[{"id":"ls-also","status":"completed","cost":1,"outputs":[]},{"id":"ls-dead","status":"completed","cost":1,"outputs":[]}]', total_cost = 2
     where id = 'ls-E';
    perform _drain_backup_scrubs(u);
    execute has_task using v_bk, 'ls-live' into ok;
    execute has_item using v_bk, 'ls-live' into ok2;
    out := out || case when ok and ok2 then 'ok stale-rewrite-keeps-live; ' else format('FAIL stale-rewrite-keeps-live task=%s item=%s; ', ok, ok2) end;
  exception when others then out := out || format('FAIL stale-rewrite-keeps-live %s %s; ', sqlstate, sqlerrm); end;

  -- 2. A real delete still scrubs: the deleted generation leaves the backup.
  begin
    delete from tasks where id = 'ls-dead';
    perform _drain_backup_scrubs(u);
    execute has_task using v_bk, 'ls-dead' into ok;
    execute has_item using v_bk, 'ls-dead' into ok2;
    out := out || case when not ok and not ok2 then 'ok delete-still-scrubs; ' else format('FAIL delete-still-scrubs task=%s item=%s; ', ok, ok2) end;
  exception when others then out := out || format('FAIL delete-still-scrubs %s %s; ', sqlstate, sqlerrm); end;

  -- 3. A queued History entry id that is still live is not scrubbed; a queued output a live generation uses stays.
  begin
    insert into backup_scrub_queue (username, log_ids, outputs) values (u, array['ls-F'], array['https://h/live.png']);
    perform _drain_backup_scrubs(u);
    execute has_entry using v_bk, 'ls-F' into ok;
    execute has_out using v_bk, 'https://h/live.png' into ok2;
    out := out || case when ok and ok2 then 'ok live-entry-and-output-kept; ' else format('FAIL live-entry-and-output-kept entry=%s out=%s; ', ok, ok2) end;
  exception when others then out := out || format('FAIL live-entry-and-output-kept %s %s; ', sqlstate, sqlerrm); end;

  -- 4. Review round 4 (migration 20261022220000): a generation live only in History (no tasks row: a restore keeps 500
  --    tasks rows but up to 1000 entries) is live too. A queued scrub of its id keeps it in every backup.
  begin
    insert into history (id, device_id, timestamp, tasks, total_cost) values
      ('ls-H', u, 1000, '[{"id":"ls-honly","status":"completed","cost":1,"outputs":[]},{"id":"ls-hkeep","status":"completed","cost":1,"outputs":[]}]', 2);
    update data_backups set tasks_snapshot = tasks_snapshot || '[{"id":"ls-honly","device_id":"user:__live_scrub","status":"completed"}]'::jsonb,
                            history_snapshot = history_snapshot || (select jsonb_agg(row_to_json(x)) from history x where x.id = 'ls-H')
     where id = v_bk;
    insert into backup_scrub_queue (username, task_ids) values (u, array['ls-honly']);
    perform _drain_backup_scrubs(u);
    execute has_task using v_bk, 'ls-honly' into ok;
    execute has_item using v_bk, 'ls-honly' into ok2;
    out := out || case when ok and ok2 then 'ok history-only-is-live; ' else format('FAIL history-only-is-live task=%s item=%s; ', ok, ok2) end;
  exception when others then out := out || format('FAIL history-only-is-live %s %s; ', sqlstate, sqlerrm); end;

  -- 5. Deleting that whole entry queues its items too: once nothing live holds the generation, it leaves the backups.
  begin
    delete from history where id = 'ls-H';
    perform _drain_backup_scrubs(u);
    execute has_task using v_bk, 'ls-honly' into ok;
    execute has_entry using v_bk, 'ls-H' into ok2;
    out := out || case when not ok and not ok2 then 'ok entry-delete-queues-items; ' else format('FAIL entry-delete-queues-items task=%s entry=%s; ', ok, ok2) end;
  exception when others then out := out || format('FAIL entry-delete-queues-items %s %s; ', sqlstate, sqlerrm); end;

  -- 6. An entry deleted while its generation's tasks row lives (Clear Logs) leaves that generation in the backups.
  begin
    execute has_task using v_bk, 'ls-also' into ok;
    out := out || case when ok then 'ok log-delete-keeps-live-generation; ' else 'FAIL log-delete-keeps-live-generation; ' end;
  exception when others then out := out || format('FAIL log-delete-keeps-live-generation %s %s; ', sqlstate, sqlerrm); end;

  -- 7. The restore cap: a generation the restore removed (tombstoned by_restore) whose item a live entry still holds
  --    stays in the backups; the same with a user delete's tombstone is scrubbed (case 2).
  begin
    insert into history (id, device_id, timestamp, tasks, total_cost) values
      ('ls-R', u, 1000, '[{"id":"ls-capped","status":"completed","cost":1,"outputs":[]}]', 1);
    insert into sync_tombstones (id, kind, device_id, deleted_at, by_restore) values ('ls-capped', 'task', u, now(), true);
    update data_backups set tasks_snapshot = tasks_snapshot || '[{"id":"ls-capped","device_id":"user:__live_scrub","status":"completed"}]'::jsonb
     where id = v_bk;
    insert into backup_scrub_queue (username, task_ids) values (u, array['ls-capped']);
    perform _drain_backup_scrubs(u);
    execute has_task using v_bk, 'ls-capped' into ok;
    out := out || case when ok then 'ok restore-capped-kept; ' else 'FAIL restore-capped-kept; ' end;
  exception when others then out := out || format('FAIL restore-capped-kept %s %s; ', sqlstate, sqlerrm); end;

  raise exception 'RESULT: %', out;
end $t$;
