# Multi-user plan (draft 2026-10-22)

Owner, 2026-10-22: "i do need multi user capabilities but they must work just as mine works without them colliding or
interfering regardless of simultaneous use".

Status: PLAN, nothing built. Written by the RLS session from 5 parallel research agents (workflow wb1wiq89k) plus its
own checks of the live build (§8). The owner ruled on every decision on 2026-10-23 (§6). The work split in §5 is a
proposal until the lockdown session agrees to it.

## 1. What "works just as mine, without colliding" means (acceptance rules; each becomes a test in §7)
- **R1 Parity.** Every member gets everything the owner has:
  - sign-in with the 3-try lockout and a backup code;
  - their own WaveSpeed key through the proxy;
  - generations that resume and that land while every device is closed (webhook);
  - delete-everywhere, archive, cross-device sync with live pings, backups and restore, settings, favorites and presets.
- **R2 Isolation.** No account can read, change, delete or even detect another account's rows, files, keys, backups,
  pings or logs. This includes the owner: the console shows counts, never content.
- **R3 Non-interference.** Nothing one account does changes another account's experience. That covers wrong passwords,
  password changes, restores, renames, deletes, heavy batches, a bad WaveSpeed key and a cron backlog. Shared capacity
  (the proxy, the database, Realtime) is divided by per-account limits, not first come first served.
- **R4 Simultaneity.** N accounts working at once on several devices each end in the same per-account state as each
  account working alone.
- **R5 Owner continuity.** During the rollout the owner is never signed out mid-generation and never loses data. Every
  server step has a pre-tested rollback, the same method as the RLS lockdown.

## 2. What breaks today with a second account
Verified 2026-10-22 22:15–22:20 UTC from catalog, code and logs; no content was read.

1. **Only one account can exist.** app_secrets holds a single admin_username, admin_password_hash,
   admin_backup_code_hash and admin_email. verify_admin and _verify_session_token compare against that one name.
2. **Global hot rows.** admin_login_lockout, admin_backup_attempts and admin_sessions_valid_after are single rows. One
   person's 3 wrong passwords lock every account. One password change signs every account out. Every sign-in queues
   behind one row lock.
3. **Policies admit any valid session.** USING admits "any valid session"; only WITH CHECK pins the scope (migration
   20261022120000). The `generations` storage policies have no folder check. A signed-in member could read, change or
   delete every row and file.
4. **The scope is the username.** It is `'user:<username>'`, which can change:
   - a rename rewrites device_id in every table and races with other devices;
   - archive folders are `user_<name>/…` and uploads are `uploads/user_<name>/…`;
   - data_backups is keyed by username.

   A freed name reused by someone else would inherit that person's backups, tombstones and files.
5. **Every definer function is its own boundary.** There are 48 SECURITY DEFINER functions in public. 22 of them can be
   called by browsers, and 21 contain an `'admin:'` literal. Definer functions skip RLS.
6. **The webhook isn't bound to an account.**
   - There is one WAVESPEED_WEBHOOK_SECRET (api/ws-webhook.ts:51).
   - ws_webhook_apply and the 5-minute sweep match tasks by WaveSpeed task_id alone.
   - ws_deleted_predictions has PRIMARY KEY (task_id), and tasks.task_id is not unique.

   Deliveries from members' own WaveSpeed accounts would presumably fail verification, so their results would land only
   while a device polls. Even a verified delivery is not tied to an account.
7. **One live-update topic.** It is derived from the single admin, so every account would wake every other account's
   devices.
8. **auto_backups is global** (app_secrets). One account turning backups off turns them off for everyone.
9. **The proxy rate limit is OFF in production.** The Vercel runtime log at 22:12:22 UTC says "rate limiting DISABLED
   — UPSTASH not configured", and the limit counts request rate only. One account could flood the shared proxy. Owner
   ruling 2026-10-23: limits stay off by default, but the capability gets built (P5).
10. **The browser assumes one account.**
    - There is one IndexedDB database, 'proximaai' (src/lib/storage.js:9).
    - The localStorage keys are global: failed syncs, ws/file deletes, released predictions, form holds and logs.
    - `setSession` only overwrites the stored username (src/lib/session.js:54). Nothing wipes or parks the previous
      account's local data.

    A second account signing in on the same browser would see the first account's local rows and replay its queued
    writes under its own session. (The research brief claimed a different-account sign-in clears local data. It does
    not.)
11. **Unbounded cron loops.** backup-scrub-drain (every minute), ws-webhook-sweep (every 5 min) and auto-backup-2day
    loop over all data. They run as postgres with no statement timeout, so one account's backlog delays everyone.

## 3. Design decisions (recommended)
- **D1. Keep ProximaAI's own sign-in, made per account. No Supabase Auth now.**
  - Why: the live lockdown (`x-proxima-session` plus `proxima_auth.session_scope`) carries over unchanged.
  - Supabase Auth would need synthetic emails, a different token in a different header, and a redo of every policy and
    RPC check. Its one real gain, private Realtime channels, matters little because pings carry no content.
  - Revisit only for email, Google or passkey sign-in. (The research split 2–1 here.)
- **D2. An immutable account id (uuid) is the data scope; usernames are display names.**
  - The scope value `'user:<uuid>'` stays in the existing `device_id` column. The column name is legacy, and renaming it
    would touch every query for no gain.
  - A rename becomes a one-row update, and a freed name can never inherit data.
  - Switching the owner's account to it reuses rename_my_account's proven all-tables rewrite, one last time.
- **D3. Accounts live in `proxima_auth.users`, an unexposed schema like session_scope.**
  - Columns: id, username (unique, case-insensitive), role owner|member, password hash, backup code hash,
    sessions_valid_after, lockout counters, email, auto_backups, disabled_at, deleted_at, invited_by.
  - The owner's current hash, backup code and email are copied in, so the password and codes stay the same.
- **D4. Every rule is per account.** That covers the lockout (the same 3-try rule and backup code), the sign-out epoch,
  the backup switch, the live topic, the rate limit, the WaveSpeed key and the webhook secret. On top of that:
  - a per-IP sign-in throttle, so a stranger can't lock members out by guessing;
  - one generic sign-in error, with no "that username exists" leak.
- **D5. Ids stay globally unique UUIDs.** This deliberately differs from research lens 2, which wanted (owner, id)
  composite keys.
  - Supabase's standard is a global uuid key plus an owner column plus RLS.
  - With strict per-account policies, a reused id can only make the reuser's own write fail.
  - The protection that matters: every definer function and service path filters by the account it derived from the
    token or the webhook route, never by an id alone.
  - Drop genId's non-UUID fallback, and make task_id unique per account.
- **D6. Each account brings its own WaveSpeed key; its webhook secret is optional.** Spend, WaveSpeed rate limits and
  balance never cross accounts. Without a webhook secret, generations still complete through the WaveSpeed API alone
  (the open device polls), exactly as before 2026-10-20. Keys move into Supabase Vault (installed, unused) before the
  first member's key is stored.
- **D7. Webhooks are routed per account.**
  - The proxy adds an opaque route id to the callback URL.
  - ws-webhook verifies with that account's secret (the owner's stays the env secret) and applies only to that
    account's rows.
- **D8. Browser: one account per browser profile at a time.**
  - Each account's local data lives in its own IndexedDB database, `proximaai:<uuid>`, with per-account localStorage keys.
  - Switching accounts parks the other account's data: it is never shown and never replayed.
  - Web Locks make one tab do the replay, reconcile and resume.
  - An optional "sign out and remove this device's data" covers shared devices.
- **D9. Members join by invite only.** The owner console issues single-use 7-day codes. No public sign-up endpoint
  exists.
- **D10. The owner console manages accounts, never content.**
  - It can list accounts (counts and bytes only), invite, disable, sign out, reset (one-time code) and delete (purge
    everywhere).
  - Every action is audited and re-authenticated.

## 4. Do's and don'ts for all multi-user work
**Do**
- Derive the account once inside every definer function, from the verified token or the webhook route, and filter EVERY
  statement by it.
- Keep `(select proxima_auth.session_scope(...))` wrapped, so it runs once per statement as an InitPlan.
- Keep device_id leading the indexes, and filter client reads by scope too, so the planner uses the index.
- Stamp every queued browser write with its account at enqueue time, and replay it only while that account is signed in.
- Take locks in one order: account marker row → tasks → history → favorites → tombstones → backups.
- Bound every cron run: a batch LIMIT, a per-account exception block, SKIP LOCKED, and SET LOCAL statement_timeout.
- Fail closed where something is switched on: a rate limit that is ON but whose store (Upstash) is missing answers
  503, and an unknown webhook route answers 401. Rate limits themselves are off by default (owner ruling).
- Log an opaque account id. Never log names, prompts or outputs.

**Don't**
- Don't use `USING (any valid session)` on per-account data. Only `USING (device_id = scope)`.
- Don't accept a username, scope or account id from the browser or a payload inside a definer function.
- Don't put a global hot row in a request path, meaning one row that every account locks.
- Don't cache a decrypted key in a serverless module unless it is keyed by the verified account with a short TTL.
- Don't add a view over account tables without security_invoker.
- Don't let the service worker cache /rest, /storage or /api responses.
- Don't test isolation as postgres or service_role. Always test as anon WITH a minted token per account, as
  scripts/test-rls-*.sql do.

**Worth knowing (research findings and discoveries)**
- Supabase's RLS benchmark:
  - wrapping the auth function in `(select …)` took a query from 179 ms to 9 ms;
  - indexing the policy column took 171 ms to under 0.1 ms.

  Both are already true here; keep them.
- Postgres runs BEFORE row triggers before the RLS WITH CHECK. For the P3 cut-over, an alias trigger can therefore map
  writes still stamped with the old `'user:<name>'` scope onto the new uuid scope, rejecting none. Proven live
  2026-10-23 (scripts/test-mu-alias-probe.sql, rolled back, 4/0): without the trigger a legacy-stamped insert is refused
  (42501); with it, the insert and an upsert of an existing row land in the session's scope. Design: docs/P3-SCOPE-DESIGN.md.
- Realtime counts each broadcast once when sent and once per receiving device. A project allows 200 concurrent
  connections on Free and 500 on Pro, so budget for accounts × open devices. The design target of 50 accounts × about 3
  open devices is about 150 connections: inside Free, with Pro as the step up.
- One `Clear-Site-Data: "cache", "storage", "executionContexts"` response wipes a shared device (Baseline since 2023).
  Also call `caches.delete`.
- A Playwright browser context is a separate browser with its own IndexedDB and localStorage. One script can therefore
  run the owner's PC, the owner's phone at 384×782 and a member, all at once, on the live site.
- WaveSpeed rate and concurrency limits are per WaveSpeed account. Extra keys on one account add no capacity, which is
  another reason for BYOK.

## 5. Phases
Each phase ships on its own, keeps the owner's account working exactly as now, and has its own tests and rollback.
**No member account can be created before Phase 4's gate passes.**

**P1 — Accounts table and per-account auth (server, additive). Size M.**
- Create `proxima_auth.users`, seeded from app_secrets: the owner's hash, code, email, epoch and auto_backups.
- Sign-in, lockout, backup-code unlock and the password, username and code changes all read and write the owner's row
  instead of the global rows.
- Tokens: new sign-ins get `u:<uuid>`. Existing `admin:<name>` tokens stay valid until they expire (12 h), so nobody is
  forced to sign out. The proxy (api/ws-proxy.ts) and get_my_wavespeed_key accept both formats.
- One helper, `proxima_auth.current_account(token)`, replaces the 21 `'admin:'` literals. get_my_account returns the
  account's id, role and scope.
- Sign-in gives one generic error, and a per-IP throttle reads the caller's IP from request.headers (the gateway's
  x-forwarded-for; verify it arrives before relying on it).
- Gate:
  - every existing suite stays green;
  - a new auth suite runs two accounts seeded inside a rolled-back block. A's wrong passwords don't lock B. A's
    password change doesn't sign B out.
- Rollback: the functions go back to the app_secrets rows, which stay untouched until P5.

**P2 — Browser per-account isolation (client). Size L. Touches App.jsx and storage.js.**
- The client takes its account id and scope from the server instead of building `user:<name>` itself.
- IndexedDB becomes `proximaai:<uuid>`. On the first sign-in, the legacy 'proximaai' database is copied over and then
  deleted.
- The localStorage queues and logs become per account, and each queue entry carries its account.
- Replay, reconcile and resume run behind `navigator.locks` per account.
- Session changes go out on a `proximaai-auth` BroadcastChannel, versionchange closes the database, and sign-out comes
  in two levels.
- Gate:
  - Node tests for the queue-owner rule;
  - Playwright: queue as A, sign in as B. B gains 0 rows and A's entry stays queued. Two tabs make one replay;
  - the owner's PC and phone keep every pending item across the upgrade.

**P3 — Immutable scope (server data migration). Size M.**
- One transaction rewrites `user:StephJr101` to `user:<owner uuid>` in every table, using the rename machinery for the
  last time. It includes data_backups, user_secrets, backup_scrub_queue and the markers.
- Files stay where they are. A folder-alias table maps the legacy folders (`user_StephJr101/`,
  `uploads/user_StephJr101/`) to the account, and new files go under `<uuid>/…`.
- For 48 h, a temporary alias trigger maps writes still stamped with the old scope (from old tabs or queued writes) to
  the new one, so none are rejected. Then it is dropped.
- rename_my_account becomes a plain username update: instant, with no row rewrites.
- Gate:
  - per-table row counts are equal before and after;
  - the owner's PC and phone converge;
  - writes queued before the switch land.

**P4 — Per-account walls (server). Size L. THE GATE before any second account.**
- Policies:
  - `USING (device_id = scope)` for every command on all six tables;
  - the storage policies check the account's folders;
  - tombstones are readable for the own scope only.
- Definer audit:
  - all 48 functions derive the account themselves and filter every statement, including existence checks: e.g.
    `_clear_kind` checks `sync_tombstones` and "no tasks row" by id across every scope (fine with one account and
    global UUIDs; scope it here);
  - internal helpers move to proxima_auth with EXECUTE revoked, and search_path is pinned.
- Catalog gates fail if any of these is true:
  - a policy lacks the scope predicate;
  - a definer function is executable by PUBLIC;
  - a view lacks security_invoker.
- Live topic per account: an HMAC of the account id and its epoch. Ping triggers send one ping per account present in
  the changed rows.
- Webhook per account:
  - a route id in the callback URL and a per-account secret lookup;
  - apply, sweep and deleted-predictions all match (account, task_id);
  - a unique index on (device_id, task_id).
- Cron fairness:
  - per-account loops with batch limits, SKIP LOCKED and statement timeouts;
  - auto_backups becomes per account.
- Gate:
  - a two-account SQL matrix runs as anon with two minted tokens, A against B. It covers every table × every command,
    every storage operation and every browser-callable definer function;
  - the catalog gates;
  - a live two-account probe over REST, Storage and the topic (counts only).

**P5 — Members (server, client and Vercel). Size L.**
- Invite and `/join?code=` (the code is removed from the URL after use), then:
  - the member sets an account name and password, and gets a backup code shown once;
  - onboarding asks for the WaveSpeed key (validated against its balance endpoint) and, optionally, the webhook secret.
    Without the secret, results arrive through the WaveSpeed API alone while a device is open, as before 2026-10-20.
- Vault holds every key and webhook secret. Settings shows only a masked fingerprint.
- Rate limits, built as a capability and **OFF by default** (owner ruling 2026-10-23):
  - per-account caps on request rate and on in-flight submits, switched on per account or for everyone from the owner
    console;
  - a limit that is switched on needs Upstash (owner action) and fails closed without it;
  - with every limit off, the proxy behaves exactly as today.
- Owner console (counts only) and an audit log.
- Account deletion purges everything everywhere: rows, files, WaveSpeed predictions (through that account's key) and
  backups.
- Retire the app_secrets `admin_*` rows.

**P6 — Prove simultaneity. Size M.**
- Playwright on the live site. The owner on the PC, the owner's phone at 384×782 and a test member in a second context
  generate, archive, delete, restore and rename at the same time. Pass means:
  - zero foreign rows in any response;
  - every device converges;
  - no failed-sync leftovers.
- A load test on a Supabase branch (owner decision 2026-06: staging = Branching), with 50 test accounts × 3 devices
  (the owner's design target) and WaveSpeed mocked. Pass means:
  - 0 cross-account rows and 0 deadlocks;
  - p95 within budget;
  - each account's final state equals the same script run alone.
- A review loop (3 critics, one lens each) until a round comes back empty.

**Later, optional:** an authenticator-app code (TOTP) for the owner; data export; a per-account spend ledger with caps;
a device list with "sign out other devices".

**Work split (proposal; needs the lockdown session's OK).**
- Lockdown session (owns sign-in, the proxy, delete flows, App.jsx and storage.js): P1, P2, P5.
- RLS session (owns policies, session_scope, the ping and the isolation tests): P3, P4, and the gates of P6.
- Never two writers on one file. A shared file changes only after a message and an answer.

## 6. Owner rulings (2026-10-23)
1. **How people join:** invite codes ("we can do an invite code"): single-use, 7 days, created in the owner console.
2. **Who pays WaveSpeed:** each member's own key (the recommendation).
3. **Members' results with their devices closed:** members may paste their WaveSpeed webhook secret (the
   recommendation), and "it should also work with just the wavespeed api alone as well just like we had before". So the
   secret is optional, and without it results arrive by polling while a device is open. One check with a second
   WaveSpeed account must confirm that signing secrets are per account.
4. **Sign-in system:** ProximaAI's own, per account (the recommendation).
5. **Shared devices:** one account per browser profile; switching parks the other account's data, untouched (the
   recommendation).
6. **Seeing members' generations:** never (the recommendation). The console shows counts and storage size only.
7. **Scale:** "build for 50 capability though only 2 to worry about for now me and another user but build as if 50".
   The design target and the load test are 50 accounts; real use starts with 2.
8. **Deleting an account:** an immediate purge everywhere, matching "delete means delete" (the recommendation).
9. **Rate limiting:** "add rate limiting capabilities but i dont want the rate limits on by default". The limits are
   built and switchable, OFF by default; Upstash is needed only once a limit is switched on.

## 7. Tests (how R1–R5 are proven)
- R2 and R3, SQL:
  - `scripts/test-mu-matrix.sql` runs rolled back, as anon with minted tokens for two seeded accounts, over every table
    × command, storage operation and browser-callable definer function;
  - `scripts/test-mu-catalog.sql` holds the catalog gates (built 2026-10-23). Today it reads 11 PASS / 2 FAIL by
    design: G1 (16 row policies admit any valid session) and G2 (4 storage policies lack a folder check) are the walls P4
    builds. Failing-first with one planted defect per other gate: all 10 predicted FAILs;
  - `scripts/test-mu-auth.sql` (P1, lockdown session) covers the per-account lockout, epoch and backup code. The live
    topic stays owner-only until P4 (members get `sync_topic` null); P4's matrix covers the topic per account;
  - the existing test-rls-* and feature suites keep passing unchanged.
- R2, live: `scripts/tools/mu-probe.mjs` drives two test accounts over REST, Storage and Realtime and reports counts
  only.
- R1 and R4, browser: Playwright with multiple contexts on the live URL (PC, 384×782 phone and a member).
- R4, load: a Supabase branch with 50 accounts × 3 devices, asserting no deadlocks and full convergence.
- R5, at every server phase:
  - per-table row counts before and after;
  - failed-sync queues empty on both owner devices;
  - rollback files proven exact before the apply.

## 8. Provenance
- Research: workflow wb1wiq89k, 5 Opus 5.5 agents, 2026-10-22 21:49:46–21:52:41 UTC, 84 tool calls, about 538k tokens.
  - Lenses: identity and accounts; data isolation and RLS; concurrency and non-interference; secrets, keys and billing;
    browser and PWA.
  - 67 findings, condensed here.
- Checked independently afterwards:
  - catalog: key names, indexes, function counts, cron, role timeouts;
  - code: session.js, storage.js, supabase.js, ws-proxy.ts, ws-webhook.ts;
  - the Vercel runtime log showing the limiter off.
- Deviations from the research:
  - D5 keeps global UUID ids instead of composite keys;
  - D1 keeps ProximaAI's own sign-in instead of Supabase Auth, with the lenses split 2–1.

## Appendix A. P4 definer audit (2026-10-23)
Generated from the live catalog (function definitions only, no rows): 49 SECURITY DEFINER functions in public, 23 of
them browser-callable. All pin search_path, none is executable through PUBLIC, and every browser-callable one checks
the session except the two that run before a session exists. P4 must make each derive the ACCOUNT (not just "a valid
session") and filter every statement by it. "Owner" is the session whose files hold the function today; a change goes
through that owner or a handover.

| Group | Functions | Owner | What P4 needs |
|---|---|---|---|
| Before a session exists | verify_admin(p_username, p_password), unlock_admin_with_backup_code | lockdown (P1) | per-account lockout and backup code; one generic error |
| Account rows in global app_secrets | change_my_password, set_admin_backup_code, set_admin_credentials_rehash, set_my_account, get_my_account, rename_my_account, get_auto_backups, set_auto_backups, _reauth_admin, _revoke_admin_sessions, _verify_session_token, _sign_session_token | lockdown (P1) | move to proxima_auth.users; rename becomes a username update (P3); auto_backups per account |
| Keys | set_my_wavespeed_key, get_my_wavespeed_key (service role only) | lockdown (P5) | Vault, keyed by the account id |
| Data RPCs scoped by the token's device_id | delete_queued_rows, clear_queued_rows, reset_queued_rows, upsert_queued_history, generations_live, paths_in_use, purge_my_backups_of, list_my_backups_phase2, delete_my_backup_phase2, snapshot_my_data_phase2, restore_my_backup_phase2, server_time_ms | lockdown (delete/backup area) | already scope their DML; audit existence checks too (e.g. _clear_kind's tombstone and "no tasks row" lookups match by id across scopes) |
| Webhook (service role) | ws_webhook_apply, ws_webhook_sweep, ws_predictions_deleted, _tasks_take_webhook, _tasks_settle_webhook, _tasks_purge_webhook_events | webhook session | route per account; match (account, task_id); record the account on deleted predictions |
| Backups and scrubs (cron, triggers) | create_auto_backup, _drain_backup_scrubs, _scrub_backups, _scrub_backups_to_live_items, _backup_scrub_follow_rename, _history_queue_backup_scrub, _history_queue_item_scrub, _tasks_queue_backup_scrub, _auto_backups_on | lockdown (delete/backup area) | per-account loops with batch limits, SKIP LOCKED and timeouts; the per-account switch |
| Row triggers | _history_drop_emptied, _history_strip_deleted_items, _rows_keep_owner, _rows_not_tombstoned, sync_tombstone_record, sync_tombstone_clear | lockdown / RLS | use NEW/OLD.device_id throughout; tombstone lookups by (device_id, id) |

Browser-callable functions with an account argument: only verify_admin (sign-in by name, by design); the three scrub
helpers that take p_username are server-only. G6/G7 of scripts/test-mu-catalog.sql keep it that way.
