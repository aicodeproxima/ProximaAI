-- Rollback of supabase/migrations/20261022120000_rls_session_header.sql: restores the policies, grants and Realtime
-- publication measured on 2026-10-21 exactly (scripts/test-rls-rollback.sql proves it with a catalog diff). Kept OUT of
-- supabase/migrations/ so that `supabase db push` never applies it. Phase-0 objects stay; the phase-1 client works
-- against either policy set (it sends the header; the open policies ignore it). No client revert is needed.
do $rb$
declare t text;
begin
  foreach t in array array['tasks','history','settings','favorites','presets'] loop
    execute format('drop policy if exists %I on public.%I', t || '_session_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_session_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_session_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_session_delete', t);
    execute format('create policy %I on public.%I as permissive for all to anon using (true) with check (true)',
                   t || '_device_access', t);
  end loop;
end $rb$;
drop policy if exists sync_tombstones_session_select on public.sync_tombstones;
create policy sync_tombstones_device_access on public.sync_tombstones as permissive for all to anon using (true) with check (true);
grant insert, update, delete on public.sync_tombstones to anon, authenticated;
grant truncate, references, trigger, maintain
  on public.tasks, public.history, public.settings, public.favorites, public.presets, public.sync_tombstones
  to anon, authenticated;
drop policy if exists "generations session select" on storage.objects;
drop policy if exists "generations session insert" on storage.objects;
drop policy if exists "generations session update" on storage.objects;
drop policy if exists "generations session delete" on storage.objects;
create policy "Public read generations" on storage.objects for select to anon using (bucket_id = 'generations');
create policy "Anon upload generations" on storage.objects for insert to anon with check (bucket_id = 'generations');
create policy "Anon update generations" on storage.objects for update to anon using (bucket_id = 'generations');
create policy "Anon delete generations" on storage.objects for delete to anon using (bucket_id = 'generations');
alter publication supabase_realtime add table public.tasks, public.history;
