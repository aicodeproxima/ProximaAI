-- Review round 2 (2026-10-22): these security definer RPCs were executable through PUBLIC (Postgres grants EXECUTE to
-- PUBLIC on every new function; their migrations granted the callers but never revoked it). So every role could call
-- them, the read-only role behind scripts/tools/sb-query.mjs included, and verify_admin / unlock_admin_with_backup_code
-- count failed attempts. Each already has explicit grants for anon, authenticated, service_role and postgres (the app,
-- the proxy, Hermes, cron), which stay. Guarded by scripts/test-public-execute-db.sql.
revoke execute on function public.change_my_password(text, text, text) from public;
revoke execute on function public.delete_my_backup_phase2(text, uuid) from public;
revoke execute on function public.get_my_account(text) from public;
revoke execute on function public.list_my_backups_phase2(text, integer) from public;
revoke execute on function public.rename_my_account(text, text, text) from public;
revoke execute on function public.restore_my_backup_phase2(text, uuid) from public;
revoke execute on function public.set_admin_backup_code(text, text, text) from public;
revoke execute on function public.set_admin_credentials_rehash(text, text) from public;
revoke execute on function public.set_my_account(text, text, boolean, bigint) from public;
revoke execute on function public.set_my_wavespeed_key(text, text) from public;
revoke execute on function public.snapshot_my_data_phase2(text, text, text) from public;
revoke execute on function public.unlock_admin_with_backup_code(text, text) from public;
revoke execute on function public.verify_admin(text, text) from public;
