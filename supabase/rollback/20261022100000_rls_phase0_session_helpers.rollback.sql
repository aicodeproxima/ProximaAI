-- Rollback of supabase/migrations/20261022100000_rls_phase0_session_helpers.sql. Kept OUT of supabase/migrations/ so that
-- `supabase db push` never applies it. Roll back phase 2 (20261022120000) first: while its policies use
-- proxima_auth.session_scope, the final drops here fail, which is intended. With the phase-1 client live, this removes
-- the only live-update source (the ping); devices then sync on the 20 s / focus / visible / online reconcile only.
drop trigger if exists tasks_sync_ping_ins on public.tasks;
drop trigger if exists tasks_sync_ping_upd on public.tasks;
drop trigger if exists tasks_sync_ping_del on public.tasks;
drop trigger if exists history_sync_ping_ins on public.history;
drop trigger if exists history_sync_ping_upd on public.history;
drop trigger if exists history_sync_ping_del on public.history;
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
    'password_is_bcrypt', exists (select 1 from app_secrets where key = 'admin_password_hash'));
end $function$;
drop function if exists proxima_auth.ping_sync();
drop function if exists proxima_auth.sync_topic();
drop function if exists proxima_auth.session_scope(boolean);
alter default privileges for role postgres in schema proxima_auth grant execute on functions to public;
drop schema if exists proxima_auth;
