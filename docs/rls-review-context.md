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
- Storage folders (P4, RLS session) — supabase/migrations/20261025100000_mu_p4_storage_folders.sql (applied 2026-10-25 20:18:55 UTC):
  every "generations session *" policy asks for the object's account folder, `proxima_auth.object_folder(name)`
  ('<folder>/…' archives, 'uploads/<folder>/…' inputs; plain SQL the planner inlines) = any (`my_folders`), so a session
  lists, writes, moves and deletes only its own account's files. `proxima_auth.account_folders` records every folder an
  account has had (trigger on users.scope; a folder never changes hands: 23505, or a counted `username_taken` in
  rename_my_account); seeded with every folder that already held a file; the migration refuses on a file outside every
  folder, or (several accounts) a member's folder holding files from before that member.
- Live topic per account (P4, RLS session) — 20261025200000_mu_p4_topic_per_account.sql (applied 2026-10-25 20:19:49 UTC):
  `proxima_auth.account_topic` (the owner keeps M2's input, so its value did not change; a member's input carries its
  account id); ping_sync sends one ping per account whose rows the statement changed (none to disabled or deleted
  accounts); get_my_account returns each account's own topic.
- Tombstones per account (P4, RLS session) — 20261025300000_mu_p4_tombstone_key.sql (applied 2026-10-25 20:20:13 UTC): sync_tombstones
  is keyed (device_id, id); the delete paths (delete_queued_rows, _clear_kind) look for an existing tombstone, task row
  or History row of a named id in the caller's own scope only, and every ON CONFLICT on tombstones targets
  (device_id, id). Each account keeps its own tombstone of an id, so one account's tombstone never stops another's.
- Squat-proof backups (P4, RLS session) — 20261025400000_mu_p4_squat_proof_backups.sql (applied 2026-10-25 21:10:58
  UTC; review rounds 3-7): `_drain_backup_scrubs` and the restore's scrub judge gone/live in the account's own rows; the
  restore leaves out snapshot ids another account holds (counted as `skipped_in_use`), never scrubs what its restored
  snapshot holds, and keeps the account's tombstones of the ids it leaves out.
- Per-account id keys, step (a) (P4, RLS session) — 20261025450000_mu_p4_account_id_keys_a.sql (applied 2026-10-25
  21:11:16 UTC): unique indexes (device_id, id) on tasks, history and favorites, for the client's step (b).
- Automatic backups per account (P4, RLS session) — 20261025800000_mu_p4_auto_backups_per_account.sql (applied
  2026-10-26 06:07:28 UTC; review rounds 8-21, 3 critics each): each account has its own switch,
  `proxima_auth.users.auto_backups`, seeded from the old global row (app_secrets 'auto_backups', no longer read), so the
  owner's value did not change. The scrub triggers leave out only the rows of accounts whose own switch is on (a scope
  without an account row counts as off); the 2-day cron backs up each switched-on account that has generations and is
  neither disabled nor deleted, and one account's error is a WARNING naming the account by id that never stops the
  others; switching off scrubs only the caller's own backups, and switching on first runs a switch-off's scrub still
  queued (drained later it would reach what is deleted while on; if it cannot run, the switch stays off: try again in a
  minute); pre-* and pre-restore safety backups and the restore's scrub follow the caller's switch. get/set_auto_backups
  answer every signed-in account about its own switch (before: the owner only, members 42501).
- Backups hold their account row (P4, RLS session) — 20261025820000_backups_hold_account_row.sql (applied 2026-10-26
  06:10:55 UTC; review rounds lk1 and 11-21, 3 critics each): the 2-day backup and snapshots take FOR KEY SHARE on the
  account row before their INSERT and write under the scope it has then, so a rename can no longer leave a backup under
  the old name (invisible, never scrubbed); a snapshot also checks its session again. Only a rename of that account
  waits while a backup is open (sign-in, unlock, re-auth and key saves take FOR NO KEY UPDATE since 20261025920000): one
  snapshot, about 65 ms at the snapshot limits; a 2-day run, up to about 3.3 s at 50 max-size accounts. The planned
  account deletion (P5: an UPDATE of users.deleted_at) does not wait for FOR KEY SHARE: it must lock the account row FOR
  UPDATE before deleting backups, as a rename does, or a backup still being written survives it (round 14).
- Backup scrubs per account (P4, RLS session) — 20261026200000_mu_p4_backup_scrubs_per_account.sql (applied 2026-10-27
  04:28:43 UTC; review round 24, 3 critics): the switch-off scrub that trims backed-up History entries to their live
  items builds each backup's History in one statement (the loop was quadratic: 2.8 seconds for 3 backups of 1000
  entries, now under 0.2; byte-equal to the loop on identical data, but an entry with a live row and no tasks key now
  stays); cron backup-scrub-drain calls the procedure _drain_backup_scrubs_job(), which drains one account per
  transaction with a 2 s lock wait, so no account's drain holds another's locks; rename_my_account takes the new name's
  sign-in key before its account row (as join_with_invite does), allows the names join allows, answers a unique
  violation its checks cannot see with a counted username_taken, and moves the account's queued scrubs.
- Gate: scripts/test-mu-matrix.sql (owner A vs seeded members, as anon with minted tokens: rows, files, folders,
  topics, tombstones, id squatting, id keys, every browser-callable data, backup and key function, Automatic
  backups per account; 81/0 live after 20261026200000) and scripts/test-mu-catalog.sql (13/0), with
  scripts/test-mu-invite-walls-db.sql (a member cannot create, list or revoke the owner's invites).
- Related: 08e2bb2 (deleteArchivedPath true only when Storage confirms), 1bd2e68 (clear*Remote → {ok, error}).

## Open (P4, in progress)
- Id squatting (review round 3 of the P4 walls): tasks, history and favorites keep a key of (id) across accounts, so a
  member who learns a deleted id (an archived output's public path carries its task id) can create a row with it. Before
  20261025400000 (live) that kept the deleted item in the other account's backups and failed that account's restores on
  the duplicate key; now the account's own rows decide, within the residual below. Root fix, agreed with the lockdown
  session 2026-10-25: (a, live 21:11:16 UTC) unique
  indexes on (device_id, id); (b) the client's upserts switch to onConflict "device_id,id"; (c) after 24 h with no
  on_conflict=id in the edge logs, the primary keys become (device_id, id) and every definer write path names that key.
  Step (c) checklist so far (P4 reviews rounds 4-5): upsert_queued_history's `on conflict (id)`; `_history_drop_emptied`
  deletes `where id = new.id`; 20261025400000's "left out because another account holds it" filters in the restore
  (with a test that both accounts keep their own row of one id); the webhook paths (ws_webhook_apply, ws_webhook_sweep,
  _tasks_take_webhook, _tasks_settle_webhook) key on task_id with no account; `_history_queue_item_scrub` joins old and
  new rows by id alone (`join became n on n.id = o.id`); syncFavorite (src/lib/supabase.js:442) names no onConflict, so
  the 24 h edge-log gate cannot see it (safe across the key swap, as it falls back to the primary key); the SQL suites'
  `on conflict (id)` on these tables (test-history-emptied, -history-strip-restore, -mu-alias-probe, -mu-matrix incl.
  its "held once, by A" id-key cases, -paths-in-use, -rls-phase0, -rls-plan, -rls-triggers, -tombstone-rowless,
  -ws-webhook) must move first; a PWA device closed more than 24 h can come back on an old bundle after (c): its
  uploads get 400 and stay queued until the service worker updates.
  Between (a) and (c): an upsert's ON CONFLICT handles only its arbiter index, so two upserts of one brand-new id in
  one scope at the same instant can end in 23505 instead of an update; the failed-sync queue retries it.
  Until (c), accepted (P4 review rounds 5-6): an id a restore leaves out because another account holds it stays deleted
  in the restoring account. Its tombstone stays, so that account's other devices drop it (deleting the tombstone made a
  lagging device re-upload it into a refused batch, round 6), and the restore's own scrub never removes its copies
  (round 4). A later all-tombstones scrub (switching that account's own Automatic backups off, since 20261025800000)
  applies that delete like any other, so those copies go then; for a left-out History entry, its items go the same way.
  Before 20261025400000 such a restore failed outright. Step (c) removes the left-out filters, the `v_skip_ids_*` lists
  and `skipped_in_use` together; the keep-list (`v_keep_t` / `v_keep_h`) can stay. Webhook item (P4, with the webhook
  session): `_tasks_purge_webhook_events` and `ws_predictions_deleted` record and purge webhook events by WaveSpeed
  task_id with no account either (round 7 lead).

## Accepted — do not re-report
- A switch-off of Automatic backups queues its scrub at once, but a drain that starts between that switch-off and the
  commit of a backup of the same account still being written takes the queued row without seeing that backup, which
  then keeps those copies (a window as long as the backup: about 65 ms for a snapshot, the rest of a 2-day run). The
  same holds for a delete still committing when the switch goes off: its trigger read the switch as on, and a drain
  in between cannot see its tombstones yet (a few ms; the global switch had the same race). Closing either would make
  switch-offs wait on backups and deletes (review rounds 13-14).
- An expired-token holder keeps receiving content-free pings until the topic rotates (rename, password change, unlock,
  key rotation). Pings carry nothing.
- A rename's own pings go to a topic of the new name with the old epoch (the epoch moves after the rows), which no
  device holds; the account's other devices learn the new topic at their next reconcile. As before P4.
- Rolling back phase 0 while the phase-1 client is live stops instant updates; the 20 s / focus reconcile remains.
- The policies trust session_signing_key: a holder of that key can mint valid sessions (rotation is the remedy).
- Owner-run maintenance with the service role (scripts/tools/supabase-admin.mjs) bypasses the policies by design.

## Tests
JS: scripts/test-session-header.mjs, test-sync-ping.mjs, test-storage-remove.mjs, test-remote-clears.mjs and the static
test-mu-p4-ab-guards.mjs (20261025800000/820000's lock limits, guards and record deletes) (npm test).
SQL, each rolls back (run alone against live; to test an unapplied migration, prepend its text in the same call):
scripts/test-scrub-linear-db.sql, test-rename-name-rules-db.sql and test-backup-scrub-job-db.sql (20261026200000:
the scrub byte-equal to the loop it replaced and linear, rename's name rules and sign-in key, the per-account drain);
scripts/test-backup-account-lock-db.sql (20261025820000: a rename staged inside a 2-day run, both orders of a
snapshot and a rename, and the lock-before-INSERT order read from the bodies with comments stripped);
scripts/test-rls-{phase0,tables,storage,triggers,plan,rpcs,rename}.sql; P4 gate: scripts/test-mu-matrix.sql (two accounts:
rows, files, folders, topics, tombstones; failing-first before the walls 26/19) with scripts/test-mu-catalog.sql, and the
P4 rollback proof scripts/test-mu-p4-rollback.sql + scripts/fixtures/p4s-final.sql (both orders in its header);
20261025800000's rollback proof scripts/test-mu-p4-ab-rollback.sql with scripts/fixtures/p4s-ab-*.sql (each
p4s-ab-guard-* fixture but the end marker -noop must refuse);
20261025820000's: scripts/test-backup-account-lock-rollback.sql with scripts/fixtures/p4s-lk-*.sql;
20261026200000's: scripts/test-backup-scrubs-rollback.sql (migration, rollback, then this); after an apply,
scripts/tools/drain-job-probe.mjs proves the cron job's CALL commits (a probe scrub drained by the next run);
P1 M2: scripts/test-mu-scope-topic.sql (38
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
