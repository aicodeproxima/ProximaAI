-- Migration: 20261115000000_provider_keys_higgsfield.sql
-- Expand proxima_auth.provider_keys check constraint and RPCs to include 'higgsfield'

-- 1. Update check constraint on proxima_auth.provider_keys
alter table proxima_auth.provider_keys drop constraint if exists provider_keys_provider_check;
alter table proxima_auth.provider_keys add constraint provider_keys_provider_check
  check (provider in ('wavespeed', 'kie', 'higgsfield'));

-- 2. Update set_my_provider_key to accept 'higgsfield'
create or replace function public.set_my_provider_key(p_session_token text, p_provider text, p_key text) returns json
 language plpgsql security definer set search_path to 'public', 'pg_catalog'
as $function$
declare
  v_acc proxima_auth.account := proxima_auth.current_account(p_session_token);
  v_key text := btrim(p_key);
  v_fp  text;
begin
  if v_acc.id is null then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_provider is null or p_provider not in ('wavespeed', 'kie', 'higgsfield') then
    raise exception 'unknown provider' using errcode = '22023';
  end if;
  if not proxima_auth._provider_key_ok(v_key) then
    raise exception 'That key does not look right (8 to 512 characters, no spaces).' using errcode = '22023';
  end if;
  perform 1 from proxima_auth.users u where u.id = v_acc.id for update;
  v_fp := proxima_auth._store_provider_key(v_acc.id, p_provider, v_key);
  if p_provider = 'wavespeed' then
    delete from user_secrets where device_id = v_acc.scope and key = 'wavespeed_api_key';
  end if;
  return json_build_object('ok', true, 'provider', p_provider, 'fingerprint', v_fp);
end $function$;

-- 3. Update clear_my_provider_key to accept 'higgsfield'
create or replace function public.clear_my_provider_key(p_session_token text, p_provider text) returns json
 language plpgsql security definer set search_path to 'public', 'pg_catalog'
as $function$
declare
  v_acc proxima_auth.account := proxima_auth.current_account(p_session_token);
  v_secret uuid;
  v_n int := 0;
begin
  if v_acc.id is null then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_provider is null or p_provider not in ('wavespeed', 'kie', 'higgsfield') then
    raise exception 'unknown provider' using errcode = '22023';
  end if;
  perform 1 from proxima_auth.users u where u.id = v_acc.id for update;
  delete from proxima_auth.provider_keys k where k.account_id = v_acc.id and k.provider = p_provider returning k.secret_id into v_secret;
  if v_secret is not null then
    delete from vault.secrets s where s.id = v_secret;
    v_n := 1;
  end if;
  if p_provider = 'wavespeed' then
    delete from user_secrets where device_id = v_acc.scope and key = 'wavespeed_api_key';
  end if;
  return json_build_object('ok', true, 'removed', v_n = 1);
end $function$;
