-- Provider-key saves lock the account row FOR NO KEY UPDATE again. 20261025920000 had made every account-row lock that
-- changes no key FOR NO KEY UPDATE, so a key save or removal does not wait behind a running backup's FOR KEY SHARE
-- (20261025820000) and does not hold up the backup's own writes. 20261115000000 (Higgsfield) rewrote
-- set_my_provider_key and clear_my_provider_key with FOR UPDATE on proxima_auth.users, which brought that wait back;
-- scripts/test-signin-locks-db.sql L1 has failed since. Those two lock lines are the only change: the bodies are the
-- installed ones verbatim (generated from pg_get_functiondef, md5-guarded below), so the 'higgsfield' provider stays.
-- Tests: scripts/test-signin-locks-db.sql (L1) and the provider-key suites. Rollback:
-- supabase/rollback/20261115200000_provider_keys_no_key_lock.rollback.sql

set local lock_timeout = '2s';

do $guard$
begin
  if md5(pg_get_functiondef('public.set_my_provider_key(text,text,text)'::regprocedure)) <> '8403439e99b822ba6c43a9ca0961bc22' then
    raise exception 'provider_keys_no_key_lock: % changed since this migration was written (installed %, expected 8403439e99b822ba6c43a9ca0961bc22)', 'public.set_my_provider_key(text,text,text)', md5(pg_get_functiondef('public.set_my_provider_key(text,text,text)'::regprocedure));
  end if;
  if md5(pg_get_functiondef('public.clear_my_provider_key(text,text)'::regprocedure)) <> '03cbfb1056fef4890c232a93bc97af2c' then
    raise exception 'provider_keys_no_key_lock: % changed since this migration was written (installed %, expected 03cbfb1056fef4890c232a93bc97af2c)', 'public.clear_my_provider_key(text,text)', md5(pg_get_functiondef('public.clear_my_provider_key(text,text)'::regprocedure));
  end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.set_my_provider_key(p_session_token text, p_provider text, p_key text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
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
  perform 1 from proxima_auth.users u where u.id = v_acc.id for no key update;
  v_fp := proxima_auth._store_provider_key(v_acc.id, p_provider, v_key);
  if p_provider = 'wavespeed' then
    delete from user_secrets where device_id = v_acc.scope and key = 'wavespeed_api_key';
  end if;
  return json_build_object('ok', true, 'provider', p_provider, 'fingerprint', v_fp);
end $function$;

CREATE OR REPLACE FUNCTION public.clear_my_provider_key(p_session_token text, p_provider text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_acc proxima_auth.account := proxima_auth.current_account(p_session_token);
  v_secret uuid;
  v_n int := 0;
begin
  if v_acc.id is null then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_provider is null or p_provider not in ('wavespeed', 'kie', 'higgsfield') then
    raise exception 'unknown provider' using errcode = '22023';
  end if;
  perform 1 from proxima_auth.users u where u.id = v_acc.id for no key update;
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
