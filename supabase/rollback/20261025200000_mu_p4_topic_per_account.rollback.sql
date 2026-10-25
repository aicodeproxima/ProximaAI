-- Rollback of supabase/migrations/20261025200000_mu_p4_topic_per_account.sql (exact inverse: the three bodies below are
-- the live pg_get_functiondef text of 2026-10-25, md5 get_my_account 9771a17c…, ping_sync ab280548…, sync_topic
-- d477f4ef…). Proof: scripts/test-mu-p4-rollback.sql. Kept OUT of supabase/migrations/.
-- With a second account in proxima_auth.users this rollback takes members' live updates away again (they fall back to
-- the 20 s / focus reconcile) and makes their changes ping the owner's devices; nothing is exposed.
-- md5 guard (review round 2, c3 #2): the bodies this file restores must still be the ones 20261025200000 installed;
-- otherwise someone changed them since, and restoring the old text would undo that change.
do $rbguard$
begin
  if md5(pg_get_functiondef('public.get_my_account(text)'::regprocedure)) <> 'c7833f60f204b73c809687b575795d28'
     or md5(pg_get_functiondef('proxima_auth.ping_sync()'::regprocedure)) <> '516e17a5ae5eafa97528cc46f041905f'
     or md5(pg_get_functiondef('proxima_auth.sync_topic()'::regprocedure)) <> 'c964d12d14bc20f7cb8af27be1aaaecf' then
    raise exception 'refusing the 20261025200000 rollback: a function it restores changed since the migration (write a new rollback from the live body)';
  end if;
end $rbguard$;

CREATE OR REPLACE FUNCTION proxima_auth.sync_topic()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select 'proxima-sync-' || encode(extensions.hmac(
           'sync-ping:' || u.username || ':' || (u.sessions_valid_after + 1)::text,
           (select value->>'key' from public.app_secrets where key = 'session_signing_key'),
           'sha256'), 'hex')
    from proxima_auth.users u
   where u.role = 'owner'
$function$
;

CREATE OR REPLACE FUNCTION proxima_auth.ping_sync()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if exists (select 1 from changed_rows) then
    perform realtime.send('{}'::jsonb, 'changed', proxima_auth.sync_topic(), false);
  end if;
  return null;
end $function$
;

CREATE OR REPLACE FUNCTION public.get_my_account(p_session_token text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
declare v_acc proxima_auth.account := proxima_auth.current_account(p_session_token); v_u proxima_auth.users;
begin
  if v_acc.id is null then return json_build_object('ok', false, 'reason', 'forbidden'); end if;
  select * into v_u from proxima_auth.users u where u.id = v_acc.id;
  return json_build_object('ok', true,
    'id',                v_u.id,
    'role',              v_u.role,
    'scope',             v_u.scope,
    'username',          v_u.username,
    'email',             v_u.email,
    'email_verified',    v_u.email_verified,
    'last_verified_at',  v_u.last_verified_at,
    'has_backup_code',   v_u.backup_code_hash is not null,
    'password_is_bcrypt', v_u.password_hash is not null,
    'sync_topic',        case when v_u.role = 'owner' then proxima_auth.sync_topic() end);
end $function$
;

drop function proxima_auth.account_topic(uuid);

-- The migration's own record goes with it, in the same transaction, so a later apply re-applies it.
delete from supabase_migrations.schema_migrations where version = '20261025200000' and name = 'mu_p4_topic_per_account';
