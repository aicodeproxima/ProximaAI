-- Rollback of supabase/migrations/20261022350000_revoke_browser_delete.sql (exact inverse; proven with
-- scripts/test-rls-rollback-before.sql + migration + this file + scripts/test-rls-grants-unchanged.sql in one call).
-- That order proves it while the migration is unapplied. Now that it is live, the other order: test-rls-rollback-before.sql
-- + this file + the migration + test-rls-grants-unchanged.sql (1/0 on 2026-10-23; this file alone then differs, 0/1).
-- Kept OUT of supabase/migrations/ so `supabase db push` never applies it.
grant delete on public.tasks, public.history, public.settings, public.favorites, public.presets to anon, authenticated;

-- The migration's own record goes with it, in the same transaction: a later apply-migration then
--   re-applies the migration instead of answering "already recorded" (lockdown session's M3 review, 2026-10-23).
delete from supabase_migrations.schema_migrations where version = '20261022350000' and name = 'revoke_browser_delete';
