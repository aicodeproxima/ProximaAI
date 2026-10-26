-- Rollback for supabase/migrations/20261025900000_form_inputs_newest_wins.sql: form-inputs:% rows go back to "the last
-- write to arrive wins" (no PT409 refusals). Nothing else changed. Run with sb-query.mjs --write -f (one transaction).
drop trigger settings_form_inputs_newest on public.settings;
drop function public._settings_form_inputs_newest();
delete from supabase_migrations.schema_migrations where version = '20261025900000' and name = 'form_inputs_newest_wins';
