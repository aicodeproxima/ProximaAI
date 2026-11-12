-- Tests for supabase/migrations/20261115000000_provider_keys_higgsfield.sql
-- Verifies 'higgsfield' provider key support in Vault, check constraint, and RPCs.
-- Run via:
--   node scripts/tools/sql-tx.mjs supabase/migrations/20261115000000_provider_keys_higgsfield.sql --test scripts/test-provider-keys-hf.sql

do $t$
declare
  out text := '';
  ok boolean; j json; v text;
  owner_id uuid; owner_tk text; mem uuid; mem_tk text;
  nm text := '__pkhf_' || txid_current();
  hf_key constant text := '7463fb77-5ce2-4552-bda6-37e96b837fcc:e9dd8f992eb8373f7eb1da5b33471dfab4258081325516640350c21e22fed13b';
  hf_key2 constant text := 'test-key-id-1234:test-key-secret-5678-abcdef';
begin
  select id into owner_id from proxima_auth.users where role = 'owner';
  execute 'select proxima_auth.mint_token($1)' into owner_tk using owner_id;
  execute 'insert into proxima_auth.users (username, role, scope) values ($1, ''member'', $2) returning id' into mem using nm, 'user:' || nm;
  execute 'select proxima_auth.mint_token($1)' into mem_tk using mem;

  -- HF1. Check constraint accepts 'higgsfield'
  begin
    execute 'set local role anon';
    perform set_config('request.headers', json_build_object('x-proxima-session', mem_tk)::text, true);
    j := public.set_my_provider_key(mem_tk, 'higgsfield', '  ' || hf_key || ' ');
    execute 'reset role';

    execute 'set local role service_role';
    v := public.get_provider_key(mem_tk, 'higgsfield');
    execute 'reset role';

    ok := ((j->>'ok')::boolean and j->>'fingerprint' = '••••d13b' and v = hf_key);
    if ok then
      out := out || 'ok HF1 member-saves-higgsfield; ';
    else
      out := out || format('FAIL HF1 member-saves-higgsfield %s %s; ', j->>'fingerprint', v = hf_key);
    end if;
  exception when others then
    begin execute 'reset role'; exception when others then null; end;
    out := out || format('FAIL HF1 %s %s; ', sqlstate, sqlerrm);
  end;

  -- HF2. Listing provider keys returns 'higgsfield' with masked fingerprint
  begin
    execute 'set local role anon';
    perform set_config('request.headers', json_build_object('x-proxima-session', mem_tk)::text, true);
    j := public.my_provider_keys(mem_tk);
    execute 'reset role';

    ok := exists (
      select 1 from json_array_elements(j->'keys') elem
      where elem->>'provider' = 'higgsfield' and elem->>'fingerprint' = '••••d13b'
    );
    if ok then
      out := out || 'ok HF2 my_provider_keys-lists-higgsfield; ';
    else
      out := out || format('FAIL HF2 my_provider_keys %s; ', j);
    end if;
  exception when others then
    begin execute 'reset role'; exception when others then null; end;
    out := out || format('FAIL HF2 %s %s; ', sqlstate, sqlerrm);
  end;

  -- HF3. Clearing provider key works cleanly
  begin
    execute 'set local role anon';
    perform set_config('request.headers', json_build_object('x-proxima-session', mem_tk)::text, true);
    j := public.clear_my_provider_key(mem_tk, 'higgsfield');
    execute 'reset role';

    execute 'set local role service_role';
    v := public.get_provider_key(mem_tk, 'higgsfield');
    execute 'reset role';

    ok := ((j->>'ok')::boolean and (j->>'removed')::boolean and v is null);
    if ok then
      out := out || 'ok HF3 clear-higgsfield-key; ';
    else
      out := out || format('FAIL HF3 clear-higgsfield-key %s %s; ', j, v);
    end if;
  exception when others then
    begin execute 'reset role'; exception when others then null; end;
    out := out || format('FAIL HF3 %s %s; ', sqlstate, sqlerrm);
  end;

  -- HF4. Reject unknown provider
  begin
    execute 'set local role anon';
    perform set_config('request.headers', json_build_object('x-proxima-session', mem_tk)::text, true);
    j := public.set_my_provider_key(mem_tk, 'invalid_provider', hf_key2);
    execute 'reset role';
    out := out || 'FAIL HF4 should-reject-invalid-provider; ';
  exception when others then
    begin execute 'reset role'; exception when others then null; end;
    ok := (sqlstate = '22023');
    if ok then
      out := out || 'ok HF4 reject-invalid-provider; ';
    else
      out := out || format('FAIL HF4 %s %s; ', sqlstate, sqlerrm);
    end if;
  end;

  raise exception 'RESULT: %', out;
end $t$;
