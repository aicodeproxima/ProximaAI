-- Tests for supabase/migrations/20261022230000_queued_deletes_check_restore.sql: a delete intent replayed from a device's
-- queue goes through delete_queued_rows, which refuses it when a restore committed after the intent was queued (review
-- round 4: the client checked once, then sent its deletes tens of seconds later). Same harness as test-paths-in-use-db.sql:
-- one DO block that always ends in an exception, so everything rolls back (the admin_username swap included). Run before
-- the migration exists as "begin;" + migration + this file; afterwards this file alone. Fixtures: account '__qd_test'.
do $t$
declare
  out text := '';
  u constant text := 'user:__qd_test';
  v_tok text; r json; v_bk uuid; v_marker bigint;
begin
  update app_secrets set value = jsonb_set(value, '{username}', '"__qd_test"') where key = 'admin_username';
  v_tok := _sign_session_token('admin:__qd_test', now() + interval '12 hours 5 minutes');
  insert into tasks (id, device_id, status, start_time, outputs) values
    ('qd-1', u, 'completed', 1000, '[]'), ('qd-2', u, 'completed', 1000, '[]'), ('qd-3', u, 'completed', 1000, '[]');
  insert into history (id, device_id, timestamp, tasks, total_cost) values ('qd-L', u, 1000, '[]', 0);

  -- 1. No restore recorded: the queued delete runs (as the app calls it: anon + token).
  begin
    set local role anon;
    r := delete_queued_rows(v_tok, 'task', array['qd-1'], 1000);
    reset role;
    out := out || case when (r->>'voided')::boolean = false and (r->>'deleted')::int = 1 and not exists (select 1 from tasks where id = 'qd-1')
      then 'ok runs-without-restore; ' else format('FAIL runs-without-restore %s; ', r) end;
  exception when others then reset role; out := out || format('FAIL runs-without-restore %s %s; ', sqlstate, sqlerrm); end;

  -- 2. A restore after the intent was queued voids it: nothing is deleted.
  begin
    insert into settings (device_id, key, value) values (u, 'last_restore_at', '5000')
      on conflict (device_id, key) do update set value = excluded.value;
    r := delete_queued_rows(v_tok, 'task', array['qd-2'], 4000);
    out := out || case when (r->>'voided')::boolean and (r->>'deleted')::int = 0 and exists (select 1 from tasks where id = 'qd-2')
      then 'ok voided-before-restore; ' else format('FAIL voided-before-restore %s; ', r) end;
    r := delete_queued_rows(v_tok, 'history', array['qd-L'], 6000);
    out := out || case when not (r->>'voided')::boolean and (r->>'deleted')::int = 1 and not exists (select 1 from history where id = 'qd-L')
      then 'ok runs-after-restore; ' else format('FAIL runs-after-restore %s; ', r) end;
  exception when others then out := out || format('FAIL voided-before-restore %s %s; ', sqlstate, sqlerrm); end;

  -- 3. Only admin sessions; only task/history; at most 200 ids; only this account's rows.
  begin
    begin perform delete_queued_rows(_sign_session_token(u, now() + interval '5 minutes'), 'task', array['qd-2'], 9e12::bigint);
          out := out || 'FAIL guards non-admin; ';
    exception when insufficient_privilege then null; end;
    begin perform delete_queued_rows(v_tok, 'settings', array['x'], 9e12::bigint); out := out || 'FAIL guards kind; ';
    exception when others then null; end;
    begin perform delete_queued_rows(v_tok, 'task', array(select 'x' || g from generate_series(1, 201) g), 9e12::bigint);
          out := out || 'FAIL guards 201; ';
    exception when others then null; end;
    insert into tasks (id, device_id, status, start_time, outputs) values ('qd-other', 'user:__someone', 'completed', 1, '[]');
    r := delete_queued_rows(v_tok, 'task', array['qd-other'], 9e12::bigint);
    out := out || case when (r->>'deleted')::int = 0 and exists (select 1 from tasks where id = 'qd-other')
      then 'ok guards; ' else format('FAIL guards scope %s; ', r) end;
  exception when others then out := out || format('FAIL guards %s %s; ', sqlstate, sqlerrm); end;

  -- 4. A real restore moves the marker forward (and keeps it in place): an intent queued before it is then voided.
  begin
    insert into data_backups (username, backup_type, task_count, history_count, tasks_snapshot, history_snapshot, settings_snapshot)
      values (u, 'manual', 0, 0, '[]', '[]', '{"last_restore_at": 1}') returning id into v_bk;
    r := restore_my_backup_phase2(v_tok, v_bk);
    select (value #>> '{}')::bigint into v_marker from settings where device_id = u and key = 'last_restore_at';
    insert into tasks (id, device_id, status, start_time, outputs) values ('qd-4', u, 'completed', 1000, '[]');
    r := delete_queued_rows(v_tok, 'task', array['qd-4'], v_marker - 1);
    out := out || case when v_marker > 5000 and (r->>'voided')::boolean and exists (select 1 from tasks where id = 'qd-4')
      then 'ok restore-voids-older; ' else format('FAIL restore-voids-older marker=%s %s; ', v_marker, r) end;
  exception when others then out := out || format('FAIL restore-voids-older %s %s; ', sqlstate, sqlerrm); end;

  -- 6. Review round 6 (migration 20261022260000): a call that waited behind a rename must not run against the old, now
  --    empty name (it reported deleted: 0 and the intent was settled). A concurrent wait cannot be staged in one
  --    transaction, so: (a) both bodies check the session again AFTER taking the marker; (b) an old-name token is refused
  --    and its row stays.
  declare v_old_tok text := v_tok; v_bad text;
  begin
    select string_agg(p.proname, ',') into v_bad from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.proname in ('restore_my_backup_phase2', 'delete_queued_rows', 'rename_my_account')   -- rename: review round 7
       and not (position('_verify_session_token(p_session_token)' in substr(p.prosrc, position('last_restore_at'' for' in p.prosrc))) > 0);
    insert into tasks (id, device_id, status, start_time, outputs) values ('qd-6', u, 'completed', 1000, '[]');
    update app_secrets set value = jsonb_set(value, '{username}', '"__qd_renamed"') where key = 'admin_username';
    begin
      r := delete_queued_rows(v_old_tok, 'task', array['qd-6'], 9e12::bigint);
      v_bad := coalesce(v_bad || ',', '') || 'answered';
    exception when others then null; end;
    update app_secrets set value = jsonb_set(value, '{username}', '"__qd_test"') where key = 'admin_username';
    out := out || case when v_bad is null and exists (select 1 from tasks where id = 'qd-6') then 'ok recheck-after-lock; '
                       else format('FAIL recheck-after-lock %s; ', v_bad) end;
  exception when others then out := out || format('FAIL recheck-after-lock %s %s; ', sqlstate, sqlerrm); end;

  -- 8. Review round 6 (migration 20261022263000): a user delete of a generation without a tasks row (History-only, e.g.
  --    after a restore) records a user tombstone, so other devices drop its History item and uploads are stripped of it.
  --    A restore's tombstone becomes a user one; an id nothing holds gets no tombstone.
  begin
    insert into history (id, device_id, timestamp, tasks, total_cost) values
      ('qd-HE', u, 1000, '[{"id":"qd-honly","status":"completed","cost":1,"outputs":[]},{"id":"qd-capped","status":"completed","cost":1,"outputs":[]}]', 2);
    insert into sync_tombstones (id, kind, device_id, deleted_at, by_restore) values ('qd-capped', 'task', u, now() - interval '1 day', true);
    r := delete_queued_rows(v_tok, 'task', array['qd-honly', 'qd-capped', 'qd-nothing'], 9e12::bigint);
    out := out || case when exists (select 1 from sync_tombstones where id = 'qd-honly' and kind = 'task' and device_id = u and not by_restore)
                        and exists (select 1 from sync_tombstones where id = 'qd-capped' and not by_restore)
                        and not exists (select 1 from sync_tombstones where id = 'qd-nothing')
      then 'ok user-tombstone-for-history-only; '
      else format('FAIL user-tombstone-for-history-only %s; ', (select string_agg(id || ':' || by_restore, ',') from sync_tombstones where id like 'qd-%')) end;
  exception when others then out := out || format('FAIL user-tombstone-for-history-only %s %s; ', sqlstate, sqlerrm); end;

  -- 9. Review round 6 (migration 20261022264000): generations_live answers which generations are live by the liveness
  --    rule (a tasks row, or a live History item without a user tombstone), so the WaveSpeed queue holds the copy of a
  --    generation a restore brought back History-only.
  declare v_live text[];
  begin
    insert into tasks (id, device_id, status, start_time, outputs) values ('qd-row', u, 'completed', 1000, '[]');
    insert into history (id, device_id, timestamp, tasks, total_cost) values
      ('qd-HL', u, 1000, '[{"id":"qd-hlive","status":"completed","cost":1,"outputs":[]},{"id":"qd-hdead","status":"completed","cost":1,"outputs":[]},{"id":"qd-hrest","status":"completed","cost":1,"outputs":[]}]', 3);
    insert into sync_tombstones (id, kind, device_id, deleted_at, by_restore) values
      ('qd-hdead', 'task', u, now(), false), ('qd-hrest', 'task', u, now(), true);
    set local role anon;
    v_live := generations_live(v_tok, array['qd-row', 'qd-hlive', 'qd-hdead', 'qd-hrest', 'qd-none']);
    reset role;
    begin perform generations_live(_sign_session_token(u, now() + interval '5 minutes'), array['x']);
          v_live := v_live || array['non-admin-answered'];
    exception when insufficient_privilege then null; end;
    out := out || case when (select array_agg(x order by x) from unnest(v_live) x) = array['qd-hlive', 'qd-hrest', 'qd-row']
      then 'ok generations-live; ' else format('FAIL generations-live %s; ', v_live) end;
  exception when others then reset role; out := out || format('FAIL generations-live %s %s; ', sqlstate, sqlerrm); end;

  -- 7. Review round 6 (migration 20261022261000): the backup-scrub drain takes each account's restore marker before it
  --    touches the queue or the backups, like restore, rename and replayed deletes (a cron drain and a rename locked
  --    backup_scrub_queue / data_backups in opposite orders).
  begin
    out := out || case when (select position('last_restore_at'' for' in prosrc) between 1 and position('delete from backup_scrub_queue' in prosrc)
                              from pg_proc where pronamespace = 'public'::regnamespace and proname = '_drain_backup_scrubs')
      then 'ok drain-marker-first; ' else 'FAIL drain-marker-first; ' end;
  exception when others then out := out || format('FAIL drain-marker-first %s %s; ', sqlstate, sqlerrm); end;

  -- 5. Review round 5 (migration 20261022250000): restore, delete_queued_rows and rename_my_account all take the account's
  --    restore marker before they touch its tasks rows, so no two of them wait on each other in opposite orders (the
  --    rename needs the owner's password, so its body is checked here rather than called).
  declare v_bad text;
  begin
    select string_agg(p.proname, ',') into v_bad
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname in ('restore_my_backup_phase2', 'delete_queued_rows', 'rename_my_account')
       and not (position('last_restore_at'' for' in p.prosrc) > 0      -- the lock statement: "... 'last_restore_at' for update|share"
                and position('last_restore_at'' for' in p.prosrc)
                    < least(coalesce(nullif(position('delete from tasks' in p.prosrc), 0), 999999),
                            coalesce(nullif(position('update tasks' in p.prosrc), 0), 999999)));
    out := out || case when v_bad is null then 'ok marker-lock-first; ' else format('FAIL marker-lock-first %s; ', v_bad) end;
  exception when others then out := out || format('FAIL marker-lock-first %s %s; ', sqlstate, sqlerrm); end;

  raise exception 'RESULT: %', out;
end $t$;
