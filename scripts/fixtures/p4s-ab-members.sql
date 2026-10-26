-- Fixture for scripts/test-mu-p4-ab-rollback.sql, run between 20261025800000 and its rollback (rolled back with the rest):
-- member M has its own Automatic backups switch on, member N has it off, the owner's is as it is. Each has a backup
-- holding a generation it then deletes: M's delete queues no scrub (switch on), N's queues one. Records the owner's
-- switch and the global row's fingerprint for the test.
do $fx$
declare
  m uuid := '00000000-0000-4000-8000-0000000000f1'; n uuid := '00000000-0000-4000-8000-0000000000f2';
begin
  insert into proxima_auth.users (id, username, role, scope, auto_backups) values
    (m, '__ab_rb_m', 'member', 'user:__ab_rb_m', true), (n, '__ab_rb_n', 'member', 'user:__ab_rb_n', false);
  insert into public.tasks (id, device_id, status, start_time, outputs) values
    ('abrb-m', 'user:__ab_rb_m', 'completed', 1, '[]'), ('abrb-n', 'user:__ab_rb_n', 'completed', 1, '[]');
  insert into public.data_backups (username, backup_type, task_count, tasks_snapshot)
    select t.device_id, 'manual', 1, jsonb_build_array(row_to_json(t)) from public.tasks t where t.id in ('abrb-m', 'abrb-n');
  delete from public.tasks where id in ('abrb-m', 'abrb-n');
  -- As apply-migration.mjs records it, so the test can see the rollback delete its own record.
  insert into supabase_migrations.schema_migrations (version, name, statements)
    values ('20261025800000', 'mu_p4_auto_backups_per_account', array['(recorded by the test fixture)']);
  perform set_config('p4ab.owner_switch', public._auto_backups_on()::text, true);
  perform set_config('p4ab.updated_before',
    coalesce((select s.updated_at::text from public.app_secrets s where s.key = 'auto_backups'), 'none'), true);
  perform set_config('p4ab.row_before',
    coalesce((select md5(s.value::text || s.updated_at::text) from public.app_secrets s where s.key = 'auto_backups'), 'none'), true);
  perform set_config('p4ab.queued_m', (select count(*) from public.backup_scrub_queue where username = 'user:__ab_rb_m')::text, true);
  perform set_config('p4ab.queued_n', (select count(*) from public.backup_scrub_queue where username = 'user:__ab_rb_n')::text, true);
end $fx$;
