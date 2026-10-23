-- Rollback of supabase/migrations/20261023050000_rls_own_scope_rows.sql (exact inverse; proven with
-- scripts/test-rls-rollback-before.sql + migration + this file + scripts/test-rls-grants-unchanged.sql in one call).
-- That order proves it while the migration is unapplied. Now that it is live, the other order: test-rls-rollback-before.sql
-- + this file + the migration + test-rls-grants-unchanged.sql (1/0 on 2026-10-23; this file alone then differs, 0/1).
-- Kept OUT of supabase/migrations/ so `supabase db push` never applies it.
alter policy tasks_session_select on public.tasks using ((select proxima_auth.session_scope(true)) is not null);
alter policy tasks_session_update on public.tasks using ((select proxima_auth.session_scope(true)) is not null);
alter policy tasks_session_delete on public.tasks using ((select proxima_auth.session_scope(true)) is not null);
alter policy history_session_select on public.history using ((select proxima_auth.session_scope(true)) is not null);
alter policy history_session_update on public.history using ((select proxima_auth.session_scope(true)) is not null);
alter policy history_session_delete on public.history using ((select proxima_auth.session_scope(true)) is not null);
alter policy settings_session_select on public.settings using ((select proxima_auth.session_scope(true)) is not null);
alter policy settings_session_update on public.settings using ((select proxima_auth.session_scope(true)) is not null);
alter policy settings_session_delete on public.settings using ((select proxima_auth.session_scope(true)) is not null);
alter policy favorites_session_select on public.favorites using ((select proxima_auth.session_scope(true)) is not null);
alter policy favorites_session_update on public.favorites using ((select proxima_auth.session_scope(true)) is not null);
alter policy favorites_session_delete on public.favorites using ((select proxima_auth.session_scope(true)) is not null);
alter policy presets_session_select on public.presets using ((select proxima_auth.session_scope(true)) is not null);
alter policy presets_session_update on public.presets using ((select proxima_auth.session_scope(true)) is not null);
alter policy presets_session_delete on public.presets using ((select proxima_auth.session_scope(true)) is not null);
alter policy sync_tombstones_session_select on public.sync_tombstones using ((select proxima_auth.session_scope(true)) is not null);

-- The migration's own record goes with it, in the same transaction: a later apply-migration then
--   re-applies the migration instead of answering "already recorded" (lockdown session's M3 review, 2026-10-23).
delete from supabase_migrations.schema_migrations where version = '20261023050000' and name = 'rls_own_scope_rows';
