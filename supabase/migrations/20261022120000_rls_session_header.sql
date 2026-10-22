-- Phase 2: nobody without a valid ProximaAI session reads, changes or deletes the owner's rows or files (design: judge
-- panel wf_89f53ef9-80f, approach A). Needs phase 0 (20261022100000: proxima_auth.session_scope) and the phase-1 client
-- (every REST/Storage request sends x-proxima-session; edge_logs marker "proxima-rls/1 sess/1") on every device first.
--
-- Five data tables, every command strict: no header -> 28000 'session token missing' (HTTP 403), so a stale client can
-- neither read an empty answer as "nothing there" nor have a write or delete succeed silently with nothing done. (A
-- lenient read policy was tested and rejected: Postgres may evaluate the SELECT policy's qual before the command's, so a
-- headerless update/delete could filter to 0 rows without raising. Nothing headerless reads these tables: tasks/history
-- leave the Realtime publication below, and cron/RPCs/triggers run as postgres, which bypasses RLS.) USING is "any valid session" (single admin: only the live username's token
-- verifies), which keeps ON CONFLICT DO UPDATE rescues of another scope's row into the live scope working
-- (_rows_keep_owner); WITH CHECK pins every new or updated row to the session's own scope.
-- sync_tombstones: browsers only read it; the SECURITY DEFINER triggers (owner postgres, BYPASSRLS) write it.
-- Storage bucket 'generations': reads lenient (no header -> empty list), writes strict; bucket-wide, no folder check (rename_my_account does not move objects; deleting a
-- generation removes uploads/<old scope>/... too). Public GET /object/public/... bypasses RLS (measured), so <img>, <video>
-- and WaveSpeed's fetches of uploaded inputs keep working; list/upload/overwrite/delete need a session.
-- Realtime: tasks/history leave supabase_realtime (the client listens to the content-free ping since phase 1), which
-- ends the primary-key-only DELETE events that reached anyone holding the publishable key.
-- service_role (proxy, webhook) and postgres (pg_cron, SECURITY DEFINER RPCs/triggers) bypass RLS: unchanged.
-- Rollback: supabase/rollback/20261022120000_rls_session_header.rollback.sql (tested as an exact inverse).

do $mig$
declare t text;
begin
  foreach t in array array['tasks','history','settings','favorites','presets'] loop
    execute format('drop policy if exists %I on public.%I', t || '_device_access', t);
    execute format('create policy %I on public.%I for select to anon, authenticated
                      using ((select proxima_auth.session_scope(true)) is not null)', t || '_session_select', t);
    execute format('create policy %I on public.%I for insert to anon, authenticated
                      with check (device_id = (select proxima_auth.session_scope(true)))', t || '_session_insert', t);
    execute format('create policy %I on public.%I for update to anon, authenticated
                      using ((select proxima_auth.session_scope(true)) is not null)
                      with check (device_id = (select proxima_auth.session_scope(true)))', t || '_session_update', t);
    execute format('create policy %I on public.%I for delete to anon, authenticated
                      using ((select proxima_auth.session_scope(true)) is not null)', t || '_session_delete', t);
  end loop;
end $mig$;

drop policy if exists sync_tombstones_device_access on public.sync_tombstones;
create policy sync_tombstones_session_select on public.sync_tombstones for select to anon, authenticated
  using ((select proxima_auth.session_scope(true)) is not null);
revoke insert, update, delete on public.sync_tombstones from anon, authenticated;

-- Table privileges that bypass RLS or that the app never uses (relacl before: arwdDxtm for anon and authenticated).
revoke truncate, references, trigger, maintain
  on public.tasks, public.history, public.settings, public.favorites, public.presets, public.sync_tombstones
  from anon, authenticated;

drop policy if exists "Public read generations" on storage.objects;
drop policy if exists "Anon upload generations" on storage.objects;
drop policy if exists "Anon update generations" on storage.objects;
drop policy if exists "Anon delete generations" on storage.objects;
create policy "generations session select" on storage.objects for select to anon, authenticated
  using (bucket_id = 'generations' and (select proxima_auth.session_scope(false)) is not null);
create policy "generations session insert" on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'generations' and (select proxima_auth.session_scope(true)) is not null);
create policy "generations session update" on storage.objects for update to anon, authenticated
  using (bucket_id = 'generations' and (select proxima_auth.session_scope(true)) is not null)
  with check (bucket_id = 'generations' and (select proxima_auth.session_scope(true)) is not null);
create policy "generations session delete" on storage.objects for delete to anon, authenticated
  using (bucket_id = 'generations' and (select proxima_auth.session_scope(true)) is not null);

alter publication supabase_realtime drop table public.tasks, public.history;
