-- Tests for supabase/migrations/20261025820000_backups_hold_account_row.sql: the 2-day backup and snapshots hold their
-- account row and write under the scope it has then, so a rename never leaves a backup under the old name. One
-- transaction cannot interleave two sessions (a lock never blocks its own transaction), so this checks:
--   1. the bodies' statements, read with comments and string literals (also E'') removed and whitespace collapsed, as
--      contiguous sequences (a copy in a dead branch or a string cannot pass; a body holding any $ fails): the run's
--      locked read of the account row (scope plus the switch / disabled / deleted re-check) right before its INSERT,
--      and no other assignment of the scope it writes; the snapshot's skip check -> lock -> session check -> scope
--      compare -> its first read; rename_my_account's own lock before its first data write (no opposite-order wait);
--   2. a rename staged inside a 2-day run, from a trigger on an earlier account's backup: the backup lands under the new
--      name (20261025800000's body wrote the scope its loop query had read);
--   3. an account switched off, one deleted and one disabled, staged the same way: none is backed up (the re-check
--      under the lock);
--   4. a rename that commits first, then a snapshot with the session it revoked: refused, no backup under either name;
--   5. a snapshot first, then a rename: the backup moves with the account.
-- 2 and 3 fail on 20261025800000's body; 4 and 5 are regression checks. Run with 20261025800000 present: before 820000
-- is applied, node scripts/tools/sql-tx.mjs <820000> --test <this file> (prepend 800000 too while it is not applied);
-- afterwards this file alone. Fixtures: accounts '__lk_<txid>*' with cost-4 passwords, tasks 'lk-*'; tokens are minted
-- here and never printed. Everything rolls back.
do $t$
declare
  r text[] := '{}'; p text := '__lk_' || txid_current(); pw constant text := 'lk-pass-0001';
  w_id uuid := gen_random_uuid(); x_id uuid := gen_random_uuid(); y_id uuid := gen_random_uuid(); z_id uuid := gen_random_uuid();
  rw_id uuid := gen_random_uuid(); rx_id uuid := gen_random_uuid(); ry_id uuid := gen_random_uuid(); rz_id uuid := gen_random_uuid();
  w text; x text; y text; z text; rw text; rx text; ry text; rz text; xt text; yt text; zt text; nz int;
  j json; j2 json; n int; m int; k int; src text; a int; b int; c int; d int; e int; ans text;
begin
  w := 'user:' || p || 'w'; x := 'user:' || p || 'x'; y := 'user:' || p || 'y'; z := 'user:' || p || 'z';
  rw := 'user:' || p || 'rw'; rx := 'user:' || p || 'rx'; ry := 'user:' || p || 'ry'; rz := 'user:' || p || 'rz';
  insert into proxima_auth.users (id, username, role, scope, password_hash) values
    (w_id, p || 'w', 'member', w, extensions.crypt(pw, extensions.gen_salt('bf', 4))),
    (x_id, p || 'x', 'member', x, extensions.crypt(pw, extensions.gen_salt('bf', 4))),
    (y_id, p || 'y', 'member', y, extensions.crypt(pw, extensions.gen_salt('bf', 4))),
    (z_id, p || 'z', 'member', z, extensions.crypt(pw, extensions.gen_salt('bf', 4))),
    (rw_id, p || 'rw', 'member', rw, null), (rx_id, p || 'rx', 'member', rx, null), (ry_id, p || 'ry', 'member', ry, null),
    (rz_id, p || 'rz', 'member', rz, null);
  update proxima_auth.users set auto_backups = true where id in (w_id, x_id);   -- 800000's own switch (RW, RX, RY: case 3)
  xt := proxima_auth.mint_token(x_id); yt := proxima_auth.mint_token(y_id); zt := proxima_auth.mint_token(z_id);
  insert into public.tasks (id, device_id, status, start_time, outputs) values
    ('lk-w-' || p, w, 'completed', 1, '[]'), ('lk-x-' || p, x, 'completed', 1, '[]'),
    ('lk-y-' || p, y, 'completed', 1, '[]'), ('lk-z-' || p, z, 'completed', 1, '[]'),
    ('lk-rw-' || p, rw, 'completed', 1, '[]'), ('lk-rx-' || p, rx, 'completed', 1, '[]'), ('lk-ry-' || p, ry, 'completed', 1, '[]'),
    ('lk-rz-' || p, rz, 'completed', 1, '[]');
  -- X also holds a History entry, a setting and a favorite, so case 2 can tell every column of its backup from the old
  -- name's (review round 16).
  insert into public.history (id, device_id, timestamp, tasks) values ('lk-xh-' || p, x, 1, '[]');
  insert into public.settings (device_id, key, value) values (x, 'lk-key', '1'::jsonb);
  insert into public.favorites (id, device_id, prompt) values ('lk-xf-' || p, x, 'x');
  -- W (backed up in the same run) holds the same kinds of rows, and X a form draft no backup keeps, so case 2 can
  -- tell that X's backup holds exactly X's rows (review round 17).
  insert into public.history (id, device_id, timestamp, tasks) values ('lk-wh-' || p, w, 1, '[]');
  insert into public.settings (device_id, key, value) values (w, 'lk-wkey', '1'::jsonb), (x, 'form-inputs:lk', '1'::jsonb);
  insert into public.favorites (id, device_id, prompt) values ('lk-wf-' || p, w, 'w');

  -- 1. The bodies' statements (what a second session would wait on). Comments go first (they hold apostrophes), then
  --    E'' and '' strings, then runs of whitespace; each check is one contiguous sequence of statements.
  execute $n$create function pg_temp.lk_norm(t text) returns text language sql immutable as $b$
    select regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(lower(t),
             '--[^\n]*', ' ', 'g'), '/\*.*?\*/', ' ', 'g'), '\me''(?:[^''\\]|\\.|'''')*''', '''''', 'g'),
             '''(?:[^'']|'''')*''', '''''', 'g'), '\s+', ' ', 'g')
  $b$$n$;
  src := pg_temp.lk_norm((select prosrc from pg_proc where oid = 'public.create_auto_backup()'::regprocedure));
  a := position('loop begin select u.scope into v_scope from proxima_auth.users u where u.id = rec.id and u.auto_backups and u.disabled_at is null and u.deleted_at is null for key share; if v_scope is not null then insert into public.data_backups' in src);
  c := (select count(*) from regexp_matches(src, 'into\s+(strict\s+)?"?v_scope"?', 'g'));
  nz := (select count(*) from regexp_matches(src, 'v_scope"?\s*:?=', 'g'));
  -- The loop row carries the account id only: every column is read through v_scope (review round 16).
  e := (select count(*) from regexp_matches(regexp_replace(src, '\mrec\.id\M', '', 'g'), '\mrec\.', 'g'));
  r := r || format('%s order: the 2-day backup reads the scope it writes from the account row under FOR KEY SHARE (switch, disabled, deleted re-checked) right before its INSERT, assigns it nowhere else, and reads no loop field but the id (%s reads, %s assignments, %s other loop fields)',
                   case when a > 0 and c = 1 and nz = 0 and e = 0 and position('$' in src) = 0 then 'PASS' else 'FAIL' end, c, nz, e);
  src := pg_temp.lk_norm((select prosrc from pg_proc where oid = 'public.snapshot_my_data_phase2(text,text,text)'::regprocedure));
  a := position('not public._auto_backups_on(v_username) then return json_build_object('''', true, '''', true); end if; ' ||
                'perform 1 from proxima_auth.users u where u.scope = v_username for key share; ' ||
                'perform public._verify_session_token(p_session_token); ' ||
                'if (proxima_auth.current_account(p_session_token)).scope is distinct from v_username then raise exception ''''; end if; ' ||
                'select coalesce(jsonb_agg(row_to_json(t)), ''''::jsonb) into v_tasks' in src);
  b := position('insert into data_backups' in src);
  r := r || format('%s order: a snapshot checks its pre-* switch, then holds the account row, checks its token, compares its scope, then reads (one sequence), and INSERTs after',
                   case when a > 0 and a < b and position('$' in src) = 0 then 'PASS' else 'FAIL' end);
  src := pg_temp.lk_norm((select prosrc from pg_proc where oid = 'public.rename_my_account(text,text,text)'::regprocedure));
  a := position('from proxima_auth.users u where u.id = v_acc.id for update' in src); b := position('update tasks set device_id' in src);
  r := r || format('%s order: rename_my_account holds the account row before it moves any data row (no opposite-order wait)',
                   case when a > 0 and a < b then 'PASS' else 'FAIL' end);

  -- 2. A rename that commits during a 2-day run, after the run's account query: staged from a trigger on W's backup
  --    (W sorts before X). The run must write X's backup under X's new name, never the old one, and fill it from X's
  --    rows as they are after the rename (they moved with it), never from the old name's (review round 15).
  begin
    perform set_config('request.headers', json_build_object('x-forwarded-for', '192.0.2.81', 'cf-connecting-ip', '192.0.2.81',
                                                            'x-proxima-session', xt)::text, true);
    execute format($f$create function public.%I() returns trigger language plpgsql as $b$
      begin
        if new.username = %L and new.backup_type = 'auto-2day' and coalesce(current_setting('lk.renamed', true), '') = '' then
          perform set_config('lk.renamed', coalesce(public.rename_my_account(%L, %L, %L)->>'ok', 'null'), true);
        end if;
        return new;
      end $b$$f$, p || '_rn', w, xt, pw, p || 'x2');
    execute format('create trigger %I before insert on public.data_backups for each row execute function public.%I()', p || '_rn', p || '_rn');
    perform public.create_auto_backup();
    execute format('drop trigger %I on public.data_backups', p || '_rn');
    select count(*) filter (where bs.username = x), count(*) filter (where bs.username = 'user:' || p || 'x2'),
           count(*) filter (where bs.username = 'user:' || p || 'x2' and bs.exact)
      into n, m, k
      from (select bk.username,
                   bk.task_count = 1 and bk.history_count = 1
                   and (select array_agg(el->>'id' order by el->>'id') from jsonb_array_elements(bk.tasks_snapshot) el) = array['lk-x-' || p]
                   and (select array_agg(el->>'id' order by el->>'id') from jsonb_array_elements(bk.history_snapshot) el) = array['lk-xh-' || p]
                   and (select array_agg(el->>'id' order by el->>'id') from jsonb_array_elements(bk.favorites_snapshot) el) = array['lk-xf-' || p]
                   and (select array_agg(ky order by ky) from jsonb_object_keys(bk.settings_snapshot) ky where ky <> 'last_restore_at') = array['lk-key']
                     as exact
              from public.data_backups bk
             where bk.username in (x, 'user:' || p || 'x2') and bk.backup_type = 'auto-2day') bs;
    r := r || format('%s 2-day run: X renamed while W was being backed up (rename ok %s); X''s backup lands under the new name and holds exactly X''s rows (old %s, new %s, exact %s)',
                     case when current_setting('lk.renamed', true) = 'true' and n = 0 and m = 1 and k = 1 then 'PASS' else 'FAIL' end,
                     current_setting('lk.renamed', true), n, m, k);
  exception when others then r := r || format('FAIL 2-day run (rename): %s %s', sqlstate, sqlerrm); end;

  -- 3. An account switched off, one deleted and one disabled during a 2-day run, after its account query, staged from a
  --    trigger on RW's backup (RW < RX < RY < RZ): the run backs up RW only (all three are re-checked under the lock).
  --    Their switches go on only now, so case 2's run did not back them up already.
  begin
    update proxima_auth.users set auto_backups = true where id in (rw_id, rx_id, ry_id, rz_id);
    execute format($f$create function public.%I() returns trigger language plpgsql as $b$
      begin
        if new.username = %L and new.backup_type = 'auto-2day' then
          update proxima_auth.users set auto_backups = false where id = %L;
          update proxima_auth.users set deleted_at = now() where id = %L;
          update proxima_auth.users set disabled_at = now() where id = %L;
        end if;
        return new;
      end $b$$f$, p || '_off', rw, rx_id, ry_id, rz_id);
    execute format('create trigger %I before insert on public.data_backups for each row execute function public.%I()', p || '_off', p || '_off');
    perform public.create_auto_backup();
    execute format('drop trigger %I on public.data_backups', p || '_off');
    select count(*) filter (where username = rw), count(*) filter (where username = rx), count(*) filter (where username = ry),
           count(*) filter (where username = rz)
      into n, m, k, nz from public.data_backups where username in (rw, rx, ry, rz) and backup_type = 'auto-2day';
    r := r || format('%s 2-day run: accounts switched off, deleted or disabled while an earlier one was backed up get no backup (RW %s, RX off %s, RY deleted %s, RZ disabled %s)',
                     case when n = 1 and m = 0 and k = 0 and nz = 0 then 'PASS' else 'FAIL' end, n, m, k, nz);
  exception when others then r := r || format('FAIL 2-day run (switch off, delete): %s %s', sqlstate, sqlerrm); end;

  -- 4. A rename that commits first, then a snapshot with the session it revoked: refused, and no backup under either name.
  begin
    execute 'set local role anon';
    perform set_config('request.headers', json_build_object('x-forwarded-for', '192.0.2.82', 'cf-connecting-ip', '192.0.2.82',
                                                            'x-proxima-session', yt)::text, true);
    j := public.rename_my_account(yt, pw, p || 'y2');
    execute 'reset role';
    begin
      execute 'set local role anon';
      j2 := public.snapshot_my_data_phase2(yt, 'manual', null);
      execute 'reset role';
      ans := 'taken';
    exception when others then execute 'reset role'; ans := sqlstate;
    end;
    select count(*) into n from public.data_backups where username in (y, 'user:' || p || 'y2');
    r := r || format('%s rename then snapshot: the rename lands (%s), the old session''s snapshot is refused (%s), no backup under either name (%s)',
                     case when (j->>'ok')::boolean and ans <> 'taken' and n = 0 then 'PASS' else 'FAIL' end, j->>'ok', ans, n);
  exception when others then execute 'reset role'; r := r || format('FAIL rename then snapshot: %s %s', sqlstate, sqlerrm); end;

  -- 5. A snapshot first, then a rename: the backup moves with the account (the rename runs once the snapshot commits).
  begin
    execute 'set local role anon';
    perform set_config('request.headers', json_build_object('x-forwarded-for', '192.0.2.83', 'cf-connecting-ip', '192.0.2.83',
                                                            'x-proxima-session', zt)::text, true);
    j := public.snapshot_my_data_phase2(zt, 'manual', null);
    j2 := public.rename_my_account(zt, pw, p || 'z2');
    execute 'reset role';
    select count(*) filter (where username = z), count(*) filter (where username = 'user:' || p || 'z2') into n, m
      from public.data_backups where username in (z, 'user:' || p || 'z2');
    r := r || format('%s snapshot then rename: the backup moves with the account (snapshot %s, rename %s; old %s, new %s)',
                     case when (j->>'ok')::boolean and (j2->>'ok')::boolean and n = 0 and m = 1 then 'PASS' else 'FAIL' end,
                     j->>'ok', j2->>'ok', n, m);
  exception when others then execute 'reset role'; r := r || format('FAIL snapshot then rename: %s %s', sqlstate, sqlerrm); end;

  raise exception 'RESULT: % PASS, % FAIL :: %', (select count(*) from unnest(r) q where q like 'PASS%'),
    (select count(*) from unnest(r) q where q like 'FAIL%'), array_to_string(r, ' | ');
end $t$;
