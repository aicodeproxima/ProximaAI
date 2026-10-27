-- 20261026200000: _scrub_backups_to_live_items is linear (one statement per backup) and scrubs exactly as the loop it
-- replaces. Rolled back by sql-tx. The loop (verbatim from 20261021175200, as pg_temp.old_scrub) scrubs account A, the
-- function under test account B; both hold the same synthetic History and backups (history ids are unique across
-- accounts, so each account's ids carry its letter and the comparison swaps it): kept, partly kept and emptied entries;
-- tasks matched by id, by equality and by a shared output; non-array tasks on either side; an empty tasks array; costs.
-- Then the one deliberate difference (an entry with a live row but no tasks key stays; the loop dropped it whenever
-- another entry of its backup changed) and the timing case: 3 backups of 1000 entries of about 1.7 KB, every entry
-- losing one task (the loop: about 5 s). S5 (review round 24) reaches the loop's rules S1's data does not: an equal
-- id-less task kept, a backup with nothing to trim left uncounted, another account's live row with the same id ignored.
-- The other session's conditions for replacing its function (2026-10-27): S3 + S3b pin the no-tasks-key entry as kept
-- with or without a sibling change; S6 its catalog entry unchanged (SECURITY DEFINER, search_path, owner, grants) and
-- history_count floored at 0 as the loop does (the rollback proof covers the exact old body).
--   live, before the migration: S1, S2, S3b, S5 and S6 pass (both bodies are the loop), S3 and S4 FAIL (failing first)
--   node scripts/tools/sql-tx.mjs supabase/migrations/20261026200000_*.sql --test <this file>: all pass
create function pg_temp.old_scrub(p_username text) returns integer language plpgsql
  set search_path = public, pg_catalog as $old$
declare
  b record; e jsonb; i jsonb; live jsonb;
  v_new jsonb; v_kept jsonb; v_cost numeric; v_changed boolean; v_n int := 0;
begin
  for b in select d.id, d.history_snapshot from data_backups d
            where d.username = p_username and jsonb_typeof(d.history_snapshot) = 'array' loop
    v_new := '[]'::jsonb; v_changed := false;
    for e in select x from jsonb_array_elements(b.history_snapshot) x loop
      live := null;
      select h.tasks into live from history h where h.id = e->>'id' and h.device_id = p_username;
      if live is null or jsonb_typeof(live) <> 'array' or jsonb_typeof(e->'tasks') <> 'array' then
        v_new := v_new || jsonb_build_array(e);
        continue;
      end if;
      v_kept := '[]'::jsonb; v_cost := 0;
      for i in select y from jsonb_array_elements(e->'tasks') y loop
        if (coalesce(i->>'id', '') <> '' and exists (select 1 from jsonb_array_elements(live) l where l->>'id' = i->>'id'))
           or (coalesce(i->>'id', '') = '' and exists (
                 select 1 from jsonb_array_elements(live) l
                  where coalesce(l->>'id', '') = ''
                    and (l = i or exists (
                      select 1
                        from jsonb_array_elements_text(case when jsonb_typeof(l->'outputs') = 'array' then l->'outputs' else '[]'::jsonb end) lo,
                             jsonb_array_elements_text(case when jsonb_typeof(i->'outputs') = 'array' then i->'outputs' else '[]'::jsonb end) io
                       where lo.value = io.value)))) then
          v_kept := v_kept || jsonb_build_array(i);
          if i->>'status' = 'completed' and jsonb_typeof(i->'cost') = 'number' then v_cost := v_cost + (i->>'cost')::numeric; end if;
        else
          v_changed := true;
        end if;
      end loop;
      if jsonb_array_length(v_kept) = jsonb_array_length(e->'tasks') then
        v_new := v_new || jsonb_build_array(e);
      elsif jsonb_array_length(v_kept) > 0 then
        v_new := v_new || jsonb_build_array(jsonb_set(jsonb_set(e, '{tasks}', v_kept), '{total_cost}', to_jsonb(v_cost)));
      end if;
    end loop;
    if v_changed then
      update data_backups d set
        history_snapshot = v_new,
        history_count = greatest(coalesce(d.history_count, 0) - (jsonb_array_length(b.history_snapshot) - jsonb_array_length(v_new)), 0)
      where d.id = b.id;
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end $old$;
do $t$
declare
  r text[] := '{}'; p constant text := '__sl' || txid_current();
  na int; nb int; n int; m int; t0 timestamptz; ms numeric; ok boolean;
begin
  -- The live History: entries 1-200; entry g has 1-4 tasks, every third one id-less with an output; entry 9's tasks is
  -- no array.
  create temp table sl_live on commit drop as
    select g, case when g = 9 then '"scalar"'::jsonb else
           (select jsonb_agg(case when j % 3 = 0
                                  then jsonb_build_object('status', case when j % 2 = 0 then 'completed' else 'failed' end,
                                                          'cost', j * 0.5, 'outputs', jsonb_build_array('https://o/' || g || '-' || j))
                                  else jsonb_build_object('id', 't' || g || '-' || j, 'status', 'completed', 'cost', j,
                                                          'outputs', jsonb_build_array('https://o/' || g || '-' || j)) end order by j)
              from generate_series(1, 1 + g % 4) j) end as tasks
      from generate_series(1, 200) g;
  -- Three backups of entries 1-250 (ids '~ID~e<g>', made per account below): the live tasks plus deleted ones (an id
  -- gone from live; an id-less one sharing no output); entries g % 5 = 0 hold only deleted tasks (they go); entries
  -- 201-250 have no live row; entry 7's tasks is an object, entry 8's an empty array.
  create temp table sl_snap on commit drop as
    select k as bk, jsonb_agg(e order by g) as snap
      from generate_series(1, 3) k,
           lateral (select g, case
             when g > 200 then jsonb_build_object('id', '~ID~gone' || g, 'tasks', jsonb_build_array(jsonb_build_object('id', 'x' || g)))
             when g = 7 then jsonb_build_object('id', '~ID~e7', 'tasks', '{"not":"an array"}'::jsonb)
             when g = 8 then jsonb_build_object('id', '~ID~e8', 'tasks', '[]'::jsonb)
             when g = 9 then jsonb_build_object('id', '~ID~e9', 'tasks', jsonb_build_array(jsonb_build_object('id', 'stays9')))
             when g % 5 = 0 then jsonb_build_object('id', '~ID~e' || g, 'total_cost', 9,
                                   'tasks', jsonb_build_array(jsonb_build_object('id', 'deleted' || g || '-' || k, 'status', 'completed', 'cost', 2)))
             else jsonb_build_object('id', '~ID~e' || g, 'total_cost', 99,
                    'tasks', (select tasks from sl_live l where l.g = s.g)
                             || case when (g + k) % 2 = 0 then jsonb_build_array(jsonb_build_object('id', 'deleted' || g, 'status', 'completed', 'cost', 3))
                                     else '[]'::jsonb end
                             || case when (g + k) % 3 = 0 then jsonb_build_array(jsonb_build_object('status', 'completed', 'cost', 4,
                                                                                   'outputs', jsonb_build_array('https://o/none-' || g)))
                                     else '[]'::jsonb end) end as e
             from generate_series(1, 250) s(g)) x
     group by k;
  insert into public.history (id, device_id, timestamp, tasks)
    select p || a || '-e' || g, 'user:' || p || a, 1, tasks from sl_live, unnest(array['A', 'B']) a;
  insert into public.data_backups (username, backup_type, task_count, history_count, history_snapshot, note)
    select 'user:' || p || a, 'manual', 0, 250, replace(snap::text, '~ID~', p || a || '-')::jsonb, 'sl-' || bk
      from sl_snap, unnest(array['A', 'B']) a;

  -- S1. The same result as the loop: every backup's History and count, and the number of backups changed.
  na := pg_temp.old_scrub('user:' || p || 'A');
  nb := public._scrub_backups_to_live_items('user:' || p || 'B');
  select count(*) filter (where replace(x.history_snapshot::text, p || 'A-', p || 'B-')::jsonb is distinct from y.history_snapshot
                             or x.history_count is distinct from y.history_count),
         count(*)
    into n, m
    from public.data_backups x join public.data_backups y on y.username = 'user:' || p || 'B' and y.note = x.note
   where x.username = 'user:' || p || 'A';
  r := r || format('%s S1 scrubs exactly as the loop: %s of %s backups differ; backups changed %s (loop %s)',
                   case when n = 0 and m = 3 and na = nb and na = 3 then 'PASS' else 'FAIL' end, n, m, nb, na);
  -- S2. It really scrubbed (B): emptied entries and deleted tasks gone, the odd entries kept as they were.
  select count(*) into n from public.data_backups d, jsonb_array_elements(d.history_snapshot) e
   where d.username = 'user:' || p || 'B' and (e->>'id' = p || 'B-e10' or e::text like '%deleted%' or e::text like '%none-%');
  select count(*) into m from public.data_backups d, jsonb_array_elements(d.history_snapshot) e
   where d.username = 'user:' || p || 'B' and e->>'id' in (p || 'B-e7', p || 'B-e8', p || 'B-e9', p || 'B-gone201');
  r := r || format('%s S2 removes emptied entries and deleted tasks, keeps the odd entries (left %s, odd kept %s of 12)',
                   case when n = 0 and m = 12 then 'PASS' else 'FAIL' end, n, m);

  -- S3. The deliberate difference: an entry with a live row but no tasks key stays when another entry of its backup
  -- changes (D: the function under test); the loop drops it (E: shown, not asserted as right).
  insert into public.history (id, device_id, timestamp, tasks)
    select p || a || '-' || i, 'user:' || p || a, 1, jsonb_build_array(jsonb_build_object('id', 'k' || i))
      from unnest(array['D', 'E']) a, unnest(array['n1', 'n2']) i;
  insert into public.data_backups (username, backup_type, task_count, history_count, history_snapshot, note)
    select 'user:' || p || a, 'manual', 0, 2,
           jsonb_build_array(jsonb_build_object('id', p || a || '-n1', 'note', 'no tasks key'),
                             jsonb_build_object('id', p || a || '-n2', 'tasks', jsonb_build_array(jsonb_build_object('id', 'kn2'), jsonb_build_object('id', 'gone')))),
           'nk'
      from unnest(array['D', 'E']) a;
  n := public._scrub_backups_to_live_items('user:' || p || 'D');
  m := pg_temp.old_scrub('user:' || p || 'E');
  select count(*) into na from public.data_backups d, jsonb_array_elements(d.history_snapshot) e
   where d.username = 'user:' || p || 'D' and d.history_count = 2
     and (e = jsonb_build_object('id', p || 'D-n1', 'note', 'no tasks key')
          or e = jsonb_build_object('id', p || 'D-n2', 'tasks', jsonb_build_array(jsonb_build_object('id', 'kn2')), 'total_cost', 0));
  select jsonb_array_length(history_snapshot) into nb from public.data_backups where username = 'user:' || p || 'E';
  r := r || format('%s S3 an entry without a tasks key stays while its backup is trimmed (%s of 2 entries as expected, %s changed; the loop left %s of 2)',
                   case when na = 2 and n = 1 then 'PASS' else 'FAIL' end, na, n, nb);

  -- S4. Linear: 3 backups of 1000 entries of about 1.7 KB, each entry losing one task.
  insert into public.history (id, device_id, timestamp, tasks)
    select p || 'C-big' || g, 'user:' || p || 'C', 1, jsonb_build_array(jsonb_build_object('id', 'bt' || g, 'status', 'completed', 'cost', 1,
                                                                    'outputs', jsonb_build_array('https://o/' || repeat('k', 1500) || g)))
      from generate_series(1, 1000) g;
  insert into public.data_backups (username, backup_type, task_count, history_count, history_snapshot, note)
    select 'user:' || p || 'C', 'manual', 0, 1000,
           (select jsonb_agg(jsonb_build_object('id', p || 'C-big' || g, 'tasks', jsonb_build_array(
                    jsonb_build_object('id', 'bt' || g, 'status', 'completed', 'cost', 1, 'outputs', jsonb_build_array('https://o/' || repeat('k', 1500) || g)),
                    jsonb_build_object('id', 'bdel' || g, 'status', 'completed', 'cost', 1))) order by g)
              from generate_series(1, 1000) g), 'big-' || k
      from generate_series(1, 3) k;
  t0 := clock_timestamp();
  n := public._scrub_backups_to_live_items('user:' || p || 'C');
  ms := round(extract(epoch from clock_timestamp() - t0) * 1000);
  select count(*) into m from public.data_backups d, jsonb_array_elements(d.history_snapshot) e
   where d.username = 'user:' || p || 'C' and jsonb_array_length(e->'tasks') = 1 and e->'total_cost' = '1';
  r := r || format('%s S4 3 backups of 1000 entries scrubbed in %s ms (under 1500; the loop takes about 5000), %s backups changed, %s of 3000 entries trimmed',
                   case when ms < 1500 and n = 3 and m = 3000 then 'PASS' else 'FAIL' end, ms, n, m);

  -- S5. The loop's rules S1's data never reaches (review round 24 c2), the loop on F, the function under test on G: an
  -- id-less task without outputs kept only by being equal to a live one (and one dropped); a backup with nothing to trim
  -- (left as it is, not counted); an entry whose id is a live History row of another account (Z), not of this one.
  insert into public.history (id, device_id, timestamp, tasks)
    select p || a || '-q1', 'user:' || p || a, 1, '[{"status":"failed"},{"id":"k1"}]'::jsonb from unnest(array['F', 'G']) a
    union all
    select p || a || '-z1', 'user:' || p || 'Z', 1, '[]'::jsonb from unnest(array['F', 'G']) a;
  insert into public.data_backups (username, backup_type, task_count, history_count, history_snapshot, note)
    select 'user:' || p || a, 'manual', 0, 2, replace(d.v, '~', p || a)::jsonb, d.nt
      from unnest(array['F', 'G']) a,
           (values ('[{"id":"~-q1","tasks":[{"status":"failed"},{"status":"queued"},{"id":"k1"}]},{"id":"~-z1","tasks":[{"id":"q"}]}]', 's5-trim'),
                   ('[{"id":"~-q1","tasks":[{"status":"failed"},{"id":"k1"}]},{"id":"~-none","tasks":[{"id":"z"}]}]', 's5-keep')) d(v, nt);
  na := pg_temp.old_scrub('user:' || p || 'F');
  nb := public._scrub_backups_to_live_items('user:' || p || 'G');
  select count(*) filter (where replace(x.history_snapshot::text, p || 'F-', p || 'G-')::jsonb is distinct from y.history_snapshot
                             or x.history_count is distinct from y.history_count),
         count(*)
    into n, m
    from public.data_backups x join public.data_backups y on y.username = 'user:' || p || 'G' and y.note = x.note
   where x.username = 'user:' || p || 'F';
  r := r || format('%s S5 equal id-less tasks kept, an untouched backup not counted, another account''s row ignored: %s of %s backups differ from the loop; changed %s (loop %s)',
                   case when n = 0 and m = 2 and na = 1 and nb = 1 then 'PASS' else 'FAIL' end, n, m, nb, na);

  -- S3b (the other session's condition 1, 2026-10-27): an entry with a live row and no tasks key, alone in its backup,
  -- is kept by both bodies and the backup is not counted; with S3, "kept" is pinned whatever its siblings do (the loop
  -- dropped it only when a sibling changed).
  insert into public.history (id, device_id, timestamp, tasks)
    select p || a || '-m1', 'user:' || p || a, 1, '[{"id":"km1"}]'::jsonb from unnest(array['J', 'K']) a;
  insert into public.data_backups (username, backup_type, task_count, history_count, history_snapshot, note)
    select 'user:' || p || a, 'manual', 0, 1, jsonb_build_array(jsonb_build_object('id', p || a || '-m1', 'note', 'no tasks key')), 's3b'
      from unnest(array['J', 'K']) a;
  na := pg_temp.old_scrub('user:' || p || 'J');
  nb := public._scrub_backups_to_live_items('user:' || p || 'K');
  select count(*) into n from public.data_backups d
   where (d.username, d.history_snapshot, d.history_count) in
         (('user:' || p || 'J', jsonb_build_array(jsonb_build_object('id', p || 'J-m1', 'note', 'no tasks key')), 1),
          ('user:' || p || 'K', jsonb_build_array(jsonb_build_object('id', p || 'K-m1', 'note', 'no tasks key')), 1));
  r := r || format('%s S3b an entry without a tasks key alone in its backup stays, uncounted, in both (%s of 2 backups as they were; changed %s, loop %s)',
                   case when n = 2 and na = 0 and nb = 0 then 'PASS' else 'FAIL' end, n, nb, na);

  -- S6 (the other session's conditions 3 and 4): the function keeps its catalog entry (SECURITY DEFINER, its
  -- search_path, owner and grants, as live on 2026-10-27), and history_count follows the loop's rule (old count minus the
  -- entries removed, floored at 0: a count of 1 or null with two entries removed gives 0 in both bodies).
  select p2.prosecdef and p2.proconfig = array['search_path=public, pg_catalog'] and p2.proowner = 'postgres'::regrole
         and p2.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
    into ok from pg_proc p2 where p2.oid = 'public._scrub_backups_to_live_items(text)'::regprocedure;
  insert into public.history (id, device_id, timestamp, tasks)
    select p || a || '-' || x, 'user:' || p || a, 1, '[{"id":"live"}]'::jsonb from unnest(array['L', 'M']) a, unnest(array['r1', 'r2']) x;
  insert into public.data_backups (username, backup_type, task_count, history_count, history_snapshot, note)
    select 'user:' || p || a, 'manual', 0, c.hc,
           jsonb_build_array(jsonb_build_object('id', p || a || '-r1', 'tasks', '[{"id":"dead1"}]'::jsonb),
                             jsonb_build_object('id', p || a || '-r2', 'tasks', '[{"id":"dead2"}]'::jsonb)), c.nt
      from unnest(array['L', 'M']) a, (values (1, 's6-one'), (null::int, 's6-null')) c(hc, nt);
  na := pg_temp.old_scrub('user:' || p || 'L');
  nb := public._scrub_backups_to_live_items('user:' || p || 'M');
  select count(*) filter (where x.history_count = 0 and y.history_count = 0 and x.history_snapshot = '[]' and y.history_snapshot = '[]'), count(*)
    into n, m
    from public.data_backups x join public.data_backups y on y.username = 'user:' || p || 'M' and y.note = x.note
   where x.username = 'user:' || p || 'L';
  r := r || format('%s S6 catalog unchanged (SECURITY DEFINER, search_path, owner, grants: %s); counts floored at 0 like the loop (%s of %s; changed %s, loop %s)',
                   case when ok and n = 2 and m = 2 and na = 2 and nb = 2 then 'PASS' else 'FAIL' end, ok, n, m, nb, na);
  raise exception 'RESULT: % PASS, % FAIL :: %', (select count(*) from unnest(r) q where q like 'PASS%'),
    (select count(*) from unnest(r) q where q like 'FAIL%'), array_to_string(r, ' | ');
end $t$;
