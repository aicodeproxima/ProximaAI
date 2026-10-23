-- Tests for supabase/migrations/20261022200000_account_rpcs_no_public.sql: no security definer function in schema public
-- is executable through PUBLIC (every role, the read-only role sb-query uses included), while the roles that call the
-- account RPCs keep them (review round 2). Catalog checks only; the block ends in an exception, so nothing persists.
-- Run before the migration exists as "begin;" + migration + this file; afterwards this file alone.
do $t$
declare
  out text := '';
  v_public text; v_kept int; v_ro int;
  -- Expected account RPCs per stage: 13 before P1's M1; 14 from M1 (the new unlock_with_backup_code is one too, like
  -- verify_admin) until M4; 13 again once M4 drops set_admin_credentials_rehash (review m4crit #4).
  v_p1 constant boolean := to_regprocedure('public.unlock_with_backup_code(text,text,text)') is not null;
  v_rehash constant boolean := to_regprocedure('public.set_admin_credentials_rehash(text,text)') is not null;
  v_expect constant int := case when not v_p1 then 13 when v_rehash then 14 else 13 end;
begin
  -- 1. No security definer function of schema public is executable through PUBLIC.
  select string_agg(p.proname, ',' order by p.proname) into v_public
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace, aclexplode(p.proacl) a
   where p.prosecdef and n.nspname = 'public' and a.grantee = 0 and a.privilege_type = 'EXECUTE';
  out := out || case when v_public is null then 'ok no-public; ' else format('FAIL no-public %s; ', v_public) end;

  -- 2. anon, authenticated and service_role still execute every account RPC; the read-only role executes none.
  select count(*) into v_kept from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('change_my_password', 'delete_my_backup_phase2', 'get_my_account',
           'list_my_backups_phase2', 'rename_my_account', 'restore_my_backup_phase2', 'set_admin_backup_code',
           'set_admin_credentials_rehash', 'set_my_account', 'set_my_wavespeed_key', 'snapshot_my_data_phase2',
           'unlock_admin_with_backup_code', 'unlock_with_backup_code', 'verify_admin')
     and has_function_privilege('anon', p.oid, 'EXECUTE') and has_function_privilege('authenticated', p.oid, 'EXECUTE')
     and has_function_privilege('service_role', p.oid, 'EXECUTE');
  out := out || case when v_kept = v_expect then 'ok callers-kept; ' else format('FAIL callers-kept %s (expected %s); ', v_kept, v_expect) end;
  select count(*) into v_ro from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where p.prosecdef and n.nspname = 'public' and has_function_privilege('supabase_read_only_user', p.oid, 'EXECUTE');
  out := out || case when v_ro = 0 then 'ok read-only-none; ' else format('FAIL read-only-none %s; ', v_ro) end;

  raise exception 'RESULT: %', out;
end $t$;
