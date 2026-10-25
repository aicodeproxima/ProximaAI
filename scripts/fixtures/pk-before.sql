-- Fixture for scripts/test-provider-keys-continuity.sql: an md5 of each clear-text WaveSpeed key BEFORE
-- 20261025500000_mu_p5_provider_keys moves it into Vault (temp table, inside sql-tx's rolled-back transaction).
create temp table _pk_before as
  select s.device_id, md5(s.value->>'value') as h from public.user_secrets s where s.key = 'wavespeed_api_key';
create temp table _pk_vault as select count(*)::int as n from vault.secrets;
