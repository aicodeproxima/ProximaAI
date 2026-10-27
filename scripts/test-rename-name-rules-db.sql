-- 20261026200000: rename_my_account's name rules, called as the browser calls it (anon, a minted token, a client IP);
-- rolled back by sql-tx. Each call that could change something runs in a block undone right after it is measured.
--   N1 every name join_with_invite refuses is refused (invalid_username), and each allowed name is allowed: the same
--      verdict as join for every name (letters, digits, '_' and '-', 2 to 64, after trimming spaces)
--   N2 a name taken in each way join's check (proxima_auth._username_taken) knows is taken for a rename too, and a free
--      one is free for both
--   N3 a unique violation from something the checks cannot see (injected: a trigger raising 23505 for one name) answers
--      username_taken, counts against the rename limit and moves nothing
--   N4 a rename holds its new name's sign-in key (the one join_with_invite takes), taken before its account row
--   N5 an account with queued backup scrubs and no backup takes them along to its new name
--   N6 any other error in that update (injected: 55P03) fails the call and is not counted (only 23505 is a taken name)
--   live, before the migration: N1 FAILS (the old rule allowed 'bob!', 'bób', ...), N3 FAILS (an error), N4 and N5 FAIL;
--   N2 and N6 guard what already held
--   node scripts/tools/sql-tx.mjs supabase/migrations/20261026200000_mu_p4_backup_scrubs_per_account.sql --test <this file>
do $t$
declare
  r text[] := '{}'; p constant text := '__rn' || txid_current();
  pw constant text := 'rename-rules-pass-1';
  hdr text; x_id uuid; x_tok text; x_name constant text := p || 'x'; z_id uuid; z_name constant text := p || 'z';
  y_id uuid; y_tok text; y_name constant text := p || 'y';
  j json; jj json; v text; n int; m int; k bigint; ok boolean; ri boolean; ji boolean; src text;
  refused text[] := array['bob!', 'bo b', 'b', repeat('a', 65), 'bób', 'a.b', 'a/b', 'a:b', '   ', 'b#c',
                          'tab' || chr(9) || 'x', 'zw' || chr(8203) || 'j', 'Ⅻx', 'mañana', 'a' || chr(65039)];
  allowed text[] := array[p || 'Ok_1', p || '-Two', '  ' || p || 'Pad  ', repeat('Q', 64 - length(p)) || p];
  bad text[] := '{}';
begin
  insert into proxima_auth.users (username, role, scope, password_hash)
    values (x_name, 'member', 'user:' || x_name, extensions.crypt(pw, extensions.gen_salt('bf', 4))) returning id into x_id;
  insert into proxima_auth.users (username, role, scope, password_hash)
    values (z_name, 'member', 'user:' || z_name, extensions.crypt(pw, extensions.gen_salt('bf', 4))) returning id into z_id;
  x_tok := proxima_auth.mint_token(x_id);
  hdr := json_build_object('x-proxima-session', x_tok, 'cf-connecting-ip', '198.51.100.41')::text;
  update proxima_auth.auth_config set members_open = true;   -- join_with_invite judges names only while members may join

  -- N1. The same verdict as join_with_invite for every name; rename's refusal changes nothing.
  foreach v in array refused || allowed loop
    begin
      execute 'set local role anon'; perform set_config('request.headers', hdr, true);
      j := public.rename_my_account(x_tok, pw, v);
      raise exception using message = 'undo';
    exception when others then
      if sqlerrm <> 'undo' then j := json_build_object('ok', false, 'reason', 'error ' || sqlstate); end if;
    end;
    begin
      execute 'set local role anon'; perform set_config('request.headers', hdr, true);
      jj := public.join_with_invite('AAAA-BBBB-CCCC-DDDD', v, 'joiner-pass-0001');
      raise exception using message = 'undo';
    exception when others then
      if sqlerrm <> 'undo' then jj := json_build_object('ok', false, 'reason', 'error ' || sqlstate); end if;
    end;
    ri := coalesce(j->>'reason', '') = 'invalid_username'; ji := coalesce(jj->>'reason', '') = 'invalid_username';
    if ri <> ji or ri <> (v = any (refused)) then
      bad := bad || format('%s: rename %s, join %s', to_json(v)::text, coalesce(j->>'reason', 'ok'), coalesce(jj->>'reason', 'ok'));
    end if;
  end loop;
  r := r || format('%s N1 rename allows exactly the names join_with_invite allows (%s names; differing: %s)',
                   case when cardinality(bad) = 0 then 'PASS' else 'FAIL' end, cardinality(refused) + cardinality(allowed),
                   coalesce(nullif(array_to_string(bad, '; '), ''), 'none'));

  -- N2. Taken the ways join's check knows: another account's name, its other case, a folder it holds (an old name),
  -- rows of a scope with no account. Free: a fresh name.
  insert into proxima_auth.account_folders (folder, account_id) values (proxima_auth.scope_folder('user:' || p || 'old'), z_id);
  insert into public.tasks (id, device_id) values (p || '_stale_task', 'user:' || p || 'stale');
  bad := '{}';
  foreach v in array array[z_name, upper(z_name), p || 'old', p || 'stale', p || 'free'] loop
    begin
      execute 'set local role anon'; perform set_config('request.headers', hdr, true);
      j := public.rename_my_account(x_tok, pw, v);
      raise exception using message = 'undo';
    exception when others then
      if sqlerrm <> 'undo' then j := json_build_object('ok', false, 'reason', 'error ' || sqlstate); end if;
    end;
    ok := proxima_auth._username_taken(v); ri := coalesce(j->>'reason', '') = 'username_taken';
    if ri <> ok or ok <> (v <> p || 'free') or (not ok and coalesce((j->>'ok')::boolean, false) is not true) then
      bad := bad || format('%s: rename %s, taken for join %s', v, coalesce(j->>'reason', 'ok'), ok);
    end if;
  end loop;
  src := pg_get_functiondef('public.join_with_invite(text,text,text)'::regprocedure);
  r := r || format('%s N2 a name is taken for a rename exactly when join''s check finds it taken (5 ways; join calls it: %s; differing: %s)',
                   case when cardinality(bad) = 0 and src ~ 'proxima_auth\._username_taken\(v_name\)' then 'PASS' else 'FAIL' end,
                   src ~ 'proxima_auth\._username_taken\(v_name\)', coalesce(nullif(array_to_string(bad, '; '), ''), 'none'));

  -- N3. A unique violation the checks cannot see (a trigger raising 23505 for one free name, made here, rolled back).
  insert into public.tasks (id, device_id) values (p || '_x_task', 'user:' || x_name);
  begin
    execute format($f$create function public.%I() returns trigger language plpgsql as $b$
                     begin raise exception using errcode = '23505', message = 'injected: that name is not available'; end $b$$f$,
                   p || '_collide');
    execute format('create trigger %I before update of username on proxima_auth.users for each row when (new.username = %L) execute function public.%I()',
                   p || '_collide', p || 'Collide', p || '_collide');
    execute 'set local role anon'; perform set_config('request.headers', hdr, true);
    j := public.rename_my_account(x_tok, pw, p || 'Collide');
  exception when others then j := json_build_object('ok', false, 'reason', 'error ' || sqlstate || ' ' || left(sqlerrm, 60));
  end;
  execute 'reset role';
  select u.rename_taken_count, (select count(*) from public.tasks t where t.id = p || '_x_task' and t.device_id = 'user:' || x_name)
    into n, m from proxima_auth.users u where u.id = x_id and u.username = x_name;
  r := r || format('%s N3 a unique violation the checks miss answers username_taken (%s), counts once (%s) and moves nothing (%s of 1 row stayed)',
                   case when j->>'reason' = 'username_taken' and n = 1 and m = 1 then 'PASS' else 'FAIL' end,
                   coalesce(j->>'reason', 'ok'), n, m);

  -- N4. The new name's sign-in key is held after a rename (and taken before the account row).
  k := hashtextextended('proxima-signin:' || lower(p || 'Keyed'), 0);
  begin
    execute 'set local role anon'; perform set_config('request.headers', hdr, true);
    j := public.rename_my_account(x_tok, pw, p || 'Keyed');
    execute 'reset role';
    ok := exists (select 1 from pg_locks l where l.locktype = 'advisory' and l.pid = pg_backend_pid() and l.objsubid = 1 and l.granted
                    and l.classid::bigint = (k >> 32) & 4294967295 and l.objid::bigint = k & 4294967295);
    raise exception using message = 'undo';
  exception when others then
    if sqlerrm <> 'undo' then j := json_build_object('ok', false, 'reason', 'error ' || sqlstate); ok := false; end if;
  end;
  src := pg_get_functiondef('public.rename_my_account(text,text,text)'::regprocedure);
  r := r || format('%s N4 a rename holds the new name''s sign-in key (renamed: %s, key held: %s), taken before its account row (%s)',
                   case when (j->>'ok')::boolean and ok
                             and position('pg_advisory_xact_lock(hashtextextended(''proxima-signin:'' || lower(v_new), 0))' in src) between 1 and
                                 position('from proxima_auth.users u where u.id = v_acc.id for update' in src) then 'PASS' else 'FAIL' end,
                   coalesce(j->>'ok', j->>'reason'), ok,
                   case when position('pg_advisory_xact_lock(hashtextextended(''proxima-signin:'' || lower(v_new), 0))' in src) = 0 then 'no key'
                        else 'key at ' || position('pg_advisory_xact_lock(hashtextextended(''proxima-signin:'' || lower(v_new), 0))' in src)
                             || ', row at ' || position('from proxima_auth.users u where u.id = v_acc.id for update' in src) end);

  -- N5. Queued scrubs move with an account that has no backup.
  insert into proxima_auth.users (username, role, scope, password_hash)
    values (y_name, 'member', 'user:' || y_name, extensions.crypt(pw, extensions.gen_salt('bf', 4))) returning id into y_id;
  y_tok := proxima_auth.mint_token(y_id);
  insert into public.backup_scrub_queue (username, task_ids) values ('user:' || y_name, array[p || '_gone']);
  begin
    execute 'set local role anon';
    perform set_config('request.headers', json_build_object('x-proxima-session', y_tok, 'cf-connecting-ip', '198.51.100.42')::text, true);
    j := public.rename_my_account(y_tok, pw, p || 'Moved');
  exception when others then j := json_build_object('ok', false, 'reason', 'error ' || sqlstate);
  end;
  execute 'reset role';
  select count(*) filter (where q.username = 'user:' || p || 'Moved'), count(*) filter (where q.username = 'user:' || y_name)
    into n, m from public.backup_scrub_queue q where q.task_ids = array[p || '_gone'];
  r := r || format('%s N5 an account with queued scrubs and no backup takes them along (renamed: %s; under the new name %s, the old %s)',
                   case when (j->>'ok')::boolean and n = 1 and m = 0 then 'PASS' else 'FAIL' end, coalesce(j->>'ok', j->>'reason'), n, m);

  -- N6. Only a unique violation is read as a taken name: any other error in the account row's update (injected: a
  -- trigger raising 55P03 for one name, undone with its block) fails the call and is not counted (review round 24 c2).
  select u.rename_taken_count into m from proxima_auth.users u where u.id = x_id;
  begin
    execute format($f$create function public.%I() returns trigger language plpgsql as $b$
                     begin raise exception using errcode = '55P03', message = 'injected: a lock wait ran out'; end $b$$f$,
                   p || '_err');
    execute format('create trigger %I before update of username on proxima_auth.users for each row when (new.username = %L) execute function public.%I()',
                   p || '_err', p || 'Err', p || '_err');
    execute 'set local role anon'; perform set_config('request.headers', hdr, true);
    j := public.rename_my_account(x_tok, pw, p || 'Err');
  exception when others then j := json_build_object('ok', false, 'reason', 'error ' || sqlstate);
  end;
  execute 'reset role';
  select u.rename_taken_count into n from proxima_auth.users u where u.id = x_id and u.username = x_name;
  r := r || format('%s N6 another error in the account update fails the call (%s) and counts nothing (%s more)',
                   case when j->>'reason' = 'error 55P03' and n = m then 'PASS' else 'FAIL' end, coalesce(j->>'reason', 'ok'), n - m);

  raise exception 'RESULT: % PASS, % FAIL :: %', (select count(*) from unnest(r) q where q like 'PASS%'),
    (select count(*) from unnest(r) q where q like 'FAIL%'), array_to_string(r, ' | ');
end $t$;
