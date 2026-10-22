# ProximaAI page map

Measured on the live site (https://proxima-ai-seven.vercel.app) on 2026-10-20, by driving it from
Claude in Chrome (desktop) and the owner's Galaxy S24 over adb + CDP. Load this before driving the site.
Reusable scripts are in `scripts/browser/`.

## Build check
- Live bundle: `curl -sL <site>/ | grep -o 'assets/index-[^"]*\.js'`, then grep that bundle for a string your
  change added. In the page: `[...document.scripts].map(s => s.src).find(s => s.includes('/assets/index-'))`.
- Vercel deploys ~20-30 s after `git push origin main`. Reload open tabs (and the phone) after every deploy.
- Wait for a deploy in one call: `sh scripts/browser/wait-deploy.sh '<string your change added>'` (polls every 5 s,
  checks index.html and the bundle, prints the live bundle).
- Right after a deploy a navigation can get the previous index.html whose bundle 404s (blank page); the inline guard in
  index.html reloads once. If a page is blank, check `[...document.scripts]` against the live bundle and reload.

## Sign-in (since 2026-10-20; measured live at 384 px)
| What | Selector |
|---|---|
| Fields | `#login-username`, `#login-password`; submit is the form's `button[type=submit]` ("SIGN IN") |
| Reset / unlock | under SIGN IN two equal buttons (135×44 at 384): "Forgot password?" → `#login-backup-code` (masked text field, Show/Hide button), `#login-new-password`, `#login-confirm-password`, submit "RESET PASSWORD"; "Locked out?" → `#login-backup-code` only, "UNLOCK". Back: "← Back to sign in" |
| Account reset (signed in) | Account menu "Forgot Password? Use Backup Code" → `#acct-reset-code`, `#acct-reset-new-password`, `#acct-reset-confirm-password`; success signs every device out |
| Signed in? | `localStorage["proximaai-session"]` (JSON `{token, expires_at, username}`, 12 h); `proximaai-user` alone no longer signs in |
| Account modal ids | `#acct-current-password`, `#acct-new-password`, `#acct-confirm-password`, `#acct-new-username`, `#acct-backup-code`, `#acct-type-it-again`, `#acct-email-address`, `#acct-verification-code` |
Never type the owner's password or key. A minted token (`_sign_session_token('admin:'||username, <exp>)`) is also
revoked when exp − 12 h is before `app_secrets.admin_sessions_valid_after` (bumped by every password change or
backup-code unlock; 20:36 UTC on 2026-10-20), so a short token only works until the first such bump; after it, any
working token lives about 12 h and only "sign out everywhere" ends it — ask the owner first. Preferred: the owner signs
in to the Chrome tab, then drive the app.

## Navigation (no deep links: pages are React state)
| What | Selector / action |
|---|---|
| Cockpit (generate) | first `button.sidebar-btn` |
| Gallery / Logs | `button[title="Gallery"]`, `button[title="Logs"]` (pick the one with `offsetParent !== null`) |
| Type tabs (7, one row at 384 px) | `.type-tab` — Image, Image Edit, Image → 3D, Text → Video, Image → Video, Video Edit, Avatar. Clicking one CLEARS the model selection |

## Generating
| What | Selector / action |
|---|---|
| Model rows | `.model-item` (`.selected` when chosen); name in `.model-name` |
| Select a model | click `item.querySelector('input,button,[role=checkbox]') \|\| item.firstElementChild` — clicking the row container does nothing |
| Prompt | `textarea[placeholder^="Describe"]` — React-controlled: use the native value setter + `input` event |
| Batch count | the `.settings-row` whose `label` is "Batch" → its `select` (native setter + `change`) |
| Generate | `.gen-btn` (disabled until a model and a prompt are set, and while the server reports no/rejected key) |
| Running / done | `.task-progress-fill` exists while running; `.task-status` reads DONE / FAILED / PROCESSING |
| Batch position badge | `.task-batch-index` ("2/4") inside `.task-model` |

## Deleting (select mode)
`.sel-launch` → click `.task-card` (Gallery) or `.log-row` (Logs) → `.sel-del`. Delete raises `confirm()` more than
once (measured 2026-10-22: a second native confirm came after the first was answered): keep the
`window.confirm = () => true` override until the card count has dropped, then restore it. A native dialog freezes the
page for Claude in Chrome (scripts and screenshots time out) and a pressed Enter does not reach it — the owner must
click OK. Cards do not show the prompt text: find yours by `.task-model`, `.task-status` and the `img` src. Selected state:
`.task-card.card-selected`, `.log-row.log-row-selected`; count in `.sel-count`; `.sel-cancel` exits.
Always assert the selection is exactly your own rows before clicking delete.

Restore-check probe that writes nothing (measured 2026-10-22, bundle jENc_sX8): push a queued entry into localStorage
`proximaai-failed-syncs` — `{kind:"history", id:"probe-…", data:{id, timestamp:1, prompt:"[PROBE]", tasks:[], totalCost:0},
queuedAt:-1, ts:Date.now(), attempts:1}` — then short-press the Save button (`button.sidebar-btn`, title "Saved…" or
"Retry (n)"; dispatch mousedown, then mouseup within 600 ms, since a long press makes a backup). Expect POST
`rpc/upsert_queued_history` 200, the entry gone from the queue, title "Saved!", and no `history` row with that id.
queuedAt must be negative: the account's restore marker (settings `last_restore_at`) is `0` until a restore runs, so
any queuedAt ≥ 0 is NOT voided and the entry is written. Task/History delete intents (`task-delete`/`history-delete`
with ids that do not exist) probe `delete_queued_rows` the same way.

## Logs
Rows `.log-row:not(.log-header)` with `.log-prompt`, `.log-models` ("1 model · 4 images"), `.log-cost`.

## Money
- `.balance-pill` shows the WaveSpeed balance rounded to cents.
- Raw balance (6 decimals) from inside a signed-in page: `fetch("/api/wavespeed-v2/api/v3/balance", { headers:
  { "X-Proxima-Session": JSON.parse(localStorage["proximaai-session"]).token } })`. The key never reaches the browser
  (since 2026-10-20); proxy refusals carry `X-Proxima-Auth: session | no-key`.
- Cheapest live tests: Flux Schnell $0.003/image (native batch), P-Image $0.005/image (fan-out batch),
  Nano Banana 2.1 $0.036. Billing check 2026-10-20: estimate = logged cost = actual charge for both batch kinds.
- Prices follow the settings sent (`src/lib/pricing.js`). Billing check 2026-10-20 (bundle BptSS0uN), estimate =
  card = log = charge: GPT Image 2.0 low/2K $0.019, Nano Banana 2.1 2K $0.054, FLUX 3 Video Edit on a 5.06 s clip
  $0.18 (WaveSpeed bills ceil(seconds); charged at submit). `.cost-amount` starts with "~" and its `title` says so
  while an input's length is unmeasured; it then becomes exact.
- Picker `.model-price` = one generation of that model at the current settings (batch of one; same "~" rule); its
  `title` gives the default-settings price. Selecting one model at Batch 1 makes the estimate equal its label
  (swept on 82 models 2026-10-20, bundle 1hxo0fjF). Rows fit a 10-character label at 384 px.
- Cheap input-length test: Video Edit → FLUX 3 Video Edit ($0.03/s, ceil). Test clip: MDN CC0
  `https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4` (5.06 s, CORS `*`): fetch it into a
  `File` and inject it into `input[type=file][accept='video/*']` with `DataTransfer` + `change`; the app uploads it
  to WaveSpeed. Do NOT paste `static.wavespeed.ai` example URLs: that CDN 403s any foreign Referer, so the browser
  reports "Format error" and nothing can be measured (the app's own uploads on `*.cloudfront.net` work).

## Result webhook (since 2026-10-20)
- The proxy adds `standard_webhook=<site>/api/ws-webhook` to model submits; WaveSpeed's signed delivery is written into
  the cloud `tasks` row by task_id (`ws_webhook_apply`; waiting deliveries in `ws_webhook_events`, swept every 5 min by
  pg_cron `ws-webhook-sweep`). Code: `api/ws-webhook.ts`, `src/lib/wsWebhook.js`; tests `scripts/test-ws-webhook.mjs`,
  `scripts/test-ws-webhook-db.sql`.
- "App closed" test without leaving the page: before Generate, wrap `window.fetch` so GETs matching
  `/api/v3/predictions/<id>/result` throw `TypeError("Failed to fetch")` (the app retries, never fails), record the
  submit's `data.id` from the flux POST, then close the tab. supabase-js captured `fetch` at start, so its uploads
  pass. Proof: Vercel runtime log `[ws-webhook] 200 applied` (or `queued`) and an aggregate
  `select status, count(*) from tasks where start_time >= <t0 ms> group by status` (no prompts or outputs).
  Verified 2026-10-20: Flux Schnell, Generate 21:37:01.4 UTC, tab closed before the delivery (21:37:12.3 UTC), row
  completed.
- Network tracking in Claude in Chrome starts at its first `read_network_requests` call; call it before Generate.

## Data access and security (per-session RLS, since 2026-10-22)
- Every supabase-js call to `<SUPABASE_URL>/rest/v1/` and `/storage/v1/` carries `x-proxima-session: <token>`
  (src/lib/session.js `withSessionHeader`); the row policies (migrations 20261022100000 + 20261022120000) verify it
  per statement via `proxima_auth.session_scope()`. Signed out, the client answers table/Storage calls itself with 401
  "session token missing". A raw `fetch` to those paths WITHOUT the header is refused — use the app's client, or the
  service role for owner-run maintenance (scripts/tools/supabase-admin.mjs).
- Outsider view (publishable key only), measured right after the apply: any table read/write → 403
  `session token missing`; forged token → 403 `invalid signature`; expired/revoked → 403 with that message; Storage
  list → `200 []`; Storage upload/overwrite/remove → HTTP 500 `database error, code: 28000`; public image URL → 200.
  A plain table DELETE, with or without a valid session (since 20261022350000, measured 22:13 UTC), → HTTP 401 `42501
  permission denied for table <t>`: browser roles hold no DELETE; the app deletes only through the restore-checked RPCs.
- Edge logs show which build a device runs: `x_client_info` ends in `proxima-rls/1 sess/1` (signed in) or `sess/0`
  (RPCs before sign-in). CORS preflights (`OPTIONS`) never carry it — exclude them. Per-device gate query:
  `node scripts/tools/sb-logs.mjs <start> <end> "select multiIf(log_attributes['request.headers.user_agent'] like
  '%Windows NT%Chrome%','PC', log_attributes['request.headers.user_agent'] like '%Android%Chrome%','phone','other') as
  dev, log_attributes['request.headers.x_client_info'] as xci, log_attributes['response.status_code'] as st, count(*)
  as n from logs where source='edge_logs' and log_attributes['request.method'] != 'OPTIONS' and
  log_attributes['request.path'] like '/rest/v1/%' group by dev, xci, st"`.
- Live updates: no postgres_changes any more. Triggers on tasks/history send an empty Realtime broadcast on a secret
  topic (`get_my_account` → `sync_topic`); a device reconciles ~0.4–1.4 s after a write elsewhere (measured on both
  devices). Manual ping: `node scripts/tools/sb-query.mjs --write "select realtime.send('{}'::jsonb, 'changed',
  proxima_auth.sync_topic(), false)"`.
- SQL / logs without connector prompts: `scripts/tools/sb-query.mjs`, `scripts/tools/sb-logs.mjs` (Management API).
  Database tests (each rolls back; run alone against live): scripts/test-rls-{tables,storage,triggers,plan,rpcs,
  rename,phase0}.sql, rollback proof scripts/test-rls-rollback-before.sql + phase-2 file + rollback file +
  scripts/test-rls-rollback.sql in one call (a grants-only change ends with scripts/test-rls-grants-unchanged.sql
  instead). Rollback files: supabase/rollback/ (never in migrations/).
  Test with pending migrations: `node scripts/tools/sql-tx.mjs [migration.sql ...] --test <test.sql>` (begin + files +
  a guard that always aborts; prints one line per case, exit 0 only with zero FAIL). Apply + record a migration in
  schema_migrations: `node scripts/tools/apply-migration.mjs <file.sql> --dry-run` first (writes nothing, says whether
  the version is already recorded), then without --dry-run (one transaction per file; refuses recorded versions).
- Opening the app on the phone: Chrome's `/json/new` is refused; use `adb shell am start -a android.intent.action.VIEW
  -d https://proxima-ai-seven.vercel.app/ com.android.chrome` (new tab, other tabs untouched).

## Storage
- IndexedDB `proximaai`: stores `settings` (key), `tasks` (id), `history` (id), `favorites`, `presets`.
- localStorage: `proximaai-failed-syncs` (upload/delete retry queue), `proximaai-user` (username).
- Cloud: Supabase `vhznmpxlcjbdzntmfvvy`, tables `tasks`, `history`, `sync_tombstones`; scope column
  `device_id = "user:<username>"`. Sync design: `src/lib/syncReconcile.js`. Since 2026-10-22 every row is readable and
  writable only with a valid session, and writes only into the session's own scope (see "Data access and security").

## Gotchas
- The Claude in Chrome JS tool times out at 45 s: start long work without awaiting it, store the result on `window`,
  and poll in a second call (see `scripts/browser/app-helpers.js`).
- Several Claude sessions may drive the same Chrome profile: every open app tab is a full sync client on the same
  IndexedDB. Close your tabs when done and never assume a row you see is yours — match your own prompt text.
- 384 px layout without a phone: a same-origin `<iframe src="/">` 384 px wide inside an app tab shares the signed-in
  session, and media queries follow the frame width (DPR does not).
- Phone (Galaxy S24, 384×782 CSS px @ 3.75): `scripts/browser/phone-watchdog.sh` + `scripts/browser/cdp.mjs`
  (`GC_PORT=9333`). Start the watchdog before driving the phone; it locks the phone if another app takes the
  foreground, so stop it when you finish.
