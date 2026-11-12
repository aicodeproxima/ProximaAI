-- Rollback of supabase/migrations/20261115200000_provider_keys_no_key_lock.sql: set_my_provider_key and
-- clear_my_provider_key get back the bodies 20261115000000 installed (verbatim from the live database when the migration
-- was written: full-definition md5 8403439e99b822ba6c43a9ca0961bc22 and 03cbfb1056fef4890c232a93bc97af2c), with the
-- account row locked FOR UPDATE again. Refuses unless the installed bodies are the ones the migration installed.

set local lock_timeout = '2s';

do $guard$
begin
  if md5(pg_get_functiondef('public.set_my_provider_key(text,text,text)'::regprocedure)) <> '97f4b9c9ba66782143389a1cd7092b7a' then
    raise exception 'provider_keys_no_key_lock rollback: % is not the body the migration installed (installed %, expected 97f4b9c9ba66782143389a1cd7092b7a)', 'public.set_my_provider_key(text,text,text)', md5(pg_get_functiondef('public.set_my_provider_key(text,text,text)'::regprocedure));
  end if;
  if md5(pg_get_functiondef('public.clear_my_provider_key(text,text)'::regprocedure)) <> 'de9f1b46bbefe247a04e7f88e024e9ed' then
    raise exception 'provider_keys_no_key_lock rollback: % is not the body the migration installed (installed %, expected de9f1b46bbefe247a04e7f88e024e9ed)', 'public.clear_my_provider_key(text,text)', md5(pg_get_functiondef('public.clear_my_provider_key(text,text)'::regprocedure));
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
  perform 1 from proxima_auth.users u where u.id = v_acc.id for update;
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
