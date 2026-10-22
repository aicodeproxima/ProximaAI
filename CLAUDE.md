# ProximaAI — Claude working preferences

Auto-loaded when any Claude session works in this repo.

## Stack at a glance
- React + Vite deployed to Vercel (proxima-ai-seven.vercel.app, auto-deploys on git push to main)
- Supabase backend: project `vhznmpxlcjbdzntmfvvy`
  - Tables: tasks, history, settings, favorites, presets, data_backups
  - Storage bucket: `generations` (manual per-task archive via ☁ button)
  - pg_cron job `auto-backup-2day` runs every 2 days
- Client-side triple-layer persistence: React state → IndexedDB → Supabase
- Auth (since 2026-10-20): server-side sign-in via the `verify_admin` RPC (bcrypt in `app_secrets`), returning a
  12-hour HMAC session token (`src/lib/session.js`). 3 failed sign-ins lock it; the backup code (Settings →
  Account) unlocks it. Password/username/backup-code changes need the current password. Email OTP remains a UI step.
- WaveSpeed key: only in `user_secrets` (server). All WaveSpeed calls go through `/api/wavespeed-v2` (`api/ws-proxy.ts`)
  with header `X-Proxima-Session`; the proxy adds the key. The browser never stores or syncs it.
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
  but the server only takes it while **Automatic backups** (Settings → Cloud Backups, `app_secrets.auto_backups`) is
  ON; it is OFF by the owner's choice. When ON, a failed backup aborts the delete. Never add a copy of deleted data
  anywhere without going through that switch. A WaveSpeed result delivered after its generation was deleted is dropped
  by the server (`ws_deleted_predictions`, filled by the tasks delete trigger and by `api/ws-proxy.ts` before it
  forwards `POST api/v3/predictions/delete`; the proxy answers 503 if it cannot record, so the client queue retries).
  The 5-minute sweep also removes deliveries that waited over 2 days for a row that never came.
  Backup copies are scrubbed by the server, never by the client: while the switch is off, the tasks/history delete
  triggers and the history update trigger queue into `backup_scrub_queue` in the change's own transaction; cron
  `backup-scrub-drain` drains it every minute, and restore drains first and refuses while anything is left. Switching
  OFF scrubs every existing backup of every deleted id, restore-replaced rows included, and trims backed-up History
  entries to their live items (owner rulings 2026-10-22). Files go through the durable queue `proximaai-file-deletes`
  (`fileDelete.js`): queued by `stagePurge` before any network call, settled only on a confirmed remove or a HEAD
  400/404, and a path a kept generation uses again is never deleted. Log deletes delete no files. A file a Generate
  form still holds (any live tab, per-tab key `proximaai-form-inputs:<tab>`) is kept until every form lets go of it,
  then deleted. A History entry with an item whose task this device lacks is rewritten, not removed, and the server
  strips items of deleted tasks from every History upload (`history_strip_deleted_items`).
- **Back-button trap**: PWA must not exit on Android back gesture (kills in-flight polls).

## Transparency + theming
- CSS variables (`--bg-deep`, `--text-primary`, `--accent`, `--glass-border`, `--bg-card`)
  are set by `useTheme` — never hardcode rgba in CSS/JSX unless intentional
- `html` has the base color; `body`, `#root`, `.proxima-app` are transparent
  so the fixed `BackgroundLayer` (z-index: 0) shows through
- Card opacity ≤ 20% alpha across all themes; use `backdrop-filter: blur` for legibility
- Theme changes must visibly shift both accent AND backdrop

## Mobile-first details
- All 5 type-tabs must fit one row without horizontal scroll at 430px width
- Sticky bottom action panel for cockpit (position: fixed, safe-area-inset-bottom)
- Tap targets ≥ 44×44
- Disable overflow-x on html/body/#root to lock the page from any panning

## Architectural decisions already made — don't relitigate
- Separate Supabase tables per data type (not a generic `user_data` KV store)
- Device scope = username (`user:admin`, `user:Steph101`); a rename moves every row server-side
  (`rename_my_account`). Login creds live in `app_secrets` (no browser access), not in `settings`
- Failed-sync retry queue in localStorage (not IDB — tiny records, faster)
- Cloud archive is **manual per-generation** via ☁ button on each task card
  (user explicitly removed auto-on-completion)
- PWA: service worker network-first with cache fallback. Bump `CACHE_NAME` in
  `sw.js` when deploying breaking payload changes

## When in doubt
- Pull Supabase data with curl first — don't assume
- Verify the deployed bundle has expected code: `curl -sL <url>/assets/index-*.js`
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

## Key commits for reference
- `8da8f95` Defensive fixes for debounced-sync races
- `baf45c3` Back-button trap + resumable polling
- `5c32917` Hardened DALL-E + SW cache bump
- `1cf5fdf` Cloud-first save/sync/backup system
- `62b9d79` Data-driven progress bars from real Supabase timings
