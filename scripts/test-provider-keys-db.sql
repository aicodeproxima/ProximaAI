-- Tests for supabase/migrations/20261025500000_mu_p5_provider_keys.sql: provider keys per account in Vault. Before it is applied:
--   node scripts/tools/sql-tx.mjs supabase/migrations/20261025500000_mu_p5_provider_keys.sql --test scripts/test-provider-keys-db.sql
-- One DO block, always rolled back by sql-tx. Fixtures: a member account '__pk_<txid>' created here; the owner's account
-- is only read (its WaveSpeed key is compared by md5 inside the block, never printed). Browser calls run as anon with a
-- minted token, server reads as service_role. Each case catches its errors.
do $t$
declare
  out text := '';
  ok boolean; st text; j json; v text; n int; sid uuid; sid2 uuid;
  owner_id uuid; owner_tk text; mem uuid; mem_tk text; mem2 uuid; mem2_tk text;
  nm text := '__pk_' || txid_current();
  kie_key constant text := 'kie-test-0123456789abcdef';
  kie_key2 constant text := 'kie-test-fedcba9876543210';
  ws_key constant text := 'ws-test-key-00000000000000000000aaaa';
begin
  select id into owner_id from proxima_auth.users where role = 'owner';
  execute 'select proxima_auth.mint_token($1)' into owner_tk using owner_id;
  execute 'insert into proxima_auth.users (username, role, scope) values ($1, ''member'', $2) returning id' into mem using nm, 'user:' || nm;
  execute 'select proxima_auth.mint_token($1)' into mem_tk using mem;
  execute 'insert into proxima_auth.users (username, role, scope) values ($1, ''member'', $2) returning id' into mem2 using nm || 'b', 'user:' || nm || 'b';
  execute 'select proxima_auth.mint_token($1)' into mem2_tk using mem2;

  -- K1. The clear-text WaveSpeed rows moved into Vault: none left for any account's scope, one Vault key per moved row.
  begin
    ok := not exists (select 1 from public.user_secrets s join proxima_auth.users u on u.scope = s.device_id where s.key = 'wavespeed_api_key')
      and exists (select 1 from proxima_auth.provider_keys where account_id = owner_id and provider = 'wavespeed');
    out := out || case when ok then 'ok K1 moved-to-vault; ' else 'FAIL K1 moved-to-vault; ' end;
  exception when others then out := out || format('FAIL K1 %s %s; ', sqlstate, sqlerrm); end;

  -- K2. A member saves a kie.ai key as anon: answer has the fingerprint and never the key; the server reads it back.
  begin
    execute 'set local role anon';
    perform set_config('request.headers', json_build_object('x-proxima-session', mem_tk)::text, true);
    j := public.set_my_provider_key(mem_tk, 'kie', '  ' || kie_key || ' ');
    execute 'reset role';
    execute 'set local role service_role';
    v := public.get_provider_key(mem_tk, 'kie');
    execute 'reset role';
    ok := (j->>'ok')::boolean and j->>'fingerprint' = '••••cdef' and position(kie_key in j::text) = 0 and v = kie_key;
    out := out || case when ok then 'ok K2 member-saves-kie; ' else format('FAIL K2 member-saves-kie %s %s; ', j->>'fingerprint', v = kie_key) end;
  exception when others then
    begin execute 'reset role'; exception when others then null; end;
    out := out || format('FAIL K2 %s %s; ', sqlstate, sqlerrm);
  end;

  -- K3. Isolation: the owner and another member read no kie.ai key; my_provider_keys lists only the caller's own.
  begin
    execute 'set local role service_role';
    ok := public.get_provider_key(owner_tk, 'kie') is null and public.get_provider_key(mem2_tk, 'kie') is null;
    execute 'reset role';
    execute 'set local role anon';
    perform set_config('request.headers', json_build_object('x-proxima-session', mem2_tk)::text, true);
    j := public.my_provider_keys(mem2_tk);
    execute 'reset role';
    ok := ok and json_array_length(j->'keys') = 0;
    out := out || case when ok then 'ok K3 isolation; ' else format('FAIL K3 isolation %s; ', j) end;
  exception when others then
    begin execute 'reset role'; exception when others then null; end;
    out := out || format('FAIL K3 %s %s; ', sqlstate, sqlerrm);
  end;

  -- K4. Browsers cannot read keys: anon and authenticated may not execute get_provider_key / get_my_wavespeed_key, nor
  --     read proxima_auth.provider_keys or vault.decrypted_secrets.
  declare cases text[] := array[
      'select public.get_provider_key($1, ''kie'')', 'select public.get_my_wavespeed_key($1)',
      'select count(*) from proxima_auth.provider_keys', 'select count(*) from vault.decrypted_secrets'];
    c text; r text; bad text := '';
  begin
    foreach r in array array['anon', 'authenticated'] loop
      foreach c in array cases loop
        st := 'none';
        begin
          execute format('set local role %I', r);
          perform set_config('request.headers', json_build_object('x-proxima-session', mem_tk)::text, true);
          execute c using mem_tk;
        exception when others then st := sqlstate; end;
        execute 'reset role';
        if st <> '42501' then bad := bad || format('[%s %s -> %s]', r, left(c, 40), st); end if;
      end loop;
    end loop;
    out := out || case when bad = '' then 'ok K4 browsers-cannot-read; ' else format('FAIL K4 %s; ', bad) end;
  exception when others then
    begin execute 'reset role'; exception when others then null; end;
    out := out || format('FAIL K4 %s %s; ', sqlstate, sqlerrm);
  end;

  -- K5. No valid session: set / clear / list refuse and nothing is written.
  begin
    select count(*) into n from proxima_auth.provider_keys;
    st := '';
    for i in 1..3 loop
      begin
        execute 'set local role anon';
        perform set_config('request.headers', '{}', true);
        if i = 1 then perform public.set_my_provider_key('x.1.y', 'kie', kie_key);
        elsif i = 2 then perform public.clear_my_provider_key(null, 'kie');
        else perform public.my_provider_keys(''); end if;
        st := st || 'none,';
      exception when others then st := st || sqlstate || ','; end;
      execute 'reset role';
    end loop;
    ok := st not like '%none%' and (select count(*) from proxima_auth.provider_keys) = n;
    out := out || case when ok then 'ok K5 no-session-refused; ' else format('FAIL K5 no-session %s; ', st) end;
  exception when others then
    begin execute 'reset role'; exception when others then null; end;
    out := out || format('FAIL K5 %s %s; ', sqlstate, sqlerrm);
  end;

  -- K6. Bad input: an unknown provider and malformed keys are refused (22023) and store nothing.
  begin
    st := '';
    foreach v in array array['openai|' || kie_key, 'kie|short', 'kie|has space inside', 'kie|' || repeat('a', 513), 'kie|'] loop
      begin
        execute 'set local role anon';
        perform set_config('request.headers', json_build_object('x-proxima-session', mem2_tk)::text, true);
        perform public.set_my_provider_key(mem2_tk, split_part(v, '|', 1), split_part(v, '|', 2));
        st := st || 'none,';
      exception when others then st := st || sqlstate || ','; end;
      execute 'reset role';
    end loop;
    ok := st = '22023,22023,22023,22023,22023,' and not exists (select 1 from proxima_auth.provider_keys where account_id = mem2);
    out := out || case when ok then 'ok K6 bad-input; ' else format('FAIL K6 bad-input %s; ', st) end;
  exception when others then
    begin execute 'reset role'; exception when others then null; end;
    out := out || format('FAIL K6 %s %s; ', sqlstate, sqlerrm);
  end;

  -- K7. Replacing a key keeps one Vault secret (updated in place) and the new fingerprint; then clearing removes the row
  --     and the Vault secret, and the server reads nothing.
  begin
    select secret_id into sid from proxima_auth.provider_keys where account_id = mem and provider = 'kie';
    execute 'set local role anon';
    perform set_config('request.headers', json_build_object('x-proxima-session', mem_tk)::text, true);
    j := public.set_my_provider_key(mem_tk, 'kie', kie_key2);
    execute 'reset role';
    select secret_id into sid2 from proxima_auth.provider_keys where account_id = mem and provider = 'kie';
    ok := sid = sid2 and j->>'fingerprint' = '••••3210' and proxima_auth._provider_key(mem, 'kie') = kie_key2;
    execute 'set local role anon';
    perform set_config('request.headers', json_build_object('x-proxima-session', mem_tk)::text, true);
    j := public.clear_my_provider_key(mem_tk, 'kie');
    execute 'reset role';
    ok := ok and (j->>'removed')::boolean and not exists (select 1 from vault.secrets where id = sid)
      and not exists (select 1 from proxima_auth.provider_keys where account_id = mem and provider = 'kie');
    execute 'set local role service_role';
    ok := ok and public.get_provider_key(mem_tk, 'kie') is null;
    execute 'reset role';
    out := out || case when ok then 'ok K7 replace-then-clear; ' else format('FAIL K7 replace-then-clear %s; ', j) end;
  exception when others then
    begin execute 'reset role'; exception when others then null; end;
    out := out || format('FAIL K7 %s %s; ', sqlstate, sqlerrm);
  end;

  -- K8. Settings' existing call (set_my_wavespeed_key) for a member: same answer shape as before, the key lands in Vault,
  --     no clear-text row; the proxy's get_my_wavespeed_key reads it; the owner's WaveSpeed key is untouched.
  declare h_owner text;
  begin
    h_owner := md5(proxima_auth._provider_key(owner_id, 'wavespeed'));
    execute 'set local role anon';
    perform set_config('request.headers', json_build_object('x-proxima-session', mem_tk)::text, true);
    j := public.set_my_wavespeed_key(mem_tk, ws_key);
    execute 'reset role';
    execute 'set local role service_role';
    v := public.get_my_wavespeed_key(mem_tk);
    execute 'reset role';
    ok := (j->>'ok')::boolean and j->>'device_id' = 'user:' || nm and v = ws_key
      and not exists (select 1 from public.user_secrets where device_id = 'user:' || nm)
      and md5(proxima_auth._provider_key(owner_id, 'wavespeed')) is not distinct from h_owner;
    out := out || case when ok then 'ok K8 wavespeed-compat; ' else format('FAIL K8 wavespeed-compat %s; ', j) end;
  exception when others then
    begin execute 'reset role'; exception when others then null; end;
    out := out || format('FAIL K8 %s %s; ', sqlstate, sqlerrm);
  end;

  -- K9. The old "too short" answer for Settings stays word for word.
  begin
    st := 'none';
    begin
      execute 'set local role anon';
      perform set_config('request.headers', json_build_object('x-proxima-session', mem_tk)::text, true);
      perform public.set_my_wavespeed_key(mem_tk, 'abc');
    exception when others then st := sqlerrm; end;
    execute 'reset role';
    out := out || case when st = 'WaveSpeed key looks invalid (too short)' then 'ok K9 short-message; ' else format('FAIL K9 %s; ', st) end;
  exception when others then
    begin execute 'reset role'; exception when others then null; end;
    out := out || format('FAIL K9 %s %s; ', sqlstate, sqlerrm);
  end;

  -- K10. A disabled account's still-unexpired token reads and writes nothing.
  begin
    -- positive control first (K8 saved this key): readable while the account is enabled
    execute 'set local role service_role';
    v := public.get_provider_key(mem_tk, 'wavespeed');
    execute 'reset role';
    if v is distinct from ws_key then raise exception 'control: key not readable while enabled'; end if;
    update proxima_auth.users set disabled_at = now() where id = mem;
    st := 'none';
    begin
      execute 'set local role service_role';
      perform public.get_provider_key(mem_tk, 'wavespeed');
    exception when others then st := 'refused'; end;
    execute 'reset role';
    update proxima_auth.users set disabled_at = null where id = mem;
    out := out || case when st = 'refused' then 'ok K10 disabled-refused; ' else 'FAIL K10 disabled-read; ' end;
  exception when others then
    begin execute 'reset role'; exception when others then null; end;
    out := out || format('FAIL K10 %s %s; ', sqlstate, sqlerrm);
  end;

  -- K11. Catalog: the four new public functions are definer, never executable by PUBLIC; get_provider_key only by
  --      service_role; the internal helpers by none of the API roles.
  begin
    ok := not has_function_privilege('public', 'public.get_provider_key(text,text)', 'execute')
      and not has_function_privilege('anon', 'public.get_provider_key(text,text)', 'execute')
      and has_function_privilege('service_role', 'public.get_provider_key(text,text)', 'execute')
      and has_function_privilege('anon', 'public.set_my_provider_key(text,text,text)', 'execute')
      and has_function_privilege('anon', 'public.my_provider_keys(text)', 'execute')
      and not exists (select 1 from pg_proc p join pg_namespace s on s.oid = p.pronamespace,
                        aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                       where (s.nspname, p.proname) in (('public', 'set_my_provider_key'), ('public', 'clear_my_provider_key'),
                                                        ('public', 'my_provider_keys'), ('public', 'get_provider_key'))
                         and a.grantee = 0)
      and not has_function_privilege('service_role', 'proxima_auth._provider_key(uuid,text)', 'execute')
      and not has_function_privilege('anon', 'proxima_auth._store_provider_key(uuid,text,text)', 'execute');
    out := out || case when ok then 'ok K11 grants; ' else 'FAIL K11 grants; ' end;
  exception when others then out := out || format('FAIL K11 %s %s; ', sqlstate, sqlerrm); end;

  raise exception 'RESULT: %', out;
end $t$;
