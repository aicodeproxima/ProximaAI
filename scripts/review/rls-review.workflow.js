export const meta = {
  name: 'proxima-rls-review',
  description: 'Adversarial review of the ProximaAI per-session RLS rollout (phase 0/1/2 migrations, client, tests): 5 dimension finders, dedup, 2-lens refuters',
  phases: [
    { title: 'Find', detail: '5 dimension finders' },
    { title: 'Verify', detail: '2 adversarial refuters per finding' },
  ],
}

const M = 'claude-opus-5-5'
const CTX_FILE = (args && args.context) || 'C:/Users/aicod/Projects/ProximaAI/deploy/docs/rls-review-context.md'
const ROUND = (args && args.round) || 1
const PRIOR = (args && args.prior) || ''

const CONTEXT = `You are reviewing a security change in the ProximaAI repo (it may be shipped or not; the context file says). FIRST read ${CTX_FILE} (what changed, why, the files, the deviations from the design spec, how to query the live DB read-only). It also points to the migrations, client files and tests.
Report only CONFIRMED defects: a concrete failure scenario (exact inputs/state -> wrong result) cited as file:line, ideally proven with a rolled-back DO block or a code trace. No style nits, no "consider", no hypotheticals without a path. Things explicitly accepted in the context file (e.g. an expired-token holder keeps receiving content-free pings until topic rotation; bucket-wide storage for the single admin; other-scope rows readable/deletable by the admin session) are NOT defects. If nothing is wrong in your area, return an empty list.${PRIOR ? `\nALREADY HANDLED in earlier rounds (do not re-report unless the fix itself is wrong): ${PRIOR}` : ''}`

const FINDINGS = {
  type: 'object',
  properties: {
    findings: { type: 'array', items: { type: 'object', properties: {
      title: { type: 'string' }, severity: { type: 'string', enum: ['Critical', 'High', 'Medium', 'Low'] },
      file: { type: 'string' }, line: { type: 'integer' }, scenario: { type: 'string' }, evidence: { type: 'string' }, fix: { type: 'string' } },
      required: ['title', 'severity', 'file', 'line', 'scenario', 'evidence', 'fix'] } },
    checked: { type: 'string' },
  },
  required: ['findings', 'checked'],
}
const VERDICT = {
  type: 'object',
  properties: { refuted: { type: 'boolean' }, reason: { type: 'string' }, adjusted_severity: { type: 'string', enum: ['Critical', 'High', 'Medium', 'Low'] } },
  required: ['refuted', 'reason'],
}

const DIMENSIONS = [
  { key: 'security', prompt: 'SECURITY: can anyone holding only the publishable/anon key (or the authenticated role from a self-made Email-OTP user) read, change or delete any row of the six tables or any object/listing in bucket generations after phase 2, or learn the sync topic, or call the helpers? Check header spoofing/injection (request.headers JSON shape, duplicate headers, case), SECURITY DEFINER + search_path, exposed schemas, GRANT/REVOKE gaps (incl. column privileges, default privileges, sequences), RPC paths that read these tables as INVOKER, storage.prefixes / other storage tables or functions that list objects without going through storage.objects policies, Realtime (postgres_changes after the publication drop, broadcast topic guessing, realtime.messages readability by anon), and revocation timing (password change, rename, key rotation).' },
  { key: 'nobreak', prompt: 'NO-BREAKAGE: walk every client data path in src/lib/supabase.js and its callers (App.jsx, purge.js, wsDelete.js, batchLog/taskResume as relevant) under phase 1 + phase 2: bootstrap pull, reconcile (checkSession, pullAllRemoteData, pullCloudIds keyset, uploads, deletes, tombstones), failed-sync replay, settings/model-favorites sync, archive upload/upsert + getPublicUrl, input uploads (50 MB), getArchiveStats list, deleteArchivedPath, backups/restore/rename RPCs, sign-in/out, email OTP window, session expiry while the app is open, a device still on the OLD bundle after phase 2, the proxy/webhook (service role), pg_cron jobs, and every trigger. Find any path that breaks, loses data, resurrects deleted rows, or pins the save status in error.' },
  { key: 'realtime', prompt: 'LIVE UPDATES: review the content-free ping end to end: proxima_auth.ping_sync + the six statement-level transition-table triggers (correctness for INSERT ... ON CONFLICT, multi-row statements, restore/rename bulk updates, webhook DEFINER writes, cron, trigger ordering with existing triggers, realtime.send behaviour/permissions/errors, write-path cost), sync_topic rotation, get_my_account, and the client (src/lib/syncPing.js, supabase.js subscribeToCloudChanges/checkSession/getMyAccount, App.jsx effect ~1950 that calls subscribeToCloudChanges(soon) and reconcileWithCloud which calls checkSession first). Find cases where pings stop arriving for good, arrive for the wrong account, leak anything, open duplicate channels, or break writes. Also: what happens between phase 1 deploy and phase 2 (postgres_changes removed client-side while still published).' },
  { key: 'tests', prompt: 'TEST INTEGRITY: read every new test (scripts/test-rls-*.sql, scripts/test-session-header.mjs, test-sync-ping.mjs, test-storage-remove.mjs). Do they prove what they claim, against the real roles and request shapes PostgREST/Storage use (e.g. PostgREST upsert = INSERT ... ON CONFLICT DO UPDATE SET <all columns> from excluded; DELETE with filters; Prefer return=minimal)? Are there must-allow or must-deny cases missing (e.g. storage upsert via ON CONFLICT, PostgREST bulk upsert of 100 rows, keyset reads with gt, settings upsert with the (device_id,key) conflict, restore_my_backup_phase2 / rename_my_account / snapshot / purge_my_backups_of run through the new policies as anon calling the RPC, ws_webhook_apply as service_role, cron functions as postgres)? You MAY run additional rolled-back DO blocks (prepend both migration files) to prove a gap is a real defect rather than just untested.' },
  { key: 'rollout', prompt: 'ROLLOUT AND ROLLBACK: check the phase order and gates for hazards: applying phase 0 before the phase-1 deploy, the window where phase 1 runs against open policies, edge_logs proof, the CACHE_NAME bump and the "New version ready" banner (src/lib/updateCheck.js, public/sw.js), a third browser/tab or a cached PWA still on the old bundle when phase 2 lands, migration file naming vs the live migration history (supabase_migrations), rollback exactness (catalog diff covers what?), rollback ordering (phase 2 before phase 0), and whether the rollback of phase 2 leaves the phase-1 client working. Find concrete ways the rollout or a rollback breaks the live app.' },
]

phase('Find')
const found = (await parallel(DIMENSIONS.map(d => () =>
  agent(`${CONTEXT}\n\nYour dimension (round ${ROUND}): ${d.prompt}`, { label: `find:${d.key}`, phase: 'Find', schema: FINDINGS, model: M, effort: 'medium' })
))).filter(Boolean)
const all = found.flatMap((r, i) => (r.findings || []).map(f => ({ ...f, dim: DIMENSIONS[i].key })))
const seen = new Map()
for (const f of all) {
  const key = `${(f.file || '').replace(/\\/g, '/').split('/').pop()}:${Math.round((f.line || 0) / 6)}:${f.title.toLowerCase().split(/\W+/).slice(0, 3).join(' ')}`
  if (!seen.has(key)) seen.set(key, f)
}
const deduped = [...seen.values()]
log(`round ${ROUND}: ${all.length} findings, ${deduped.length} after dedup`)
if (!deduped.length) return { round: ROUND, confirmed: [], refuted: [], checked: found.map(r => r.checked) }

phase('Verify')
const LENSES = [
  'REPRODUCE lens: rebuild the exact failure from the code and, where it is database behaviour, with a rolled-back DO block (prepend the migration files). If it does not reproduce exactly as described, it is refuted.',
  'IMPACT lens: assume the mechanism is as described; does it actually hurt the owner (data exposure to a sessionless caller, data loss, a broken flow, a stuck error status) in this single-admin app, given the accepted trade-offs in the context file? If the impact is nil or already guarded elsewhere (cite where), it is refuted.',
]
const judged = await parallel(deduped.map(f => () =>
  parallel(LENSES.map((lens, li) => () =>
    agent(`${CONTEXT}\n\nAdversarially verify this finding. Default to refuted=true if you cannot confirm it with evidence.\n${lens}\n\nFINDING (${f.dim}): ${f.title} [${f.severity}] at ${f.file}:${f.line}\nScenario: ${f.scenario}\nEvidence given: ${f.evidence}\nProposed fix: ${f.fix}`,
      { label: `verify:${f.dim}:${li}`, phase: 'Verify', schema: VERDICT, model: M, effort: 'high' })
  )).then(vs => ({ ...f, verdicts: vs.filter(Boolean), confirmed: vs.filter(Boolean).filter(v => !v.refuted).length === 2 }))
))
const confirmed = judged.filter(Boolean).filter(j => j.confirmed)
const refuted = judged.filter(Boolean).filter(j => !j.confirmed).map(j => ({ title: j.title, file: j.file, line: j.line, reasons: j.verdicts.map(v => (v.refuted ? 'REFUTED: ' : 'CONFIRMED: ') + v.reason.slice(0, 300)) }))
log(`round ${ROUND}: ${confirmed.length} confirmed, ${refuted.length} refuted`)
return { round: ROUND, confirmed, refuted }
