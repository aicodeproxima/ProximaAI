-- Realtime DELETE events can't be filtered server-side; with FULL replica identity the old row
-- (including device_id) is included, so clients drop other scopes' deletes instead of re-syncing.
alter table public.tasks replica identity full;
alter table public.history replica identity full;
