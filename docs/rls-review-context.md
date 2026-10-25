# Review context: ProximaAI per-session RLS (live since 2026-10-22)

Read by scripts/review/rls-review.workflow.js (`args.context` can point at a copy edited for a new change; add the new
change's files, commits and accepted items, keep the rules).

Goal: nobody without a valid ProximaAI session reads, changes or deletes the owner's rows in public.tasks / history /
settings / favorites / presets / sync_tombstones or the files in storage bucket 'generations' (public GETs stay public).
Accounts live in proxima_auth.users since P1's M1 (owner only until P5); identity = HMAC session token ('u:<uuid>', or
'admin:<owner name>' until M4) verified by public._verify_session_token and resolved by proxima_auth.current_account;
not Supabase Auth.

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
- P1 M2 (RLS session) — supabase/migrations/20261023200000_mu_p1_scope_topic.sql (applied 2026-10-23 08:21:35 UTC,
  after the lockdown session's M1 20261023100000): session_scope takes the account from proxima_auth.current_account,
  so 'u:<uuid>' tokens work ('admin:<owner name>' ones did too until the lockdown session's M4, 20261023400000,
  applied 2026-10-23 21:14:04 UTC, ended them; session_scope needed no change), and it returns the account's
  proxima_auth.users.scope (the owner's is still 'user:<name>'); the 28000 wrapper and its messages are unchanged.
  sync_topic hashes the owner row's name and sessions_valid_after + 1: the old text while the owner row has not moved
  since M1, else one rotation that the next reconcile picks up. One topic, the owner's, until P4. Rollback
  supabase/rollback/20261023200000_*.rollback.sql (refuses while M3 is live; M1's rollback refuses while M2 is live).
- Scoped tombstones (lockdown session) — supabase/migrations/20261023500000_tombstone_rowless_scoped.sql (applied
  2026-10-23 21:30:50 UTC): a delete or clear records a tombstone for every id it names, in the caller's own scope, even
  when no row exists; _rows_not_tombstoned (now SECURITY INVOKER) drops an insert or upsert of a tombstoned id only within
  that scope, and when row security is active and the row's scope is not the session's it returns before its advisory
  lock, so the RLS check decides. While sync_tombstones' key is (id), a rowless tombstone is inserted on conflict (id) do
  nothing, so one account can never move another's tombstone. Live probe after the apply: no header 28000, forged token
  28000, another account 42501, own tombstoned id 0 rows, fresh id 1 row. Test: scripts/test-tombstone-rowless-db.sql.
- History strip (lockdown session; RLS-reviewed) — supabase/migrations/20261024100000_history_strip_restore_removed.sql
  (applied 2026-10-23 22:31:54 UTC): a History upload loses the items a restore removed (by_restore task tombstones in
  the entry's scope) unless the stored entry already holds them. Its review closed the History twin of the tombstone
  oracle: the emptied-new-entry branch of _history_strip_deleted_items wrote a History tombstone and returned NULL before
  the row policies' WITH CHECK, so a sessionless or other-account insert naming another scope wrote tombstones there and
  revealed which ids were tombstoned. Now a browser role (read from the role GUC, as the function is SECURITY DEFINER)
  naming a scope other than its session's gets an error (session_scope(true) → 28000, else 42501). This holds on the
  direct REST path and through the definer RPC upsert_queued_history, where no policy runs. The "no stored entry" check
  is scoped too. Live probe 2026-10-25: no header 28000, forged token 28000, another account 42501, own session
  tombstone, nothing written into a foreign scope. Tests: scripts/test-history-strip-restore-db.sql (R10a-d, R11).
- Related: 08e2bb2 (deleteArchivedPath true only when Storage confirms), 1bd2e68 (clear*Remote → {ok, error}).

## Accepted — do not re-report
- Until P4 changes sync_tombstones' key to (device_id, id): if account A writes a row with an id that account B already
  tombstoned, A's later delete records no tombstone of its own (its insert yields to B's on conflict (id)), so another
  of A's devices could upload it again. Ids are crypto.randomUUID(); this needs deliberate id reuse.
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
scripts/test-rls-{phase0,tables,storage,triggers,plan,rpcs,rename}.sql; P1 M2: scripts/test-mu-scope-topic.sql (38
checks: both token formats, two accounts' rows, the topic; failing-first with M1 alone 22/14) and
test-mu-scope-topic-rollback.sql (13), with scripts/fixtures/mu-owner-{unlock,rename}.sql moving the owner between M1
and M2 (M2 must still apply); rollback proof =
test-rls-rollback-before.sql + phase-2 migration + its rollback + test-rls-rollback.sql in ONE call;
test-rls-phase0-rollback.sql likewise; for an applied migration the order is before + its rollback + the migration + test-rls-grants-unchanged.sql (the pre-apply
form: before + migration + rollback); the DELETE revoke's = test-rls-rollback-before.sql + 20261022350000 + its
rollback + test-rls-grants-unchanged.sql. scripts/test-rls-queued-rpcs.sql: the restore-checked delete RPCs refuse 6 bad
tokens each, a valid token reaches only its own scope, _clear_kind is closed to browser roles (32 checks; failing-first
with 3 planted defects → 11 FAIL). The other features' SQL tests (scripts/test-*-db.sql: ws-webhook,
ws-webhook-deleted, backup-scrub, backup-switch-off, history-strip, history-emptied, queued-deletes, paths-in-use,
public-execute, restore-scrub, scrub-live, tombstone-rowless, history-strip-restore) must stay green too.

## Rules for reviewers
Query the live database with `node scripts/tools/sb-query.mjs "<select>"` or `--write -f <file.sql>` (Management API,
no prompts; one call = one transaction). Only SELECTs on pg_catalog / information_schema / pg_get_functiondef /
pg_policies / count(*), OR a DO block that ENDS IN `raise exception 'RESULT: ...'` (rolls everything back). Never select
prompts/outputs/rows from public.* or storage.* (counts only), never print tokens, never run anything that commits,
never apply migrations, never edit files. Report only confirmed defects with a concrete failure scenario at file:line.
