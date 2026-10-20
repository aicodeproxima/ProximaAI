-- create_auto_backup() is SECURITY DEFINER, had no search_path and was executable by anon: anyone with the public
-- key could call it 30 times and push every real 2-day backup out of its 30-per-user retention (review
-- wf_8443c1d0-93e, 2026-10-20). Only the pg_cron job (runs as postgres) needs it.
revoke execute on function public.create_auto_backup() from public, anon, authenticated;
alter function public.create_auto_backup() set search_path = public, pg_catalog;

-- Tidy-up: trigger functions are not callable as RPCs, but they need no browser grant either.
revoke execute on function public._settings_drop_secrets() from public, anon, authenticated;
revoke execute on function public._backups_strip_secrets() from public, anon, authenticated;
alter function public._settings_drop_secrets() set search_path = public, pg_catalog;
alter function public._backups_strip_secrets() set search_path = public, pg_catalog;
