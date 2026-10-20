-- Refines _rows_keep_owner (20261020000009) after regression review wf_184ec0f8-767 (2026-10-20). It blocked every
-- client device_id change, so a row a stale device had written under a renamed-away name could never be moved into
-- the live account: each reconcile pass re-uploaded it, the trigger silently kept the old scope, and the row never
-- synced. Now a client may move a row INTO the live account's scope from any other scope (heals orphans), but never
-- OUT of the live scope (still stops the rename ping-pong). rename_my_account's proxima.rescope flag still allows
-- everything.

create or replace function public._rows_keep_owner() returns trigger
language plpgsql set search_path = public, pg_catalog as $$
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
