-- Rollback of supabase/migrations/20261025450000_mu_p4_account_id_keys_a.sql (exact inverse). Kept OUT of
-- supabase/migrations/. It refuses after step (c) (a primary key that is no longer (id)). It CANNOT see step (b): once
-- the client names on_conflict "device_id,id", dropping these indexes makes every upsert fail with 42P10, so revert the
-- client first, or check the edge logs for on_conflict=device_id,id before running it (review round 5).
set local lock_timeout = '5s';   -- a rollback that cannot take its locks within 5 s stops instead of queueing the app

do $rb$
begin
  if exists (select 1 from pg_constraint c
              where c.conrelid in ('public.tasks'::regclass, 'public.history'::regclass, 'public.favorites'::regclass)
                and c.contype = 'p' and pg_get_constraintdef(c.oid) <> 'PRIMARY KEY (id)') then
    raise exception 'refusing the step (a) rollback: a primary key is no longer (id) (step c has run)';
  end if;
end $rb$;

drop index public.tasks_device_id_id_key;
drop index public.history_device_id_id_key;
drop index public.favorites_device_id_id_key;
set local lock_timeout to default;   -- the 5 s limit covers this rollback only

-- The migration's own record goes with it, in the same transaction, so a later apply re-applies it.
delete from supabase_migrations.schema_migrations where version = '20261025450000' and name = 'mu_p4_account_id_keys_a';
