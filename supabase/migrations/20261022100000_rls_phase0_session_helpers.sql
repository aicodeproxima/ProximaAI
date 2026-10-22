-- Phase 0 of closing the generation tables and the 'generations' bucket to requests without a valid session (design:
-- judge panel wf_89f53ef9-80f, approach A). ADDITIVE ONLY: no policy, grant or publication changes here.
--
-- 1. proxima_auth.session_scope(p_required): who the current HTTP request is. PostgREST and Storage copy request headers
--    into the request.headers setting (lower-cased names; measured 2026-10-21 with an isolated probe), and the app sends
--    its session token as x-proxima-session (src/lib/session.js withSessionHeader).
--      no header / request.headers empty or not JSON : p_required=false -> NULL ; p_required=true -> 28000 'session token missing'
--      header present but not valid                    : 28000 with _verify_session_token's message ('invalid signature',
--                                                        'session token expired', 'session token revoked', 'malformed ...')
--      valid but subject not 'admin:%'                 : 28000 'not admin-scoped'
--      valid                                           : 'user:<live username>'
--    28000 reaches the browser as HTTP 403 with that message (matches session.js SESSION_ERROR, except 'session token
--    missing', which is a client state). The schema is not exposed by PostgREST (exposed: public, graphql_public).
-- 2. proxima_auth.sync_topic(): the secret Realtime topic of the content-free "something changed" ping. It changes on
--    rename (username), password change / backup-code unlock (admin_sessions_valid_after) and signing-key rotation.
--    Only get_my_account (token-checked) hands it out.
-- 3. Statement-level AFTER triggers on tasks/history send one empty broadcast per statement that changed rows. It replaces
--    postgres_changes, which phase 2 removes (Realtime cannot see request headers, and its DELETE events carry primary
--    keys to anyone holding the publishable key). realtime.send catches its own errors, so a ping never fails a write.
-- Rollback: supabase/rollback/20261022100000_rls_phase0_session_helpers.rollback.sql

create schema if not exists proxima_auth;
revoke all on schema proxima_auth from public;
grant usage on schema proxima_auth to anon, authenticated;
alter default privileges for role postgres in schema proxima_auth revoke execute on functions from public;

create or replace function proxima_auth.session_scope(p_required boolean default false)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_raw text := nullif(current_setting('request.headers', true), '');   -- '' after a RESET on a pooled connection
  v_tok text;
  v_sub text;
begin
  if v_raw is not null then
    begin
      v_tok := nullif(btrim((v_raw::jsonb) ->> 'x-proxima-session'), '');
    exception when others then
      v_tok := null;                                      -- unparsable request.headers = no header
    end;
  end if;
  if v_tok is null then
    if p_required then
      raise exception using errcode = '28000', message = 'session token missing',
        hint = 'send the x-proxima-session header';
    end if;
    return null;                                          -- realtime / cron / headerless reads: no rows, no error
  end if;
  begin
    v_sub := public._verify_session_token(v_tok);         -- exp, HMAC (current|previous key), admin_username, valid_after
  exception when others then
    raise exception using errcode = '28000', message = sqlerrm;
  end;
  if v_sub is null or v_sub not like 'admin:%' then
    raise exception using errcode = '28000', message = 'not admin-scoped';
  end if;
  return 'user:' || substring(v_sub from 7);
end $$;
alter function proxima_auth.session_scope(boolean) owner to postgres;
revoke all on function proxima_auth.session_scope(boolean) from public;
grant execute on function proxima_auth.session_scope(boolean) to anon, authenticated;

create or replace function proxima_auth.sync_topic()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select 'proxima-sync-' || encode(extensions.hmac(
           'sync-ping:'
             || coalesce((select value->>'username' from public.app_secrets where key = 'admin_username'), '')
             || ':'
             || coalesce((select value->>'at' from public.app_secrets where key = 'admin_sessions_valid_after'), '0'),
           (select value->>'key' from public.app_secrets where key = 'session_signing_key'),
           'sha256'), 'hex')
$$;
alter function proxima_auth.sync_topic() owner to postgres;
revoke all on function proxima_auth.sync_topic() from public, anon, authenticated;

create or replace function proxima_auth.ping_sync()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from changed_rows) then
    perform realtime.send('{}'::jsonb, 'changed', proxima_auth.sync_topic(), false);
  end if;
  return null;
end $$;
alter function proxima_auth.ping_sync() owner to postgres;
revoke all on function proxima_auth.ping_sync() from public, anon, authenticated;

create trigger tasks_sync_ping_ins   after insert on public.tasks   referencing new table as changed_rows for each statement execute function proxima_auth.ping_sync();
create trigger tasks_sync_ping_upd   after update on public.tasks   referencing new table as changed_rows for each statement execute function proxima_auth.ping_sync();
create trigger tasks_sync_ping_del   after delete on public.tasks   referencing old table as changed_rows for each statement execute function proxima_auth.ping_sync();
create trigger history_sync_ping_ins after insert on public.history referencing new table as changed_rows for each statement execute function proxima_auth.ping_sync();
create trigger history_sync_ping_upd after update on public.history referencing new table as changed_rows for each statement execute function proxima_auth.ping_sync();
create trigger history_sync_ping_del after delete on public.history referencing old table as changed_rows for each statement execute function proxima_auth.ping_sync();

-- get_my_account: the live body (md5 cd1d77c0bc45dd6a273e4643115f8076 on 2026-10-22) plus sync_topic.
-- CREATE OR REPLACE keeps its ACL.
create or replace function public.get_my_account(p_session_token text)
returns json
language plpgsql
security definer
set search_path to 'public', 'extensions', 'pg_catalog'
as $function$
declare v_subject text := _verify_session_token(p_session_token);
begin
  if v_subject not like 'admin:%' then return json_build_object('ok', false, 'reason', 'forbidden'); end if;
  return json_build_object('ok', true,
    'username',          (select value->>'username' from app_secrets where key = 'admin_username'),
    'email',             (select value->>'email' from app_secrets where key = 'admin_email'),
    'email_verified',    coalesce((select (value->>'verified')::boolean from app_secrets where key = 'admin_email_verified'), false),
    'last_verified_at',  (select (value->>'at')::bigint from app_secrets where key = 'admin_last_verified_at'),
    'has_backup_code',   exists (select 1 from app_secrets where key = 'admin_backup_code_hash'),
    'password_is_bcrypt', exists (select 1 from app_secrets where key = 'admin_password_hash'),
    'sync_topic',        proxima_auth.sync_topic());
end $function$;
