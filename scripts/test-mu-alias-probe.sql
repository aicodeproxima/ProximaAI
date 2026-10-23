-- P3 design probe (rolled back): does a BEFORE row trigger run before the row policy's WITH CHECK, so an alias trigger
-- can move writes still stamped with a legacy scope onto the session's scope? As anon with a valid session, like the app.
do $pt$
declare
  u text; s text; tok text; p text := '__p3_alias_' || txid_current(); r text[] := '{}'; v text;
begin
  -- The owner: proxima_auth.users from P1's M1 on (a rename then writes only that row), app_secrets before it.
  if to_regclass('proxima_auth.users') is not null then
    execute 'select scope, proxima_auth.mint_token(id) from proxima_auth.users where role = ''owner''' into s, tok;
  else
    u := (select value->>'username' from public.app_secrets where key = 'admin_username');
    s := 'user:' || u;
    tok := public._sign_session_token('admin:' || u, now() + interval '12 hours');
  end if;

  -- Control: no alias trigger yet, so a legacy-stamped insert must be refused by WITH CHECK.
  execute 'set local role anon';
  perform set_config('request.headers', json_build_object('x-proxima-session', tok)::text, true);
  begin
    insert into public.history (id, device_id) values (p || '_c', 'user:__legacy_name');
    r := r || text 'FAIL control: legacy-stamped insert accepted without the alias';
  exception when sqlstate '42501' then r := r || text 'PASS control: legacy-stamped insert refused by WITH CHECK (42501)';
  end;
  execute 'reset role';

  -- The alias: rows stamped with the legacy scope move to the session's scope before any policy sees them.
  create function public.__p3_alias() returns trigger language plpgsql as $f$
  begin
    if new.device_id = 'user:__legacy_name' then new.device_id := (select proxima_auth.session_scope(true)); end if;
    return new;
  end $f$;
  create trigger __p3_alias before insert or update on public.history for each row execute function public.__p3_alias();

  execute 'set local role anon';
  perform set_config('request.headers', json_build_object('x-proxima-session', tok)::text, true);
  begin
    insert into public.history (id, device_id) values (p || '_1', 'user:__legacy_name');
    r := r || text 'PASS insert: legacy-stamped insert accepted through the alias';
  exception when others then r := r || format('FAIL insert: %s %s', sqlstate, sqlerrm);
  end;
  begin
    insert into public.history (id, device_id, prompt) values (p || '_1', 'user:__legacy_name', 'x')
      on conflict (id) do update set prompt = excluded.prompt, device_id = excluded.device_id;
    r := r || text 'PASS upsert: legacy-stamped upsert of an existing row accepted';
  exception when others then r := r || format('FAIL upsert: %s %s', sqlstate, sqlerrm);
  end;
  execute 'reset role';
  select device_id into v from public.history where id = p || '_1';
  r := r || format('%s stored scope is the session''s, not the legacy one', case when v = s then 'PASS' else 'FAIL' end);

  raise exception 'RESULT: % PASS, % FAIL :: %',
    (select count(*) from unnest(r) x where x like 'PASS%'), (select count(*) from unnest(r) x where x like 'FAIL%'),
    array_to_string(r, ' | ');
end $pt$;
