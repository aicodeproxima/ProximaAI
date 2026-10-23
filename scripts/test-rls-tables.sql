-- Tests for supabase/migrations/20261022120000_rls_session_header.sql on tasks, history, settings, favorites, presets and
-- sync_tombstones, as the roles the browser really uses. Everything rolls back (the block ends in an exception whose
-- message is the result line). Needs phase 0 (20261022100000) applied; before phase 2 is applied, send the phase-2
-- migration + this file as ONE query (one Management API call = one transaction); after, this file alone.
-- Tokens are minted inside the block and never printed. Fixture ids start '__rls_probe_'.
do $pt$
declare
  u text;   -- the owner's name, set first thing below
  s text; p text := '__rls_probe_' || txid_current(); q text;
  t_good text; t_forged text; t_exp text; t_other text; t_nonadmin text;
  bad text[]; bad_lbl text[] := array['forged','expired','other-subject','non-admin','garbage'];
  bad_msg text[] := array['invalid signature','session token expired','session token revoked','not admin-scoped','malformed session token'];
  tbls text[] := array['tasks','history','settings','favorites','presets'];
  kcol text[] := array['id','id','key','id','model_id'];
  conf text[] := array['id','id','device_id, key','id','device_id, model_id'];
  total int[] := '{}'; tomb0 int; r text[] := '{}';
  n int; i int; j int; k int; stmt text; verb text; tok text;
begin
  -- The owner: proxima_auth.users from P1's M1 on, app_secrets before it (this suite runs in both states).
  if to_regclass('proxima_auth.users') is not null then
    execute 'select username from proxima_auth.users where role = ''owner''' into u;
  else
    u := (select value->>'username' from public.app_secrets where key = 'admin_username');
  end if;
  s := 'user:' || u;
  t_good     := public._sign_session_token('admin:' || u, now() + interval '12 hours');
  t_forged   := left(t_good, -1) || case right(t_good, 1) when '0' then '1' else '0' end;
  t_exp      := public._sign_session_token('admin:' || u, now() - interval '1 minute');
  t_other    := public._sign_session_token('admin:__rls_not_admin', now() + interval '12 hours');
  t_nonadmin := public._sign_session_token('svc:__rls', now() + interval '12 hours');
  bad := array[t_forged, t_exp, t_other, t_nonadmin, 'garbage'];
  for i in 1..5 loop                                   -- as postgres: one live-scope seed per table, then the expected count
    q := p || '_' || tbls[i];
    execute format('insert into public.%I (%I, device_id) values (%L, %L)', tbls[i], kcol[i], q || '_seed', s);
    -- and one row in another scope: from 20261023050000 a session never sees or touches it
    execute format('insert into public.%I (%I, device_id) values (%L, %L)', tbls[i], kcol[i], q || '_other', 'user:__rls_other_scope');
    execute format('select count(*) from public.%I where device_id = %L', tbls[i], s) into n;   -- the session's own rows
    total := total || n;
  end loop;
  select count(*) into tomb0 from public.sync_tombstones where device_id = s;
  insert into public.sync_tombstones (id, kind, device_id) values (p || '_tomb_other', 'task', 'user:__rls_other_scope');

  execute 'set local role anon';
  for i in 1..5 loop
    q := p || '_' || tbls[i];
    -- A. MUST DENY without a header (or with unparsable request.headers): reads and writes raise 28000, and a plain
    --    DELETE is refused by privilege (42501, migration 20261022350000). An UPDATE that matches NO row may raise or
    --    report 0 rows (nothing to change either way); both are accepted.
    foreach tok in array array['{}', 'not json'] loop
      perform set_config('request.headers', tok, true);
      begin
        execute format('select count(*) from public.%I', tbls[i]) into n;
        r := r || format('FAIL %s no-header(%s) select allowed (%s rows)', tbls[i], tok, n);
      exception
        when sqlstate '28000' then r := r || format('%s %s no-header(%s) select: %s',
               case when sqlerrm = 'session token missing' then 'PASS' else 'FAIL' end, tbls[i], tok, sqlerrm);
        when others then r := r || format('FAIL %s no-header(%s) select raised %s %s', tbls[i], tok, sqlstate, sqlerrm);
      end;
      foreach stmt in array array[
          format('insert into public.%I (%I, device_id) values (%L, %L)', tbls[i], kcol[i], q || '_x', s),
          format('update public.%I set device_id = device_id where %I = %L', tbls[i], kcol[i], q || '_seed'),
          format('delete from public.%I where %I = %L', tbls[i], kcol[i], q || '_seed'),
          format('delete from public.%I where %I = %L', tbls[i], kcol[i], q || '_no_such_row'),
          format('update public.%I set device_id = device_id where %I = %L', tbls[i], kcol[i], q || '_no_such_row')] loop
        verb := split_part(stmt, ' ', 1) || case when stmt like '%_no_such_row%' then '(no match)' else '' end;
        begin
          execute stmt;
          get diagnostics n = row_count;
          r := r || format('%s %s no-header(%s) %s allowed rows=%s',
                 case when verb = 'update(no match)' and n = 0 then 'PASS' else 'FAIL' end, tbls[i], tok, verb, n);
        exception
          when sqlstate '28000' then r := r || format('%s %s no-header(%s) %s: %s',
                 case when sqlerrm = 'session token missing' and verb not like 'delete%' then 'PASS' else 'FAIL' end, tbls[i], tok, verb, sqlerrm);
          when sqlstate '42501' then r := r || format('%s %s no-header(%s) %s: %s',
                 case when verb like 'delete%' and sqlerrm like 'permission denied for table%' then 'PASS' else 'FAIL' end, tbls[i], tok, verb, sqlerrm);
          when others then r := r || format('FAIL %s no-header(%s) %s: %s %s', tbls[i], tok, verb, sqlstate, sqlerrm);
        end;
      end loop;
    end loop;
    -- B. MUST DENY: forged / expired / other subject / non-admin / garbage -> read and write raise 28000 with the right message;
    --    a plain DELETE is refused by privilege (42501) before the token is even looked at
    for j in 1..5 loop
      perform set_config('request.headers', json_build_object('x-proxima-session', bad[j])::text, true);
      foreach stmt in array array[
          format('select count(*) from public.%I', tbls[i]),
          format('insert into public.%I (%I, device_id) values (%L, %L)', tbls[i], kcol[i], q || '_x', s),
          format('delete from public.%I where %I = %L', tbls[i], kcol[i], q || '_seed')] loop
        verb := split_part(stmt, ' ', 1);
        begin
          execute stmt;
          r := r || format('FAIL %s %s %s allowed', tbls[i], bad_lbl[j], verb);
        exception
          when sqlstate '28000' then r := r || format('%s %s %s %s: %s',
                 case when (sqlerrm = bad_msg[j] or (bad_lbl[j] = 'non-admin' and sqlerrm = 'malformed session token')) and verb <> 'delete' then 'PASS' else 'FAIL' end, tbls[i], bad_lbl[j], verb, sqlerrm);
          when sqlstate '42501' then r := r || format('%s %s %s %s: %s',
                 case when verb = 'delete' and sqlerrm like 'permission denied for table%' then 'PASS' else 'FAIL' end, tbls[i], bad_lbl[j], verb, sqlerrm);
          when others then r := r || format('FAIL %s %s %s: %s %s', tbls[i], bad_lbl[j], verb, sqlstate, sqlerrm);
        end;
      end loop;
    end loop;
    -- C. MUST ALLOW with a valid token: full read, insert, upsert over an existing row, update. A plain DELETE stays
    --    refused (42501) even with a valid session: deletes go through the restore-checked RPCs (delete_queued_rows ...).
    perform set_config('request.headers', json_build_object('x-proxima-session', t_good)::text, true);
    begin
      execute format('select count(*) from public.%I', tbls[i]) into n;
      r := r || format('%s %s valid select=%s expected=%s', case when n = total[i] then 'PASS' else 'FAIL' end, tbls[i], n, total[i]);
      execute format('select count(*) from public.%I where %I = %L', tbls[i], kcol[i], q || '_other') into n;
      r := r || format('%s %s another scope''s row invisible (%s)', case when n = 0 then 'PASS' else 'FAIL' end, tbls[i], n);
      execute format('update public.%I set device_id = device_id where %I = %L', tbls[i], kcol[i], q || '_other');
      get diagnostics n = row_count;
      r := r || format('%s %s another scope''s row not updatable (%s rows)', case when n = 0 then 'PASS' else 'FAIL' end, tbls[i], n);
      for k in 1..2 loop                               -- pass 1 inserts, pass 2 takes ON CONFLICT DO UPDATE (PostgREST upsert shape)
        execute format('insert into public.%I (%I, device_id) values (%L, %L) on conflict (%s) do update set device_id = excluded.device_id',
                       tbls[i], kcol[i], q || '_v', s, conf[i]);
        get diagnostics n = row_count;
        r := r || format('%s %s valid upsert#%s rows=%s', case when n = 1 then 'PASS' else 'FAIL' end, tbls[i], k, n);
      end loop;
      execute format('update public.%I set device_id = device_id where %I = %L', tbls[i], kcol[i], q || '_v');
      get diagnostics n = row_count;
      r := r || format('%s %s valid update rows=%s', case when n = 1 then 'PASS' else 'FAIL' end, tbls[i], n);
      begin
        execute format('delete from public.%I where %I in (%L, %L)', tbls[i], kcol[i], q || '_v', q || '_seed');
        r := r || format('FAIL %s plain delete allowed with a valid session', tbls[i]);
      exception when sqlstate '42501' then r := r || format('%s %s plain delete refused even with a valid session',
                  case when sqlerrm like 'permission denied for table%' then 'PASS' else 'FAIL' end, tbls[i]);
      end;
    exception when others then r := r || format('FAIL %s valid path raised %s %s', tbls[i], sqlstate, sqlerrm);
    end;
    -- D. MUST DENY: a valid token writing into another scope
    begin
      execute format('insert into public.%I (%I, device_id) values (%L, %L)', tbls[i], kcol[i], q || '_o', 'user:__rls_other');
      r := r || format('FAIL %s insert into another scope allowed', tbls[i]);
    exception
      when sqlstate '42501' then r := r || format('PASS %s insert into another scope refused', tbls[i]);
      when others then r := r || format('FAIL %s other-scope insert: %s %s', tbls[i], sqlstate, sqlerrm);
    end;
  end loop;

  -- Deletes run server-side now (owner role, as delete_queued_rows does): make the 4 tombstones section E counts.
  execute 'reset role';
  delete from public.tasks where id in (p || '_tasks_v', p || '_tasks_seed');
  delete from public.history where id in (p || '_history_v', p || '_history_seed');
  execute 'set local role anon';

  -- E. sync_tombstones: read with a session only; never writable by browser roles
  perform set_config('request.headers', '{}', true);
  begin
    select count(*) into n from public.sync_tombstones;
    r := r || format('FAIL tombstones no-header select allowed (%s rows)', n);
  exception when sqlstate '28000' then r := r || format('%s tombstones no-header select: %s',
                case when sqlerrm = 'session token missing' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  perform set_config('request.headers', json_build_object('x-proxima-session', t_good)::text, true);
  select count(*) into n from public.sync_tombstones;               -- +4: the tasks and history _v and _seed deletes above
  r := r || format('%s tombstones valid select=%s expected=%s', case when n = tomb0 + 4 then 'PASS' else 'FAIL' end, n, tomb0 + 4);
  select count(*) into n from public.sync_tombstones where id = p || '_tomb_other';
  r := r || format('%s tombstones of another scope invisible (%s)', case when n = 0 then 'PASS' else 'FAIL' end, n);
  foreach stmt in array array[
      format('insert into public.sync_tombstones (id, kind, device_id) values (%L, %L, %L)', p || '_tomb', 'task', s),
      format('update public.sync_tombstones set deleted_at = now() where id = %L', p || '_tasks_seed'),
      format('delete from public.sync_tombstones where id = %L', p || '_tasks_seed')] loop
    begin
      execute stmt;
      r := r || format('FAIL tombstones %s allowed', split_part(stmt, ' ', 1));
    exception
      when sqlstate '42501' then r := r || format('PASS tombstones %s refused', split_part(stmt, ' ', 1));
      when others then r := r || format('FAIL tombstones %s: %s %s', split_part(stmt, ' ', 1), sqlstate, sqlerrm);
    end;
  end loop;
  perform set_config('request.headers', json_build_object('x-proxima-session', t_forged)::text, true);
  begin perform count(*) from public.sync_tombstones; r := r || text 'FAIL tombstones forged select allowed';
  exception when sqlstate '28000' then r := r || ('PASS tombstones forged select: ' || sqlerrm); end;

  -- F. grants that bypass RLS are gone
  execute 'reset role';
  select count(*) into n
    from unnest(array['tasks','history','settings','favorites','presets','sync_tombstones']) t,
         unnest(array['anon','authenticated']) g,
         unnest(array['TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) pr
   where has_table_privilege(g, 'public.' || t, pr);
  r := r || format('%s no TRUNCATE/REFERENCES/TRIGGER/MAINTAIN for browser roles (%s left)', case when n = 0 then 'PASS' else 'FAIL' end, n);
  select count(*) into n
    from unnest(array['tasks','history','settings','favorites','presets']) t, unnest(array['anon','authenticated']) g
   where has_table_privilege(g, 'public.' || t, 'DELETE');
  r := r || format('%s no DELETE for browser roles on the data tables (%s left)', case when n = 0 then 'PASS' else 'FAIL' end, n);

  -- G. role authenticated (the Email-OTP window): same gate
  execute 'set local role authenticated';
  perform set_config('request.headers', json_build_object('x-proxima-session', t_good)::text, true);
  begin
    select count(*) into n from public.tasks;
    r := r || format('%s authenticated valid select=%s', case when n = total[1] - 1 then 'PASS' else 'FAIL' end, n);
    insert into public.settings (device_id, key) values (s, p || '_auth');
    r := r || text 'PASS authenticated valid write';
    begin
      delete from public.settings where device_id = s and key = p || '_auth';
      r := r || text 'FAIL authenticated plain delete allowed';
    exception when sqlstate '42501' then r := r || text 'PASS authenticated plain delete refused (privilege)';
    end;
  exception when others then r := r || format('FAIL authenticated valid raised %s %s', sqlstate, sqlerrm);
  end;
  perform set_config('request.headers', '{}', true);
  begin insert into public.settings (device_id, key) values (s, p || '_auth2'); r := r || text 'FAIL authenticated no-header insert allowed';
  exception when sqlstate '28000' then r := r || text 'PASS authenticated no-header insert refused';
            when others then r := r || format('FAIL authenticated no-header insert: %s %s', sqlstate, sqlerrm); end;

  -- H. MUST DENY: revoked (password change / backup unlock bump admin_sessions_valid_after) -> the very next statement fails
  execute 'reset role';
  insert into public.history (id, device_id) values (p || '_history_h', s);   -- a row the revoked update would touch
  insert into public.app_secrets (key, value)
    values ('admin_sessions_valid_after', jsonb_build_object('at', extract(epoch from now())::bigint + 60))
    on conflict (key) do update set value = excluded.value;
  if to_regclass('proxima_auth.users') is not null then   -- from M1 the verifier reads the owner row's epoch
    execute 'update proxima_auth.users set sessions_valid_after = $1 where role = ''owner'''
      using extract(epoch from now())::bigint + 60;
  end if;
  execute 'set local role anon';
  perform set_config('request.headers', json_build_object('x-proxima-session', t_good)::text, true);
  foreach stmt in array array[
      'select count(*) from public.tasks',
      format('insert into public.settings (device_id, key) values (%L, %L)', s, p || '_rev'),
      format('update public.history set prompt = prompt where id = %L', p || '_history_h')] loop
    begin
      execute stmt;
      r := r || format('FAIL revoked %s allowed', split_part(stmt, ' ', 1));
    exception
      when sqlstate '28000' then r := r || format('%s revoked %s: %s',
             case when sqlerrm = 'session token revoked' then 'PASS' else 'FAIL' end, split_part(stmt, ' ', 1), sqlerrm);
      when others then r := r || format('FAIL revoked %s: %s %s', split_part(stmt, ' ', 1), sqlstate, sqlerrm);
    end;
  end loop;
  execute 'reset role';
  raise exception 'RESULT: % PASS, % FAIL :: %',
    (select count(*) from unnest(r) x where x like 'PASS%'), (select count(*) from unnest(r) x where x like 'FAIL%'),
    array_to_string(r, ' | ');
end $pt$;
