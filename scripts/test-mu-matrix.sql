-- Multi-user P4 gate, behaviour half (docs/MULTI-USER-PLAN.md §5 P4 and §7): two accounts, A = the owner and B = a
-- member seeded here, each as anon with its own minted session the way the app sends it. Every case asks whether one
-- account can read, change, delete or detect the other's rows or files. Everything rolls back; no live row is read
-- (only counts of probe rows this test inserts). Run alone: node scripts/tools/sql-tx.mjs --test scripts/test-mu-matrix.sql
-- Expected until a wall ships: its cases FAIL (storage folders until 20261025100000, per-account Automatic backups until
-- 20261025800000). The catalog half is scripts/test-mu-catalog.sql. No second account may exist until both report 0 FAIL.
-- The cases on shared ids read the key stage (kc): before step (c) an id is held by one account at most; from step (c)
-- (20261028100000, keys (device_id, id)) each account may hold its own row of an id, and the walls are that no account's
-- write, delete or restore reaches another's row of it.
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
  dx_id uuid := gen_random_uuid(); dy_id uuid := gen_random_uuid(); dx text; dy text; dx_tok text; dy_tok text;   -- definers
  dy_task text; dy_hist text; dy_bk uuid := gen_random_uuid(); dy_path text; fp0 text; fp1 text; ans text; calls text[] := '{}';
  ab_on boolean := exists (select 1 from pg_attribute where attrelid = 'proxima_auth.users'::regclass   -- 20261025800000
                             and attname = 'auto_backups' and not attisdropped);
  ax_id uuid := gen_random_uuid(); ay_id uuid := gen_random_uuid(); az_id uuid := gen_random_uuid();   -- auto-backups
  aw_id uuid := gen_random_uuid(); av_id uuid := gen_random_uuid(); au_id uuid := gen_random_uuid();
  ax text; ay text; az text; aw text; av text; au text; an text; ax_tok text; ay_tok text; own0 boolean;
  bkx uuid; bky uuid; nx int; ny int; av_tok text; aq_id uuid := gen_random_uuid(); ar_id uuid := gen_random_uuid(); aq text; ar text;
  ao_id uuid := gen_random_uuid(); ap_id uuid := gen_random_uuid(); ao text; ap text; ao_tok text; ap_tok text; jd json;
  kc boolean; kc_n int; kq int; kr int; sd text;          -- key stage (step (c)) and its counts
begin
  select u.id, u.scope, proxima_auth.mint_token(u.id) into a_id, a_scope, a_tok from proxima_auth.users u where u.role = 'owner';
  insert into proxima_auth.users (id, username, role, scope) values (b_id, b_name, 'member', 'user:' || b_name);
  b_scope := 'user:' || b_name;
  b_tok := proxima_auth.mint_token(b_id);
  a_dir := regexp_replace(a_scope, '[^A-Za-z0-9_-]', '_', 'g');      -- the app's folder spelling (supabase.js)
  b_dir := regexp_replace(b_scope, '[^A-Za-z0-9_-]', '_', 'g');
  r := r || format('%s setup: B seeded, folders %s / %s', case when b_tok is not null then 'PASS' else 'FAIL' end,
                   case when a_dir = 'user_StephJr101' then 'A ok' else 'A=' || a_dir end, b_dir);
  -- The key stage, the same on all three tables (one migration swaps them together).
  select count(*) filter (where pk = array['device_id', 'id']), count(*) into kc_n, kq
    from (select array(select a.attname::text from pg_attribute a where a.attrelid = c.conrelid and a.attnum = any (c.conkey)
                       order by a.attname) as pk
            from pg_constraint c where c.contype = 'p' and c.conrelid in ('public.tasks'::regclass, 'public.history'::regclass,
                                                                           'public.favorites'::regclass)) s;
  kc := kc_n = 3;
  r := r || format('%s setup: keys %s on tasks, History and favorites (%s of %s on (device_id, id))',
                   case when kq = 3 and kc_n in (0, 3) then 'PASS' else 'FAIL' end,
                   case when kc then '(device_id, id), step (c)' when kc_n = 0 then '(id), before step (c)' else 'MIXED' end, kc_n, kq);

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
  -- An upsert colliding with A's id is refused, never moved into B's scope. From step (c) the app's upsert names
  -- (device_id, id): B's row of A's id is B's own and A's row stays A's; an old bundle still naming (id) is refused (42P10)
  -- before anything is written.
  if not kc then
    begin
      insert into public.tasks (id, device_id) values (p || '_a', b_scope)
        on conflict (id) do update set device_id = excluded.device_id;
      r := r || text 'FAIL rows tasks: B''s upsert of A''s id landed';
    exception when sqlstate '42501' then r := r || text 'PASS rows tasks: B''s upsert of A''s id refused';
              when others then r := r || format('FAIL rows tasks: B upsert of A''s id: %s %s', sqlstate, sqlerrm); end;
  else
    begin
      insert into public.tasks (id, device_id) values (p || '_a', b_scope)
        on conflict (device_id, id) do update set device_id = excluded.device_id;
      execute 'reset role';
      select count(*) filter (where device_id = b_scope), count(*) filter (where device_id = a_scope), count(*)
        into n, kq, kr from public.tasks where id = p || '_a';
      execute 'set local role anon';
      r := r || format('%s rows tasks: B''s upsert naming (device_id, id) with A''s id is B''s own row, A''s stays A''s (B %s, A %s, of %s)',
                       case when n = 1 and kq = 1 and kr = 2 then 'PASS' else 'FAIL' end, n, kq, kr);
    exception when others then r := r || format('FAIL rows tasks: B upsert naming (device_id, id) of A''s id: %s %s', sqlstate, sqlerrm); end;
    begin
      insert into public.tasks (id, device_id) values (p || '_a', b_scope)
        on conflict (id) do update set device_id = excluded.device_id;
      r := r || text 'FAIL rows tasks: an old bundle''s upsert naming (id) was taken after step (c)';
    exception when sqlstate '42P10' then r := r || text 'PASS rows tasks: an old bundle''s upsert naming (id) is refused (42P10)';
              when others then r := r || format('FAIL rows tasks: an old bundle''s upsert naming (id): %s %s', sqlstate, sqlerrm); end;
  end if;
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
  if ab_on then execute 'update proxima_auth.users set auto_backups = false where id in ($1, $2)' using sv_id, sm_id; end if;   -- per account
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
    if not kc then
      r := r || format('%s squat: V''s restore of a backup holding M''s id succeeds and skips it (ok %s, skipped_in_use %s, M keeps X %s, V gets Y %s)',
                       case when (j->>'ok')::boolean and (j->>'skipped_in_use')::int = 1
                                 and exists (select 1 from public.tasks where id = sx and device_id = sm)
                                 and exists (select 1 from public.tasks where id = sy and device_id = sv) then 'PASS' else 'FAIL' end,
                       coalesce(j->>'ok', 'null'), coalesce(j->>'skipped_in_use', 'none'),
                       exists (select 1 from public.tasks where id = sx and device_id = sm), exists (select 1 from public.tasks where id = sy and device_id = sv));
    else
      r := r || format('%s squat: V''s restore of a backup holding an id M also holds brings it back as V''s own (ok %s, skipped_in_use %s, M keeps its X %s, V gets X %s, V gets Y %s)',
                       case when (j->>'ok')::boolean and j->>'skipped_in_use' is null
                                 and exists (select 1 from public.tasks where id = sx and device_id = sm)
                                 and exists (select 1 from public.tasks where id = sx and device_id = sv)
                                 and exists (select 1 from public.tasks where id = sy and device_id = sv) then 'PASS' else 'FAIL' end,
                       coalesce(j->>'ok', 'null'), coalesce(j->>'skipped_in_use', 'none'),
                       exists (select 1 from public.tasks where id = sx and device_id = sm), exists (select 1 from public.tasks where id = sx and device_id = sv),
                       exists (select 1 from public.tasks where id = sy and device_id = sv));
    end if;
  exception when others then
    execute 'reset role';
    r := r || format('FAIL squat: %s %s', sqlstate, sqlerrm);
  end;
  -- Skip-then-scrub: V's History holds W (its Generations row gone), M holds a tasks row W, V restores a backup holding
  -- tasks W and Y; W is left out and must keep its copies in that backup and in V's older one. From step (c) W comes back
  -- as V's own row (M keeps its W), and both backups still keep their copies.
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
    if not kc then
      r := r || format('%s squat: an id V''s restore left out keeps its copies in the restored and the older backup (%s, %s; ok %s)',
                       case when n = 1 and kn = 1 and coalesce((j->>'ok')::boolean, false) then 'PASS' else 'FAIL' end, n, kn, coalesce(j->>'ok', 'null'));
    else
      r := r || format('%s squat: V''s restore brings back an id M also holds as V''s own, M keeps its own, both backups keep their copies (%s, %s; V''s W %s, M''s W %s; ok %s)',
                       case when n = 1 and kn = 1 and coalesce((j->>'ok')::boolean, false)
                                 and exists (select 1 from public.tasks where id = sw and device_id = sv)
                                 and exists (select 1 from public.tasks where id = sw and device_id = sm) then 'PASS' else 'FAIL' end,
                       n, kn, exists (select 1 from public.tasks where id = sw and device_id = sv),
                       exists (select 1 from public.tasks where id = sw and device_id = sm), coalesce(j->>'ok', 'null'));
    end if;
  exception when others then
    execute 'reset role';
    r := r || format('FAIL squat: skip-then-scrub %s %s', sqlstate, sqlerrm);
  end;
  su := p || '_su';
  begin
    update public.app_secrets set value = '{"enabled": true}'::jsonb where key = 'auto_backups';
    if ab_on then execute 'update proxima_auth.users set auto_backups = true where id in ($1, $2)' using sv_id, sm_id; end if;
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
    -- Before step (c) the left-out id stays deleted in V's account: V's tombstone stays (V's other devices drop it, no
    -- refused upload), and the restored backup keeps its copy; a later switch-off scrub applies that delete. From step (c)
    -- the restore brings it back as V's own row (its tombstone cleared), M keeps its own, and the backup keeps its copy.
    select count(*) into n from public.data_backups where id = bu and tasks_snapshot @> jsonb_build_array(jsonb_build_object('id', su));
    select count(*) into kn from public.sync_tombstones where device_id = sv and id = su;
    if not kc then
      r := r || format('%s squat: a left-out id stays deleted for V (tombstone %s) and keeps its copy in the restored backup (%s; restore ok %s)',
                       case when n = 1 and kn = 1 and coalesce((j->>'ok')::boolean, false) then 'PASS' else 'FAIL' end, kn, n, coalesce(j->>'ok', 'null'));
    else
      select count(*) filter (where device_id = sv), count(*) filter (where device_id = sm) into kq, kr from public.tasks where id = su;
      r := r || format('%s squat: V''s restore brings back an id V deleted and M then used as V''s own (V''s %s, tombstone %s), M keeps its own (%s), the backup keeps its copy (%s; restore ok %s)',
                       case when kq = 1 and kn = 0 and kr = 1 and n = 1 and coalesce((j->>'ok')::boolean, false) then 'PASS' else 'FAIL' end,
                       kq, kn, kr, n, coalesce(j->>'ok', 'null'));
    end if;
  exception when others then
    execute 'reset role';
    r := r || format('FAIL squat: switch-off %s %s', sqlstate, sqlerrm);
  end;
  -- A lagging device of V uploads the left-out id with a new row in one batch (the client's upsert): no stall. From
  -- step (c) the batch names (device_id, id) and also carries D, an id V deleted and M then used: V's restored row is
  -- updated, the new row lands, D stays deleted for V (its tombstone drops it), and M's rows of those ids are untouched.
  begin
    if not kc then
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
    else
      sd := p || '_sd';
      insert into public.tasks (id, device_id, status, start_time, outputs) values (sd, sv, 'completed', 1, '[]');
      execute 'set local role anon';
      perform set_config('request.headers', json_build_object('x-proxima-session', sv_tok)::text, true);
      j := public.delete_queued_rows(sv_tok, 'task', array[sd], now_ms + 900000);
      perform set_config('request.headers', json_build_object('x-proxima-session', sm_tok)::text, true);
      insert into public.tasks (id, device_id, status, start_time, outputs) values (sd, sm, 'completed', 1, '[]');   -- M uses D
      perform set_config('request.headers', json_build_object('x-proxima-session', sv_tok)::text, true);
      insert into public.tasks (id, device_id, status, start_time, outputs)
        values (su, sv, 'completed', 2, '[]'), (p || '_snew', sv, 'completed', 2, '[]'), (sd, sv, 'completed', 2, '[]')
        on conflict (device_id, id) do update set status = excluded.status;
      execute 'reset role';
      select count(*) filter (where id = su and device_id = sv), count(*) filter (where id = p || '_snew' and device_id = sv),
             count(*) filter (where id = sd and device_id = sv), count(*) filter (where id in (su, sd) and device_id = sm)
        into n, kn, kq, kr from public.tasks where id in (su, sd, p || '_snew');
      r := r || format('%s squat: a lagging device''s batch naming (device_id, id) updates V''s restored row, lands its new one, keeps a deleted id deleted and leaves M''s rows (V''s restored %s, new %s, deleted %s, M''s %s of 2)',
                       case when n = 1 and kn = 1 and kq = 0 and kr = 2 then 'PASS' else 'FAIL' end, n, kn, kq, kr);
    end if;
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

  ---------------------------------------------------------------- per-account id keys: upserts naming (device_id, id)
  -- Steps (a) and (b): an id stays unique across accounts, so B's upsert with A's id is refused. Step (c): each account
  -- holds its own row of the id, and A's row stays A's.
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
      r := r || format('%s id keys: B''s upsert naming (device_id, id) with A''s %s id %s', case when kc then 'PASS' else 'FAIL' end, t,
                       case when kc then 'lands as B''s own row' else 'landed' end);
    exception when sqlstate '23505' or sqlstate '42501' then
                r := r || format('%s id keys: B''s upsert with A''s %s id refused (%s)', case when kc then 'FAIL' else 'PASS' end, t, sqlstate);
              when others then r := r || format('FAIL id keys: B''s upsert of A''s %s id: %s %s', t, sqlstate, sqlerrm); end;
    execute 'reset role';
    execute format('select count(*) from public.%I where id = %L', t, p || '_k' || t) into n;
    execute format('select count(*) from public.%I where id = %L and device_id = %L', t, p || '_k' || t, a_scope) into kn;
    if not kc then
      r := r || format('%s id keys: %s id held once, by A (%s rows, %s A''s)', case when n = 1 and kn = 1 then 'PASS' else 'FAIL' end, t, n, kn);
    else
      execute format('select count(*) from public.%I where id = %L and device_id = %L', t, p || '_k' || t, b_scope) into kq;
      r := r || format('%s id keys: %s id held by A and by B, each its own row (%s rows, %s A''s, %s B''s)',
                       case when n = 2 and kn = 1 and kq = 1 then 'PASS' else 'FAIL' end, t, n, kn, kq);
    end if;
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
  -- A rename to a name whose folder another account holds (E's old name: an account keeps its folders) is a counted
  -- 'username_taken', so names cannot be probed past the rename limit. A spelling of another account's folder with a
  -- character outside the join allow-list is refused for its shape before anything is looked up (20261026200000), so
  -- it tells nothing and is not counted.
  insert into proxima_auth.users (username, role, scope) values (p || 'e!', 'member', 'user:' || p || 'e!');
  insert into proxima_auth.users (username, role, scope) values (p || 'e2', 'member', 'user:' || p || 'e2');
  update proxima_auth.users set username = p || 'e3', scope = 'user:' || p || 'e3' where username = p || 'e2';
  insert into proxima_auth.users (id, username, role, scope, password_hash)
    values (d_id, p || 'd', 'member', 'user:' || p || 'd', extensions.crypt('mu-pass-D', extensions.gen_salt('bf', 4)));
  d_tok := proxima_auth.mint_token(d_id);
  begin
    j := public.rename_my_account(d_tok, 'mu-pass-D', p || 'e#');
    select u.rename_taken_count into n from proxima_auth.users u where u.id = d_id;
    r := r || format('%s folders: a rename into a spelling of another account''s folder answers %s, counted %s',
                     case when j->>'reason' = 'invalid_username' and n = 0 then 'PASS' else 'FAIL' end,
                     coalesce(j->>'reason', 'ok=' || (j->>'ok')), n);
  exception when others then r := r || format('FAIL folders: rename into a folder spelling raised %s %s', sqlstate, sqlerrm); end;
  begin
    select u.rename_taken_count into n from proxima_auth.users u where u.id = d_id;
    j := public.rename_my_account(d_tok, 'mu-pass-D', p || 'e2');
    select u.rename_taken_count - n into n from proxima_auth.users u where u.id = d_id;
    r := r || format('%s folders: a rename into another account''s old folder answers %s, counted %s',
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
  ---------------------------------------------------------------- every browser-callable data / backup / key function
  dx := 'user:' || p || 'dx'; dy := 'user:' || p || 'dy'; dy_task := p || '_dyt'; dy_hist := p || '_dyh';
  dy_path := 'user_' || p || 'dy/' || dy_task || '-0.png';
  insert into proxima_auth.users (id, username, role, scope) values (dx_id, p || 'dx', 'member', dx), (dy_id, p || 'dy', 'member', dy);
  dx_tok := proxima_auth.mint_token(dx_id); dy_tok := proxima_auth.mint_token(dy_id);
  insert into public.tasks (id, device_id, status, start_time, outputs) values
    (dy_task, dy, 'completed', 1, jsonb_build_array('https://x.supabase.co/storage/v1/object/public/generations/' || dy_path)),
    (p || '_dxt', dx, 'completed', 1, '[]');
  insert into public.history (id, device_id, timestamp, tasks) values
    (dy_hist, dy, 1, jsonb_build_array(jsonb_build_object('id', dy_task, 'status', 'completed', 'outputs', '[]'::jsonb)));
  insert into public.favorites (id, device_id, prompt) values (p || '_dyf', dy, 'y');
  insert into public.settings (device_id, key, value) values (dy, p || '_dys', '"y"'::jsonb);
  insert into public.data_backups (id, username, backup_type, task_count, tasks_snapshot) values
    (dy_bk, dy, 'manual', 1, jsonb_build_array(jsonb_build_object('id', dy_task, 'device_id', dy, 'status', 'completed', 'start_time', 1, 'outputs', '[]'::jsonb)));
  begin
    perform public.set_my_provider_key(dy_tok, 'kie', 'fake-kie-y-' || md5(random()::text));
    perform public.set_my_wavespeed_key(dy_tok, 'fake-ws-y-' || md5(random()::text));
  exception when others then r := r || format('FAIL definers: seeding Y''s keys: %s %s', sqlstate, sqlerrm); end;
  -- Y's whole state, as one fingerprint.
  fp0 := md5(concat_ws('|',
    (select string_agg(concat_ws(',', id, status, start_time, outputs::text), ';' order by id) from public.tasks where device_id = dy),
    (select string_agg(concat_ws(',', id, tasks::text), ';' order by id) from public.history where device_id = dy),
    (select string_agg(id, ';' order by id) from public.favorites where device_id = dy),
    (select string_agg(concat_ws(',', key, value::text), ';' order by key) from public.settings where device_id = dy),
    (select string_agg(concat_ws(',', id, kind, by_restore), ';' order by id) from public.sync_tombstones where device_id = dy),
    (select string_agg(concat_ws(',', id, task_count, md5(coalesce(tasks_snapshot, '[]'::jsonb)::text)), ';' order by id) from public.data_backups where username = dy),
    (select string_agg(concat_ws(',', provider, fingerprint, updated_at), ';' order by provider) from proxima_auth.provider_keys where account_id = dy_id),
    (select md5(to_jsonb(u)::text) from proxima_auth.users u where u.id = dy_id),   -- the whole account row, its switch included
    (select count(*)::text from public.backup_scrub_queue where username = dy)));
  execute 'set local role anon';
  perform set_config('request.headers', json_build_object('x-proxima-session', dx_tok)::text, true);
  -- Each call in its own block: an error is recorded, never ends the section.
  begin ans := array_to_string(public.generations_live(dx_tok, array[dy_task]), ',');
        calls := calls || format('generations_live %s', case when coalesce(ans, '') like '%' || dy_task || '%' then 'LEAK' else 'ok' end);
  exception when others then calls := calls || format('generations_live err %s', sqlstate); end;
  begin ans := array_to_string(public.paths_in_use(dx_tok, array[dy_path]), ',');
        calls := calls || format('paths_in_use %s', case when coalesce(ans, '') like '%' || dy_path || '%' then 'LEAK' else 'ok' end);
  exception when others then calls := calls || format('paths_in_use err %s', sqlstate); end;
  begin perform public.purge_my_backups_of(dx_tok, array[dy_task], array[dy_hist]); calls := calls || text 'purge_my_backups_of ok';
  exception when others then calls := calls || format('purge_my_backups_of err %s', sqlstate); end;
  begin select string_agg(b.id::text, ',') into ans from public.list_my_backups_phase2(dx_tok, 50) b;
        calls := calls || format('list_my_backups %s', case when coalesce(ans, '') like '%' || dy_bk::text || '%' then 'LEAK' else 'ok' end);
  exception when others then calls := calls || format('list_my_backups err %s', sqlstate); end;
  begin perform public.delete_my_backup_phase2(dx_tok, dy_bk); calls := calls || text 'delete_my_backup ok';
  exception when others then calls := calls || format('delete_my_backup err %s', sqlstate); end;
  begin ans := public.restore_my_backup_phase2(dx_tok, dy_bk)::text;
        calls := calls || format('restore_my_backup %s', case when ans like '%"ok" : true%' then 'RESTORED-Y' else 'refused' end);
  exception when others then calls := calls || format('restore_my_backup err %s', sqlstate); end;
  begin perform public.clear_queued_rows(dx_tok, 'task', now_ms, array[dy_task]); calls := calls || text 'clear_queued_rows ok';
  exception when others then calls := calls || format('clear_queued_rows err %s', sqlstate); end;
  begin perform public.upsert_queued_history(dx_tok, jsonb_build_array(jsonb_build_object('id', dy_hist, 'device_id', dy, 'timestamp', 2, 'tasks', '[]'::jsonb)), now_ms);
        calls := calls || text 'upsert_queued_history ok';
  exception when others then calls := calls || format('upsert_queued_history err %s', sqlstate); end;
  begin perform public.set_my_provider_key(dx_tok, 'kie', 'fake-kie-x-' || md5(random()::text));
        ans := public.my_provider_keys(dx_tok)::text;
        calls := calls || format('provider keys %s', case when (select count(*) from json_array_elements(ans::json -> 'keys')) = 1 then 'own only' else 'LEAK' end);
        perform public.clear_my_provider_key(dx_tok, 'kie');
  exception when others then calls := calls || format('provider keys err %s', sqlstate); end;
  begin perform public.set_my_wavespeed_key(dx_tok, 'fake-ws-x-' || md5(random()::text)); calls := calls || text 'set_my_wavespeed_key ok';
  exception when others then calls := calls || format('set_my_wavespeed_key err %s', sqlstate); end;
  begin perform public.set_my_account(dx_tok, 'x@example.test', true, now_ms); calls := calls || text 'set_my_account ok';
  exception when others then calls := calls || format('set_my_account err %s', sqlstate); end;
  begin perform public.set_auto_backups(dx_tok, false); calls := calls || text 'set_auto_backups ran';
  exception when others then calls := calls || format('set_auto_backups refused %s', sqlstate); end;
  begin perform public.snapshot_my_data_phase2(dx_tok, 'manual', null); calls := calls || text 'snapshot ok';
  exception when others then calls := calls || format('snapshot err %s', sqlstate); end;
  begin perform public.reset_queued_rows(dx_tok, now_ms, array[dy_task], array[dy_hist], null); calls := calls || text 'reset_queued_rows ok';
  exception when others then calls := calls || format('reset_queued_rows err %s', sqlstate); end;
  begin perform public.server_time_ms(dx_tok); calls := calls || text 'server_time_ms ok';
  exception when others then calls := calls || format('server_time_ms err %s', sqlstate); end;
  execute 'reset role';
  fp1 := md5(concat_ws('|',
    (select string_agg(concat_ws(',', id, status, start_time, outputs::text), ';' order by id) from public.tasks where device_id = dy),
    (select string_agg(concat_ws(',', id, tasks::text), ';' order by id) from public.history where device_id = dy),
    (select string_agg(id, ';' order by id) from public.favorites where device_id = dy),
    (select string_agg(concat_ws(',', key, value::text), ';' order by key) from public.settings where device_id = dy),
    (select string_agg(concat_ws(',', id, kind, by_restore), ';' order by id) from public.sync_tombstones where device_id = dy),
    (select string_agg(concat_ws(',', id, task_count, md5(coalesce(tasks_snapshot, '[]'::jsonb)::text)), ';' order by id) from public.data_backups where username = dy),
    (select string_agg(concat_ws(',', provider, fingerprint, updated_at), ';' order by provider) from proxima_auth.provider_keys where account_id = dy_id),
    (select md5(to_jsonb(u)::text) from proxima_auth.users u where u.id = dy_id),   -- the whole account row, its switch included
    (select count(*)::text from public.backup_scrub_queue where username = dy)));
  r := r || format('%s definers: X''s %s calls naming Y''s ids leave Y unchanged and return nothing of Y''s [%s]',
                   case when fp0 = fp1 and not exists (select 1 from unnest(calls) c where c ~ 'LEAK|RESTORED-Y') then 'PASS' else 'FAIL' end,
                   cardinality(calls), array_to_string(calls, '; '));
  -- X's own snapshot holds no row of Y's: no element of Y's scope and none of Y's content (its task id, which its file
  -- and its History items carry too, its favorite, its setting). Not Y's History id itself: from step (c) X's own History
  -- row of that id (upsert_queued_history above writes into X's scope) is X's, not Y's.
  select count(*), count(*) filter (where position(dy_task in snap.txt) > 0 or position(p || '_dyf' in snap.txt) > 0
                                       or position(p || '_dys' in snap.txt) > 0
                                       or exists (select 1 from jsonb_array_elements(coalesce(b.tasks_snapshot, '[]'::jsonb)
                                                                                      || coalesce(b.history_snapshot, '[]'::jsonb)
                                                                                      || coalesce(b.favorites_snapshot, '[]'::jsonb)) e
                                                  where e->>'device_id' = dy))
    into n, kn
    from public.data_backups b,
         lateral (select concat_ws('|', b.tasks_snapshot, b.history_snapshot, b.favorites_snapshot, b.settings_snapshot) as txt) snap
   where b.username = dx;
  r := r || format('%s definers: X''s new backup holds none of Y''s rows (tasks, History, favorites, settings; %s backup(s), %s with Y''s)',
                   case when n >= 1 and kn = 0 then 'PASS' else 'FAIL' end, n, kn);

  ---------------------------------------------------------------- Automatic backups per account (20261025800000)
  if not ab_on then
    r := r || text 'FAIL auto-backups: proxima_auth.users.auto_backups missing (20261025800000 not applied)';
  else
    ax := 'user:' || p || 'ax'; ay := 'user:' || p || 'ay'; az := 'user:' || p || 'az';
    aw := 'user:' || p || 'aw'; av := 'user:' || p || 'av'; au := 'user:' || p || 'au';
    an := 'user:' || p || 'an';   -- a scope with no account row
    insert into proxima_auth.users (id, username, role, scope, disabled_at) values
      (ax_id, p || 'ax', 'member', ax, null), (ay_id, p || 'ay', 'member', ay, null), (az_id, p || 'az', 'member', az, now()),
      (aw_id, p || 'aw', 'member', aw, null), (av_id, p || 'av', 'member', av, null), (au_id, p || 'au', 'member', au, null);
    ax_tok := proxima_auth.mint_token(ax_id); ay_tok := proxima_auth.mint_token(ay_id);
    own0 := public._auto_backups_on();
    -- Switch on for Z (disabled), W (deleted below), V (no generations) and U (its backup fails, planted below).
    execute 'update proxima_auth.users set auto_backups = true where id in ($1, $2, $3, $4)' using az_id, aw_id, av_id, au_id;
    -- X turns its own switch on (the app's calls); Y's, the owner's and the old global row do not move.
    begin
      v := (select md5(sec.value::text || sec.updated_at::text) from public.app_secrets sec where sec.key = 'auto_backups');
      execute 'set local role anon';
      perform set_config('request.headers', json_build_object('x-proxima-session', ax_tok)::text, true);
      ok := public.set_auto_backups(ax_tok, true);
      ok := ok and public.get_auto_backups(ax_tok);
      perform set_config('request.headers', json_build_object('x-proxima-session', ay_tok)::text, true);
      ok := ok and not public.get_auto_backups(ay_tok);
      execute 'reset role';
      r := r || format('%s auto-backups: X turns its own switch on; Y''s, the owner''s and the old global row stay as they were',
                       case when ok and public._auto_backups_on() is not distinct from own0 and not public._auto_backups_on(ay)
                                 and v is not distinct from (select md5(sec.value::text || sec.updated_at::text)
                                                               from public.app_secrets sec where sec.key = 'auto_backups')
                            then 'PASS' else 'FAIL' end);
    exception when others then
      execute 'reset role';
      r := r || format('FAIL auto-backups: switch %s %s', sqlstate, sqlerrm);
    end;
    -- One statement over several accounts' rows (only the server can do that): Y (off) and a scope with no account row
    -- (reads as off) queue scrubs from each of the three triggers; X (on) does not.
    begin
      insert into public.tasks (id, device_id, status, start_time, outputs) values
        (p || '_abx', ax, 'completed', 1, '["https://h/abx.png"]'), (p || '_aby', ay, 'completed', 1, '["https://h/aby.png"]'),
        (p || '_abn', an, 'completed', 1, '[]');
      insert into public.history (id, device_id, timestamp, tasks) values
        (p || '_abhx', ax, 1, '[{"id":"abq1","status":"completed","outputs":[]},{"id":"abq2","status":"completed","outputs":[]}]'),
        (p || '_abhy', ay, 1, '[{"id":"abq1","status":"completed","outputs":[]},{"id":"abq2","status":"completed","outputs":[]}]'),
        (p || '_abhn', an, 1, '[{"id":"abq1","status":"completed","outputs":[]},{"id":"abq2","status":"completed","outputs":[]}]');
      delete from public.backup_scrub_queue where username in (ax, ay, an);
      delete from public.tasks where id in (p || '_abx', p || '_aby', p || '_abn');
      update public.history set tasks = '[{"id":"abq1","status":"completed","outputs":[]}]'::jsonb where id in (p || '_abhx', p || '_abhy', p || '_abhn');
      delete from public.history where id in (p || '_abhx', p || '_abhy', p || '_abhn');
      select count(*) filter (where username = ax), count(*) filter (where username = ay), count(*) filter (where username = an)
        into na, nb, kn from public.backup_scrub_queue where username in (ax, ay, an);
      r := r || format('%s auto-backups: a delete, a History rewrite and a History delete over several accounts queue scrubs for Y (off) and a scope without an account (off), never X (on) (X %s, Y %s of 3, no account %s of 3)',
                       case when na = 0 and nb = 3 and kn = 3 then 'PASS' else 'FAIL' end, na, nb, kn);
    exception when others then r := r || format('FAIL auto-backups: triggers %s %s', sqlstate, sqlerrm); end;
    -- The 2-day backup covers each account whose own switch is on, and none that is disabled (Z), deleted (W) or without
    -- generations (V). A failing backup for one account (U, a planted trigger; U sorts before X) is a WARNING that never
    -- stops the others'.
    begin
      execute 'update proxima_auth.users set deleted_at = now() where id = $1' using aw_id;
      insert into public.tasks (id, device_id, status, start_time, outputs) values
        (p || '_abx2', ax, 'completed', 1, '[]'), (p || '_aby2', ay, 'completed', 1, '[]'), (p || '_abz2', az, 'completed', 1, '[]'),
        (p || '_abw2', aw, 'completed', 1, '[]'), (p || '_abu2', au, 'completed', 1, '[]');
      -- X also holds a History entry, a favorite, a setting and a form draft, so the exact-rows check below can fail in
      -- every column (review round 18).
      insert into public.history (id, device_id, timestamp, tasks) values (p || '_abhx2', ax, 1, '[]');
      insert into public.favorites (id, device_id, prompt) values (p || '_abfx2', ax, 'x');
      insert into public.settings (device_id, key, value) values (ax, p || '_absx2', '1'::jsonb), (ax, 'form-inputs:' || p, '1'::jsonb);
      execute format($f$create function public.%I() returns trigger language plpgsql as $b$
        begin if new.username = %L then raise exception 'planted failure'; end if; return new; end $b$$f$, p || '_fail', au);
      execute format('create trigger %I before insert on public.data_backups for each row execute function public.%I()', p || '_fail', p || '_fail');
      perform public.create_auto_backup();
      execute format('drop trigger %I on public.data_backups', p || '_fail');
      select count(*) filter (where username = ax), count(*) filter (where username = ay), count(*) filter (where username = az),
             count(*) filter (where username = aw), count(*) filter (where username = av), count(*) filter (where username = au)
        into na, nb, kn, n, nx, ny from public.data_backups where username in (ax, ay, az, aw, av, au) and backup_type = 'auto-2day';
      r := r || format('%s auto-backups: the 2-day backup covers X (on), none of Y (off), Z (disabled), W (deleted), V (no generations) or U (planted failure), and U''s failure does not stop X''s (X %s, Y %s, Z %s, W %s, V %s, U %s)',
                       case when na = 1 and nb = 0 and kn = 0 and n = 0 and nx = 0 and ny = 0 then 'PASS' else 'FAIL' end, na, nb, kn, n, nx, ny);
      -- X's backup holds exactly X's own rows, every column read by X's scope (review round 17).
      select count(*) into kn from public.data_backups bk
       where bk.username = ax and bk.backup_type = 'auto-2day'
         and bk.task_count = (select count(*) from public.tasks tk where tk.device_id = ax)
         and bk.history_count = (select count(*) from public.history hs where hs.device_id = ax)
         and coalesce((select array_agg(el->>'id' order by el->>'id') from jsonb_array_elements(bk.tasks_snapshot) el), '{}')
             = coalesce((select array_agg(tk.id order by tk.id) from public.tasks tk where tk.device_id = ax), '{}')
         and coalesce((select array_agg(el->>'id' order by el->>'id') from jsonb_array_elements(bk.history_snapshot) el), '{}')
             = coalesce((select array_agg(hs.id order by hs.id) from public.history hs where hs.device_id = ax), '{}')
         and coalesce((select array_agg(el->>'id' order by el->>'id') from jsonb_array_elements(bk.favorites_snapshot) el), '{}')
             = coalesce((select array_agg(fv.id order by fv.id) from public.favorites fv where fv.device_id = ax), '{}')
         and coalesce((select array_agg(ky order by ky) from jsonb_object_keys(bk.settings_snapshot) ky), '{}')
             = coalesce((select array_agg(sg.key order by sg.key) from public.settings sg
                          where sg.device_id = ax and sg.key not like 'form-inputs:%'), '{}');
      r := r || format('%s auto-backups: X''s 2-day backup holds exactly X''s own tasks, History, favorites and settings, and counts them (%s of 1)',
                       case when kn = 1 then 'PASS' else 'FAIL' end, kn);
    exception when others then r := r || format('FAIL auto-backups: cron %s %s', sqlstate, sqlerrm); end;
    -- A pre-delete safety backup follows the caller's own switch.
    begin
      execute 'set local role anon';
      perform set_config('request.headers', json_build_object('x-proxima-session', ax_tok)::text, true);
      j := public.snapshot_my_data_phase2(ax_tok, 'pre-delete', null);
      perform set_config('request.headers', json_build_object('x-proxima-session', ay_tok)::text, true);
      ans := public.snapshot_my_data_phase2(ay_tok, 'pre-delete', null)::text;
      execute 'reset role';
      r := r || format('%s auto-backups: a pre-delete backup is taken for X (on) and skipped for Y (off) (X %s, Y skipped %s)',
                       case when j->>'id' is not null and ans::json->>'skipped' = 'true'
                                 and not exists (select 1 from public.data_backups where username = ay and backup_type = 'pre-delete')
                            then 'PASS' else 'FAIL' end,
                       case when j->>'id' is not null then 'taken' else 'none' end, coalesce(ans::json->>'skipped', 'no'));
    exception when others then
      execute 'reset role';
      r := r || format('FAIL auto-backups: pre-delete %s %s', sqlstate, sqlerrm);
    end;
    -- X switching off queues one scrub of X's own backups, none of Y's.
    begin
      insert into public.data_backups (username, backup_type, task_count, tasks_snapshot) values (ay, 'manual', 0, '[]'::jsonb);
      delete from public.backup_scrub_queue where username in (ax, ay);
      execute 'set local role anon';
      perform set_config('request.headers', json_build_object('x-proxima-session', ax_tok)::text, true);
      ok := not public.set_auto_backups(ax_tok, false);
      execute 'reset role';
      select count(*) filter (where username = ax and all_tombstones), count(*) filter (where username = ay) into na, nb
        from public.backup_scrub_queue where username in (ax, ay);
      r := r || format('%s auto-backups: X switching off queues one scrub of X''s own backups and none of Y''s; the owner''s switch never moved (X %s, Y %s)',
                       case when ok and na = 1 and nb = 0 and public._auto_backups_on() is not distinct from own0 then 'PASS' else 'FAIL' end, na, nb);
      -- A null value means off: it answers false, stores off and queues the same scrub (review round 9). Sent while the
      -- switch is on, so "null keeps the value" cannot pass for "null means off" (review round 10).
      delete from public.backup_scrub_queue where username = ax;
      execute 'update proxima_auth.users set auto_backups = true where id = $1' using ax_id;
      execute 'set local role anon';
      perform set_config('request.headers', json_build_object('x-proxima-session', ax_tok)::text, true);
      ok := not public.set_auto_backups(ax_tok, null);
      execute 'reset role';
      ok := ok and (select not u.auto_backups from proxima_auth.users u where u.id = ax_id);
      select count(*) filter (where all_tombstones) into na from public.backup_scrub_queue where username = ax;
      r := r || format('%s auto-backups: a null switch value (sent while on) is off, stored off, and queues the switch-off scrub (%s)',
                       case when ok and na = 1 then 'PASS' else 'FAIL' end, na);
    exception when others then
      execute 'reset role';
      r := r || format('FAIL auto-backups: switch-off %s %s', sqlstate, sqlerrm);
    end;
    -- An account with no backup yet that switches off still gets its scrub queued (review round 12: one still being
    -- written is reached by a later drain); V has no generations, so the 2-day run above made none for it.
    begin
      av_tok := proxima_auth.mint_token(av_id);
      select count(*) into kn from public.data_backups where username = av;
      delete from public.backup_scrub_queue where username = av;
      execute 'set local role anon';
      perform set_config('request.headers', json_build_object('x-proxima-session', av_tok)::text, true);
      ok := not public.set_auto_backups(av_tok, false);
      execute 'reset role';
      select count(*) filter (where all_tombstones) into na from public.backup_scrub_queue where username = av;
      r := r || format('%s auto-backups: an account with no backup that switches off still gets its scrub queued (backups %s, queued %s)',
                       case when ok and kn = 0 and na = 1 then 'PASS' else 'FAIL' end, kn, na);
    exception when others then
      execute 'reset role';
      r := r || format('FAIL auto-backups: switch-off without a backup %s %s', sqlstate, sqlerrm);
    end;
    -- Off, then on again before any drain, then a delete while on (review round 17): the switch-off's scrub must not
    -- reach what the account deletes after it is back on, its pre-delete copy included. The switch-on runs it at once.
    begin
      ao := 'user:' || p || 'ao';
      insert into proxima_auth.users (id, username, role, scope) values (ao_id, p || 'ao', 'member', ao);
      execute 'update proxima_auth.users set auto_backups = true where id = $1' using ao_id;
      ao_tok := proxima_auth.mint_token(ao_id);
      insert into public.tasks (id, device_id, status, start_time, outputs) values (p || '_abo', ao, 'completed', 1, '[]');
      execute 'set local role anon';
      perform set_config('request.headers', json_build_object('x-proxima-session', ao_tok)::text, true);
      ok := not public.set_auto_backups(ao_tok, false);
      if not public.set_auto_backups(ao_tok, true) then ok := false; end if;   -- never behind a short-circuit
      jd := public.snapshot_my_data_phase2(ao_tok, 'pre-delete', null);
      j := public.delete_queued_rows(ao_tok, 'task', array[p || '_abo'], now_ms);
      execute 'reset role';
      perform public._drain_backup_scrubs(ao);
      select count(*) into na from public.data_backups
       where id = (jd->>'id')::uuid and tasks_snapshot @> jsonb_build_array(jsonb_build_object('id', p || '_abo'));
      select count(*) into nb from public.backup_scrub_queue where username = ao;
      r := r || format('%s auto-backups: off, on again, then a delete while on: the deleted generation stays in its pre-delete copy (%s of 1), nothing queued (%s)',
                       case when ok and na = 1 and nb = 0 then 'PASS' else 'FAIL' end, na, nb);
    exception when others then
      execute 'reset role';
      r := r || format('FAIL auto-backups: off-on %s %s', sqlstate, sqlerrm);
    end;
    -- A switch-on whose queued scrub cannot run now (a planted failure in its drain) is refused; the switch stays off.
    begin
      ap := 'user:' || p || 'ap';
      insert into proxima_auth.users (id, username, role, scope) values (ap_id, p || 'ap', 'member', ap);
      ap_tok := proxima_auth.mint_token(ap_id);
      insert into public.backup_scrub_queue (username, all_tombstones) values (ap, true);
      execute format($f$create function public.%I() returns trigger language plpgsql as $b$
        begin if old.username = %L then raise exception 'planted failure'; end if; return old; end $b$$f$, p || '_qf', ap);
      execute format('create trigger %I before delete on public.backup_scrub_queue for each row execute function public.%I()', p || '_qf', p || '_qf');
      execute 'set local role anon';
      perform set_config('request.headers', json_build_object('x-proxima-session', ap_tok)::text, true);
      begin
        perform public.set_auto_backups(ap_tok, true);
        ans := 'not refused';
      exception when others then
        ans := sqlstate;
      end;
      ok := not public.get_auto_backups(ap_tok);
      execute 'reset role';
      execute format('drop trigger %I on public.backup_scrub_queue', p || '_qf');
      execute format('drop function public.%I()', p || '_qf');
      select count(*) filter (where all_tombstones) into na from public.backup_scrub_queue where username = ap;
      r := r || format('%s auto-backups: a switch-on whose queued scrub cannot run now is refused (%s); the switch stays off (%s), the scrub still queued (%s)',
                       case when ans = '55000' and ok and na = 1 then 'PASS' else 'FAIL' end, ans, ok, na);
    exception when others then
      execute 'reset role';
      r := r || format('FAIL auto-backups: refused switch-on %s %s', sqlstate, sqlerrm);
    end;
    -- The no-arg form is the owner's own switch, not the old global row; a restore takes its pre-restore backup by the
    -- caller's own switch whatever the owner's: with the owner's on, Y (off) restores and gets none; with the owner's
    -- off, X (on again) restores and gets one. The owner's row changes inside this rolled-back test only.
    begin
      select id into bkx from public.data_backups where username = ax and backup_type = 'auto-2day' limit 1;
      select id into bky from public.data_backups where username = ay and backup_type = 'manual' limit 1;
      v := (select md5(sec.value::text || sec.updated_at::text) from public.app_secrets sec where sec.key = 'auto_backups');
      execute 'update proxima_auth.users set auto_backups = $1 where id = $2' using not own0, a_id;
      ok := public._auto_backups_on() is not distinct from (not own0)
            and v is not distinct from (select md5(sec.value::text || sec.updated_at::text) from public.app_secrets sec where sec.key = 'auto_backups');
      execute 'update proxima_auth.users set auto_backups = true where id = $1' using a_id;
      execute 'set local role anon';
      perform set_config('request.headers', json_build_object('x-proxima-session', ay_tok)::text, true);
      j := public.restore_my_backup_phase2(ay_tok, bky);
      execute 'reset role';
      ok := ok and coalesce((j->>'ok')::boolean, false);
      execute 'update proxima_auth.users set auto_backups = false where id = $1' using a_id;
      select count(*) into kn from public.backup_scrub_queue where username = ax;   -- X holds backups now
      execute 'set local role anon';
      perform set_config('request.headers', json_build_object('x-proxima-session', ax_tok)::text, true);
      if not public.set_auto_backups(ax_tok, true) then ok := false; end if;   -- never behind a short-circuit
      execute 'reset role';
      -- Switching on queues no scrub (review round 9): the copies are what the switch is for. It runs the one X's
      -- switch-off left queued instead (review round 17), so nothing is left.
      ok := ok and kn >= 1 and not exists (select 1 from public.backup_scrub_queue where username = ax);
      execute 'set local role anon';
      perform set_config('request.headers', json_build_object('x-proxima-session', ax_tok)::text, true);
      j := public.restore_my_backup_phase2(ax_tok, bkx);
      execute 'reset role';
      ok := ok and coalesce((j->>'ok')::boolean, false);
      select count(*) filter (where username = ax), count(*) filter (where username = ay) into nx, ny
        from public.data_backups where username in (ax, ay) and backup_type = 'pre-restore';
      r := r || format('%s auto-backups: the no-arg form follows the owner''s own switch, not the old global row; switching on queues no scrub and runs the one still queued; a restore''s pre-restore backup follows the caller''s switch whatever the owner''s (X on %s of 1, Y off %s of 0)',
                       case when ok and nx = 1 and ny = 0 then 'PASS' else 'FAIL' end, nx, ny);
    exception when others then
      execute 'reset role';
      r := r || format('FAIL auto-backups: owner switch / restore %s %s', sqlstate, sqlerrm);
    end;
    -- A rename that commits while set_auto_backups waits for the account row revokes the session, and the scope read at
    -- the start is stale: the call re-checks the session after its update (review round 8), as restore_my_backup_phase2
    -- does after its marker lock. One transaction cannot interleave two sessions, so this reads the order in the body.
    -- Read as one contiguous sequence with comments, E'' and '' strings removed (a copy in a dead branch or a string
    -- cannot pass; a body holding any $ fails), review round 12.
    select regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(lower(p.prosrc),
             '--[^\n]*', ' ', 'g'), '/\*.*?\*/', ' ', 'g'), '\me''(?:[^''\\]|\\.|'''')*''', '''''', 'g'),
             '''(?:[^'']|'''')*''', '''''', 'g'), '\s+', ' ', 'g')
      into ans from pg_proc p where p.oid = 'public.set_auto_backups(text,boolean)'::regprocedure;
    -- The same sequence runs on through the switch branch (review round 18): switching off queues the scrub; switching
    -- on drains after the UPDATE (the account row, then the marker, as rename) and refuses while a switch-off scrub is
    -- left; one drain call in the whole body.
    r := r || format('%s auto-backups: set_auto_backups re-checks the session (token, then scope) right after it holds the account row, then queues the switch-off scrub or, switching on, runs the queued one and refuses while a switch-off scrub is left (one sequence, one drain call)',
                     case when position('updated_at = now() where id = v_acc.id; perform public._verify_session_token(p_session_token); ' ||
                                        'if (proxima_auth.current_account(p_session_token)).scope is distinct from v_acc.scope then raise exception ''''; end if; ' ||
                                        'if not coalesce(p_enabled, false) then insert into backup_scrub_queue (username, all_tombstones) values (v_acc.scope, true); ' ||
                                        'else perform public._drain_backup_scrubs(v_acc.scope); ' ||
                                        'if exists (select 1 from backup_scrub_queue q where q.username = v_acc.scope and q.all_tombstones) then ' ||
                                        'raise exception '''' using errcode = ''''; end if; end if;' in ans) > 0
                               and (select count(*) from regexp_matches(ans, '_drain_backup_scrubs', 'g')) = 1
                               and position('$' in ans) = 0 then 'PASS' else 'FAIL' end);
    -- get/set read the switch by the account's id, never by the scope read at the start (round 8: a rename committing
    -- meanwhile would read as off); likewise only the body tells (review round 9).
    select count(*) into na from pg_proc p
     where p.oid in ('public.get_auto_backups(text)'::regprocedure, 'public.set_auto_backups(text,boolean)'::regprocedure)
       and position('where u.id = v_acc.id), false)' in regexp_replace(regexp_replace(p.prosrc, '/\*.*?\*/', ' ', 'g'), '--[^\n]*', ' ', 'g')) > 0
       and position('_auto_backups_on(v_acc.scope)' in regexp_replace(regexp_replace(p.prosrc, '/\*.*?\*/', ' ', 'g'), '--[^\n]*', ' ', 'g')) = 0;
    r := r || format('%s auto-backups: get_auto_backups and set_auto_backups answer the switch read by account id (%s of 2)',
                     case when na = 2 then 'PASS' else 'FAIL' end, na);
    -- The 2-day run's warning for a failed account names it by its id, never by its name (plan §4).
    v := pg_get_functiondef('public.create_auto_backup()'::regprocedure);
    r := r || format('%s auto-backups: the 2-day run''s warning names a failed account by its id, never by its name',
                     case when position('RAISE WARNING ''create_auto_backup: account % failed: % %'', rec.id, sqlstate, sqlerrm;' in v) > 0
                               and v !~* 'raise[^;]*(rec\.username|v_scope|\.scope)' then 'PASS' else 'FAIL' end);
    -- The 2-day run keeps the newest 30 automatic backups of EACH account: Q (on) and R (off) hold 30 each; after the
    -- run, Q's oldest gave way to the new one and R's are untouched (a trim across accounts would mix them).
    begin
      aq := 'user:' || p || 'aq'; ar := 'user:' || p || 'ar';
      insert into proxima_auth.users (id, username, role, scope) values (aq_id, p || 'aq', 'member', aq), (ar_id, p || 'ar', 'member', ar);
      execute 'update proxima_auth.users set auto_backups = true where id = $1' using aq_id;
      insert into public.tasks (id, device_id, status, start_time, outputs) values (p || '_abq', aq, 'completed', 1, '[]');
      insert into public.data_backups (username, backup_type, task_count, tasks_snapshot, created_at)
        select u, 'auto-2day', 0, '[]'::jsonb, now() - make_interval(hours => g) from unnest(array[aq, ar]) u, generate_series(1, 30) g;
      -- Q also holds a manual backup older than all of them: the trim removes automatic backups only (review round 19).
      insert into public.data_backups (username, backup_type, task_count, tasks_snapshot, created_at)
        values (aq, 'manual', 0, '[]'::jsonb, now() - interval '40 days');
      perform public.create_auto_backup();
      select count(*) filter (where username = aq), count(*) filter (where username = ar),
             count(*) filter (where username = aq and created_at = now())
        into na, nb, kn from public.data_backups where username in (aq, ar) and backup_type = 'auto-2day';
      select count(*) into nx from public.data_backups where username = aq and backup_type = 'manual';
      r := r || format('%s auto-backups: the 2-day run keeps the newest 30 automatic backups per account and no other kind (on %s of 30 incl. %s new, off %s of 30, Q''s older manual backup %s of 1)',
                       case when na = 30 and nb = 30 and kn = 1 and nx = 1 then 'PASS' else 'FAIL' end, na, kn, nb, nx);
    exception when others then r := r || format('FAIL auto-backups: retention %s %s', sqlstate, sqlerrm); end;
  end if;

  if not walls then r := r || text 'FAIL walls: proxima_auth.account_folders missing (20261025100000 not applied)'; end if;

  -- Sign-in history (the other session's 20261027100000; owner ruling 2026-10-27: only the owner sees it, for every
  -- account): a member is refused and gets no event; the owner reads them (the ruling's one exception to the walls).
  if to_regprocedure('public.list_signins(text,integer)') is null then
    r := r || text 'PASS sign-in history: not live yet (20261027100000), nothing to wall';
  else
    begin
      -- a member made here with a fresh session (B's was revoked by its rename above), and a fresh owner session
      insert into proxima_auth.users (username, role, scope) values (p || 'sg', 'member', 'user:' || p || 'sg');
      select proxima_auth.mint_token(u.id) into v from proxima_auth.users u where u.username = p || 'sg';
      ans := proxima_auth.mint_token(a_id);
      execute 'set local role anon';
      perform set_config('request.headers', json_build_object('x-proxima-session', v)::text, true);
      execute 'select public.list_signins($1, 200)' into j using v;
      perform set_config('request.headers', json_build_object('x-proxima-session', ans)::text, true);
      execute 'select public.list_signins($1, 1)' into jd using ans;
      execute 'reset role';
      r := r || format('%s sign-in history: a member is refused (%s, events in the answer: %s); the owner reads them (%s)',
                       case when j->>'reason' = 'forbidden' and j->'events' is null and (jd->>'ok')::boolean then 'PASS' else 'FAIL' end,
                       coalesce(j->>'reason', 'ok'), j->'events' is not null, coalesce(jd->>'ok', jd->>'reason'));
    exception when others then r := r || format('FAIL sign-in history: %s %s', sqlstate, sqlerrm); end;
  end if;
  raise exception 'RESULT: % PASS, % FAIL :: %',
    (select count(*) from unnest(r) x where x like 'PASS%'), (select count(*) from unnest(r) x where x like 'FAIL%'),
    array_to_string(r, ' | ');
end $pt$;
