-- Review round 9 (2026-10-22): the restore marker (settings 'last_restore_at') decides which delete intents a restore
-- voids, but any browser role with a session could delete or overwrite it like any other setting: Reset's settings
-- clear deleted it, and the next queued delete re-created it as '0', so intents queued before that restore ran after
-- all. Only server functions write it now (restore, rename, the queued-delete functions, all security definer and owned
-- by postgres): for the browser roles a change to that row is skipped, silently, so a bulk settings delete from an older
-- bundle still removes the other keys. Test: test-queued-deletes-db.sql case marker-server-only.
create or replace function public._settings_marker_server_only()
returns trigger language plpgsql set search_path = public, pg_catalog as $$
begin
  if current_user in ('anon', 'authenticated')
     and ((tg_op <> 'INSERT' and old.key = 'last_restore_at') or (tg_op <> 'DELETE' and new.key = 'last_restore_at')) then
    return null;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
revoke execute on function public._settings_marker_server_only() from public;
drop trigger if exists settings_marker_server_only on public.settings;
create trigger settings_marker_server_only before insert or update or delete on public.settings
  for each row execute function public._settings_marker_server_only();
