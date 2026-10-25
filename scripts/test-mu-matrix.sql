-- Multi-user P4 gate, behaviour half (docs/MULTI-USER-PLAN.md §5 P4 and §7): two accounts, A = the owner and B = a
-- member seeded here, each as anon with its own minted session the way the app sends it. Every case asks whether one
-- account can read, change, delete or detect the other's rows or files. Everything rolls back; no live row is read
-- (only counts of probe rows this test inserts). Run alone: node scripts/tools/sql-tx.mjs --test scripts/test-mu-matrix.sql
-- Expected until a wall ships: its cases FAIL (storage folders until 20261025100000). The catalog half is
-- scripts/test-mu-catalog.sql. No second account may exist until both report 0 FAIL.
do $pt$
declare
  r text[] := '{}'; n int; v text; ok boolean;
  p text := '__mu_' || txid_current();                -- unique probe tag
  a_id uuid; a_scope text; a_tok text; a_dir text;     -- A: the owner
  b_id uuid := gen_random_uuid(); b_name text := '__mu_b_' || txid_current(); b_scope text; b_tok text; b_dir text;
  walls boolean := to_regclass('proxima_auth.account_folders') is not null;
  t text; k text; tables text[] := array['tasks','history','settings','favorites','presets'];
  keycol jsonb := '{"tasks":"id","history":"id","settings":"key","favorites":"id","presets":"model_id"}';
  n_tomb_a int;
  stmt text;
  ta text; tb text; n0a int; n0b int; na int; nb int;   -- live topics and ping counts
  d_id uuid := gen_random_uuid(); d_tok text; j json;    -- D renames into a folder E holds
  kn int;
  tx text; now_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint + 60000;   -- after any restore marker
  sv_id uuid := gen_random_uuid(); sm_id uuid := gen_random_uuid(); sv_tok text; sm_tok text;   -- squat: victim, squatter
  sv text; sm text; sx text; sy text; bx uuid := gen_random_uuid(); bz uuid := gen_random_uuid();
  sw text; bw uuid := gen_random_uuid(); bo uuid := gen_random_uuid();   -- skip-then-scrub (review round 4)
  su text; bu uuid := gen_random_uuid();                                  -- switch-off after a skip (review round 5)
  bh uuid := gen_random_uuid();                                           -- restore counts (review round 6)
begin
  select u.id, u.scope, proxima_auth.mint_token(u.id) into a_id, a_scope, a_tok from proxima_auth.users u where u.role = 'owner';
  insert into proxima_auth.users (id, username, role, scope) values (b_id, b_name, 'member', 'user:' || b_name);
  b_scope := 'user:' || b_name;
  b_tok := proxima_auth.mint_token(b_id);
  a_dir := regexp_replace(a_scope, '[^A-Za-z0-9_-]', '_', 'g');      -- the app's folder spelling (supabase.js)
  b_dir := regexp_replace(b_scope, '[^A-Za-z0-9_-]', '_', 'g');
  r := r || format('%s setup: B seeded, folders %s / %s', case when b_tok is not null then 'PASS' else 'FAIL' end,
                   case when a_dir = 'user_StephJr101' then 'A ok' else 'A=' || a_dir end, b_dir);

  -- Seed probe rows and files for both accounts (as postgres: no policy involved).
  perform set_config('storage.allow_delete_query', 'true', true);
  foreach t in array tables loop
    k := keycol ->> t;
    if t = 'settings' then
      execute format('insert into public.settings (device_id, key, value) values (%L, %L, ''1''::jsonb), (%L, %L, ''1''::jsonb)',
                     a_scope, p || '_a', b_scope, p || '_b');
    else
      execute format('insert into public.%I (%I, device_id) values (%L, %L), (%L, %L)', t, k, p || '_a', a_scope, p || '_b', b_scope);
    end if;
  end loop;
  select count(*) into n_tomb_a from public.sync_tombstones where device_id = a_scope;
  insert into storage.objects (bucket_id, name) values
    ('generations', a_dir || '/' || p || '_a.png'), ('generations', 'uploads/' || a_dir || '/' || p || '_a.png'),
    ('generations', b_dir || '/' || p || '_b.png'), ('generations', 'uploads/' || b_dir || '/' || p || '_b.png');

  ---------------------------------------------------------------- rows: B against A, then A against B
  execute 'set local role anon';
  perform set_config('request.headers', json_build_object('x-proxima-session', b_tok)::text, true);
  foreach t in array tables loop
    k := keycol ->> t;
    execute format('select count(*) from public.%I where %I like %L', t, k, p || '%') into n;
    r := r || format('%s rows %s: B sees only its own probe (%s of 2)', case when n = 1 then 'PASS' else 'FAIL' end, t, n);
    -- B writing a row stamped with A's scope is refused by WITH CHECK.
    begin
      if t = 'settings' then
        execute format('insert into public.settings (device_id, key, value) values (%L, %L, ''2''::jsonb)', a_scope, p || '_bx');
      else
        execute format('insert into public.%I (%I, device_id) values (%L, %L)', t, k, p || '_bx', a_scope);
      end if;
      r := r || format('FAIL rows %s: B inserted a row into A''s scope', t);
    exception when sqlstate '42501' then r := r || format('PASS rows %s: B''s insert into A''s scope refused', t);
              when others then r := r || format('FAIL rows %s: B insert into A: %s %s', t, sqlstate, sqlerrm); end;
    -- B updating A's row reaches nothing.
    begin
      execute format('update public.%I set device_id = device_id where %I = %L', t, k, p || '_a');
      get diagnostics n = row_count;
      r := r || format('%s rows %s: B''s update of A''s row reached %s', case when n = 0 then 'PASS' else 'FAIL' end, t, n);
    exception when others then r := r || format('FAIL rows %s: B update of A: %s %s', t, sqlstate, sqlerrm); end;
  end loop;
  -- An upsert colliding with A's id is refused, never moved into B's scope.
  begin
    insert into public.tasks (id, device_id) values (p || '_a', b_scope)
      on conflict (id) do update set device_id = excluded.device_id;
    r := r || text 'FAIL rows tasks: B''s upsert of A''s id landed';
  exception when sqlstate '42501' then r := r || text 'PASS rows tasks: B''s upsert of A''s id refused';
            when others then r := r || format('FAIL rows tasks: B upsert of A''s id: %s %s', sqlstate, sqlerrm); end;
  -- B has no tombstones of its own, so it must read none (A has n_tomb_a).
  select count(*) into n from public.sync_tombstones;
  r := r || format('%s rows sync_tombstones: B reads %s tombstones (A holds %s)', case when n = 0 then 'PASS' else 'FAIL' end, n, n_tomb_a);

  perform set_config('request.headers', json_build_object('x-proxima-session', a_tok)::text, true);
  foreach t in array tables loop
    k := keycol ->> t;
    execute format('select count(*) from public.%I where %I like %L', t, k, p || '%') into n;
    r := r || format('%s rows %s: A sees only its own probe (%s of 2)', case when n = 1 then 'PASS' else 'FAIL' end, t, n);
  end loop;

  ---------------------------------------------------------------- files: B against A
  perform set_config('request.headers', json_build_object('x-proxima-session', b_tok)::text, true);
  select count(*) filter (where name like '%' || p || '_b.png'), count(*) filter (where name like '%' || p || '_a.png')
    into n, v from storage.objects where bucket_id = 'generations' and name like '%' || p || '%';
  r := r || format('%s files: B lists its own 2 probes (%s) and none of A''s (%s)', case when n = 2 and v = '0' then 'PASS' else 'FAIL' end, n, v);
  foreach stmt in array array[
      format('insert into storage.objects (bucket_id, name) values (''generations'', %L)', a_dir || '/' || p || '_bx.png'),
      format('insert into storage.objects (bucket_id, name) values (''generations'', %L)', 'uploads/' || a_dir || '/' || p || '_bx.png'),
      format('insert into storage.objects (bucket_id, name) values (''generations'', %L)', p || '_root.png'),
      format('insert into storage.objects (bucket_id, name) values (''generations'', %L)', 'uploads/' || p || '_root.png')] loop
    begin
      execute stmt;
      r := r || format('FAIL files: B wrote %s', split_part(stmt, '''', 4));
    exception when sqlstate '42501' then r := r || format('PASS files: B refused at %s', split_part(stmt, '''', 4));
              when others then r := r || format('FAIL files: B write %s: %s %s', split_part(stmt, '''', 4), sqlstate, sqlerrm); end;
  end loop;
  update storage.objects set metadata = '{"mu":1}'::jsonb where bucket_id = 'generations' and name like '%' || p || '_a.png';
  get diagnostics n = row_count;
  r := r || format('%s files: B''s overwrite of A''s files reached %s', case when n = 0 then 'PASS' else 'FAIL' end, n);
  delete from storage.objects where bucket_id = 'generations' and name like '%' || p || '_a.png';
  get diagnostics n = row_count;
  r := r || format('%s files: B''s delete of A''s files reached %s', case when n = 0 then 'PASS' else 'FAIL' end, n);
  begin
    update storage.objects set name = a_dir || '/' || p || '_moved.png' where bucket_id = 'generations' and name = b_dir || '/' || p || '_b.png';
    get diagnostics n = row_count;
    r := r || format('%s files: B''s move into A''s folder (%s rows)', case when n = 0 then 'PASS' else 'FAIL' end, n);
  exception when sqlstate '42501' then r := r || text 'PASS files: B''s move into A''s folder refused';
            when others then r := r || format('FAIL files: B move: %s %s', sqlstate, sqlerrm); end;
  -- B's own folders work: archive upsert path and an input upload.
  begin
    insert into storage.objects (bucket_id, name) values ('generations', b_dir || '/' || p || '_b2.png'), ('generations', 'uploads/' || b_dir || '/' || p || '_b2.png');
    update storage.objects set metadata = '{"mu":2}'::jsonb where bucket_id = 'generations' and name = b_dir || '/' || p || '_b2.png';
    get diagnostics n = row_count;
    delete from storage.objects where bucket_id = 'generations' and name like '%' || p || '_b2.png';
    get diagnostics v = row_count;
    r := r || format('%s files: B writes, overwrites and deletes in its own folders (%s, %s)', case when n = 1 and v = '2' then 'PASS' else 'FAIL' end, n, v);
  exception when others then r := r || format('FAIL files: B own folder: %s %s', sqlstate, sqlerrm); end;

  ---------------------------------------------------------------- files: A against B
  perform set_config('request.headers', json_build_object('x-proxima-session', a_tok)::text, true);
  select count(*) filter (where name like '%' || p || '_a.png'), count(*) filter (where name like '%' || p || '_b.png')
    into n, v from storage.objects where bucket_id = 'generations' and name like '%' || p || '%';
  r := r || format('%s files: A lists its own 2 probes (%s) and none of B''s (%s)', case when n = 2 and v = '0' then 'PASS' else 'FAIL' end, n, v);
  begin
    insert into storage.objects (bucket_id, name) values ('generations', 'uploads/' || b_dir || '/' || p || '_ax.png');
    r := r || text 'FAIL files: A wrote into B''s upload folder';
  exception when sqlstate '42501' then r := r || text 'PASS files: A refused in B''s upload folder';
            when others then r := r || format('FAIL files: A write into B: %s %s', sqlstate, sqlerrm); end;
  delete from storage.objects where bucket_id = 'generations' and name like '%' || p || '_b.png';
  get diagnostics n = row_count;
  r := r || format('%s files: A''s delete of B''s files reached %s', case when n = 0 then 'PASS' else 'FAIL' end, n);
  begin
    insert into storage.objects (bucket_id, name) values ('generations', a_dir || '/' || p || '_a2.png'), ('generations', 'uploads/' || a_dir || '/' || p || '_a2.png');
    delete from storage.objects where bucket_id = 'generations' and name like '%' || p || '_a2.png';
    get diagnostics n = row_count;
    r := r || format('%s files: A writes and deletes in its own folders (%s)', case when n = 2 then 'PASS' else 'FAIL' end, n);
  exception when others then r := r || format('FAIL files: A own folder: %s %s', sqlstate, sqlerrm); end;
  execute 'reset role';

  ---------------------------------------------------------------- live topic per account
  -- Each account learns its own topic from get_my_account; a change pings exactly the accounts whose rows it touched.
  execute 'set local role anon';
  begin
    ta := public.get_my_account(a_tok)->>'sync_topic';
    tb := public.get_my_account(b_tok)->>'sync_topic';
  exception when others then r := r || format('FAIL topic: get_my_account: %s %s', sqlstate, sqlerrm); end;
  execute 'reset role';
  r := r || format('%s topic: each account learns its own (A %s, B %s)',
                   case when ta is not null and tb is not null and ta <> tb then 'PASS' else 'FAIL' end,
                   case when ta is null then 'none' else 'yes' end,
                   case when tb is null then 'none' when tb = ta then 'A''s' else 'its own' end);
  -- B changes its own row: A's devices must not wake.
  select count(*) into n0a from realtime.messages m where m.topic = ta;
  select count(*) into n0b from realtime.messages m where m.topic = tb;
  execute 'set local role anon';
  perform set_config('request.headers', json_build_object('x-proxima-session', b_tok)::text, true);
  update public.tasks set status = 'mu' where id = p || '_b';
  execute 'reset role';
  select count(*) - n0a into na from realtime.messages m where m.topic = ta;
  select count(*) - n0b into nb from realtime.messages m where m.topic = tb;
  r := r || format('%s topic: B''s change pings B only (A +%s, B +%s)', case when na = 0 and nb = 1 then 'PASS' else 'FAIL' end, na, nb);
  -- A changes its own row: B's devices must not wake.
  select count(*) into n0a from realtime.messages m where m.topic = ta;
  select count(*) into n0b from realtime.messages m where m.topic = tb;
  execute 'set local role anon';
  perform set_config('request.headers', json_build_object('x-proxima-session', a_tok)::text, true);
  update public.tasks set status = 'mu' where id = p || '_a';
  execute 'reset role';
  select count(*) - n0a into na from realtime.messages m where m.topic = ta;
  select count(*) - n0b into nb from realtime.messages m where m.topic = tb;
  r := r || format('%s topic: A''s change pings A only (A +%s, B +%s)', case when na = 1 and nb = 0 then 'PASS' else 'FAIL' end, na, nb);
  -- One server statement touching both accounts pings each once (cron, webhook, maintenance).
  select count(*) into n0a from realtime.messages m where m.topic = ta;
  select count(*) into n0b from realtime.messages m where m.topic = tb;
  update public.tasks set status = 'mu2' where id in (p || '_a', p || '_b');
  select count(*) - n0a into na from realtime.messages m where m.topic = ta;
  select count(*) - n0b into nb from realtime.messages m where m.topic = tb;
  r := r || format('%s topic: a statement touching both pings each once (A +%s, B +%s)', case when na = 1 and nb = 1 then 'PASS' else 'FAIL' end, na, nb);

  ---------------------------------------------------------------- tombstones per account
  -- A deletes its row X; B then creates a row with the same id and deletes it: each account keeps its own tombstone.
  tx := p || '_tx';
  insert into public.tasks (id, device_id) values (tx, a_scope);
  j := public.delete_queued_rows(a_tok, 'task', array[tx], now_ms);
  begin
    execute 'set local role anon';
    perform set_config('request.headers', json_build_object('x-proxima-session', b_tok)::text, true);
    insert into public.tasks (id, device_id) values (tx, b_scope);
    execute 'reset role';
    j := public.delete_queued_rows(b_tok, 'task', array[tx], now_ms);
    select count(*) filter (where device_id = a_scope), count(*) filter (where device_id = b_scope) into na, nb
      from public.sync_tombstones where id = tx;
    r := r || format('%s tombstones: a reused id keeps one tombstone per account after both deletes (A %s, B %s)',
                     case when na = 1 and nb = 1 then 'PASS' else 'FAIL' end, na, nb);
  exception when others then
    execute 'reset role';
    r := r || format('FAIL tombstones: reused id: %s %s', sqlstate, sqlerrm);
  end;
  -- A rowless delete by B of an id only A has tombstoned records B's own tombstone.
  tx := p || '_ty';
  insert into public.tasks (id, device_id) values (tx, a_scope);
  j := public.delete_queued_rows(a_tok, 'task', array[tx], now_ms);
  j := public.delete_queued_rows(b_tok, 'task', array[tx], now_ms);
  select count(*) filter (where device_id = a_scope), count(*) filter (where device_id = b_scope) into na, nb
    from public.sync_tombstones where id = tx;
  r := r || format('%s tombstones: B''s rowless delete of an id A tombstoned records B''s own (A %s, B %s)',
                   case when na = 1 and nb = 1 then 'PASS' else 'FAIL' end, na, nb);
  -- The same for History ids.
  tx := p || '_tz';
  insert into public.history (id, device_id) values (tx, a_scope);
  j := public.delete_queued_rows(a_tok, 'history', array[tx], now_ms);
  j := public.delete_queued_rows(b_tok, 'history', array[tx], now_ms);
  select count(*) filter (where device_id = a_scope), count(*) filter (where device_id = b_scope) into na, nb
    from public.sync_tombstones where id = tx;
  r := r || format('%s tombstones: History ids too (A %s, B %s)', case when na = 1 and nb = 1 then 'PASS' else 'FAIL' end, na, nb);

  ---------------------------------------------------------------- id squatting (two seeded members, never the owner's rows)
  sv := 'user:' || p || 'sv'; sm := 'user:' || p || 'sm'; sx := p || '_sx'; sy := p || '_sy';
  insert into proxima_auth.users (id, username, role, scope) values (sv_id, p || 'sv', 'member', sv), (sm_id, p || 'sm', 'member', sm);
  sv_tok := proxima_auth.mint_token(sv_id); sm_tok := proxima_auth.mint_token(sm_id);
  -- With Automatic backups off (rolled back) a delete queues a backup scrub.
  insert into public.app_secrets (key, value, updated_at) values ('auto_backups', '{"enabled": false}'::jsonb, now())
    on conflict (key) do update set value = excluded.value;
  insert into public.tasks (id, device_id, status, start_time, outputs) values (sx, sv, 'completed', 1, '[]');
  insert into public.data_backups (id, username, backup_type, task_count, tasks_snapshot) values
    (bx, sv, 'manual', 1, jsonb_build_array(jsonb_build_object('id', sx, 'device_id', sv, 'status', 'completed', 'start_time', 1, 'outputs', '[]'::jsonb)));
  begin
    execute 'set local role anon';
    perform set_config('request.headers', json_build_object('x-proxima-session', sv_tok)::text, true);
    j := public.delete_queued_rows(sv_tok, 'task', array[sx], now_ms);
    perform set_config('request.headers', json_build_object('x-proxima-session', sm_tok)::text, true);
    insert into public.tasks (id, device_id, status, start_time, outputs) values (sx, sm, 'completed', 1, '[]');   -- M squats X
    execute 'reset role';
    perform public._drain_backup_scrubs(sv);
    select count(*) into n from public.data_backups where id = bx and tasks_snapshot @> jsonb_build_array(jsonb_build_object('id', sx));
    r := r || format('%s squat: V''s deleted item leaves V''s backups although M holds a row with its id (%s left)',
                     case when n = 0 then 'PASS' else 'FAIL' end, n);
    -- A backup that still holds X (and Y): V's restore succeeds, leaves X to M, reports it.
    insert into public.data_backups (id, username, backup_type, task_count, tasks_snapshot) values
      (bz, sv, 'manual', 2, jsonb_build_array(jsonb_build_object('id', sx, 'device_id', sv, 'status', 'completed', 'start_time', 1, 'outputs', '[]'::jsonb),
                                              jsonb_build_object('id', sy, 'device_id', sv, 'status', 'completed', 'start_time', 1, 'outputs', '[]'::jsonb)));
    execute 'set local role anon';
    perform set_config('request.headers', json_build_object('x-proxima-session', sv_tok)::text, true);
    j := public.restore_my_backup_phase2(sv_tok, bz);
    execute 'reset role';
    r := r || format('%s squat: V''s restore of a backup holding M''s id succeeds and skips it (ok %s, skipped_in_use %s, M keeps X %s, V gets Y %s)',
                     case when (j->>'ok')::boolean and (j->>'skipped_in_use')::int = 1
                               and exists (select 1 from public.tasks where id = sx and device_id = sm)
                               and exists (select 1 from public.tasks where id = sy and device_id = sv) then 'PASS' else 'FAIL' end,
                     coalesce(j->>'ok', 'null'), coalesce(j->>'skipped_in_use', 'none'),
                     exists (select 1 from public.tasks where id = sx and device_id = sm), exists (select 1 from public.tasks where id = sy and device_id = sv));
  exception when others then
    execute 'reset role';
    r := r || format('FAIL squat: %s %s', sqlstate, sqlerrm);
  end;
  -- Skip-then-scrub: V's History holds W (its Generations row gone), M holds a tasks row W, V restores a backup holding
  -- tasks W and Y; W is left out and must keep its copies in that backup and in V's older one.
  sw := p || '_sw';
  begin
    insert into public.history (id, device_id, timestamp, tasks) values
      (p || '_swh', sv, 1, jsonb_build_array(jsonb_build_object('id', sw, 'status', 'completed', 'outputs', '[]'::jsonb)));
    insert into public.tasks (id, device_id, status, start_time, outputs) values (sw, sm, 'completed', 1, '[]');
    insert into public.data_backups (id, username, backup_type, task_count, tasks_snapshot) values
      (bw, sv, 'manual', 2, jsonb_build_array(jsonb_build_object('id', sw, 'device_id', sv, 'status', 'completed', 'start_time', 1, 'outputs', '[]'::jsonb),
                                              jsonb_build_object('id', sy, 'device_id', sv, 'status', 'completed', 'start_time', 1, 'outputs', '[]'::jsonb))),
      (bo, sv, 'manual', 1, jsonb_build_array(jsonb_build_object('id', sw, 'device_id', sv, 'status', 'completed', 'start_time', 1, 'outputs', '[]'::jsonb)));
    execute 'set local role anon';
    perform set_config('request.headers', json_build_object('x-proxima-session', sv_tok)::text, true);
    j := public.restore_my_backup_phase2(sv_tok, bw);
    execute 'reset role';
    select count(*) filter (where id = bw), count(*) filter (where id = bo) into n, kn
      from public.data_backups where id in (bw, bo) and tasks_snapshot @> jsonb_build_array(jsonb_build_object('id', sw));
    r := r || format('%s squat: an id V''s restore left out keeps its copies in the restored and the older backup (%s, %s; ok %s)',
                     case when n = 1 and kn = 1 and coalesce((j->>'ok')::boolean, false) then 'PASS' else 'FAIL' end, n, kn, coalesce(j->>'ok', 'null'));
  exception when others then
    execute 'reset role';
    r := r || format('FAIL squat: skip-then-scrub %s %s', sqlstate, sqlerrm);
  end;
  su := p || '_su';
  begin
    update public.app_secrets set value = '{"enabled": true}'::jsonb where key = 'auto_backups';
    insert into public.tasks (id, device_id, status, start_time, outputs) values (su, sv, 'completed', 1, '[]');
    insert into public.data_backups (id, username, backup_type, task_count, tasks_snapshot) values
      (bu, sv, 'manual', 1, jsonb_build_array(jsonb_build_object('id', su, 'device_id', sv, 'status', 'completed', 'start_time', 1, 'outputs', '[]'::jsonb)));
    execute 'set local role anon';
    perform set_config('request.headers', json_build_object('x-proxima-session', sv_tok)::text, true);
    j := public.delete_queued_rows(sv_tok, 'task', array[su], now_ms + 600000);
    perform set_config('request.headers', json_build_object('x-proxima-session', sm_tok)::text, true);
    insert into public.tasks (id, device_id, status, start_time, outputs) values (su, sm, 'completed', 1, '[]');   -- M squats
    perform set_config('request.headers', json_build_object('x-proxima-session', sv_tok)::text, true);
    j := public.restore_my_backup_phase2(sv_tok, bu);
    execute 'reset role';
    -- The left-out id stays deleted in V's account: V's tombstone stays (V's other devices drop it, no refused upload),
    -- and the restored backup keeps its copy. A later switch-off scrub applies that delete (accepted until step (c)).
    select count(*) into n from public.data_backups where id = bu and tasks_snapshot @> jsonb_build_array(jsonb_build_object('id', su));
    select count(*) into kn from public.sync_tombstones where device_id = sv and id = su;
    r := r || format('%s squat: a left-out id stays deleted for V (tombstone %s) and keeps its copy in the restored backup (%s; restore ok %s)',
                     case when n = 1 and kn = 1 and coalesce((j->>'ok')::boolean, false) then 'PASS' else 'FAIL' end, kn, n, coalesce(j->>'ok', 'null'));
  exception when others then
    execute 'reset role';
    r := r || format('FAIL squat: switch-off %s %s', sqlstate, sqlerrm);
  end;
  -- A lagging device of V uploads the left-out id with a new row in one batch (the client's upsert): no stall.
  begin
    execute 'set local role anon';
    perform set_config('request.headers', json_build_object('x-proxima-session', sv_tok)::text, true);
    insert into public.tasks (id, device_id, status, start_time, outputs)
      values (su, sv, 'completed', 2, '[]'), (p || '_snew', sv, 'completed', 2, '[]')
      on conflict (id) do update set status = excluded.status;
    execute 'reset role';
    select count(*) filter (where id = su and device_id = sv), count(*) filter (where id = p || '_snew' and device_id = sv)
      into n, kn from public.tasks where id in (su, p || '_snew');
    r := r || format('%s squat: a lagging device''s batch with the left-out id lands its other row (left-out %s, new %s)',
                     case when n = 0 and kn = 1 then 'PASS' else 'FAIL' end, n, kn);
  exception when others then
    execute 'reset role';
    r := r || format('FAIL squat: lagging batch refused: %s %s', sqlstate, sqlerrm);
  end;
  begin
    insert into public.data_backups (id, username, backup_type, task_count, history_count, tasks_snapshot, history_snapshot) values
      (bh, sv, 'manual', 1, 1,
       jsonb_build_array(jsonb_build_object('id', p || '_ct', 'device_id', sv, 'status', 'completed', 'start_time', 1, 'outputs', '[]'::jsonb)),
       jsonb_build_array(jsonb_build_object('id', p || '_ch', 'device_id', sv, 'timestamp', 1,
                                            'tasks', jsonb_build_array(jsonb_build_object('id', p || '_ct', 'status', 'completed', 'outputs', '[]'::jsonb)))));
    execute 'set local role anon';
    perform set_config('request.headers', json_build_object('x-proxima-session', sv_tok)::text, true);
    j := public.restore_my_backup_phase2(sv_tok, bh);
    execute 'reset role';
    r := r || format('%s restore counts: a backup of one task and one History entry reports tasks %s, History %s, skipped %s',
                     case when (j->>'ok')::boolean and (j->>'tasks_restored')::int = 1 and (j->>'history_restored')::int = 1
                               and coalesce((j->>'skipped_in_use')::int, 0) = 0 then 'PASS' else 'FAIL' end,
                     j->>'tasks_restored', j->>'history_restored', coalesce(j->>'skipped_in_use', 'none'));
  exception when others then
    execute 'reset role';
    r := r || format('FAIL restore counts: %s %s', sqlstate, sqlerrm);
  end;

  ---------------------------------------------------------------- per-account id keys, step (a): upserts naming (device_id, id)
  foreach t in array array['tasks', 'history', 'favorites'] loop
    execute 'set local role anon';
    perform set_config('request.headers', json_build_object('x-proxima-session', a_tok)::text, true);
    begin
      execute format('insert into public.%I (id, device_id) values (%L, %L) on conflict (device_id, id) do update set device_id = excluded.device_id',
                     t, p || '_k' || t, a_scope);
      execute format('insert into public.%I (id, device_id) values (%L, %L) on conflict (device_id, id) do update set device_id = excluded.device_id',
                     t, p || '_k' || t, a_scope);
      r := r || format('PASS id keys: A''s upsert naming (device_id, id) works on its own %s row', t);
    exception when others then r := r || format('FAIL id keys: A''s upsert on (device_id, id) of %s: %s %s', t, sqlstate, sqlerrm); end;
    perform set_config('request.headers', json_build_object('x-proxima-session', b_tok)::text, true);
    begin
      execute format('insert into public.%I (id, device_id) values (%L, %L) on conflict (device_id, id) do update set device_id = excluded.device_id',
                     t, p || '_k' || t, b_scope);
      r := r || format('FAIL id keys: B''s upsert naming (device_id, id) with A''s %s id landed', t);
    exception when sqlstate '23505' or sqlstate '42501' then
                r := r || format('PASS id keys: B''s upsert with A''s %s id refused (%s)', t, sqlstate);
              when others then r := r || format('FAIL id keys: B''s upsert of A''s %s id: %s %s', t, sqlstate, sqlerrm); end;
    execute 'reset role';
    execute format('select count(*) from public.%I where id = %L', t, p || '_k' || t) into n;
    execute format('select count(*) from public.%I where id = %L and device_id = %L', t, p || '_k' || t, a_scope) into kn;
    r := r || format('%s id keys: %s id held once, by A (%s rows, %s A''s)', case when n = 1 and kn = 1 then 'PASS' else 'FAIL' end, t, n, kn);
  end loop;

  ---------------------------------------------------------------- folders follow renames, never change hands
  update proxima_auth.users set username = b_name || 'r', scope = 'user:' || b_name || 'r' where id = b_id;
  execute 'set local role anon';
  perform set_config('request.headers', json_build_object('x-proxima-session', b_tok)::text, true);
  begin
    delete from storage.objects where bucket_id = 'generations' and name = b_dir || '/' || p || '_b.png';
    get diagnostics n = row_count;
    insert into storage.objects (bucket_id, name) values ('generations', b_dir || 'r/' || p || '_new.png');
    r := r || format('%s folders: after a rename B still reaches its old folder (%s) and writes the new one', case when n = 1 then 'PASS' else 'FAIL' end, n);
  exception when others then r := r || format('FAIL folders: B after rename: %s %s', sqlstate, sqlerrm); end;
  execute 'reset role';
  -- B's old name is free in users, but its folder is not: an account taking that name is refused.
  begin
    insert into proxima_auth.users (username, role, scope) values (b_name, 'member', 'user:' || b_name);
    r := r || text 'FAIL folders: a new account took B''s old name and folder';
  exception when sqlstate '23505' then r := r || text 'PASS folders: a new account cannot take B''s old folder (23505)';
            when others then r := r || format('FAIL folders: new account on B''s old name: %s %s', sqlstate, sqlerrm); end;
  -- Two names that the app spells as one folder: the second is refused.
  begin
    insert into proxima_auth.users (username, role, scope) values (p || 'c!', 'member', 'user:' || p || 'c!');
    insert into proxima_auth.users (username, role, scope) values (p || 'c#', 'member', 'user:' || p || 'c#');
    r := r || text 'FAIL folders: two accounts share one folder spelling';
  exception when sqlstate '23505' then r := r || text 'PASS folders: a second account with the same folder spelling refused (23505)';
            when others then r := r || format('FAIL folders: same spelling: %s %s', sqlstate, sqlerrm); end;
  -- A rename to a name whose folder another account holds (E, a spelling of the same folder) is a counted
  -- 'username_taken', so names cannot be probed past the rename limit.
  insert into proxima_auth.users (username, role, scope) values (p || 'e!', 'member', 'user:' || p || 'e!');
  insert into proxima_auth.users (id, username, role, scope, password_hash)
    values (d_id, p || 'd', 'member', 'user:' || p || 'd', extensions.crypt('mu-pass-D', extensions.gen_salt('bf', 4)));
  d_tok := proxima_auth.mint_token(d_id);
  begin
    j := public.rename_my_account(d_tok, 'mu-pass-D', p || 'e#');
    select u.rename_taken_count into n from proxima_auth.users u where u.id = d_id;
    r := r || format('%s folders: a rename into another account''s folder spelling answers %s, counted %s',
                     case when j->>'reason' = 'username_taken' and n = 1 then 'PASS' else 'FAIL' end,
                     coalesce(j->>'reason', 'ok=' || (j->>'ok')), n);
  exception when others then r := r || format('FAIL folders: rename into another folder raised %s %s (not counted)', sqlstate, sqlerrm); end;
  -- proxima_auth.object_folder (inlined into the policies) grants exactly what storage.foldername's segments would:
  -- foldername keeps empty segments (''), object_folder answers NULL there; no account folder is '', so both refuse.
  if walls then
    execute $q$
      select count(*) filter (where proxima_auth.object_folder(x) is distinct from
                                    nullif(case when (storage.foldername(x))[1] = 'uploads' then (storage.foldername(x))[2]
                                                else (storage.foldername(x))[1] end, '')),
             string_agg(x, ' ; ') filter (where proxima_auth.object_folder(x) is distinct from
                                    nullif(case when (storage.foldername(x))[1] = 'uploads' then (storage.foldername(x))[2]
                                                else (storage.foldername(x))[1] end, ''))
        from unnest(array['user_A/f.png', 'user_A/sub/f.png', 'user_A/', 'user_A', 'user_A//f', '/user_A/f', '//user_A/f',
                          'uploads/user_A/f.png', 'uploads/user_A/sub/f', 'uploads/user_A/', 'uploads/user_A', 'uploads/f.png',
                          'uploads/', 'uploads', 'uploads//user_A/f', 'uploads/uploads/user_A/f', 'Uploads/user_A/f',
                          'uploadsX/f', ' user_A/f', 'user_A /f', 'user_' || chr(1040) || '/f', 'user_A' || chr(8203) || '/f',
                          'user_A/../user_B/f', '', 'a/b/c/d/e/f', 'uploads/' || repeat('x', 300) || '/f']) x
    $q$ into n, v;
    r := r || format('%s folders: object_folder matches storage.foldername on 26 tricky paths (%s differ%s)',
                     case when n = 0 then 'PASS' else 'FAIL' end, n, coalesce(': ' || v, ''));
  end if;
  if not walls then r := r || text 'FAIL walls: proxima_auth.account_folders missing (20261025100000 not applied)'; end if;

  raise exception 'RESULT: % PASS, % FAIL :: %',
    (select count(*) from unnest(r) x where x like 'PASS%'), (select count(*) from unnest(r) x where x like 'FAIL%'),
    array_to_string(r, ' | ');
end $pt$;
