# ProximaAI — Claude working preferences

Auto-loaded when any Claude session works in this repo.

## Stack at a glance
- React + Vite deployed to Vercel (proxima-ai-seven.vercel.app, auto-deploys on git push to main)
- Supabase backend: project `vhznmpxlcjbdzntmfvvy`
  - Tables: tasks, history, settings, favorites, presets, data_backups
  - Storage bucket: `generations` (manual per-task archive via ☁ button)
  - pg_cron job `auto-backup-2day` runs every 2 days
- Client-side triple-layer persistence: React state → IndexedDB → Supabase
- Auth (since 2026-10-20): server-side sign-in via the `verify_admin` RPC (bcrypt in `proxima_auth.users` since P1 M1,
  2026-10-23; the old `app_secrets` admin_* rows are frozen by a trigger and kept only for M1's rollback), returning a
  12-hour HMAC session token (`src/lib/session.js`). 3 failed sign-ins lock it; the backup code (Settings →
  Account) unlocks it. Password/username/backup-code changes need the current password. Email OTP remains a UI step.
- WaveSpeed key: only in `user_secrets` (server). All WaveSpeed calls go through `/api/wavespeed-v2` (`api/ws-proxy.ts`)
  with header `X-Proxima-Session`; the proxy adds the key. The browser never stores or syncs it.
  Once `20261025500000_mu_p5_provider_keys` is applied, every provider key (WaveSpeed and kie.ai) lives in Supabase Vault
  per account (`proxima_auth.provider_keys`; `get_provider_key` is service_role only).
- kie.ai (second provider, docs/SECOND-ACCOUNT-PLAN.md): models `kie/…` in `src/config/kieModels.js`, merged for lookups
  by `src/config/catalog.js` (`MODELS` stays WaveSpeed-only, since WaveSpeed's scripts read it). Calls go through `/api/kie/*`
  (`api/kie-proxy.ts`, 4 allowed calls, `src/lib/kieProxy.js`). Answers are mapped to WaveSpeed's shapes by
  `src/lib/kie.js`. kie.ai has no delete API and no task history, so kie.ai tasks never enter the WaveSpeed delete
  queue or the lost-submit lookup. Its result files expire after 14 days.
- Theme system: `src/lib/{themes,useTheme,BackgroundLayer}.{js,jsx}` (ported from
  `C:\Users\aicod\Projects\templates\mission-control-themes`)

## Default workflow — do not ask permission for these
1. Edit files in `src/`
2. `npm run build` to verify
3. `git add -A && git commit -m "..." && git push origin main`
4. Summarize what shipped + why

Vercel deploys itself in ~30s. **Never run `npm run dev` or local preview** — user
tests on the live URL. User's primary device is a Galaxy S24 Ultra, measured at 384×782 CSS px (DPR 3.75);
check 384 first, 412 second. Chrome on it freezes the app in the background and kills its sockets.

## Supabase management — direct SQL when needed
- Management API endpoint: `https://api.supabase.com/v1/projects/vhznmpxlcjbdzntmfvvy/database/query`
- Personal access token + anon key + DB connection: in memory file
  `reference_supabase_proximaai.md` (never paste in commits)
- Prefer the Management API over guessing — confirm schema + data before claiming
  a fix works

## Hard rules — violations caused real bugs, don't repeat
- **Never silent-success**: every cloud write must be preemptively added to the
  failed-sync queue in localStorage BEFORE firing. Remove only on confirmed success.
  If tab closes mid-debounce, the mount effect replays it.
- **Never say "Saved" if work is pending**: honest save status. If
  `failedSyncCount > 0`, status is "error" regardless of other state.
- **Flush before bootstrap**: any pending debounced writes must flush BEFORE cloud
  pull merges. Otherwise stale writes overwrite fresh cloud data (commit 8da8f95).
- **Validate payloads defensively**: `validatePayload()` is the final pass in
  `buildPayload()`. Don't trust the primary path — stale service-worker bundles
  have shipped invalid payloads before (DALL-E "1k" incident, commit 5c32917).
- **Delete means delete (owner, 2026-10-21)**: deleting generations removes them everywhere the app can reach — this
  device, the cloud, WaveSpeed (`POST /api/v3/predictions/delete`), their uploaded and archived files, their History,
  and backup copies — via `purgeEverywhere` in App.jsx. Destructive buttons still call `createBackup("pre-*")` first,
  but the server only takes it while that account's own **Automatic backups** (Settings → Cloud Backups; per account,
  `proxima_auth.users.auto_backups`, since 20261025800000) is ON; the owner's is OFF by choice. When ON, a failed backup
  aborts the delete. Never add a copy of deleted data
  anywhere without going through that switch. A WaveSpeed result delivered after its generation was deleted is dropped
  by the server (`ws_deleted_predictions`, filled by the tasks delete trigger and by `api/ws-proxy.ts` before it
  forwards `POST api/v3/predictions/delete`; the proxy answers 503 if it cannot record, so the client queue retries).
  The 5-minute sweep also removes deliveries that waited over 2 days for a row that never came.
  Backup copies are scrubbed by the server, never by the client: while an account's switch is off, the tasks/history
  delete triggers and the history update trigger queue into `backup_scrub_queue` in the change's own transaction; cron
  `backup-scrub-drain` drains it every minute, one account per transaction, and restore drains first and refuses while
  anything is left. Switching OFF scrubs that account's backups of every id it deleted, restore-replaced rows included,
  and trims backed-up History entries to their live items (owner rulings 2026-10-22). Files go through the durable queue
  `proximaai-file-deletes`
  (`fileDelete.js`): held by `stagePurge` before any network call (`proximaai-held-purges-v3`, with the WaveSpeed
  deletes; a delete whose intents and hold cannot both be written changes nothing and says "storage is full"; when the
  rule that decides holds changes, they move to a key no previous build reads, see THE KEY RULE in storage.js),
  released to the queues once that delete is confirmed for every owner; if a restore voids or drops it, the next sync
  that read the cloud after that restore decides: kept if the generation came back, deleted if it did not (owner ruling
  2026-10-23: a cancelled delete's put-back leaves the holds to that sync; an uncertain outcome never cancels a hold); a
  generation deleted elsewhere is re-planned by every device that removes it (its files against that device's view, its
  WaveSpeed result by the device holding the prediction id); settled only on a
  confirmed remove or a HEAD 400/404, and a path a kept generation uses again is never deleted. Log deletes delete no files. A file a Generate
  form still holds (any live tab, per-tab key `proximaai-form-inputs:<tab>`; the other device's via settings
  `form-inputs:<browser>`; this browser's rows not uploaded yet in `form-inputs:<browser>:unsent`, with their generation and
  prediction ids, which also hold those WaveSpeed results) is kept until every form lets go of it and those rows are sent,
  then deleted. A History upload naming a generation whose own row is still queued goes out only after that :unsent row
  is confirmed to name it (App.jsx publishUnsentBefore); it is also published as the page hides or closes. A hold counts 7 days after its last
  heartbeat (`FORM_HOLD_ALIVE_MS`): a page Chrome froze sends nothing but still holds its form. A History entry with
  an item whose task this device lacks is rewritten, not removed, and the server strips items of deleted tasks from
  every History upload (`history_strip_deleted_items`); since 20261024100000 also the items of generations a restore
  removed that the stored entry lacks (a restore wins over uploads queued before it; every device drops them from its copy). A confirmed delete whose row shows up again without a restore is
  deleted again, but only a confirm this build marked final (`proximaai-final-confirms`; a previous build's is released).
  A restore wins over every delete queued before it: deletes, clears and a delete's History rewrites go only through
  restore-checked functions that take the account's marker (settings `last_restore_at`, server-only since 20261022301000)
  — `delete_queued_rows`, `clear_queued_rows` (rows that existed at the queue time + the ids named), `upsert_queued_history`.
  Never add a plain REST delete or clear of tasks/history/settings/favorites.
- **Back-button trap**: PWA must not exit on Android back gesture (kills in-flight polls).
- **Only a valid session touches the data (2026-10-22)**: tasks, history, settings, favorites, presets, sync_tombstones and
  bucket `generations` are closed by row policies that verify the `x-proxima-session` header on every statement
  (migrations 20261022100000 + 20261022120000; since P1 M2, 20261023200000, the token is resolved to its account by
  `proxima_auth.current_account`, so `u:<uuid>` tokens work too). Every data call goes through the supabase.js client, whose fetch adds
  the header (`withSessionHeader`); never add a raw `fetch` to /rest/v1 or /storage/v1 from the browser. Rows are
  written only into the session's own scope, and read or changed only there (20261023050000). Public image URLs stay open. Live updates come from a content-free ping
  (`syncPing.js`), not postgres_changes. New SQL that browser roles run needs a rolled-back test as `anon` WITH a
  minted token in `request.headers` (see scripts/test-rls-*.sql). Details and the outsider view: docs/page-map.md.

## Transparency + theming
- CSS variables (`--bg-deep`, `--text-primary`, `--accent`, `--glass-border`, `--bg-card`)
  are set by `useTheme` — never hardcode rgba in CSS/JSX unless intentional
- `html` has the base color; `body`, `#root`, `.proxima-app` are transparent
  so the fixed `BackgroundLayer` (z-index: 0) shows through
- Card opacity ≤ 20% alpha across all themes; use `backdrop-filter: blur` for legibility
- Theme changes must visibly shift both accent AND backdrop

## Mobile-first details
- All 7 type-tabs must fit one row without horizontal scroll at 384px width (measured 2026-10-20, docs/page-map.md)
- Sticky bottom action panel for cockpit (position: fixed, safe-area-inset-bottom)
- Tap targets ≥ 44×44
- Disable overflow-x on html/body/#root to lock the page from any panning

## Architectural decisions already made — don't relitigate
- Separate Supabase tables per data type (not a generic `user_data` KV store)
- Device scope = username (`user:admin`, `user:Steph101`); a rename moves every row server-side
  (`rename_my_account`). Login creds live in `proxima_auth.users` (no browser access; docs/P1-AUTH-DESIGN.md), not in `settings`
- Failed-sync retry queue in localStorage (not IDB — tiny records, faster)
- Cloud archive is **manual per-generation** via ☁ button on each task card
  (user explicitly removed auto-on-completion)
- PWA: service worker network-first with cache fallback. Bump `CACHE_NAME` in
  `sw.js` when deploying breaking payload changes

## When in doubt
- Pull Supabase data with curl first — don't assume
- Verify the deployed bundle has expected code: `curl -sL <url>/assets/index-*.js`
- Every build stamps `<meta name="proxima-version" content="<UTC build minute> <commit>">` into index.html and fails
  without it (scripts/lib/build-version.mjs); Settings → Version shows it with "Up to date" or Reload. A push is live
  once `sh scripts/browser/wait-deploy.sh $(git rev-parse HEAD)` hits.
- Fix root cause + ship defensive guard (belt-and-suspenders) — don't guess
- Spawn multiple agents in parallel for research-heavy audits (respect rate limits)
- Verify fixes with the actual API or a test harness before claiming success

## Source-of-truth rule (CRITICAL — violated this once, won't again)
**The deployed browser UX is the only acceptable proof.** Never claim a feature
works based on:
- Backend curl tests only
- Local code review
- "It builds successfully"
- An agent's research output

Every new model, payload, or UI change must be verified by clicking through
the live deployed site via Playwright (or the user) and seeing the success
state in the actual UI. Curl tests are useful for debugging WHICH slug/param
to use, but they're not proof of working integration — the frontend payload
construction, polling, output rendering, and state persistence all have to
work together too.

When tests show failures: troubleshoot the failure logs immediately, push
fixes, re-test in the browser to confirm. Don't move on until the prod UI
shows the success state.

## Test recipes, perf notes, protected code (verified 2026-10-22; first captured 2026-06)
- **Bundle secret audit:** after `npm run build`, `grep -lE "(service_role|SUPABASE_SERVICE_ROLE_KEY|sb_secret_|postgres://)" dist/`
  must print nothing.
- **In-flight survival:** start 3 long video generations, reload at ~1 min; all 3 resume and finish (resume window
  48 h, `RESUME_WINDOW_MS` in `src/lib/taskResume.js`). Run after any deploy touching resumption or storage.
- **Failed-sync replay:** offline → 3 writes → online; all 3 land in the right scope and `proximaai-failed-syncs` empties.
- **Perf budget (6-model batch):** FPS ≥30 desktop / ≥20 at 384 px; <20 long tasks per 60 s; CLS ≤0.1.
- **Polling hot path:** batches re-render task cards every 3–15 s; keep `React.memo(CockpitTaskCard)` (`2fd2e40`) and
  stable handler refs. Next win = list virtualization.
- **Never re-add `content-visibility: auto` on `.task-card`:** it dropped typing FPS 13.9 → 1.8 on ~510 blurred cards
  (reverted `223d93b`).
- **supabase-js loads from the jsDelivr CDN at runtime** (`src/lib/supabase.js`): a CDN outage stops all cloud sync.
- **`BackgroundLayer` `paused` prop** halts animations during in-flight batches; card `backdrop-filter` blur is the next
  mobile-GPU lever if jank returns.
- **Protected reference code** (the enterprise storage blueprint cites it; extend or rebind, never rewrite; find by
  symbol): failed-sync queue (`FAILED_KEY`, `src/lib/storage.js`), bootstrap-race fix (`8da8f95`), flush hooks
  (visibilitychange/beforeunload/pagehide), task resumption (`src/lib/taskResume.js`), back-button trap,
  `validatePayload()` (`src/lib/payloadBuilder.js`), save-status state machine, IndexedDB schema + prune.
- **Decisions (owner, 2026-06):** staging = Supabase Branching, not extra projects; perf-trace test rows carry the
  prompt prefix `[PERF_TRACE_<YYYY_MM_DD>]` and are hard-deleted by that prefix.

## Key commits for reference
- `8da8f95` Defensive fixes for debounced-sync races
- `baf45c3` Back-button trap + resumable polling
- `5c32917` Hardened DALL-E + SW cache bump
- `1cf5fdf` Cloud-first save/sync/backup system
- `62b9d79` Data-driven progress bars from real Supabase timings
- `2fd2e40` Extract + memo CockpitTaskCard · `223d93b` Revert content-visibility (typing FPS regression)
