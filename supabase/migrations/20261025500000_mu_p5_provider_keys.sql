-- Provider keys per account, in Supabase Vault (docs/SECOND-ACCOUNT-PLAN.md S1, decisions K1 and K5; plan D6).
--
-- A second account generates with its own key, and kie.ai is a second provider next to WaveSpeed. Each account saves at
-- most one key per provider. The key is kept encrypted in Vault, never in a table in clear text, and is keyed by the
-- account's id, so a rename moves nothing. A browser can save, replace or clear its own account's keys and see a masked
-- fingerprint; only the server (the proxies, as service_role) ever reads a key back, through get_provider_key, which
-- re-verifies the session token (so a revoked or expired session reads nothing).
--
-- The WaveSpeed key the owner saved before this (public.user_secrets, clear text) moves into Vault here, in the same
-- transaction, after a check that Vault returns exactly the stored value; the clear-text row is deleted. The two existing
-- functions keep their signatures, grants and answers: get_my_wavespeed_key (api/ws-proxy.ts) now reads Vault, and
-- set_my_wavespeed_key (Settings) now writes Vault.
--
-- Not here: account deletion (P5) must also delete the account's Vault secrets (provider_keys.secret_id).
--
-- Rollback: supabase/rollback/20261025500000_mu_p5_provider_keys.rollback.sql (puts the WaveSpeed keys back in user_secrets
-- from Vault, restores both functions, drops the rest).
-- Tests: node scripts/tools/sql-tx.mjs supabase/migrations/20261025500000_mu_p5_provider_keys.sql --test scripts/test-provider-keys-db.sql
--   continuity (the owner's key reads back the same through the proxy's function), rolled back:
--   node scripts/tools/sql-tx.mjs scripts/fixtures/pk-before.sql supabase/migrations/20261025500000_mu_p5_provider_keys.sql --test scripts/test-provider-keys-continuity.sql

do $guard$
declare
  want constant jsonb := '{
    "public.get_my_wavespeed_key(text)": "0d9b7b286f6e4981ca165c79298a3336",
    "public.set_my_wavespeed_key(text,text)": "15e8e8585f119d3cee83268d370f94fc"
  }';
  k text; got text;
begin
  for k in select jsonb_object_keys(want) loop
    select md5(pg_get_functiondef(k::regprocedure)) into got;
    if got is distinct from want->>k then
      raise exception 'mu_p5_provider_keys: % changed since this migration was written (live %, expected %)', k, got, want->>k;
    end if;
  end loop;
end $guard$;

create table proxima_auth.provider_keys (
  account_id  uuid not null references proxima_auth.users(id),
  provider    text not null check (provider in ('wavespeed', 'kie')),
  secret_id   uuid not null unique,                     -- vault.secrets.id
  fingerprint text not null,                            -- '••••' + the key's last 4 characters, for Settings
  updated_at  timestamptz not null default now(),
  primary key (account_id, provider)
);
revoke all on table proxima_auth.provider_keys from public, anon, authenticated, service_role;

-- A key is 8 to 512 printable ASCII characters with no spaces (WaveSpeed and kie.ai keys both fit).
create function proxima_auth._provider_key_ok(p_key text) returns boolean
 language sql immutable set search_path to ''
as $$ select p_key is not null and length(p_key) between 8 and 512 and p_key ~ '^[!-~]+$' $$;

create function proxima_auth._provider_fingerprint(p_key text) returns text
 language sql immutable set search_path to ''
as $$ select '••••' || right(p_key, 4) $$;

-- Writes (or replaces) the account's key for one provider. The caller holds the account row's lock.
create function proxima_auth._store_provider_key(p_account uuid, p_provider text, p_key text) returns text
 language plpgsql security definer set search_path to ''
as $function$
declare
  v_secret uuid;
  v_fp text := proxima_auth._provider_fingerprint(p_key);
begin
  select k.secret_id into v_secret from proxima_auth.provider_keys k where k.account_id = p_account and k.provider = p_provider;
  if found then
    perform vault.update_secret(v_secret, p_key);
    update proxima_auth.provider_keys set fingerprint = v_fp, updated_at = now()
     where account_id = p_account and provider = p_provider;
  else
    v_secret := vault.create_secret(p_key, null, 'ProximaAI provider key');
    insert into proxima_auth.provider_keys (account_id, provider, secret_id, fingerprint) values (p_account, p_provider, v_secret, v_fp);
  end if;
  return v_fp;
end $function$;

-- The decrypted key of one account and provider, or null.
create function proxima_auth._provider_key(p_account uuid, p_provider text) returns text
 language sql stable security definer set search_path to ''
as $$
  select d.decrypted_secret from proxima_auth.provider_keys k join vault.decrypted_secrets d on d.id = k.secret_id
   where k.account_id = p_account and k.provider = p_provider
$$;

revoke execute on function proxima_auth._provider_key_ok(text), proxima_auth._provider_fingerprint(text),
  proxima_auth._store_provider_key(uuid, text, text), proxima_auth._provider_key(uuid, text)
  from public, anon, authenticated, service_role;

-- Browser: save or replace this account's key. Answers {ok, provider, fingerprint}; never the key.
create function public.set_my_provider_key(p_session_token text, p_provider text, p_key text) returns json
 language plpgsql security definer set search_path to 'public', 'pg_catalog'
as $function$
declare
  v_acc proxima_auth.account := proxima_auth.current_account(p_session_token);
  v_key text := btrim(p_key);
  v_fp  text;
begin
  if v_acc.id is null then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_provider is null or p_provider not in ('wavespeed', 'kie') then
    raise exception 'unknown provider' using errcode = '22023';
  end if;
  if not proxima_auth._provider_key_ok(v_key) then
    raise exception 'That key does not look right (8 to 512 characters, no spaces).' using errcode = '22023';
  end if;
  perform 1 from proxima_auth.users u where u.id = v_acc.id for update;   -- one key write per account at a time
  v_fp := proxima_auth._store_provider_key(v_acc.id, p_provider, v_key);
  if p_provider = 'wavespeed' then
    delete from user_secrets where device_id = v_acc.scope and key = 'wavespeed_api_key';   -- no clear-text copy left
  end if;
  return json_build_object('ok', true, 'provider', p_provider, 'fingerprint', v_fp);
end $function$;

-- Browser: remove this account's key for one provider (Vault secret included). Answers {ok, removed}.
create function public.clear_my_provider_key(p_session_token text, p_provider text) returns json
 language plpgsql security definer set search_path to 'public', 'pg_catalog'
as $function$
declare
  v_acc proxima_auth.account := proxima_auth.current_account(p_session_token);
  v_secret uuid;
  v_n int := 0;
begin
  if v_acc.id is null then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_provider is null or p_provider not in ('wavespeed', 'kie') then
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

-- Browser: which providers this account has a key for, with masked fingerprints. Never a key.
create function public.my_provider_keys(p_session_token text) returns json
 language plpgsql stable security definer set search_path to 'public', 'pg_catalog'
as $function$
declare
  v_acc proxima_auth.account := proxima_auth.current_account(p_session_token);
begin
  if v_acc.id is null then raise exception 'forbidden' using errcode = '42501'; end if;
  return json_build_object('ok', true, 'keys', coalesce((
    select json_agg(json_build_object('provider', k.provider, 'fingerprint', k.fingerprint,
                                      'updated_at', (extract(epoch from k.updated_at) * 1000)::bigint) order by k.provider)
      from proxima_auth.provider_keys k where k.account_id = v_acc.id), '[]'::json));
end $function$;

-- Server only (the proxies, as service_role): the key of the token's account for one provider, or null.
create function public.get_provider_key(p_session_token text, p_provider text) returns text
 language plpgsql stable security definer set search_path to 'public', 'pg_catalog'
as $function$
declare
  v_acc proxima_auth.account := proxima_auth.current_account(p_session_token);
begin
  if v_acc.id is null then raise exception 'forbidden' using errcode = '42501'; end if;
  return proxima_auth._provider_key(v_acc.id, p_provider);
end $function$;

revoke execute on function public.set_my_provider_key(text, text, text), public.clear_my_provider_key(text, text),
  public.my_provider_keys(text), public.get_provider_key(text, text) from public, anon, authenticated, service_role;
grant execute on function public.set_my_provider_key(text, text, text), public.clear_my_provider_key(text, text),
  public.my_provider_keys(text) to anon, authenticated;
grant execute on function public.get_provider_key(text, text) to service_role;

-- The two existing WaveSpeed functions, now over Vault (signatures, grants and answers unchanged).
create or replace function public.get_my_wavespeed_key(p_session_token text)
 returns text
 language plpgsql
 security definer
 set search_path to 'public', 'pg_catalog'
as $function$
declare
  v_acc proxima_auth.account := proxima_auth.current_account(p_session_token);
begin
  if v_acc.id is null then raise exception 'forbidden' using errcode = '42501'; end if;
  return proxima_auth._provider_key(v_acc.id, 'wavespeed');   -- 20261025500000: Vault, keyed by the account's id
end;
$function$;

create or replace function public.set_my_wavespeed_key(p_session_token text, p_key text)
 returns json
 language plpgsql
 security definer
 set search_path to 'public', 'pg_catalog'
as $function$
declare
  v_acc proxima_auth.account;
begin
  if p_key is null or length(trim(p_key)) < 8 then
    raise exception 'WaveSpeed key looks invalid (too short)';
  end if;
  v_acc := proxima_auth.current_account(p_session_token);
  if v_acc.id is null then raise exception 'forbidden' using errcode = '42501'; end if;
  perform public.set_my_provider_key(p_session_token, 'wavespeed', p_key);   -- 20261025500000: into Vault
  return json_build_object('ok', true, 'device_id', v_acc.scope);
end;
$function$;

-- Move the clear-text WaveSpeed keys into Vault. Each one is read back from Vault and compared before its row goes; a key
-- whose scope has no account is left in place (none exist today: 1 row, the owner's).
do $move$
declare
  r record;
  v_got text;
begin
  for r in select s.device_id, s.value->>'value' as k, u.id as account_id
             from public.user_secrets s join proxima_auth.users u on u.scope = s.device_id
            where s.key = 'wavespeed_api_key' and coalesce(s.value->>'value', '') <> ''
            for update of s loop
    -- Stored exactly as saved (no trim): the proxy keeps sending the identical value.
    if not proxima_auth._provider_key_ok(r.k) then
      raise exception 'mu_p5_provider_keys: a stored WaveSpeed key does not pass the key check; nothing moved';
    end if;
    perform proxima_auth._store_provider_key(r.account_id, 'wavespeed', r.k);
    v_got := proxima_auth._provider_key(r.account_id, 'wavespeed');
    if v_got is distinct from r.k then
      raise exception 'mu_p5_provider_keys: Vault did not return the stored key; nothing moved';
    end if;
    delete from public.user_secrets where device_id = r.device_id and key = 'wavespeed_api_key';
  end loop;
end $move$;
