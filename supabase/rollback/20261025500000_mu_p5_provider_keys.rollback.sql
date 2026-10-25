-- Rollback for supabase/migrations/20261025500000_mu_p5_provider_keys.sql.
-- 1. Puts each account's WaveSpeed key back into public.user_secrets (clear text, as before the migration), from Vault.
-- 2. Restores get_my_wavespeed_key and set_my_wavespeed_key to their definitions before the migration (verbatim).
-- 3. Deletes every provider key's Vault secret. kie.ai keys are NOT kept: after a re-apply they are saved again in Settings.
-- 4. Drops the table and the functions the migration added.
-- Refuses if the two functions it restores over are not the ones the migration installed.
-- Proof (rolled back): node scripts/tools/sql-tx.mjs scripts/fixtures/pk-before.sql supabase/migrations/20261025500000_mu_p5_provider_keys.sql supabase/rollback/20261025500000_mu_p5_provider_keys.rollback.sql --test scripts/test-provider-keys-rollback.sql

do $guard$
declare
  want constant jsonb := '{
    "public.get_my_wavespeed_key(text)": "d3fcb818a753737efb8b17b7771bdd58",
    "public.set_my_wavespeed_key(text,text)": "c6db405dcc58d57674d30965f0646465"
  }';
  k text; got text;
begin
  for k in select jsonb_object_keys(want) loop
    select md5(pg_get_functiondef(k::regprocedure)) into got;
    if got is distinct from want->>k then
      raise exception 'mu_p5_provider_keys rollback: % changed since the migration (live %, expected %)', k, got, want->>k;
    end if;
  end loop;
end $guard$;

do $back$
declare r record;
begin
  for r in select u.scope, proxima_auth._provider_key(k.account_id, 'wavespeed') as v
             from proxima_auth.provider_keys k join proxima_auth.users u on u.id = k.account_id
            where k.provider = 'wavespeed' loop
    if r.v is null then raise exception 'mu_p5_provider_keys rollback: a WaveSpeed key could not be read from Vault'; end if;
    insert into public.user_secrets (device_id, key, value) values (r.scope, 'wavespeed_api_key', jsonb_build_object('value', r.v))
      on conflict (device_id, key) do update set value = excluded.value, updated_at = now();
  end loop;
  delete from vault.secrets s where s.id in (select k.secret_id from proxima_auth.provider_keys k);
end $back$;

CREATE OR REPLACE FUNCTION public.get_my_wavespeed_key(p_session_token text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_device_id text;
  v_key text;
BEGIN
  v_device_id := (proxima_auth.current_account(p_session_token)).scope;   -- the account's own scope, never the subject
  IF v_device_id IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  SELECT value->>'value' INTO v_key
    FROM user_secrets
    WHERE device_id = v_device_id AND key = 'wavespeed_api_key';
  RETURN v_key;
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_my_wavespeed_key(p_session_token text, p_key text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_device_id text;
BEGIN
  IF p_key IS NULL OR length(trim(p_key)) < 8 THEN
    RAISE EXCEPTION 'WaveSpeed key looks invalid (too short)';
  END IF;
  v_device_id := (proxima_auth.current_account(p_session_token)).scope;   -- the account's own scope, never the subject
  IF v_device_id IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  INSERT INTO user_secrets (device_id, key, value)
    VALUES (v_device_id, 'wavespeed_api_key', jsonb_build_object('value', p_key))
  ON CONFLICT (device_id, key) DO UPDATE
    SET value = EXCLUDED.value, updated_at = now();
  RETURN json_build_object('ok', true, 'device_id', v_device_id);
END;
$function$;

drop function public.set_my_provider_key(text, text, text);
drop function public.clear_my_provider_key(text, text);
drop function public.my_provider_keys(text);
drop function public.get_provider_key(text, text);
drop function proxima_auth._provider_key(uuid, text);
drop function proxima_auth._store_provider_key(uuid, text, text);
drop function proxima_auth._provider_fingerprint(text);
drop function proxima_auth._provider_key_ok(text);
drop table proxima_auth.provider_keys;
