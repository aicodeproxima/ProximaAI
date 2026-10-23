-- Tests for supabase/migrations/20261023500000_tombstone_rowless_scoped.sql (simulator findings F1, F2, F4):
--   a rowless task id and a rowless History id named in delete_queued_rows, clear_queued_rows and reset_queued_rows get
--   a user tombstone with the caller's scope, and a later insert or upsert of that id from the same scope is dropped;
--   with two accounts, A naming an id never writes over B's tombstone and never drops B's insert/upsert, and B's own
--   tombstone keeps device_id = B (also through A's insert and delete of the same id: sync_tombstone_clear/record guards);
--   _clear_kind turns a restore's (by_restore) tombstone of a named id into a user one; History uploads are stripped only
--   by the entry's own scope's tombstones; the restore bypass still re-inserts; a rename still moves tombstones;
--   T11 the (kind, scope) row locks; T12 a browser insert outside its session's scope takes no lock (RLS review).
-- One DO block that always ends in an exception: everything rolls back. Fixtures: member accounts '__tr_a', '__tr_b',
-- '__tr_c' (proxima_auth.users + mint_token; no member may persist before P5), ids prefixed '__tr_<txid>'. Rows are
-- written as postgres (the BEFORE INSERT trigger runs for every role); the delete RPCs are called as anon with the token,
-- as the app calls them. Tokens and the fixture password live in variables only; only labels and counts are printed.
--   node scripts/tools/sql-tx.mjs supabase/migrations/20261023500000_tombstone_rowless_scoped.sql --test scripts/test-tombstone-rowless-db.sql
--   node scripts/tools/sql-tx.mjs --test scripts/test-tombstone-rowless-db.sql      (before the migration: fails)
-- T11's helper (session-temporary, rolled back with the rest): does this backend hold the (kind, scope) row lock in mode?
create function pg_temp._tr_lock_held(p_kind text, p_scope text, p_mode text) returns boolean language sql as $f$
  select exists (select 1 from pg_locks l, (select hashtextextended('proxima-rows:' || p_kind || ':' || p_scope, 0) as k) h
                  where l.locktype = 'advisory' and l.pid = pg_backend_pid() and l.mode = p_mode and l.objsubid = 1
                    and l.classid::text::bigint = ((h.k >> 32) & 4294967295) and l.objid::text::bigint = (h.k & 4294967295))
$f$;
-- T12's probe (rolled back with the rest): a BEFORE INSERT trigger named to fire after *_not_tombstoned and before the
-- row policies' WITH CHECK. With tr.probe = 'on' it raises 'TRPROBE t|f' (does this backend hold any advisory lock
-- on the row's (kind, scope) key at that moment?), so an insert that RLS then refuses (its subtransaction, and the lock
-- with it, rolled back) still reports what the trigger took. Off, it passes the row through.
create function public._tr_probe() returns trigger language plpgsql security definer set search_path = pg_catalog, public as $f$
begin
  if coalesce(current_setting('tr.probe', true), '') = 'on' then
    raise exception 'TRPROBE %', exists (select 1 from pg_locks l, (select hashtextextended('proxima-rows:' || tg_argv[0] || ':' || coalesce(new.device_id, ''), 0) as k) h
                                          where l.locktype = 'advisory' and l.pid = pg_backend_pid() and l.objsubid = 1
                                            and l.classid::text::bigint = ((h.k >> 32) & 4294967295) and l.objid::text::bigint = (h.k & 4294967295));
  end if;
  return new;
end $f$;
-- T12's attempt: one insert of (kind, id, scope) as p_role (null = postgres) with p_tok in request.headers (null = no
-- header), the probe on or off. Returns 'landed' or '<sqlstate> <message>'; role, header and probe are reset after.
create function pg_temp._tr_try(p_role text, p_tok text, p_kind text, p_id text, p_scope text, p_probe boolean)
returns text language plpgsql as $f$
declare v text;
begin
  perform set_config('request.headers', case when p_tok is null then '' else json_build_object('x-proxima-session', p_tok)::text end, true);
  perform set_config('tr.probe', case when p_probe then 'on' else '' end, true);
  begin
    if p_role is not null then execute format('set local role %I', p_role); end if;
    if p_kind = 'task' then
      insert into public.tasks (id, device_id, status, start_time, outputs) values (p_id, p_scope, 'completed', 1000, '[]');
    else
      insert into public.history (id, device_id, timestamp, tasks, total_cost) values (p_id, p_scope, 1000, '[]', 0);
    end if;
    v := 'landed';
  exception when others then
    v := sqlstate || ' ' || sqlerrm;
  end;
  execute 'reset role';
  perform set_config('request.headers', '', true);
  perform set_config('tr.probe', '', true);
  return v;
end $f$;
do $t$
declare
  out text := '';
  p   constant text := '__tr_' || txid_current();
  a_id constant uuid := '7e570000-0000-4000-8000-0000000000a1';
  b_id constant uuid := '7e570000-0000-4000-8000-0000000000b1';
  c_id constant uuid := '7e570000-0000-4000-8000-0000000000c1';
  sa constant text := 'user:__tr_a';
  sb constant text := 'user:__tr_b';
  sc constant text := 'user:__tr_c';
  pw constant text := md5(random()::text);
  ta text; tb text; tc text; r json; v_bk uuid; n int; d text; br boolean; x text;
begin
  if to_regclass('proxima_auth.users') is null then
    raise exception 'RESULT: FAIL M1 not applied (no proxima_auth.users)';
  end if;
  insert into proxima_auth.users (id, username, role, scope, password_hash, sessions_valid_after)
    values (a_id, '__tr_a', 'member', sa, null, 0), (b_id, '__tr_b', 'member', sb, null, 0),
           (c_id, '__tr_c', 'member', sc, extensions.crypt(pw, extensions.gen_salt('bf', 4)), 0);
  ta := proxima_auth.mint_token(a_id);
  tb := proxima_auth.mint_token(b_id);
  tc := proxima_auth.mint_token(c_id);

  -- T1 delete_queued_rows, task kind: a rowless id no History item holds (twice, plus '' and null in the list).
  begin
    execute 'set local role anon';
    r := delete_queued_rows(ta, 'task', array[p || '_t1', p || '_t1', '', null], 9e12::bigint);
    execute 'reset role';
    select count(*), min(device_id), bool_or(by_restore) into n, d, br from sync_tombstones where id = p || '_t1' and kind = 'task';
    out := out || case when n = 1 and d = sa and not br then 'ok T1 dqr task rowless tombstone in caller scope; '
                       else format('FAIL T1 dqr task rowless tombstone n=%s scope_ok=%s; ', n, d = sa) end;
    insert into tasks (id, device_id, status, start_time, outputs) values (p || '_t1', sa, 'completed', 1000, '[]');
    insert into tasks (id, device_id, status, start_time, outputs) values (p || '_t1', sa, 'completed', 1000, '[]')
      on conflict (id) do update set status = excluded.status;
    out := out || case when not exists (select 1 from tasks where id = p || '_t1') then 'ok T1 later insert+upsert dropped (F1); '
                       else 'FAIL T1 later insert+upsert landed (F1); ' end;
  exception when others then execute 'reset role'; out := out || format('FAIL T1 %s %s; ', sqlstate, sqlerrm); end;

  -- T2 delete_queued_rows, History kind: a rowless History id.
  begin
    execute 'set local role anon';
    r := delete_queued_rows(ta, 'history', array[p || '_h1'], 9e12::bigint);
    execute 'reset role';
    select count(*), min(device_id) into n, d from sync_tombstones where id = p || '_h1' and kind = 'history' and not by_restore;
    out := out || case when n = 1 and d = sa then 'ok T2 dqr history rowless tombstone in caller scope; '
                       else format('FAIL T2 dqr history rowless tombstone n=%s; ', n) end;
    insert into history (id, device_id, timestamp, tasks, total_cost) values (p || '_h1', sa, 1000, '[]', 0);
    insert into history (id, device_id, timestamp, tasks, total_cost) values (p || '_h1', sa, 1000, '[]', 0)
      on conflict (id) do update set timestamp = excluded.timestamp;
    out := out || case when not exists (select 1 from history where id = p || '_h1') then 'ok T2 later insert+upsert dropped (F4); '
                       else 'FAIL T2 later insert+upsert landed (F4); ' end;
  exception when others then execute 'reset role'; out := out || format('FAIL T2 %s %s; ', sqlstate, sqlerrm); end;

  -- T3 clear_queued_rows, both kinds, named rowless ids (bound in 1970: only the named ids count).
  begin
    execute 'set local role anon';
    r := clear_queued_rows(ta, 'task', 1, array[p || '_t3']);
    r := clear_queued_rows(ta, 'history', 1, array[p || '_h3']);
    execute 'reset role';
    select count(*) into n from sync_tombstones
     where ((id = p || '_t3' and kind = 'task') or (id = p || '_h3' and kind = 'history')) and device_id = sa and not by_restore;
    out := out || case when n = 2 then 'ok T3 clear task+history rowless tombstones in caller scope; '
                       else format('FAIL T3 clear rowless tombstones n=%s (want 2); ', n) end;
    insert into tasks (id, device_id, status, start_time, outputs) values (p || '_t3', sa, 'completed', 1000, '[]')
      on conflict (id) do update set status = excluded.status;
    insert into history (id, device_id, timestamp, tasks, total_cost) values (p || '_h3', sa, 1000, '[]', 0)
      on conflict (id) do update set timestamp = excluded.timestamp;
    out := out || case when not exists (select 1 from tasks where id = p || '_t3') and not exists (select 1 from history where id = p || '_h3')
                       then 'ok T3 later upserts dropped; ' else 'FAIL T3 later upserts landed; ' end;
  exception when others then execute 'reset role'; out := out || format('FAIL T3 %s %s; ', sqlstate, sqlerrm); end;

  -- T4 reset_queued_rows, both kinds.
  begin
    execute 'set local role anon';
    r := reset_queued_rows(ta, 1, array[p || '_t4'], array[p || '_h4']);
    execute 'reset role';
    select count(*) into n from sync_tombstones
     where ((id = p || '_t4' and kind = 'task') or (id = p || '_h4' and kind = 'history')) and device_id = sa and not by_restore;
    out := out || case when n = 2 then 'ok T4 reset task+history rowless tombstones in caller scope; '
                       else format('FAIL T4 reset rowless tombstones n=%s (want 2); ', n) end;
    insert into tasks (id, device_id, status, start_time, outputs) values (p || '_t4', sa, 'completed', 1000, '[]');
    insert into history (id, device_id, timestamp, tasks, total_cost) values (p || '_h4', sa, 1000, '[]', 0);
    out := out || case when not exists (select 1 from tasks where id = p || '_t4') and not exists (select 1 from history where id = p || '_h4')
                       then 'ok T4 later inserts dropped; ' else 'FAIL T4 later inserts landed; ' end;
  exception when others then execute 'reset role'; out := out || format('FAIL T4 %s %s; ', sqlstate, sqlerrm); end;

  -- T5 two accounts: A names B's ids. (a) B holds row X: A's call leaves B's row and writes no tombstone; (b) X2 has no
  --    row yet: A's tombstone of it never drops B's insert or upsert (task and History).
  begin
    insert into tasks (id, device_id, status, start_time, outputs) values (p || '_x1', sb, 'completed', 1000, '[]');
    execute 'set local role anon';
    r := delete_queued_rows(ta, 'task', array[p || '_x1', p || '_x2'], 9e12::bigint);
    r := delete_queued_rows(ta, 'history', array[p || '_xl2'], 9e12::bigint);
    r := clear_queued_rows(ta, 'task', 1, array[p || '_x1']);
    execute 'reset role';
    out := out || case when exists (select 1 from tasks where id = p || '_x1' and device_id = sb)
                        and not exists (select 1 from sync_tombstones where id = p || '_x1')
                       then 'ok T5a A naming B''s live row: row kept, no tombstone; ' else 'FAIL T5a A naming B''s live row; ' end;
    insert into tasks (id, device_id, status, start_time, outputs) values (p || '_x2', sb, 'completed', 1000, '[]');
    insert into tasks (id, device_id, status, start_time, outputs) values (p || '_x2', sb, 'completed', 2000, '[]')
      on conflict (id) do update set start_time = excluded.start_time;
    insert into history (id, device_id, timestamp, tasks, total_cost) values (p || '_xl2', sb, 1000, '[]', 0)
      on conflict (id) do update set timestamp = excluded.timestamp;
    out := out || case when exists (select 1 from tasks where id = p || '_x2' and device_id = sb and start_time = 2000)
                        and exists (select 1 from history where id = p || '_xl2' and device_id = sb)
                       then 'ok T5b A''s tombstone never drops B''s insert/upsert; ' else 'FAIL T5b A''s tombstone dropped B''s insert/upsert; ' end;
    -- B's History upload with an item A tombstoned: kept (the strip reads only B's own tombstones).
    insert into history (id, device_id, timestamp, tasks, total_cost)
      values (p || '_xl3', sb, 1000, jsonb_build_array(jsonb_build_object('id', p || '_x2', 'status', 'completed', 'cost', 1)), 1);
    out := out || case when (select jsonb_array_length(tasks) from history where id = p || '_xl3') = 1
                       then 'ok T5c A''s tombstone does not strip B''s History item; ' else 'FAIL T5c B''s History item stripped or entry dropped; ' end;
  exception when others then execute 'reset role'; out := out || format('FAIL T5 %s %s; ', sqlstate, sqlerrm); end;

  -- T6 B deletes X, then A names X (every path): B's tombstone keeps device_id = B, and B's re-insert/upsert is dropped.
  begin
    insert into tasks (id, device_id, status, start_time, outputs) values (p || '_x4', sb, 'completed', 1000, '[]');
    insert into history (id, device_id, timestamp, tasks, total_cost) values (p || '_xl4', sb, 1000, '[]', 0);
    execute 'set local role anon';
    r := delete_queued_rows(tb, 'task', array[p || '_x4'], 9e12::bigint);
    r := delete_queued_rows(tb, 'history', array[p || '_xl4'], 9e12::bigint);
    r := delete_queued_rows(ta, 'task', array[p || '_x4'], 9e12::bigint);
    r := delete_queued_rows(ta, 'history', array[p || '_xl4'], 9e12::bigint);
    r := clear_queued_rows(ta, 'task', 1, array[p || '_x4']);
    r := clear_queued_rows(ta, 'history', 1, array[p || '_xl4']);
    r := reset_queued_rows(ta, 1, array[p || '_x4'], array[p || '_xl4']);
    execute 'reset role';
    select count(*) into n from sync_tombstones where id in (p || '_x4', p || '_xl4') and device_id = sb and not by_restore;
    out := out || case when n = 2 then 'ok T6 B''s tombstones keep device_id B after A names them; '
                       else format('FAIL T6 B''s tombstones moved n=%s; ', n) end;
    insert into tasks (id, device_id, status, start_time, outputs) values (p || '_x4', sb, 'completed', 1000, '[]')
      on conflict (id) do update set status = excluded.status;
    insert into history (id, device_id, timestamp, tasks, total_cost) values (p || '_xl4', sb, 1000, '[]', 0);
    out := out || case when not exists (select 1 from tasks where id = p || '_x4') and not exists (select 1 from history where id = p || '_xl4')
                       then 'ok T6 B''s re-insert/upsert still dropped; ' else 'FAIL T6 B''s re-insert landed; ' end;
  exception when others then execute 'reset role'; out := out || format('FAIL T6 %s %s; ', sqlstate, sqlerrm); end;

  -- T7 B deleted X; A inserts a row X (not silenced by B's tombstone), which neither removes B's tombstone
  --    (sync_tombstone_clear) nor, when A deletes it, moves it into A's scope (sync_tombstone_record); B's re-insert is
  --    still dropped.
  begin
    insert into tasks (id, device_id, status, start_time, outputs) values (p || '_x5', sb, 'completed', 1000, '[]');
    execute 'set local role anon';
    r := delete_queued_rows(tb, 'task', array[p || '_x5'], 9e12::bigint);
    execute 'reset role';
    insert into tasks (id, device_id, status, start_time, outputs) values (p || '_x5', sa, 'completed', 1000, '[]');
    out := out || case when exists (select 1 from tasks where id = p || '_x5' and device_id = sa)
                        and exists (select 1 from sync_tombstones where id = p || '_x5' and device_id = sb)
                       then 'ok T7 A''s insert lands, B''s tombstone stays; ' else 'FAIL T7 A''s insert dropped or B''s tombstone removed; ' end;
    execute 'set local role anon';
    r := delete_queued_rows(ta, 'task', array[p || '_x5'], 9e12::bigint);
    execute 'reset role';
    select count(*), min(device_id) into n, d from sync_tombstones where id = p || '_x5';
    insert into tasks (id, device_id, status, start_time, outputs) values (p || '_x5', sb, 'completed', 1000, '[]');
    out := out || case when (r->>'deleted')::int = 1 and n = 1 and d = sb and not exists (select 1 from tasks where id = p || '_x5')
                       then 'ok T7 A''s delete keeps B''s tombstone in B, B''s re-insert dropped; '
                       else format('FAIL T7 after A''s delete: deleted=%s n=%s b_scope=%s; ', r->>'deleted', n, d = sb) end;
  exception when others then execute 'reset role'; out := out || format('FAIL T7 %s %s; ', sqlstate, sqlerrm); end;

  -- T8 F2: a restore's tombstone (by_restore) of a named id becomes a user tombstone through clear_queued_rows and
  --    reset_queued_rows (a rowless id no History item holds), as through delete_queued_rows.
  begin
    insert into sync_tombstones (id, kind, device_id, deleted_at, by_restore)
      values (p || '_r1', 'task', sa, now() - interval '1 hour', true), (p || '_r2', 'task', sa, now() - interval '1 hour', true),
             (p || '_r3', 'task', sa, now() - interval '1 hour', true);
    execute 'set local role anon';
    r := clear_queued_rows(ta, 'task', 1, array[p || '_r1']);
    r := reset_queued_rows(ta, 1, array[p || '_r2'], null);
    r := delete_queued_rows(ta, 'task', array[p || '_r3'], 9e12::bigint);
    execute 'reset role';
    select count(*) into n from sync_tombstones where id in (p || '_r1', p || '_r2', p || '_r3') and device_id = sa and not by_restore;
    out := out || case when n = 3 then 'ok T8 by_restore flipped to user by clear, reset and delete (F2); '
                       else format('FAIL T8 by_restore flipped for %s of 3 (F2); ', n) end;
  exception when others then execute 'reset role'; out := out || format('FAIL T8 %s %s; ', sqlstate, sqlerrm); end;

  -- T9 the restore bypass: C holds a user tombstone of an id (written directly: a row delete would queue a backup scrub
  --    that the restore's drain applies to this backup first), then restores a backup holding it: the row comes back and
  --    C's tombstone of it is gone. T9/T10 do not depend on the migration (unchanged behaviour).
  begin
    insert into sync_tombstones (id, kind, device_id, deleted_at, by_restore) values (p || '_c1', 'task', sc, now(), false);
    select count(*) into n from sync_tombstones where id = p || '_c1' and device_id = sc;
    insert into data_backups (username, backup_type, task_count, history_count, tasks_snapshot, history_snapshot, settings_snapshot)
      values (sc, 'manual', 1, 0, jsonb_build_array(jsonb_build_object('id', p || '_c1', 'status', 'completed', 'start_time', 1000, 'outputs', '[]'::jsonb)),
              '[]', '{}') returning id into v_bk;
    r := restore_my_backup_phase2(tc, v_bk);
    out := out || case when n = 1 and (r->>'ok')::boolean and exists (select 1 from tasks where id = p || '_c1' and device_id = sc)
                        and not exists (select 1 from sync_tombstones where id = p || '_c1')
                       then 'ok T9 restore re-inserts a tombstoned id; ' else format('FAIL T9 restore bypass n=%s r=%s; ', n, r->>'ok') end;
  exception when others then out := out || format('FAIL T9 %s %s; ', sqlstate, sqlerrm); end;

  -- T10 a rename moves C's tombstones, and they keep dropping the renamed scope's inserts.
  begin
    insert into tasks (id, device_id, status, start_time, outputs) values (p || '_c2', sc, 'completed', 1000, '[]');
    execute 'set local role anon';
    r := delete_queued_rows(tc, 'task', array[p || '_c2'], 9e12::bigint);
    r := rename_my_account(tc, pw, '__tr_c2');
    execute 'reset role';
    select count(*), min(device_id) into n, d from sync_tombstones where id = p || '_c2';
    insert into tasks (id, device_id, status, start_time, outputs) values (p || '_c2', 'user:__tr_c2', 'completed', 1000, '[]');
    out := out || case when (r->>'ok')::boolean and n = 1 and d = 'user:__tr_c2' and not exists (select 1 from tasks where id = p || '_c2')
                       then 'ok T10 rename moves tombstones, insert in new scope dropped; '
                       else format('FAIL T10 rename ok=%s n=%s moved=%s; ', r->>'ok', n, d = 'user:__tr_c2') end;
  exception when others then execute 'reset role'; out := out || format('FAIL T10 %s %s; ', sqlstate, sqlerrm); end;

  -- T11 tombcrit #1: the rowless check and a concurrent insert of the same id are serialised by one advisory lock per
  --    (kind, scope). sql-tx runs one rolled-back transaction (no dblink, no second session), so this proves the two
  --    halves the ordering argument needs: (a) each delete path holds the exclusive key of its kind and scope (task kind:
  --    task and history), taken by the call itself (absent before); (b) an insert holds the shared key of its kind and
  --    the row's scope, and the restore bypass takes none; (c) in every body the lock call comes before the first read
  --    of rows or tombstones. Fresh scopes (D, E with accounts; F, G rows only) so no earlier case took these keys.
  declare
    d_id constant uuid := '7e570000-0000-4000-8000-0000000000d1';
    e_id constant uuid := '7e570000-0000-4000-8000-0000000000e1';
    sd constant text := 'user:__tr_d'; se constant text := 'user:__tr_e';
    sf constant text := 'user:__tr_f'; sg constant text := 'user:__tr_g';
    td text; te text; bad text := '';
  begin
    insert into proxima_auth.users (id, username, role, scope, password_hash, sessions_valid_after)
      values (d_id, '__tr_d', 'member', sd, null, 0), (e_id, '__tr_e', 'member', se, null, 0);
    td := proxima_auth.mint_token(d_id);
    te := proxima_auth.mint_token(e_id);
    if pg_temp._tr_lock_held('task', sd, 'ExclusiveLock') or pg_temp._tr_lock_held('history', sd, 'ExclusiveLock') then bad := bad || 'D-held-before,'; end if;
    execute 'set local role anon';
    r := delete_queued_rows(td, 'history', array[p || '_l1'], 9e12::bigint);
    execute 'reset role';
    if not pg_temp._tr_lock_held('history', sd, 'ExclusiveLock') then bad := bad || 'dqr-history-no-lock,'; end if;
    if pg_temp._tr_lock_held('task', sd, 'ExclusiveLock') then bad := bad || 'dqr-history-took-task,'; end if;
    execute 'set local role anon';
    r := delete_queued_rows(td, 'task', array[p || '_l2'], 9e12::bigint);
    execute 'reset role';
    if not pg_temp._tr_lock_held('task', sd, 'ExclusiveLock') then bad := bad || 'dqr-task-no-lock,'; end if;
    if pg_temp._tr_lock_held('task', se, 'ExclusiveLock') or pg_temp._tr_lock_held('history', se, 'ExclusiveLock') then bad := bad || 'E-held-before,'; end if;
    execute 'set local role anon';
    r := clear_queued_rows(te, 'task', 1, array[p || '_l3']);
    execute 'reset role';
    if not (pg_temp._tr_lock_held('task', se, 'ExclusiveLock') and pg_temp._tr_lock_held('history', se, 'ExclusiveLock')) then bad := bad || 'clear-task-no-lock,'; end if;
    if pg_temp._tr_lock_held('task', sf, 'ShareLock') or pg_temp._tr_lock_held('history', sf, 'ShareLock') then bad := bad || 'F-held-before,'; end if;
    insert into tasks (id, device_id, status, start_time, outputs) values (p || '_l4', sf, 'completed', 1000, '[]');
    if not pg_temp._tr_lock_held('task', sf, 'ShareLock') or pg_temp._tr_lock_held('task', sf, 'ExclusiveLock') then bad := bad || 'insert-task-no-shared,'; end if;
    insert into history (id, device_id, timestamp, tasks, total_cost) values (p || '_l5', sf, 1000, '[]', 0)
      on conflict (id) do update set timestamp = excluded.timestamp;
    if not pg_temp._tr_lock_held('history', sf, 'ShareLock') then bad := bad || 'upsert-history-no-shared,'; end if;
    perform set_config('proxima.restore', 'on', true);
    insert into tasks (id, device_id, status, start_time, outputs) values (p || '_l6', sg, 'completed', 1000, '[]');
    perform set_config('proxima.restore', '', true);
    if pg_temp._tr_lock_held('task', sg, 'ShareLock') then bad := bad || 'restore-bypass-took-lock,'; end if;
    select bad || coalesce(string_agg(f, ','), '') into bad
      from (select p2.proname || ':' || x.needle as f
              from pg_proc p2
              cross join lateral (values ('from tasks'), ('from history'), ('from sync_tombstones')) x(needle)
             where p2.oid in ('public.delete_queued_rows(text,text,text[],bigint)'::regprocedure,
                              'public._clear_kind(text,text,timestamp with time zone,text[])'::regprocedure,
                              'public._rows_not_tombstoned()'::regprocedure)
               and strpos(p2.prosrc, x.needle) > 0
               and (strpos(p2.prosrc, 'pg_advisory_xact_lock') = 0 or strpos(p2.prosrc, 'pg_advisory_xact_lock') > strpos(p2.prosrc, x.needle))) s;
    out := out || case when bad = '' then 'ok T11 delete paths hold the exclusive (kind, scope) lock, inserts the shared one, taken before any row read; '
                       else format('FAIL T11 lock %s; ', bad) end;
  exception when others then execute 'reset role'; out := out || format('FAIL T11 %s %s; ', sqlstate, sqlerrm); end;

  -- T12 RLS review of tombcrit #1: the shared (kind, scope) lock is taken only by an insert that can land. A browser
  --    insert (anon/authenticated, row policies apply) naming a scope other than its session's (no session, or another
  --    account's) takes no lock on the named scope and is refused by the policy as before (28000 / 42501); with the
  --    scope's own session it takes the lock and lands; server inserts (service_role = the webhook, postgres = cron, and
  --    a SECURITY DEFINER RPC such as upsert_queued_history even with no header) take it whatever the header says.
  --    Fresh scopes H, I, J, K, L so no earlier case took these keys; I and L are accounts (I is the victim in b).
  declare
    i_id constant uuid := '7e570000-0000-4000-8000-0000000000a2';
    l_id constant uuid := '7e570000-0000-4000-8000-0000000000a3';
    sh constant text := 'user:__tr_h'; si constant text := 'user:__tr_i';
    sj constant text := 'user:__tr_j'; sk constant text := 'user:__tr_k'; sl constant text := 'user:__tr_l';
    ti text; tl text; bad text := ''; v text; kd text;
  begin
    insert into proxima_auth.users (id, username, role, scope, password_hash, sessions_valid_after)
      values (i_id, '__tr_i', 'member', si, null, 0), (l_id, '__tr_l', 'member', sl, null, 0);
    ti := proxima_auth.mint_token(i_id);
    tl := proxima_auth.mint_token(l_id);
    execute 'create trigger zzz_tr_probe before insert on public.tasks for each row execute function public._tr_probe(''task'')';
    execute 'create trigger zzz_tr_probe before insert on public.history for each row execute function public._tr_probe(''history'')';
    foreach kd in array array['task', 'history'] loop
      -- (a) anon, no session, naming H.
      v := pg_temp._tr_try('anon', null, kd, p || '_m1' || kd, sh, true);
      if v is distinct from 'P0001 TRPROBE f' then bad := bad || format('a-%s-probe[%s],', kd, left(v, 40)); end if;
      v := pg_temp._tr_try('anon', null, kd, p || '_m1' || kd, sh, false);
      if left(v, 5) is distinct from '28000' then bad := bad || format('a-%s-not-refused[%s],', kd, left(v, 40)); end if;
      -- (b) anon with account A's session, naming I's scope.
      v := pg_temp._tr_try('anon', ta, kd, p || '_m2' || kd, si, true);
      if v is distinct from 'P0001 TRPROBE f' then bad := bad || format('b-%s-probe[%s],', kd, left(v, 40)); end if;
      v := pg_temp._tr_try('anon', ta, kd, p || '_m2' || kd, si, false);
      if left(v, 5) is distinct from '42501' then bad := bad || format('b-%s-not-refused[%s],', kd, left(v, 40)); end if;
      if pg_temp._tr_lock_held(kd, sh, 'ShareLock') or pg_temp._tr_lock_held(kd, si, 'ShareLock') then bad := bad || kd || '-forged-lock-held,'; end if;
      -- (c) anon with I's own session, naming I's scope: lock taken, row lands.
      v := pg_temp._tr_try('anon', ti, kd, p || '_m3' || kd, si, true);
      if v is distinct from 'P0001 TRPROBE t' then bad := bad || format('c-%s-probe[%s],', kd, left(v, 40)); end if;
      v := pg_temp._tr_try('anon', ti, kd, p || '_m3' || kd, si, false);
      if v is distinct from 'landed' or not pg_temp._tr_lock_held(kd, si, 'ShareLock') then bad := bad || format('c-%s-own[%s],', kd, left(v, 40)); end if;
      -- (d) service_role (the webhook), no header.
      v := pg_temp._tr_try('service_role', null, kd, p || '_m4' || kd, sj, false);
      if v is distinct from 'landed' or not pg_temp._tr_lock_held(kd, sj, 'ShareLock') then bad := bad || format('d-%s-service[%s],', kd, left(v, 40)); end if;
      -- (e) postgres (cron) with another account's header: trusted whatever the header names.
      v := pg_temp._tr_try(null, ta, kd, p || '_m5' || kd, sk, false);
      if v is distinct from 'landed' or not pg_temp._tr_lock_held(kd, sk, 'ShareLock') then bad := bad || format('e-%s-postgres[%s],', kd, left(v, 40)); end if;
    end loop;
    -- (f) a SECURITY DEFINER RPC called by anon with no header (the token is its argument): its insert lands with the lock.
    execute 'set local role anon';
    r := upsert_queued_history(tl, jsonb_build_array(jsonb_build_object('id', p || '_m6', 'timestamp', 1000)), 9e12::bigint);
    execute 'reset role';
    if (r->>'upserted')::int is distinct from 1 or not exists (select 1 from history where id = p || '_m6' and device_id = sl)
       or not pg_temp._tr_lock_held('history', sl, 'ShareLock') then bad := bad || format('f-rpc[%s],', r); end if;
    execute 'drop trigger zzz_tr_probe on public.tasks';
    execute 'drop trigger zzz_tr_probe on public.history';
    out := out || case when bad = '' then 'ok T12 browser inserts outside their session scope take no lock and are refused, own-scope, service_role, postgres and RPC inserts take it; '
                       else format('FAIL T12 %s; ', bad) end;
  exception when others then execute 'reset role'; out := out || format('FAIL T12 %s %s; ', sqlstate, sqlerrm); end;

  raise exception 'RESULT: %', out;
end $t$;
