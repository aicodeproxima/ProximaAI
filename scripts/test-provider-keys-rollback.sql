-- Rollback proof for 20261025500000_mu_p5_provider_keys (after the fixture, the migration and its rollback, in one
-- rolled-back transaction): both WaveSpeed functions are byte-identical to before, each clear-text key is back with the
-- same md5, Vault holds what it held before, and nothing the migration added is left.
do $t$
declare out text := ''; ok boolean;
begin
  ok := md5(pg_get_functiondef('public.get_my_wavespeed_key(text)'::regprocedure)) = '0d9b7b286f6e4981ca165c79298a3336'
    and md5(pg_get_functiondef('public.set_my_wavespeed_key(text,text)'::regprocedure)) = '15e8e8585f119d3cee83268d370f94fc';
  out := out || case when ok then 'ok B1 functions-identical; ' else 'FAIL B1 functions differ; ' end;
  ok := (select count(*) from _pk_before) >= 1
    and not exists (select 1 from _pk_before b left join public.user_secrets s on s.device_id = b.device_id and s.key = 'wavespeed_api_key'
                     where s.value is null or md5(s.value->>'value') <> b.h)
    and (select count(*) from public.user_secrets where key = 'wavespeed_api_key') = (select count(*) from _pk_before);
  out := out || case when ok then 'ok B2 keys-back-same-md5; ' else 'FAIL B2 keys differ; ' end;
  ok := (select count(*)::int from vault.secrets) = (select n from _pk_vault);
  out := out || case when ok then 'ok B3 vault-as-before; ' else 'FAIL B3 vault count differs; ' end;
  ok := to_regclass('proxima_auth.provider_keys') is null
    and not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                     where (n.nspname = 'public' and p.proname in ('set_my_provider_key', 'clear_my_provider_key', 'my_provider_keys', 'get_provider_key'))
                        or (n.nspname = 'proxima_auth' and p.proname in ('_provider_key', '_store_provider_key', '_provider_fingerprint', '_provider_key_ok')));
  out := out || case when ok then 'ok B4 nothing-left; ' else 'FAIL B4 objects remain; ' end;
  raise exception 'RESULT: %', out;
end $t$;
