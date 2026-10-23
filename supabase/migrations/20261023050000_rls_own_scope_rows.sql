-- Row policies admit only the session's own rows (multi-user plan P4 gate G1, moved forward: it needs nothing from P1,
-- because session_scope already returns the account's scope, for both token formats from M2 on). Until now every read,
-- update and delete policy admitted any valid session. With one account every live row is in the owner's scope
-- (checked 2026-10-23; the only other row is a 2026-05 audit probe in settings that the app never reads), so the owner
-- sees no change; from P1 on, a member's token can only ever reach that member's own rows. Writes were already pinned
-- (WITH CHECK device_id = scope); UPDATE keeps its WITH CHECK. The DELETE policies stay as a second guard behind the
-- revoked DELETE grant (20261022350000). Storage (G2) waits for P3's per-account folders.
-- Rollback: supabase/rollback/20261023050000_rls_own_scope_rows.rollback.sql
alter policy tasks_session_select on public.tasks using (device_id = (select proxima_auth.session_scope(true)));
alter policy tasks_session_update on public.tasks using (device_id = (select proxima_auth.session_scope(true)));
alter policy tasks_session_delete on public.tasks using (device_id = (select proxima_auth.session_scope(true)));
alter policy history_session_select on public.history using (device_id = (select proxima_auth.session_scope(true)));
alter policy history_session_update on public.history using (device_id = (select proxima_auth.session_scope(true)));
alter policy history_session_delete on public.history using (device_id = (select proxima_auth.session_scope(true)));
alter policy settings_session_select on public.settings using (device_id = (select proxima_auth.session_scope(true)));
alter policy settings_session_update on public.settings using (device_id = (select proxima_auth.session_scope(true)));
alter policy settings_session_delete on public.settings using (device_id = (select proxima_auth.session_scope(true)));
alter policy favorites_session_select on public.favorites using (device_id = (select proxima_auth.session_scope(true)));
alter policy favorites_session_update on public.favorites using (device_id = (select proxima_auth.session_scope(true)));
alter policy favorites_session_delete on public.favorites using (device_id = (select proxima_auth.session_scope(true)));
alter policy presets_session_select on public.presets using (device_id = (select proxima_auth.session_scope(true)));
alter policy presets_session_update on public.presets using (device_id = (select proxima_auth.session_scope(true)));
alter policy presets_session_delete on public.presets using (device_id = (select proxima_auth.session_scope(true)));
alter policy sync_tombstones_session_select on public.sync_tombstones using (device_id = (select proxima_auth.session_scope(true)));
