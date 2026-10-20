export const meta = {
  name: 'proxima-security-cutover-review',
  description: 'Exhaustive review of the 2026-10-20 ProximaAI sign-in/proxy cut-over, poll loop and log CSS: 6 dimension finders, dedup, 3-lens adversarial verify',
  phases: [
    { title: 'Find', detail: '6 dimension finders over cb8d026..478a741' },
    { title: 'Verify', detail: '3 perspective-diverse refuters per finding' },
  ],
}

const M = 'claude-opus-5-5'

const CONTEXT = `Repo: C:/Users/aicod/Projects/ProximaAI/deploy (React+Vite SPA on Vercel at https://proxima-ai-seven.vercel.app; Supabase project vhznmpxlcjbdzntmfvvy; WaveSpeed AI API reached only through the edge proxy api/ws-proxy.ts mounted at /api/wavespeed-v2 via vercel.json).
Changes under review: commits cb8d026..478a741 on main (git log --oneline cb8d026..478a741; git diff cb8d026..478a741 -- <path>; files at HEAD are current).
Design shipped today:
- Sign-in: RPC verify_admin (bcrypt in app_secrets) -> HMAC token "admin:<user>.<exp>.<sig>", 12 h, stored in localStorage "proximaai-session" (src/lib/session.js). _verify_session_token (SQL) checks HMAC, expiry and revocation (token username must equal app_secrets admin_username; tokens with exp-12h < admin_sessions_valid_after are revoked; bumped by change_my_password and unlock_admin_with_backup_code).
- 3 failed sign-ins lock sign-in (admin_login_lockout, FOR UPDATE); _reauth_admin (used by change_my_password, rename_my_account, set_admin_backup_code) shares that counter. unlock_admin_with_backup_code: 5 wrong codes -> 15 min pause.
- WaveSpeed key only in user_secrets; proxy verifies the token in memory, then get_my_wavespeed_key RPC (service role) re-verifies in DB; refusals carry X-Proxima-Auth: session (401) | no-key (400); lookup failure 503. Client src/lib/api.js wsFetch maps these to {session:true}/{noKey:true}; toProxyUrl maps poll URLs.
- Uploads go to the public Supabase bucket "generations" under uploads/<scope>/ (src/lib/supabase.js uploadInputFile).
- Backups via token-checked RPCs snapshot/list/restore/delete_my_backup_phase2 (restore re-scopes rows to the current user).
- Triggers: settings_drop_secrets (skips settings rows with key apiKey), backups_strip_secrets (strips apiKey from settings_snapshot).
- Client: LoginScreen (sign-in + backup-code unlock), AccountModal (password/username/backup code need current password; email OTP is a UI step), keyStatus/keyBlocked replaces the old apiKey state, signOutLocal + session-expiry handler, one shared startPolling() loop (src/lib/taskResume.js applyPoll/pollTiming/pollErrorAction), service worker skips /api/ and non-GET, mobile log rows (fixed 128px models column, class-based hiding .log-hide-m).
- Migrations: supabase/migrations/20261020000004..07. Another session concurrently shipped settings-aware pricing (src/lib/taskDraft.js, pricing.js, model picker labels) in commits before cb8d026 — check that today's App.jsx edits did not break it.
OUT OF SCOPE (never report): generation tables tasks/history/favorites/presets/settings/sync_tombstones are still anon read/write (separate planned project); the legacy /wavespeed rewrite in vercel.json is intentionally kept until the owner reloads devices; no Upstash rate limit; the email OTP step is client-side only; the 3-try sign-in lockout being triggerable by anyone (owner's explicit requirement).
ALREADY FIXED after a first review (report only if the fix itself is wrong): permanent backup-code lock; restore after rename; session revocation; proxy 503 vs no-key; service worker caching /api.
HARD RULES: read-only — never edit files, commit, push, run npm/dev servers, or call the live site/proxy. Never read private generation data: no SELECT from any public.* or storage.* table rows, no browser storage, no transcripts or AppData files. Report only CONFIRMED defects with a concrete failure scenario (exact inputs/state -> wrong result), cited as file:line at HEAD. No style nits, no hypotheticals without a path. If nothing is wrong in your area, return an empty findings list.`

const CATALOG = `You MAY run read-only catalog queries to see live function definitions not in this repo (e.g. _sign_session_token, get_my_wavespeed_key, set_my_wavespeed_key, snapshot/delete_my_backup_phase2, create_auto_backup, verify_admin): load the tool with ToolSearch query "select:mcp__776972a0-1db0-4a89-827e-0d85b5053da6__execute_sql" and call it with project_id "vhznmpxlcjbdzntmfvvy". Only SELECT from pg_proc / pg_get_functiondef(), pg_policies, pg_trigger, pg_class, information_schema, and has_*_privilege() checks. NEVER select rows from public.* or storage.* tables, never write.`

const FINDINGS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['Critical', 'High', 'Medium', 'Low'] },
          file: { type: 'string' },
          line: { type: 'integer' },
          scenario: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['title', 'severity', 'file', 'line', 'scenario', 'fix'],
      },
    },
    checked: { type: 'string' },
  },
  required: ['findings', 'checked'],
}

const VERDICT = {
  type: 'object',
  properties: {
    refuted: { type: 'boolean' },
    reason: { type: 'string' },
    adjusted_severity: { type: 'string', enum: ['Critical', 'High', 'Medium', 'Low'] },
  },
  required: ['refuted', 'reason'],
}

const DIMENSIONS = [
  { key: 'auth-sql', prompt: `Dimension: SERVER AUTH + SQL. Review supabase/migrations/20261020000004..07 and the live functions they call. Hunt: any path that issues a session, changes password/backup code/username, or exposes the WaveSpeed key without the right secret; lockout counter bypasses or races; revocation gaps (tokens minted by rename/change_my_password, the 12h iat assumption, the previous signing key); grants/search_path/SECURITY DEFINER pitfalls; triggers that break existing writes (restore, rename, pg_cron create_auto_backup, client syncSetting upserts); runtime type errors. ${CATALOG}` },
  { key: 'proxy-edge', prompt: `Dimension: EDGE PROXY + DEPLOY CONFIG. Review api/ws-proxy.ts, vercel.json, public/sw.js. Hunt: token handling (header precedence, Authorization fallback), timing/forgery, SSRF or path tricks through the ?p= path or query passthrough (can a caller reach a non-WaveSpeed host or another WaveSpeed account), CORS mistakes, body handling (413, empty bodies, multipart), abort handling, the 401/400/503 mapping and X-Proxima-Auth exposure, caching, anything that would make the client mislabel an error. ${CATALOG}` },
  { key: 'client-session', prompt: `Dimension: CLIENT SESSION + ACCOUNT. Review src/lib/session.js, src/lib/supabase.js (sessionRpc, signIn, unlockWithBackupCode, account RPC wrappers, backups), and in src/App.jsx: LoginScreen, AccountModal, handleSignedIn, handleLogout/signOutLocal, the session-expiry ref/effects, the isAuthed init. Hunt: sign-out loops, state updates after sign-out, expired-session handling gaps (an RPC raising a session error not signing out, or a non-session error signing out), network errors shown as wrong password, rehash path errors, rename flow (token swap, reload, scope), password change token swap, backup-code form validation, anything that leaves a device signed in with a dead token or signed out with a live one.` },
  { key: 'client-generation', prompt: `Dimension: CLIENT GENERATION PIPELINE. Review src/lib/api.js, src/lib/taskResume.js, scripts/test-task-resume.mjs, and in src/App.jsx: refreshBalance/keyStatus/keyBlocked, startPolling, the resume effect, handleGenerate submit + batching, regenerateTask, the upload handlers (uploadSingleFile, file selects), the settings key UI, gen-btn gating, Reset Everything. Also confirm today's App.jsx edits did not break the other session's settings-aware pricing (draftTask/unitQuote/taskUserSettings, model picker price labels). Hunt: polls that never stop or stop and never resume, tasks failed wrongly or stuck processing, duplicate polls (pollRefs), stale closures (useCallback deps), wrong genType for timing, toProxyUrl mapping mistakes for stored poll URLs, upload MIME/extension/size failures against the bucket rules, keyStatus never leaving "missing"/"invalid", generation blocked or allowed wrongly.` },
  { key: 'sync-data', prompt: `Dimension: SYNC + DATA INTEGRITY. Review how today's changes interact with cross-device sync: src/lib/supabase.js getDeviceId (proximaai-user now set/cleared by session.js), syncSetting/pull paths, the failed-sync queue (localStorage proximaai-failed-syncs, apiKey entries), forceSaveAll, the bootstrap/reconcile effects in src/App.jsx, realtime subscribeToCloudChanges scope, rename_my_account moving rows server-side then reload, restore_my_backup_phase2, the settings_drop_secrets trigger (returns NULL for apiKey: any client path that treats a skipped upsert as an error or loops?), backups_strip_secrets. Hunt: data written under the wrong scope (random device id after clearSession while debounced writes are pending), lost or resurrected rows, retry loops, tombstone breakage. ${CATALOG}` },
  { key: 'ui-mobile', prompt: `Dimension: UI + MOBILE (primary device 384x782 CSS px, Galaxy S24 Ultra; tap targets >=44, no horizontal pan, symmetric rows). Review statically in src/App.jsx: LoginScreen (sign-in and unlock modes), AccountModal steps (menu, set-backup with Generate button row, change-username/password with current-password field), the Settings WaveSpeed key block, the topbar key warning, gen-btn labels, and the log table CSS at <=768px (.log-row grid minmax(0,1fr) 128px 50px, .log-hide-m, header vs rows, select mode with the absolute checkmark and padding-left 40). Hunt: overflow at 384, buttons under 44px where they are primary, misaligned columns between header and rows, text that wraps badly, a11y gaps that block use (labels, autocomplete for password managers, focus), messages that misreport state.` },
]

phase('Find')
const results = await parallel(DIMENSIONS.map(d => () =>
  agent(`${CONTEXT}\n\n${d.prompt}\n\nReturn findings (may be empty) and a one-paragraph "checked" summary of what you verified as fine.`,
    { label: `find:${d.key}`, phase: 'Find', schema: FINDINGS, model: M, effort: 'medium' })
    .then(r => r ? r.findings.map(f => ({ ...f, dimension: d.key })) : null)))

const failedDims = DIMENSIONS.filter((d, i) => results[i] === null).map(d => d.key)
if (failedDims.length) log(`Finder(s) returned nothing (coverage gap): ${failedDims.join(', ')}`)
const all = results.filter(Boolean).flat()
log(`${all.length} raw findings`)

// Dedup across dimensions: same file within ~8 lines -> keep the most severe.
const rank = { Critical: 0, High: 1, Medium: 2, Low: 3 }
const byKey = new Map()
for (const f of all) {
  const k = `${f.file.replace(/^.*deploy[\\/]/, '')}:${Math.floor(f.line / 8)}`
  const prev = byKey.get(k)
  if (!prev) byKey.set(k, { ...f, alsoFrom: [] })
  else {
    const keep = rank[f.severity] < rank[prev.severity] ? { ...f, alsoFrom: [...prev.alsoFrom, `${prev.dimension}: ${prev.title}`] } : { ...prev, alsoFrom: [...prev.alsoFrom, `${f.dimension}: ${f.title}`] }
    byKey.set(k, keep)
  }
}
const deduped = [...byKey.values()]
if (deduped.length < all.length) log(`Dedup merged ${all.length - deduped.length} overlapping findings`)

phase('Verify')
const LENSES = [
  { key: 'reproduce', ask: 'Trace the exact code path at HEAD for the stated scenario, step by step. Does the failure actually happen as described? Refute if any step does not hold.' },
  { key: 'guarded', ask: 'Look for anything elsewhere that already prevents this: another guard, caller, trigger, RLS/grant, server check, React behavior, or browser behavior. Refute if it is already prevented or out of scope per the context.' },
  { key: 'impact', ask: 'Judge real-world impact for the owner (a single admin user on a PC and a 384px phone). Refute if it cannot affect real use or security; otherwise set adjusted_severity honestly.' },
]
const verified = await parallel(deduped.map((f, i) => () =>
  parallel(LENSES.map(l => () =>
    agent(`${CONTEXT}\n\nYou are an adversarial verifier. Lens: ${l.key}. ${l.ask}\nDefault to refuted=true if you cannot make the failure concrete from the code.\n\nFINDING (from dimension ${f.dimension}):\n${JSON.stringify({ title: f.title, severity: f.severity, file: f.file, line: f.line, scenario: f.scenario, fix: f.fix, alsoReportedAs: f.alsoFrom })}`,
      { label: `verify:${i}:${l.key}`, phase: 'Verify', schema: VERDICT, model: M, effort: 'high' })))
    .then(vs => {
      const votes = vs.filter(Boolean)
      const upheld = votes.filter(v => !v.refuted)
      const sev = upheld.map(v => v.adjusted_severity).filter(Boolean)
      return { ...f, votes: votes.length, upheld: upheld.length, survives: upheld.length >= 2,
        severity_after: sev.length ? sev.sort((a, b) => rank[b] - rank[a])[Math.floor(sev.length / 2)] : f.severity,
        reasons: votes.map(v => `${v.refuted ? 'REFUTED' : 'UPHELD'}: ${v.reason}`) }
    })))

const confirmed = verified.filter(Boolean).filter(v => v.survives).sort((a, b) => rank[a.severity_after] - rank[b.severity_after])
const refuted = verified.filter(Boolean).filter(v => !v.survives).map(v => ({ title: v.title, file: v.file, line: v.line, upheld: v.upheld, reasons: v.reasons }))
log(`${confirmed.length} confirmed, ${refuted.length} refuted`)
return { confirmed, refuted, coverageGaps: failedDims, rawCount: all.length }