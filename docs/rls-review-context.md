# Review context: ProximaAI per-session RLS (live since 2026-10-22)

Read by scripts/review/rls-review.workflow.js (`args.context` can point at a copy edited for a new change; add the new
change's files, commits and accepted items, keep the rules).

Goal: nobody without a valid ProximaAI session reads, changes or deletes the owner's rows in public.tasks / history /
settings / favorites / presets / sync_tombstones or the files in storage bucket 'generations' (public GETs stay public).
Single admin; identity = HMAC session token (public._verify_session_token), not Supabase Auth.

## What is live (design: judge panel wf_89f53ef9-80f, header-token RLS won 3/3 over a minted JWT and RPC-only)
- Phase 0 — supabase/migrations/20261022100000_rls_phase0_session_helpers.sql (2efff92):
  proxima_auth.session_scope(p_required) reads x-proxima-session from request.headers and verifies it once per statement
  (InitPlan) → 'user:<name>' / NULL / 28000; proxima_auth.sync_topic(); statement-level ping triggers on tasks/history;
  get_my_account returns sync_topic. Schema proxima_auth is not exposed by PostgREST.
- Phase 1 — client (158cc18): src/lib/session.js withSessionHeader (header on /rest/v1 and /storage/v1 only; local 401
  when signed out; edge-log marker "proxima-rls/1 sess/1|0"), src/lib/syncPing.js + supabase.js (ping replaces
  postgres_changes), public/sw.js v7.
- Phase 2 — supabase/migrations/20261022120000_rls_session_header.sql (eb5c980): all five data tables strict for every
  command (read included: a lenient read policy may be evaluated before the command's, letting a headerless
  update/delete match 0 rows silently); WITH CHECK device_id = session scope; sync_tombstones read-only for browsers;
  TRUNCATE/REFERENCES/TRIGGER/MAINTAIN revoked; storage reads lenient (no header → empty list), writes strict;
  tasks/history removed from the Realtime publication. Rollbacks: supabase/rollback/ (exact inverse, tested).
- DELETE revoke — supabase/migrations/20261022350000_revoke_browser_delete.sql (777f7f1): anon/authenticated hold no
  DELETE on tasks/history/settings/favorites/presets. Every app delete goes through the restore-checked SECURITY DEFINER
  RPCs (delete_queued_rows / clear_queued_rows / reset_queued_rows, scoped to the session's device_id); a plain REST
  delete fails with 42501 (HTTP 401) before any policy runs. The strict DELETE policies stay as a second guard.
- Own-scope rows — supabase/migrations/20261023050000_rls_own_scope_rows.sql (3961a3d, applied 2026-10-23 04:43:16 UTC):
  every select/update/delete policy uses USING (device_id = session_scope), so a session reads and changes only its own
  rows; an upsert colliding with another scope's row is refused (42501 "USING expression"), never "rescued".
- Related: 08e2bb2 (deleteArchivedPath true only when Storage confirms), 1bd2e68 (clear*Remote → {ok, error}).

## Accepted — do not re-report
- Tombstone oracle: a sessionless INSERT of a tombstoned id returns 0 rows (BEFORE trigger _rows_not_tombstoned returns
  NULL before the RLS check) while other ids raise 28000. Ids are crypto.randomUUID(); a caller must already know one.
- An expired-token holder keeps receiving content-free pings until the topic rotates (rename, password change, unlock,
  key rotation). Pings carry nothing.
- Bucket-wide storage access for a valid session (rename leaves files in the old folder; the delete flow must reach
  them); P3/P4 add per-account folders. Rows are deleted only by the scoped RPCs, never by a browser role directly.
- Rolling back phase 0 while the phase-1 client is live stops instant updates; the 20 s / focus reconcile remains.
- The policies trust session_signing_key: a holder of that key can mint valid sessions (rotation is the remedy).
- Owner-run maintenance with the service role (scripts/tools/supabase-admin.mjs) bypasses the policies by design.

## Tests
JS: scripts/test-session-header.mjs, test-sync-ping.mjs, test-storage-remove.mjs, test-remote-clears.mjs (npm test).
SQL, each rolls back (run alone against live; to test an unapplied migration, prepend its text in the same call):
scripts/test-rls-{phase0,tables,storage,triggers,plan,rpcs,rename}.sql; rollback proof =
test-rls-rollback-before.sql + phase-2 migration + its rollback + test-rls-rollback.sql in ONE call;
test-rls-phase0-rollback.sql likewise; the DELETE revoke's = test-rls-rollback-before.sql + 20261022350000 + its
rollback + test-rls-grants-unchanged.sql. scripts/test-rls-queued-rpcs.sql: the restore-checked delete RPCs refuse 6 bad
tokens each, a valid token reaches only its own scope, _clear_kind is closed to browser roles (32 checks; failing-first
with 3 planted defects → 11 FAIL). The other features' SQL tests (scripts/test-*-db.sql: ws-webhook,
ws-webhook-deleted, backup-scrub, backup-switch-off, history-strip, history-emptied, queued-deletes, paths-in-use,
public-execute, restore-scrub, scrub-live) must stay green too.

## Rules for reviewers
Query the live database with `node scripts/tools/sb-query.mjs "<select>"` or `--write -f <file.sql>` (Management API,
no prompts; one call = one transaction). Only SELECTs on pg_catalog / information_schema / pg_get_functiondef /
pg_policies / count(*), OR a DO block that ENDS IN `raise exception 'RESULT: ...'` (rolls everything back). Never select
prompts/outputs/rows from public.* or storage.* (counts only), never print tokens, never run anything that commits,
never apply migrations, never edit files. Report only confirmed defects with a concrete failure scenario at file:line.
