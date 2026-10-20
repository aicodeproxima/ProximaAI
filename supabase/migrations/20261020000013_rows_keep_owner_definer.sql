-- _rows_keep_owner (20261020000009/10) reads the live username from app_secrets, but ran as the calling role. Clients
-- are anon, and anon has no access to app_secrets since 20261020000007, so every upsert that updated an existing
-- tasks / history / favorites row failed with "permission denied for table app_secrets" (HTTP 401): re-uploads,
-- recovered tasks, archive updates, favorite toggles. Measured 2026-10-20: 119 failures from 20:36:27 UTC on the
-- owner's phone. The trigger tests had run as postgres, which can read app_secrets.
-- Now SECURITY DEFINER (body unchanged): it reads that one value with its owner's rights and returns only the row.
create or replace function public._rows_keep_owner() returns trigger
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_live text := 'user:' || (select value->>'username' from app_secrets where key = 'admin_username');
begin
  if new.device_id is distinct from old.device_id
     and coalesce(current_setting('proxima.rescope', true), '') <> 'on'
     and not (new.device_id = v_live and old.device_id is distinct from v_live) then
    new.device_id := old.device_id;   -- silent: the caller's upsert still succeeds, so its retry queue settles
  end if;
  return new;
end $$;

revoke execute on function public._rows_keep_owner() from public, anon, authenticated;
