# P3: an immutable account scope (design, 2026-10-23)

Part of docs/MULTI-USER-PLAN.md (RLS session's phase). Goal: every account's data scope changes once from
`'user:<username>'` (renamable) to `'user:<account uuid>'` (never changes). No write is rejected, nobody is signed out,
and the rollback is tested before the apply. Status: DESIGN, nothing built.

## Depends on
- **P1 (lockdown session):** `proxima_auth.users` with a `scope` column, initially `'user:' || username`. It is the
  single source of an account's data scope. Agreed 2026-10-23.
- **My session_scope change, shipped right after P1's table lands:** `session_scope()` maps both token formats
  (`admin:<name>`, `u:<uuid>`) to `users.scope`, before sign-in issues `u:` tokens.
- **The client takes its scope from the server** (`get_my_account`), not from the stored username. Planned for P2; the
  alias below covers clients that haven't reloaded yet.

## The cut-over (one migration, one transaction)
1. Lock the account's restore marker (`settings 'last_restore_at'`, FOR UPDATE), as rename_my_account does, so no
   restore or queued delete interleaves.
2. `old := users.scope; new := 'user:' || users.id`, then rewrite `old` to `new` in every scope column. Today that is
   `device_id` in tasks, history, settings, favorites, presets, sync_tombstones and user_secrets, and `username` in
   data_backups and backup_scrub_queue (live catalog, 2026-10-23). Re-read that list from the catalog when building, and
   fail the migration if a new scope column appears.
3. `users.scope := new`. Record the alias: `proxima_auth.scope_aliases(account_id, old_scope)`.
4. **Alias trigger** on each data table: BEFORE INSERT OR UPDATE, named to fire first. A row stamped with one of the
   session account's own old scopes moves to its current scope (ordering proven: scripts/test-mu-alias-probe.sql).
   - Keyed by the session's account, so one account's alias can never map another account's rows.
   - Kept with no expiry: a device closed for weeks still replays its queue safely. Removed only on the owner's word.
5. **Files stay where they are.** `proxima_auth.account_folders(folder, account_id)` (live from P4's
   20261025100000) records every folder an account has had; P4's storage policies allow `folder = any (my folders)`,
   for archives `<folder>/…` and uploads `uploads/<folder>/…`. The browser spells a folder from its scope
   (`'user:<uuid>'` → `user_<uuid>`), so after the cut-over new files go under `user_<uuid>/…` with no client path
   change, and the trigger on `users.scope` claims that folder. (Revised 2026-10-25, review c3 #2: an earlier draft said
   bare `<uuid>/…`, which the table's `^user_` check refuses and the browser would not write.)
6. rename_my_account becomes "update users.username": instant, with no row rewrites. Its restore-marker interlocks for
   rewriting rows retire, and test-rls-rename.sql changes to match.

## Proof (failing-first, rolled back, before the apply)
- Per-table row counts per scope: before the cut-over `old = N, new = 0`; after it `old = 0, new = N`; totals unchanged.
- A legacy-stamped write (old tab or queued replay) with either token format lands in the new scope. Another
  account's old scope is refused (two seeded accounts).
- After P3, a rename changes no row's scope.
- Rollback: rewriting new back to old, restoring users.scope and dropping the trigger and alias rows leaves the catalog
  and the per-scope counts identical (same method as scripts/test-rls-grants-unchanged.sql).
- Live afterwards: the owner's PC and phone converge, the failed-sync queues empty, and the edge logs show no 42501.

## Open points for the lockdown session (P1)
- Is `users.scope` written only by P3 and rename, or also by sign-in? (Proposal: P3 and rename only.)
- sync_topic: derive it from `users.id` and the account's own epoch in P1 or in my P4. (Proposal: mine, alongside the
  ping's per-account send.)
