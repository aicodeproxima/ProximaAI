-- Tests for supabase/migrations/20261025910000_history_strip_guard_first.sql (review round 30 #7): a browser naming a scope
-- that is not its session's gets the same refusal whatever that scope holds, so it learns nothing about its tombstones.
-- Before it is applied:
--   node scripts/tools/sql-tx.mjs supabase/migrations/20261025910000_history_strip_guard_first.sql --test scripts/test-history-strip-guard-db.sql
-- One DO block, always rolled back. Fixture victim scope 'user:__hsg_<txid>' (P user-tombstoned, R restore-removed, N never
-- existed) and a member account '__hsg_m_<txid>' whose token is "another account". Each probe runs as anon and sends an
-- entry whose costs overflow the recomputed total (the round 30 probe's shape).
do $t$
declare
  out text := '';
  x text := txid_current()::text;
  vic text := 'user:__hsg_' || x;
  big text := repeat('9', 131072);
  acc uuid; tk_other text; tk_owner text; s_owner text;
  st text; res text[] := '{}'; pid text;
  probe text;
begin
  insert into tasks (id, device_id, status, start_time, outputs) values ('hsg-P-' || x, vic, 'completed', 1000, '[]'), ('hsg-R-' || x, vic, 'completed', 1000, '[]');
  delete from tasks where id = 'hsg-P-' || x;
  perform set_config('proxima.restore', 'on', true);
  delete from tasks where id = 'hsg-R-' || x;
  perform set_config('proxima.restore', 'off', true);
  execute 'insert into proxima_auth.users (username, role, scope) values ($1, ''member'', $2) returning id' into acc using '__hsg_m_' || x, 'user:__hsg_m_' || x;
  execute 'select proxima_auth.mint_token($1)' into tk_other using acc;
  probe := format('[{"id":"%%s","status":"completed","cost":1},{"id":"a","status":"completed","cost":%s},{"id":"b","status":"completed","cost":%s}]', big, big);

  -- G1/G2. No header, then another account's header: P, R and N give one and the same SQLSTATE each time.
  for h in 1..2 loop
    res := '{}';
    foreach pid in array array['hsg-P-' || x, 'hsg-R-' || x, 'hsg-N-' || x] loop
      st := 'none';
      begin
        execute 'set local role anon';
        perform set_config('request.headers', case when h = 1 then '{}' else json_build_object('x-proxima-session', tk_other)::text end, true);
        insert into public.history (id, device_id, timestamp, tasks, total_cost) values ('hsg-L-' || x || h, vic, 1000, format(probe, pid)::jsonb, 0);
      exception when others then st := sqlstate; end;
      execute 'reset role';
      res := res || st;
    end loop;
    out := out || case when res[1] = res[2] and res[2] = res[3] and res[1] = (case when h = 1 then '28000' else '42501' end)
                       then format('ok G%s same-answer %s; ', h, res[1]) else format('FAIL G%s answers %s; ', h, res) end;
  end loop;

  -- G3. The account's own session still writes and strips its own tombstoned item (the guard admits the own scope).
  begin
    execute 'select scope, proxima_auth.mint_token(id) from proxima_auth.users where role = ''owner''' into s_owner, tk_owner;
    insert into tasks (id, device_id, status, start_time, outputs) values ('hsg-oP-' || x, s_owner, 'completed', 1000, '[]'), ('hsg-oK-' || x, s_owner, 'completed', 1000, '[]');
    delete from tasks where id = 'hsg-oP-' || x;
    execute 'set local role anon';
    perform set_config('request.headers', json_build_object('x-proxima-session', tk_owner)::text, true);
    insert into public.history (id, device_id, timestamp, tasks, total_cost) values ('hsg-oL-' || x, s_owner, 1000,
      format('[{"id":"hsg-oP-%s","status":"completed","cost":2},{"id":"hsg-oK-%s","status":"completed","cost":3}]', x, x)::jsonb, 5);
    select string_agg(e->>'id', ',') into st from public.history hh, jsonb_array_elements(hh.tasks) e where hh.id = 'hsg-oL-' || x;
    execute 'reset role';
    out := out || case when st = 'hsg-oK-' || x then 'ok G3 own-scope-strips; ' else format('FAIL G3 %s; ', st) end;
  exception when others then
    begin execute 'reset role'; exception when others then null; end;
    out := out || format('FAIL G3 %s %s; ', sqlstate, sqlerrm);
  end;

  -- G4. A SECURITY DEFINER RPC called with no header (its token is the argument, test-tombstone-rowless-db T12 (f)) writes in
  --     the scope its token proves (its statements run as the owner); a header-less direct write right after is refused.
  declare r json; st2 text;
  begin
    execute 'set local role anon';
    perform set_config('request.headers', '{}', true);
    r := public.upsert_queued_history(tk_owner, format('[{"id":"hsg-rpc-%s","timestamp":1000,"tasks":[{"id":"hsg-oK-%s","status":"completed","cost":3}],"total_cost":3}]', x, x)::jsonb, 9e12::bigint);
    st2 := 'none';
    begin
      insert into public.history (id, device_id, timestamp, tasks, total_cost) values ('hsg-after-' || x, s_owner, 1000, '[]', 0);
    exception when others then st2 := sqlstate; end;
    execute 'reset role';
    out := out || case when (r->>'upserted')::int = 1 and exists (select 1 from history where id = 'hsg-rpc-' || x and device_id = s_owner)
                         and st2 = '28000' and not exists (select 1 from history where id = 'hsg-after-' || x)
                       then 'ok G4 rpc-trusted-direct-refused; ' else format('FAIL G4 %s %s; ', r, st2) end;
  exception when others then
    begin execute 'reset role'; exception when others then null; end;
    out := out || format('FAIL G4 %s %s; ', sqlstate, sqlerrm);
  end;

  raise exception 'RESULT: %', out;
end $t$;
