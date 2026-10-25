-- Continuity for 20261025500000_mu_p5_provider_keys: after the move into Vault, the proxy's function
-- (get_my_wavespeed_key, as service_role, with a token minted for the account) returns exactly the key each account had
-- before. Compared by md5 inside the block; nothing is printed. Rolled back:
--   node scripts/tools/sql-tx.mjs scripts/fixtures/pk-before.sql supabase/migrations/20261025500000_mu_p5_provider_keys.sql --test scripts/test-provider-keys-continuity.sql
do $t$
declare
  out text := ''; r record; tk text; h text; n int := 0;
begin
  for r in select b.device_id, b.h, u.id from _pk_before b join proxima_auth.users u on u.scope = b.device_id loop
    n := n + 1;
    execute 'select proxima_auth.mint_token($1)' into tk using r.id;
    execute 'set local role service_role';
    h := md5(public.get_my_wavespeed_key(tk));
    execute 'reset role';
    out := out || case when h = r.h then format('ok C%s same-key-through-proxy-function; ', n)
                       else format('FAIL C%s key differs after the move; ', n) end;
  end loop;
  out := out || case when n >= 1 then format('ok C0 %s account key(s) checked; ', n) else 'FAIL C0 no key to check; ' end;
  raise exception 'RESULT: %', out;
end $t$;
