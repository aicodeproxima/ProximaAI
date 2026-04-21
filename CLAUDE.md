# ProximaAI — Claude working preferences

Auto-loaded when any Claude session works in this repo.

## Stack at a glance
- React + Vite deployed to Vercel (proxima-ai-seven.vercel.app, auto-deploys on git push to main)
- Supabase backend: project `vhznmpxlcjbdzntmfvvy`
  - Tables: tasks, history, settings, favorites, presets, data_backups
  - Storage bucket: `generations` (manual per-task archive via ☁ button)
  - pg_cron job `auto-backup-2day` runs every 2 days
- Client-side triple-layer persistence: React state → IndexedDB → Supabase
- Auth: Supabase-stored creds + email OTP verification (creds scoped under device_id=`_account`)
- Theme system: `src/lib/{themes,useTheme,BackgroundLayer}.{js,jsx}` (ported from
  `C:\Users\aicod\Projects\templates\mission-control-themes`)

## Default workflow — do not ask permission for these
1. Edit files in `src/`
2. `npm run build` to verify
3. `git add -A && git commit -m "..." && git push origin main`
4. Summarize what shipped + why

Vercel deploys itself in ~30s. **Never run `npm run dev` or local preview** — user
tests on the live URL. User's primary device is a 6.7" iPhone Pro Max (19.5:9).

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
- **Pre-destructive snapshots**: Clear/Reset buttons always `createBackup("pre-*")` first.
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
- Device scope = username (`user:admin`, `user:Steph101`) so creds can change
  without moving data; `_account` scope holds global login creds
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

## Key commits for reference
- `8da8f95` Defensive fixes for debounced-sync races
- `baf45c3` Back-button trap + resumable polling
- `5c32917` Hardened DALL-E + SW cache bump
- `1cf5fdf` Cloud-first save/sync/backup system
- `62b9d79` Data-driven progress bars from real Supabase timings
