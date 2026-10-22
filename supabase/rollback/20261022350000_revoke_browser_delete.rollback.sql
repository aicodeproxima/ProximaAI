-- Rollback of supabase/migrations/20261022350000_revoke_browser_delete.sql (exact inverse; proven with
-- scripts/test-rls-rollback-before.sql + migration + this file + scripts/test-rls-grants-unchanged.sql in one call).
-- Kept OUT of supabase/migrations/ so `supabase db push` never applies it.
grant delete on public.tasks, public.history, public.settings, public.favorites, public.presets to anon, authenticated;
