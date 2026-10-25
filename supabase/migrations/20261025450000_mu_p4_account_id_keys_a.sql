-- Multi-user P4, per-account id keys, step (a) of three (agreed with the lockdown session 2026-10-25; the "Open (P4)"
-- section of docs/rls-review-context.md): tasks, history and favorites get a unique index on (device_id, id), so the
-- client's upserts can name that key (step b, the lockdown session: onConflict "device_id,id" in src/lib/supabase.js).
-- id stays unique on its own (each table's primary key) until step (c) swaps the primary keys, 24 h after the edge logs
-- last show an upsert naming on_conflict=id (favorites name no key at all: syncFavorite falls back to the primary key).
-- One behaviour changes until (c) (review round 5): an upsert's ON CONFLICT handles only its arbiter index, so two
-- upserts of the same brand-new id in one scope at the same instant can now end with 23505 on the other unique index
-- instead of one turning into an update; the client's failed-sync queue retries it. Live 2026-10-25: 22 tasks, 13 History
-- and 0 favorite rows, all in the owner's scope, so each index builds in milliseconds.
-- Rollback: supabase/rollback/20261025450000_mu_p4_account_id_keys_a.rollback.sql
set local lock_timeout = '5s';   -- an apply that cannot take its locks within 5 s stops instead of queueing the app

create unique index tasks_device_id_id_key on public.tasks (device_id, id);
create unique index history_device_id_id_key on public.history (device_id, id);
create unique index favorites_device_id_id_key on public.favorites (device_id, id);

set local lock_timeout to default;   -- the 5 s limit covers this migration only, not what runs after it in one transaction
