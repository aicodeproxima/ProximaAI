-- Secrets lockdown, final cleanup (after the client cut-over shipped, 2026-10-20). Removes the old copies that
-- the public anon key could read:
--  * settings.apiKey (the WaveSpeed key now lives only in user_secrets, read by the proxy),
--  * the `_account` scope (username, unsalted sha256 password hash, email: replaced by app_secrets + bcrypt),
--  * the key inside existing backup snapshots (new ones are stripped by the backups_strip_secrets trigger).
-- data_backups is reached only through the token-checked *_phase2 RPCs and the pg_cron job (both SECURITY
-- DEFINER), so the browser roles lose direct access; app_secrets and user_secrets already had no policies,
-- and lose their table grants as a second lock.

delete from public.settings where key = 'apiKey';
delete from public.settings where device_id = '_account';
update public.data_backups set settings_snapshot = settings_snapshot - 'apiKey' where settings_snapshot ? 'apiKey';

drop policy if exists "Anon all data_backups" on public.data_backups;
revoke all on table public.data_backups from anon, authenticated;
revoke all on table public.app_secrets  from anon, authenticated;
revoke all on table public.user_secrets from anon, authenticated;
