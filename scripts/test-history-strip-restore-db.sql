-- Tests for supabase/migrations/20261024100000_history_strip_restore_removed.sql: a History write (not a restore) strips an
-- item whose generation a restore removed (a by_restore task tombstone in the entry's scope) when the stored entry does
-- not hold it already; a restore's History-only comeback keeps its items; user tombstones strip as before. Same harness as
-- test-history-strip-db.sql (one DO block, always rolled back by sql-tx). The migration is live (2026-10-23 22:31:54 UTC)
-- and P4 (20261025300000) later changed the function's conflict target, so run it against live, without the migration
-- file (prepending the file now fails R3/R8/R10c with 42P10; review round 30 #4):
--   node scripts/tools/sql-tx.mjs --test scripts/test-history-strip-restore-db.sql
-- Fixtures only: 'user:__strip_restore_test' and ids 'hr-' (R1-R8, as the owner of the tables); R9 runs as anon with a token
-- minted for the account's owner, in that account's own scope, with ids '__hr_probe_<txid>'. Each case catches its errors.
do $t$
declare
  out text := '';
  u constant text := 'user:__strip_restore_test';
  h record; ok boolean; v text; n int;
  ou text; tk text; s text; p text := '__hr_probe_' || txid_current();
begin
  insert into tasks (id, device_id, status, start_time, outputs) values
    ('hr-x', u, 'completed', 1000, '[]'), ('hr-x2', u, 'completed', 1000, '[]'), ('hr-y', u, 'completed', 1000, '[]'),
    ('hr-z', u, 'completed', 1000, '[]'), ('hr-u', u, 'completed', 1000, '[]'), ('hr-w', u, 'completed', 1000, '[]');
  insert into history (id, device_id, timestamp, tasks, total_cost) values
    ('hr-L', u, 1000, '[{"id":"hr-y","status":"completed","cost":2}]', 2),
    ('hr-M', u, 1000, '[{"id":"hr-x2","status":"completed","cost":3}]', 3);
  -- A restore removes hr-x, hr-x2 and hr-w (by_restore tombstones); a user deletes hr-u (a user tombstone).
  perform set_config('proxima.restore', 'on', true);
  delete from tasks where id in ('hr-x', 'hr-x2', 'hr-w');
  perform set_config('proxima.restore', 'off', true);
  delete from tasks where id = 'hr-u';
  ok := (select count(*) from sync_tombstones where id in ('hr-x', 'hr-x2', 'hr-w') and kind = 'task' and by_restore and device_id = u) = 3
    and exists (select 1 from sync_tombstones where id = 'hr-u' and not by_restore);
  out := out || case when ok then 'ok premise-tombstones; ' else 'FAIL premise-tombstones; ' end;

  -- R1. An upload re-adding a restore-removed item to an entry that lacks it: stripped, total recomputed.
  begin
    update history set tasks = '[{"id":"hr-y","status":"completed","cost":2},{"id":"hr-x","status":"completed","cost":5}]', total_cost = 7
     where id = 'hr-L';
    select * into h from history where id = 'hr-L';
    ok := (select array_agg(e->>'id') from jsonb_array_elements(h.tasks) e) = '{hr-y}' and h.total_cost = 2;
    out := out || case when ok then 'ok R1 re-added-stripped; ' else format('FAIL R1 re-added-stripped %s %s; ', h.tasks, h.total_cost) end;
  exception when others then out := out || format('FAIL R1 %s %s; ', sqlstate, sqlerrm); end;

  -- R2. The stored entry already holds it (a restore's History-only comeback): kept on a later write.
  begin
    update history set total_cost = 3.5 where id = 'hr-M';
    select * into h from history where id = 'hr-M';
    ok := h.tasks->0->>'id' = 'hr-x2';
    out := out || case when ok then 'ok R2 held-kept; ' else format('FAIL R2 held-kept %s; ', h.tasks) end;
  exception when others then out := out || format('FAIL R2 %s %s; ', sqlstate, sqlerrm); end;

  -- R3. A new entry made only of restore-removed items: not inserted, a restore's History tombstone.
  begin
    insert into history (id, device_id, timestamp, tasks, total_cost) values
      ('hr-N', u, 1000, '[{"id":"hr-x","status":"completed","cost":5},{"id":"hr-w","status":"completed","cost":1}]', 6);
    ok := not exists (select 1 from history where id = 'hr-N')
      and exists (select 1 from sync_tombstones where id = 'hr-N' and kind = 'history' and by_restore and device_id = u);
    out := out || case when ok then 'ok R3 new-all-restore-removed; ' else format('FAIL R3 %s; ', (select by_restore from sync_tombstones where id = 'hr-N')) end;
  exception when others then out := out || format('FAIL R3 %s %s; ', sqlstate, sqlerrm); end;

  -- R4. A new entry mixing a restore-removed item and a live one keeps the live one.
  begin
    insert into history (id, device_id, timestamp, tasks, total_cost) values
      ('hr-O', u, 1000, '[{"id":"hr-x","status":"completed","cost":5},{"id":"hr-z","status":"completed","cost":4}]', 9);
    select * into h from history where id = 'hr-O';
    ok := (select array_agg(e->>'id') from jsonb_array_elements(h.tasks) e) = '{hr-z}' and h.total_cost = 4;
    out := out || case when ok then 'ok R4 mixed; ' else format('FAIL R4 mixed %s %s; ', h.tasks, h.total_cost) end;
  exception when others then out := out || format('FAIL R4 %s %s; ', sqlstate, sqlerrm); end;

  -- R5. The upsert path (insert ... on conflict do update) re-adding it to an existing entry: stripped.
  begin
    insert into history (id, device_id, timestamp, tasks, total_cost) values
      ('hr-L', u, 1000, '[{"id":"hr-y","status":"completed","cost":2},{"id":"hr-x","status":"completed","cost":5}]', 7)
      on conflict (device_id, id) do update set tasks = excluded.tasks, total_cost = excluded.total_cost;
    select * into h from history where id = 'hr-L';
    ok := (select array_agg(e->>'id') from jsonb_array_elements(h.tasks) e) = '{hr-y}';
    out := out || case when ok then 'ok R5 upsert-stripped; ' else format('FAIL R5 upsert-stripped %s; ', h.tasks) end;
  exception when others then out := out || format('FAIL R5 %s %s; ', sqlstate, sqlerrm); end;

  -- R6. A user's delete strips as before, held or not.
  begin
    update history set tasks = '[{"id":"hr-y","status":"completed","cost":2},{"id":"hr-u","status":"completed","cost":1}]' where id = 'hr-L';
    select * into h from history where id = 'hr-L';
    ok := (select array_agg(e->>'id') from jsonb_array_elements(h.tasks) e) = '{hr-y}';
    out := out || case when ok then 'ok R6 user-strip; ' else format('FAIL R6 user-strip %s; ', h.tasks) end;
  exception when others then out := out || format('FAIL R6 %s %s; ', sqlstate, sqlerrm); end;

  -- R7. A restore writes its snapshot as it was (exempt).
  begin
    perform set_config('proxima.restore', 'on', true);
    insert into history (id, device_id, timestamp, tasks, total_cost) values
      ('hr-P', u, 1000, '[{"id":"hr-x","status":"completed","cost":5}]', 5);
    perform set_config('proxima.restore', 'off', true);
    select * into h from history where id = 'hr-P';
    out := out || case when h.tasks->0->>'id' = 'hr-x' then 'ok R7 restore-exempt; ' else format('FAIL R7 restore-exempt %s; ', h.tasks) end;
  exception when others then out := out || format('FAIL R7 %s %s; ', sqlstate, sqlerrm); end;

  -- R8. A new entry made only of user-deleted items: a USER History tombstone, as before.
  begin
    insert into history (id, device_id, timestamp, tasks, total_cost) values
      ('hr-Q', u, 1000, '[{"id":"hr-u","status":"completed","cost":1}]', 1);
    ok := not exists (select 1 from history where id = 'hr-Q')
      and exists (select 1 from sync_tombstones where id = 'hr-Q' and kind = 'history' and not by_restore);
    out := out || case when ok then 'ok R8 new-user-only; ' else 'FAIL R8 new-user-only; ' end;
  exception when others then out := out || format('FAIL R8 %s %s; ', sqlstate, sqlerrm); end;

  -- R11 (migration review, hardening). A stored entry holding an item without an id does not shield a restore-removed one
  -- (an id-less item made the "held" set contain NULL, and `id = any(...)` NULL kept the item).
  begin
    insert into history (id, device_id, timestamp, tasks, total_cost) values
      ('hr-V', u, 1000, '[{"status":"completed","cost":1,"outputs":["o"]}]', 1);
    update history set tasks = '[{"status":"completed","cost":1,"outputs":["o"]},{"id":"hr-x","status":"completed","cost":5}]' where id = 'hr-V';
    select * into h from history where id = 'hr-V';
    ok := jsonb_array_length(h.tasks) = 1 and h.tasks->0->>'id' is null;
    out := out || case when ok then 'ok R11 idless-held-no-shield; ' else format('FAIL R11 idless-held-no-shield %s; ', h.tasks) end;
  exception when others then out := out || format('FAIL R11 %s %s; ', sqlstate, sqlerrm); end;

  -- R9. The app's path: anon with a token minted for the owner, in the owner's own scope (row policies + the trigger).
  begin
    execute 'select username, proxima_auth.mint_token(id) from proxima_auth.users where role = ''owner''' into ou, tk;
    s := 'user:' || ou;
    insert into tasks (id, device_id, status, start_time, outputs) values (p || '_x', s, 'completed', 1000, '[]'), (p || '_y', s, 'completed', 1000, '[]');
    perform set_config('proxima.restore', 'on', true);
    delete from tasks where id = p || '_x';
    perform set_config('proxima.restore', 'off', true);
    execute 'set local role anon';
    perform set_config('request.headers', json_build_object('x-proxima-session', tk)::text, true);
    insert into public.history (id, device_id, timestamp, tasks, total_cost) values
      (p || '_L', s, 1000, format('[{"id":"%s_x","status":"completed","cost":5},{"id":"%s_y","status":"completed","cost":4}]', p, p)::jsonb, 9)
      on conflict (device_id, id) do update set tasks = excluded.tasks, total_cost = excluded.total_cost;
    select string_agg(e->>'id', ',') into v from public.history hh, jsonb_array_elements(hh.tasks) e where hh.id = p || '_L';
    execute 'reset role';
    out := out || case when v = p || '_y' then 'ok R9 anon-token; ' else format('FAIL R9 anon-token %s; ', v) end;
  exception when others then
    begin execute 'reset role'; exception when others then null; end;
    out := out || format('FAIL R9 %s %s; ', sqlstate, sqlerrm);
  end;

  -- R10 (RLS session's review, MEDIUM). The emptied-new-entry branch returns NULL, so the row policies' WITH CHECK never
  -- runs for it: a browser role naming ANOTHER scope must get nothing written there (no History tombstone, no answer that
  -- tells which items are tombstoned): no header (28000), another account's session (42501). The owner's own session still
  -- gets its restore-only tombstone (R3 on the app's path).
  declare
    st text; acc uuid; tk2 text;
  begin
    execute 'insert into proxima_auth.users (username, role, scope) values ($1, ''member'', $2) returning id'
      into acc using '__hr_other_' || txid_current(), 'user:__hr_other_' || txid_current();
    execute 'select proxima_auth.mint_token($1)' into tk2 using acc;
    -- a) no header
    st := 'none';
    begin
      execute 'set local role anon';
      perform set_config('request.headers', '{}', true);
      insert into public.history (id, device_id, timestamp, tasks, total_cost) values
        (p || '_F1', s, 1000, format('[{"id":"%s_x","status":"completed","cost":5}]', p)::jsonb, 5);
    exception when others then st := sqlstate; end;
    execute 'reset role';
    out := out || case when st in ('28000', '42501') and not exists (select 1 from sync_tombstones where id = p || '_F1')
                       then format('ok R10a no-header refused (%s); ', st) else format('FAIL R10a no-header %s tomb=%s; ', st, exists (select 1 from sync_tombstones where id = p || '_F1')) end;
    -- b) another account's valid session
    st := 'none';
    begin
      execute 'set local role anon';
      perform set_config('request.headers', json_build_object('x-proxima-session', tk2)::text, true);
      insert into public.history (id, device_id, timestamp, tasks, total_cost) values
        (p || '_F2', s, 1000, format('[{"id":"%s_x","status":"completed","cost":5}]', p)::jsonb, 5);
    exception when others then st := sqlstate; end;
    execute 'reset role';
    out := out || case when st in ('28000', '42501') and not exists (select 1 from sync_tombstones where id = p || '_F2')
                       then format('ok R10b other-account refused (%s); ', st) else format('FAIL R10b other-account %s tomb=%s; ', st, exists (select 1 from sync_tombstones where id = p || '_F2')) end;
    -- d) migration review #2/#3: the SECURITY DEFINER path (upsert_queued_history; no row policy runs inside it) with the
    --    owner's valid p_session_token but no header, then another account's header. Before 20261025910000: an error, no
    --    row, no tombstone (before that, the guard returned an empty row there, which the definer then inserted). From
    --    20261025910000 (B17 review #4): the RPC writes in the scope its own token proves (its statements run as the function's
    --    owner, which the browser-scope guard trusts), whatever the header: the emptied entry is not stored and gets a restore's History tombstone in the OWNER's scope only.
    declare v_rpc boolean := exists (select 1 from pg_trigger where tgname = 'history_0_scope_guard');   -- 20261025910000
    begin
    for i in 1..2 loop
      st := 'none';
      begin
        execute 'set local role anon';
        perform set_config('request.headers', case when i = 1 then '{}' else json_build_object('x-proxima-session', tk2)::text end, true);
        perform public.upsert_queued_history(tk, format('[{"id":"%s_F4%s","timestamp":1000,"tasks":[{"id":"%s_x","status":"completed","cost":5}],"total_cost":5}]', p, i, p)::jsonb,
          (extract(epoch from clock_timestamp()) * 1000)::bigint + 60000);
      exception when others then st := sqlstate; end;
      execute 'reset role';
      out := out || case
        when not v_rpc and st in ('28000', '42501') and not exists (select 1 from history where id = p || '_F4' || i)
             and not exists (select 1 from sync_tombstones where id = p || '_F4' || i)
          then format('ok R10d definer-rpc %s refused (%s); ', i, st)
        when v_rpc and st = 'none' and not exists (select 1 from history where id = p || '_F4' || i)
             and exists (select 1 from sync_tombstones where id = p || '_F4' || i and kind = 'history' and by_restore and device_id = s)
             and not exists (select 1 from sync_tombstones where id = p || '_F4' || i and device_id <> s)
          then format('ok R10d definer-rpc %s own-scope tombstone; ', i)
        else format('FAIL R10d definer-rpc %s %s row=%s tomb=%s; ', i, st, exists (select 1 from history where id = p || '_F4' || i), exists (select 1 from sync_tombstones where id = p || '_F4' || i)) end;
    end loop;
    end;
    -- c) the owner's own session: not inserted, a restore's History tombstone in its own scope
    st := 'none';
    begin
      execute 'set local role anon';
      perform set_config('request.headers', json_build_object('x-proxima-session', tk)::text, true);
      insert into public.history (id, device_id, timestamp, tasks, total_cost) values
        (p || '_F3', s, 1000, format('[{"id":"%s_x","status":"completed","cost":5}]', p)::jsonb, 5);
    exception when others then st := sqlstate; end;
    execute 'reset role';
    out := out || case when st = 'none' and not exists (select 1 from history where id = p || '_F3')
                         and exists (select 1 from sync_tombstones where id = p || '_F3' and kind = 'history' and by_restore and device_id = s)
                       then 'ok R10c own-session tombstone; ' else format('FAIL R10c own-session %s; ', st) end;
  exception when others then
    begin execute 'reset role'; exception when others then null; end;
    out := out || format('FAIL R10 %s %s; ', sqlstate, sqlerrm);
  end;

  raise exception 'RESULT: %', out;
end $t$;
