# ProximaAI page map

Measured on the live site (https://proxima-ai-seven.vercel.app) on 2026-10-20, by driving it from
Claude in Chrome (desktop) and the owner's Galaxy S24 over adb + CDP. Load this before driving the site.
Reusable scripts are in `scripts/browser/`.

## Build check
- Live bundle: `curl -sL <site>/ | grep -o 'assets/index-[^"]*\.js'`, then grep that bundle for a string your
  change added. In the page: `[...document.scripts].map(s => s.src).find(s => s.includes('/assets/index-'))`.
- Vercel deploys ~20-30 s after `git push origin main`. Reload open tabs (and the phone) after every deploy.
- Wait for a deploy in one call: `sh scripts/browser/wait-deploy.sh '<string your change added>'` (polls every 5 s, prints the live bundle).

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
`.sel-launch` → click `.task-card` (Gallery) or `.log-row` (Logs) → `.sel-del`. Delete raises `confirm()`:
override `window.confirm = () => true` for that click only and restore it. Selected state:
`.task-card.card-selected`, `.log-row.log-row-selected`; count in `.sel-count`; `.sel-cancel` exits.
Always assert the selection is exactly your own rows before clicking delete.

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

## Storage
- IndexedDB `proximaai`: stores `settings` (key), `tasks` (id), `history` (id), `favorites`, `presets`.
- localStorage: `proximaai-failed-syncs` (upload/delete retry queue), `proximaai-user` (username).
- Cloud: Supabase `vhznmpxlcjbdzntmfvvy`, tables `tasks`, `history`, `sync_tombstones`; scope column
  `device_id = "user:<username>"`. Sync design: `src/lib/syncReconcile.js`.

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
