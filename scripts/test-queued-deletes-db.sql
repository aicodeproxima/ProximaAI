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
  if to_regclass('proxima_auth.users') is null then   -- from P1's M1 the app_secrets admin rows are frozen; the owner row is the account
    update app_secrets set value = jsonb_set(value, '{username}', '"__qd_test"') where key = 'admin_username';
  else
    execute 'update proxima_auth.users set username = $1, scope = ''user:'' || $1 where role = ''owner''' using '__qd_test';
  end if;
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
    exception when insufficient_privilege then null;   -- before P1's M1 (42501)
              when raise_exception then                -- from M1 the verifier fails closed on a non-account subject
                if sqlerrm <> 'malformed session token' then raise; end if; end;
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
    if to_regclass('proxima_auth.users') is null then   -- from P1's M1 the app_secrets admin rows are frozen; the owner row is the account
      update app_secrets set value = jsonb_set(value, '{username}', '"__qd_renamed"') where key = 'admin_username';
    else
      execute 'update proxima_auth.users set username = $1, scope = ''user:'' || $1 where role = ''owner''' using '__qd_renamed';
    end if;
    begin
      r := delete_queued_rows(v_old_tok, 'task', array['qd-6'], 9e12::bigint);
      v_bad := coalesce(v_bad || ',', '') || 'answered';
    exception when others then null; end;
    if to_regclass('proxima_auth.users') is null then   -- from P1's M1 the app_secrets admin rows are frozen; the owner row is the account
      update app_secrets set value = jsonb_set(value, '{username}', '"__qd_test"') where key = 'admin_username';
    else
      execute 'update proxima_auth.users set username = $1, scope = ''user:'' || $1 where role = ''owner''' using '__qd_test';
    end if;
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
    exception when insufficient_privilege then null;   -- before P1's M1 (42501)
              when raise_exception then                -- from M1: the verifier fails closed on a non-account subject
                if sqlerrm <> 'malformed session token' then raise; end if; end;
    out := out || case when (select array_agg(x order by x) from unnest(v_live) x) = array['qd-hlive', 'qd-hrest', 'qd-row']
      then 'ok generations-live; ' else format('FAIL generations-live %s; ', v_live) end;
  exception when others then reset role; out := out || format('FAIL generations-live %s %s; ', sqlstate, sqlerrm); end;

  -- 10. Review round 8 (migration 20261022280000): the History half of a task delete happens in the same transaction as
  --     the row delete, so a restore can never land between them. A deleted generation's item leaves its entries (cost
  --     recomputed), an entry left empty is removed, and a voided delete leaves History untouched.
  declare v_tasks jsonb; v_cost numeric;
  begin
    insert into tasks (id, device_id, status, start_time, outputs) values ('qd-s1', u, 'completed', 1000, '[]'), ('qd-s2', u, 'completed', 1000, '[]'),
                                                                          ('qd-s3', u, 'completed', 1000, '[]');
    insert into history (id, device_id, timestamp, tasks, total_cost) values
      ('qd-SH', u, 1000, '[{"id":"qd-s1","status":"completed","cost":1,"outputs":[]},{"id":"qd-s2","status":"completed","cost":2,"outputs":[]}]', 3),
      ('qd-SE', u, 1000, '[{"id":"qd-s1","status":"completed","cost":1,"outputs":[]}]', 1),
      ('qd-SV', u, 1000, '[{"id":"qd-s3","status":"completed","cost":4,"outputs":[]}]', 4);
    r := delete_queued_rows(v_tok, 'task', array['qd-s1'], 9e12::bigint);
    select tasks, total_cost into v_tasks, v_cost from history where id = 'qd-SH';
    insert into settings (device_id, key, value) values (u, 'last_restore_at', to_jsonb(9e12::bigint + 10))
      on conflict (device_id, key) do update set value = excluded.value;
    perform delete_queued_rows(v_tok, 'task', array['qd-s3'], 9e12::bigint);   -- voided: queued before that "restore"
    out := out || case when v_tasks = '[{"id":"qd-s2","status":"completed","cost":2,"outputs":[]}]' and v_cost = 2
                        and not exists (select 1 from history where id = 'qd-SE')
                        and exists (select 1 from history where id = 'qd-SV' and jsonb_array_length(tasks) = 1)
      then 'ok history-in-same-transaction; '
      else format('FAIL history-in-same-transaction SH=%s cost=%s SE=%s; ', v_tasks, v_cost, exists (select 1 from history where id = 'qd-SE')) end;
  exception when others then out := out || format('FAIL history-in-same-transaction %s %s; ', sqlstate, sqlerrm); end;

  -- 11. Review round 8 (migration 20261022290000): Clear Logs / Clear Outputs / Reset clear through clear_queued_rows,
  --     checked against restores like the replays: queued before the last restore -> voided, nothing cleared; after it
  --     -> every row of that kind of this account goes (tasks: their History items too, entries left empty go).
  declare v_n_tasks int; v_left_hist int;
  begin
    delete from settings where device_id = u and key = 'last_restore_at';
    insert into settings (device_id, key, value) values (u, 'last_restore_at', '5000');
    insert into tasks (id, device_id, status, start_time, outputs) values ('qd-c1', u, 'completed', 1000, '[]');
    insert into history (id, device_id, timestamp, tasks, total_cost) values
      ('qd-CH', u, 1000, '[{"id":"qd-c1","status":"completed","cost":1,"outputs":[]}]', 1);
    insert into tasks (id, device_id, status, start_time, outputs) values ('qd-cother', 'user:__someone_else', 'completed', 1, '[]');
    r := clear_queued_rows(v_tok, 'task', 4000);
    v_n_tasks := (select count(*) from tasks where device_id = u);
    if not (r->>'voided')::boolean or v_n_tasks = 0 then
      out := out || format('FAIL clear-queued voided %s tasks=%s; ', r, v_n_tasks);
    else
      r := clear_queued_rows(v_tok, 'task', (extract(epoch from now()) * 1000)::bigint + 1000);   -- rows are bounded by created_at (round 9)
      v_n_tasks := (select count(*) from tasks where device_id = u);
      v_left_hist := (select count(*) from history where id = 'qd-CH');
      out := out || case when not (r->>'voided')::boolean and v_n_tasks = 0 and v_left_hist = 0
                          and exists (select 1 from tasks where id = 'qd-cother')
        then 'ok clear-queued; ' else format('FAIL clear-queued %s tasks=%s CH=%s; ', r, v_n_tasks, v_left_hist) end;
    end if;
    begin perform clear_queued_rows(v_tok, 'bogus', 6000); out := out || 'FAIL clear-queued kind; ';
    exception when others then null; end;
  exception when others then out := out || format('FAIL clear-queued %s %s; ', sqlstate, sqlerrm); end;

  -- 12. Review round 9 (migration 20261022300000): a clear covers the rows that existed when it was queued plus every id
  --     the clearing device named; a row another device created after the queue time stays. Tasks: a History-only id
  --     it named gets a user tombstone, and only entries holding a cleared id are touched.
  declare v_q bigint := (extract(epoch from now()) * 1000)::bigint + 1000; v_bn jsonb; v_left text;
  begin
    insert into tasks (id, device_id, status, start_time, outputs, created_at) values
      ('qd-b-old', u, 'completed', 1, '[]', now()),
      ('qd-b-new', u, 'completed', 1, '[]', now() + interval '1 hour'),
      ('qd-b-known', u, 'completed', 1, '[]', now() + interval '1 hour');
    insert into history (id, device_id, timestamp, tasks, total_cost, created_at) values
      ('qd-BO', u, 1, '[{"id":"qd-b-old","status":"completed","cost":1,"outputs":[]},{"id":"qd-b-ho","status":"completed","cost":1,"outputs":[]}]', 2, now()),
      ('qd-BN', u, 1, '[{"id":"qd-b-new","status":"completed","cost":1,"outputs":[]}]', 1, now() + interval '1 hour');
    r := clear_queued_rows(v_tok, 'task', v_q, array['qd-b-known', 'qd-b-ho']);
    select string_agg(id, ',' order by id) into v_left from tasks where device_id = u;
    select tasks into v_bn from history where id = 'qd-BN';
    out := out || case when not (r->>'voided')::boolean and v_left = 'qd-b-new'
                        and not exists (select 1 from history where id = 'qd-BO')
                        and v_bn = '[{"id":"qd-b-new","status":"completed","cost":1,"outputs":[]}]'
                        and exists (select 1 from sync_tombstones where id = 'qd-b-ho' and device_id = u and not coalesce(by_restore, false))
      then 'ok clear-bounded-tasks; '
      else format('FAIL clear-bounded-tasks %s left=%s BN=%s BO=%s; ', r, v_left, v_bn, exists (select 1 from history where id = 'qd-BO')) end;
    insert into history (id, device_id, timestamp, tasks, total_cost, created_at) values
      ('qd-hb-old', u, 1, '[]', 0, now()), ('qd-hb-known', u, 1, '[]', 0, now() + interval '1 hour');
    r := clear_queued_rows(v_tok, 'history', v_q, array['qd-hb-known']);
    select string_agg(id, ',' order by id) into v_left from history where device_id = u;
    out := out || case when not (r->>'voided')::boolean and v_left = 'qd-BN'
      then 'ok clear-bounded-history; ' else format('FAIL clear-bounded-history %s left=%s; ', r, v_left) end;
  exception when others then out := out || format('FAIL clear-bounded %s %s; ', sqlstate, sqlerrm); end;

  -- 13. Review round 9: Reset's settings and favorites clears are restore-checked too (they were plain REST deletes), and
  --     keep the restore marker and the form holds (form-inputs:*).
  declare v_q bigint := (extract(epoch from now()) * 1000)::bigint + 1000; v_keys text; v_favs text;
  begin
    insert into settings (device_id, key, value) values (u, 'theme', '"x"'), (u, 'form-inputs:qd', '{}')
      on conflict (device_id, key) do nothing;
    insert into favorites (id, device_id, prompt, created_at) values
      ('qd-f-old', u, 'p', now()), ('qd-f-new', u, 'p', now() + interval '1 hour');
    r := clear_queued_rows(v_tok, 'settings', 4000);   -- queued before the restore marker (5000): voided
    if not (r->>'voided')::boolean or not exists (select 1 from settings where device_id = u and key = 'theme') then
      out := out || format('FAIL clear-prefs voided %s; ', r);
    else
      perform clear_queued_rows(v_tok, 'settings', v_q);
      select string_agg(key, ',' order by key) into v_keys from settings where device_id = u;
      perform clear_queued_rows(v_tok, 'favorites', v_q);
      select string_agg(id, ',' order by id) into v_favs from favorites where device_id = u;
      out := out || case when v_keys = 'form-inputs:qd,last_restore_at' and v_favs = 'qd-f-new'
        then 'ok clear-prefs; ' else format('FAIL clear-prefs keys=%s favs=%s; ', v_keys, v_favs) end;
    end if;
  exception when others then out := out || format('FAIL clear-prefs %s %s; ', sqlstate, sqlerrm); end;

  -- 14. Review round 9 (migration 20261022301000): the restore marker belongs to the server. A browser role with a valid
  --     session can neither delete nor change it (an older bundle's Reset deleted every settings row); the rest still goes.
  declare v_m text; v_k int; v_revoked boolean := false;
  begin
    insert into settings (device_id, key, value) values (u, 'theme', '"y"') on conflict (device_id, key) do nothing;
    perform set_config('request.headers', json_build_object('x-proxima-session', v_tok)::text, true);
    execute 'set local role anon';
    update settings set value = '1' where device_id = u and key = 'last_restore_at';
    begin delete from settings where device_id = u;
    exception when sqlstate '42501' then v_revoked := true; end;   -- browser deletes revoked altogether (round 10): fine too
    execute 'reset role';
    select value #>> '{}' into v_m from settings where device_id = u and key = 'last_restore_at';
    v_k := (select count(*) from settings where device_id = u and key = 'theme');
    out := out || case when v_m = '5000' and (v_k = 0 or v_revoked) then 'ok marker-server-only; '
      else format('FAIL marker-server-only marker=%s theme=%s; ', v_m, v_k) end;
  exception when others then execute 'reset role'; out := out || format('FAIL marker-server-only %s %s; ', sqlstate, sqlerrm); end;

  -- 15. Review round 9 (migration 20261022302000): a delete's History rewrite (an entry losing items without an id) goes
  --     through upsert_queued_history at the delete's queue time: voided by a later restore, otherwise upserted into this
  --     account only (another account's entry with the same id is left alone).
  declare v_t jsonb; v_e jsonb;
  begin
    insert into history (id, device_id, timestamp, tasks, total_cost) values
      ('qd-RW', u, 1, '[{"status":"completed","cost":1,"outputs":[]},{"id":"qd-rw-1","status":"completed","cost":2,"outputs":[]}]', 3),
      ('qd-RWo', 'user:__someone_else', 1, '[]', 0);
    v_e := jsonb_build_array(
      jsonb_build_object('id', 'qd-RW', 'device_id', 'user:__someone_else', 'timestamp', 1,
                         'tasks', '[{"id":"qd-rw-1","status":"completed","cost":2,"outputs":[]}]'::jsonb, 'total_cost', 2),
      jsonb_build_object('id', 'qd-RWo', 'timestamp', 1, 'tasks', '[{"id":"qd-rw-x","status":"completed","cost":9,"outputs":[]}]'::jsonb, 'total_cost', 9),
      jsonb_build_object('id', 'qd-RWn', 'timestamp', 1, 'tasks', '[]'::jsonb, 'total_cost', 0));
    execute 'set local role anon';
    r := upsert_queued_history(v_tok, v_e, 4000);   -- queued before the restore marker (5000): voided
    execute 'reset role';
    select tasks into v_t from history where id = 'qd-RW';
    if not (r->>'voided')::boolean or jsonb_array_length(v_t) <> 2 or exists (select 1 from history where id = 'qd-RWn') then
      out := out || format('FAIL rewrite-queued voided %s; ', r);
    else
      execute 'set local role anon';
      r := upsert_queued_history(v_tok, v_e, 9e12::bigint);
      execute 'reset role';
      select tasks into v_t from history where id = 'qd-RW';
      out := out || case when not (r->>'voided')::boolean and v_t = '[{"id":"qd-rw-1","status":"completed","cost":2,"outputs":[]}]'
                          and exists (select 1 from history where id = 'qd-RW' and device_id = u)
                          and exists (select 1 from history where id = 'qd-RWo' and device_id = 'user:__someone_else' and tasks = '[]')
                          and exists (select 1 from history where id = 'qd-RWn' and device_id = u)
        then 'ok rewrite-queued; ' else format('FAIL rewrite-queued %s RW=%s; ', r, v_t) end;
    end if;
  exception when others then execute 'reset role'; out := out || format('FAIL rewrite-queued %s %s; ', sqlstate, sqlerrm); end;

  -- 16. Review round 10 (migration 20261022310000): Clear Outputs bounds its clear by the time it took BEFORE its read, so a
  --     row another device uploaded during the read (never seen, so never purged) stays; named rows go whenever written.
  --     History-only generations are tombstoned by the server from the entries that existed by then (the client no longer
  --     names them, so a row that appears for one is never deleted unpurged); a restore's tombstone becomes a user one.
  declare v_q bigint := (extract(epoch from now() - interval '30 seconds') * 1000)::bigint; v_left text; v_e1 jsonb; v_e2 jsonb;
  begin
    insert into tasks (id, device_id, status, start_time, outputs, created_at) values
      ('qd-s10-old', u, 'completed', 1, '[]', now() - interval '1 minute'),
      ('qd-s10-late', u, 'completed', 1, '[]', now() + interval '1 hour'),
      ('qd-s10-known', u, 'completed', 1, '[]', now() + interval '1 hour');
    insert into history (id, device_id, timestamp, tasks, total_cost, created_at) values
      ('qd-S10-E1', u, 1, '[{"id":"qd-s10-old","status":"completed","cost":1,"outputs":[]},{"id":"qd-s10-ho","status":"completed","cost":1,"outputs":[]},{"id":"qd-s10-late","status":"completed","cost":1,"outputs":[]}]', 3, now() - interval '1 minute'),
      ('qd-S10-E2', u, 1, '[{"id":"qd-s10-ho2","status":"completed","cost":1,"outputs":[]}]', 1, now() + interval '1 hour');
    insert into sync_tombstones (id, kind, device_id, deleted_at, by_restore) values ('qd-s10-ho', 'task', u, now(), true);
    r := clear_queued_rows(v_tok, 'task', v_q, array['qd-s10-known']);
    select string_agg(id, ',' order by id) into v_left from tasks where id like 'qd-s10-%';
    select tasks into v_e1 from history where id = 'qd-S10-E1';
    select tasks into v_e2 from history where id = 'qd-S10-E2';
    out := out || case when not (r->>'voided')::boolean and v_left = 'qd-s10-late'
                        and v_e1 = '[{"id":"qd-s10-late","status":"completed","cost":1,"outputs":[]}]'
                        and jsonb_array_length(v_e2) = 1
                        and exists (select 1 from sync_tombstones where id = 'qd-s10-ho' and not coalesce(by_restore, false))
                        and not exists (select 1 from sync_tombstones where id = 'qd-s10-ho2')
      then 'ok clear-snapshot; ' else format('FAIL clear-snapshot %s left=%s E1=%s E2=%s; ', r, v_left, v_e1, v_e2) end;
  exception when others then out := out || format('FAIL clear-snapshot %s %s; ', sqlstate, sqlerrm); end;

  -- 17. Review round 10: a large Clear Outputs fits anon's 3 s statement timeout (the History touch compared every item
  --     with every id; a generic plan nested-looped). 6000 named rows, 2000 entries of 3 items, generated and rolled back.
  declare v_q bigint := (extract(epoch from now()) * 1000)::bigint + 1000; v_names text[]; v_t0 timestamptz; v_ms int;
  begin
    insert into tasks (id, device_id, status, start_time, outputs, created_at)
      select 'qd-p-' || g, u, 'completed', 1, '[]', now() - interval '1 minute' from generate_series(1, 6000) g;
    insert into history (id, device_id, timestamp, tasks, total_cost, created_at)
      select 'qd-P-' || j, u, 1, jsonb_build_array(
               jsonb_build_object('id', 'qd-p-' || (3 * j - 2), 'status', 'completed', 'cost', 1, 'outputs', '[]'::jsonb),
               jsonb_build_object('id', 'qd-p-' || (3 * j - 1), 'status', 'completed', 'cost', 1, 'outputs', '[]'::jsonb),
               jsonb_build_object('id', 'qd-p-' || (3 * j), 'status', 'completed', 'cost', 1, 'outputs', '[]'::jsonb)), 3,
             now() - interval '1 minute'
        from generate_series(1, 2000) j;
    v_names := array(select 'qd-p-' || g from generate_series(1, 6000) g);
    v_t0 := clock_timestamp();
    r := clear_queued_rows(v_tok, 'task', v_q, v_names);
    v_ms := (extract(epoch from clock_timestamp() - v_t0) * 1000)::int;
    out := out || case when (r->>'deleted')::int >= 6000 and v_ms < 2500
                        and not exists (select 1 from history where id like 'qd-P-%')
      then format('ok clear-perf (%s ms); ', v_ms) else format('FAIL clear-perf %s in %s ms; ', r, v_ms) end;
  exception when others then out := out || format('FAIL clear-perf %s %s; ', sqlstate, sqlerrm); end;

  -- 18. Review round 10 (migration 20261022310000): settings.updated_at is the server's (a client clock cannot move it),
  --     and the settings clear takes only rows written by its time: another device's later settings stay.
  declare v_at timestamptz; v_n int;
  begin
    insert into settings (device_id, key, value, updated_at) values (u, 'qd-stamp', '"v"', '2000-01-01')
      on conflict (device_id, key) do update set value = excluded.value, updated_at = excluded.updated_at;
    select updated_at into v_at from settings where device_id = u and key = 'qd-stamp';
    perform clear_queued_rows(v_tok, 'settings', (extract(epoch from now() - interval '30 seconds') * 1000)::bigint);
    v_n := (select count(*) from settings where device_id = u and key = 'qd-stamp');
    perform clear_queued_rows(v_tok, 'settings', (extract(epoch from now()) * 1000)::bigint + 1000);
    out := out || case when v_at = now() and v_n = 1 and not exists (select 1 from settings where device_id = u and key = 'qd-stamp')
      then 'ok settings-stamped; ' else format('FAIL settings-stamped at=%s kept-early=%s; ', v_at, v_n) end;
  exception when others then out := out || format('FAIL settings-stamped %s %s; ', sqlstate, sqlerrm); end;

  -- 19. Review round 10: Reset clears all four kinds in ONE restore-checked transaction (four calls let a restore void the
  --     later ones after the earlier ones had deleted). Voided: nothing changes.
  declare v_q bigint := (extract(epoch from now() - interval '30 seconds') * 1000)::bigint; v_n int;
  begin
    insert into tasks (id, device_id, status, start_time, outputs, created_at) values
      ('qd-r-old', u, 'completed', 1, '[]', now() - interval '1 minute'), ('qd-r-named', u, 'completed', 1, '[]', now() + interval '1 hour'),
      ('qd-r-later', u, 'completed', 1, '[]', now() + interval '1 hour');
    insert into history (id, device_id, timestamp, tasks, total_cost, created_at) values
      ('qd-R-old', u, 1, '[]', 0, now() - interval '1 minute'), ('qd-R-named', u, 1, '[]', 0, now() + interval '1 hour');
    insert into favorites (id, device_id, prompt, created_at) values ('qd-rf-old', u, 'p', now() - interval '1 minute');
    r := reset_queued_rows(v_tok, 4000, array['qd-r-named'], array['qd-R-named']);   -- before the marker (5000): voided
    v_n := (select count(*) from tasks where id like 'qd-r-%') + (select count(*) from history where id like 'qd-R-%')
         + (select count(*) from favorites where id = 'qd-rf-old');
    if not (r->>'voided')::boolean or v_n <> 6 then
      out := out || format('FAIL reset-queued voided %s n=%s; ', r, v_n);
    else
      execute 'set local role anon';
      r := reset_queued_rows(v_tok, v_q, array['qd-r-named'], array['qd-R-named']);
      execute 'reset role';
      out := out || case when not (r->>'voided')::boolean
                          and (select string_agg(id, ',') from tasks where id like 'qd-r-%') = 'qd-r-later'
                          and not exists (select 1 from history where id like 'qd-R-%')
                          and not exists (select 1 from favorites where id = 'qd-rf-old')
                          and exists (select 1 from settings where device_id = u and key = 'last_restore_at')
        then 'ok reset-queued; ' else format('FAIL reset-queued %s; ', r) end;
    end if;
  exception when others then execute 'reset role'; out := out || format('FAIL reset-queued %s %s; ', sqlstate, sqlerrm); end;

  -- 20. Review round 11 (migration 20261022320000): the snapshot comes from the server, not the device's clock estimate.
  declare v_ms bigint; v_now bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  begin
    execute 'set local role anon';
    v_ms := server_time_ms(v_tok);
    execute 'reset role';
    begin perform server_time_ms('garbage'); out := out || 'FAIL server-time accepts a bad token; ';
    exception when others then null; end;
    out := out || case when abs(v_ms - v_now) < 2000 then 'ok server-time; ' else format('FAIL server-time %s vs %s; ', v_ms, v_now) end;
  exception when others then execute 'reset role'; out := out || format('FAIL server-time %s %s; ', sqlstate, sqlerrm); end;

  -- 21. Review round 11: Reset clears tasks before History, the order of every other path (History first could deadlock
  --     with a concurrent task delete); settings are bounded by the exact snapshot (p_prefs_at), rows by p_queued_at.
  declare v_src text; v_t int; v_h int;
  begin
    select prosrc into v_src from pg_proc where proname = 'reset_queued_rows' and pronamespace = 'public'::regnamespace;
    v_t := position('''task''' in v_src); v_h := position('''history''' in v_src);
    insert into settings (device_id, key, value) values (u, 'qd-prefs', '"v"') on conflict (device_id, key) do update set value = excluded.value;
    insert into tasks (id, device_id, status, start_time, outputs) values ('qd-pa-now', u, 'completed', 1, '[]');
    r := reset_queued_rows(v_tok, (extract(epoch from now() - interval '30 seconds') * 1000)::bigint, null, null,
                           (extract(epoch from now()) * 1000)::bigint + 1000);
    out := out || case when v_t > 0 and v_h > v_t
                        and not exists (select 1 from settings where device_id = u and key = 'qd-prefs')
                        and exists (select 1 from tasks where id = 'qd-pa-now')
      then 'ok reset-order-prefs; ' else format('FAIL reset-order-prefs task@%s history@%s %s; ', v_t, v_h, r) end;
  exception when others then out := out || format('FAIL reset-order-prefs %s %s; ', sqlstate, sqlerrm); end;

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
       and p.proname in ('restore_my_backup_phase2', 'delete_queued_rows', 'rename_my_account', 'clear_queued_rows', 'upsert_queued_history', 'reset_queued_rows')
       and not (position('last_restore_at'' for' in p.prosrc) > 0      -- the lock statement: "... 'last_restore_at' for update|share"
                and position('last_restore_at'' for' in p.prosrc)
                    < least(coalesce(nullif(position('delete from tasks' in p.prosrc), 0), 999999),
                            coalesce(nullif(position('update tasks' in p.prosrc), 0), 999999)));
    out := out || case when v_bad is null then 'ok marker-lock-first; ' else format('FAIL marker-lock-first %s; ', v_bad) end;
  exception when others then out := out || format('FAIL marker-lock-first %s %s; ', sqlstate, sqlerrm); end;

  raise exception 'RESULT: %', out;
end $t$;
