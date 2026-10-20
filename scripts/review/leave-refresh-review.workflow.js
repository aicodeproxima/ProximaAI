export const meta = {
  name: 'proxima-leave-refresh-review',
  description: 'Adversarial review of the ProximaAI leave/refresh generation fixes (fea3698..ba39483): 6 dimension finders, dedup, 3-lens verify',
  phases: [
    { title: 'Find', detail: '6 dimension finders over fea3698..ba39483' },
    { title: 'Verify', detail: '3 perspective-diverse refuters per finding' },
  ],
}

const M = 'claude-opus-5-5'

const CONTEXT = `Repo: C:/Users/aicod/Projects/ProximaAI/deploy (React+Vite PWA on Vercel at https://proxima-ai-seven.vercel.app; Supabase project vhznmpxlcjbdzntmfvvy; WaveSpeed AI API reached only through the edge proxy api/ws-proxy.ts at /api/wavespeed-v2). The app runs on the owner's Android phone (384x782 CSS px, Chrome freezes the app and kills its sockets when it leaves the foreground) and a PC.
Owner's request: "every time I leave the app while generating or refresh the page it fails to fetch the generations — fix it."
Changes under review: commits fea3698..ba39483 on main (git log --oneline fea3698..ba39483; git diff fea3698..ba39483 -- <path>; files at HEAD are current). Earlier same-day work (startPolling single loop, recovery of wrongly failed tasks via planResume 'recovered', update banner, retryTask, 15 s poll timeout) is context, not under review unless these commits broke it.
What the commits do:
- 0b09e79: planRepoll (taskResume.js) + effect re-polls every running task on visibilitychange->visible / pageshow(persisted) / online, throttled 5 s; clears the old timer and restarts startPolling with delay 0.
- aafaf1b: ws-proxy.ts no longer forwards req.signal to upstream POSTs (GET still does); ctx.waitUntil on the POST.
- 3226656: lost submits. The pending task is saved to IndexedDB before submitTask; submit has a 60 s timeout; a submit error for which submitMayHaveLanded(e) is true keeps the task pending; recoverOrphans() looks up WaveSpeed history (listPredictions: POST /api/v3/predictions {page,page_size:100,created_after,created_before}, up to 5 pages; documented item shape {id, model (slug), outputs, urls.get, status, created_at RFC3339 with ns}) and adopts a match (planOrphans: same model slug, created in [start-30 s, start+2 min], not owned, never while any submit is in flight) or fails it as UNSUBMITTED once a lookup that answered finds nothing after 2 min; planResume now returns orphans (pending rows without a prediction id) instead of expiring them after 10 min; rows with taskId but no pollUrl resume via pollUrlFor.
- dbba683: a submit response for a task cancelled meanwhile is ignored (isInFlight + settlePoll).
- 7d7449a: cross-device running tasks. syncInFlight uploads a processing row right after submit (queued in the failed-sync queue; removeFailedSync(kind,id,onlyIf) clears only the in-flight version); pullTasks includes 'processing'; bootstrap + reconcile don't mark pulled running rows saved and call pollUntracked; planTaskSync (syncReconcile.js) adds 'finish' updates (cloud finished + local in flight, except connection-loss failures while recovering), 'resend' (local finished + cloud processing, after the grace), and removes tombstoned running tasks; applyCloudUpdate. Migration 20261020000011 trigger tasks_keep_finished: a finished row is never set back to pending/processing.
- 9865a0a + e3260a3: batch History entry written at batch start (items carry task ids; tasks column jsonb) and finished by an effect (finishLogs in src/lib/batchLog.js) once all its tasks finished; persistLog; save effect stores every unsaved entry; IDB-loaded logs marked saved. Migration 20261020000012 history_keep_finished.
- 1e95e21: migration 20261020000013 makes _rows_keep_owner SECURITY DEFINER (it reads app_secrets; anon cannot; every update-upsert had failed 401).
- ba39483: pollErrorAction 401/403 -> "stop" (key rejected, keyStatusAfter -> "invalid"), 408 retry; lookup + submits set keyStatus; refreshBalance on return at most once a minute.
Tests: node scripts/test-task-resume.mjs (52), scripts/test-sync-reconcile.mjs (18), scripts/test-batch-log.mjs (6) — you may run these three node scripts (they are pure, no network).
OUT OF SCOPE (never report): generation tables are anon read/write with permissive RLS (separate planned project); no server webhook yet (planned follow-up); the legacy /wavespeed rewrite in vercel.json; no Upstash rate limit; WaveSpeed history sort order being undocumented (handled by the time window); iOS Safari.
HARD RULES: read-only — never edit files, commit, push, run npm/dev servers, or call the live site, the proxy or WaveSpeed. Never read private generation data: no SELECT of rows from public.* or storage.* tables, no browser storage, no transcripts or AppData files. Report only CONFIRMED defects with a concrete failure scenario (exact inputs/state -> wrong result), cited as file:line at HEAD. No style nits, no hypotheticals without a path. If nothing is wrong in your area, return an empty findings list.`

const SQL = `For SQL you MAY load the tool with ToolSearch query "select:mcp__776972a0-1db0-4a89-827e-0d85b5053da6__execute_sql" (project_id "vhznmpxlcjbdzntmfvvy") and run: catalog reads (pg_proc / pg_get_functiondef(), pg_trigger, pg_policies, information_schema, has_*_privilege()), and behaviour tests ONLY in this form, on synthetic ids starting 'zz-review-' and device_id 'test:review', always as the app's role and always rolled back: do $$ declare r text := ''; begin set local role anon; ...inserts/upserts/updates on the synthetic rows only...; r := r || ...; raise exception 'RESULT: %', r; end $$; (the exception rolls everything back). Never select or touch any other row.`

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
  { key: 'poll-loop', prompt: `Dimension: POLL LOOP + RE-POLL + KEY HANDLING. Review src/lib/taskResume.js (planRepoll, pollErrorAction, keyStatusAfter, planResume) and in src/App.jsx: startPolling, the resume effect, the re-poll (kick) effect, the refreshBalance-on-visible effect, keyBlocked gating, cancelTask. Hunt: duplicate concurrent loops for one task, a loop orphaned so a task stays processing forever, re-poll restarting a loop for a task another path just finished, stale closures in effects (deps), polls that stop on 401 and never restart after a working key is saved (trace keyBlocked -> resume effect -> getPendingTasks: does it restart tasks whose IndexedDB row is processing? what about tasks pulled from the cloud or adopted orphans?), 408/429/5xx/TypeError/DOMException classification, timers not cleared on sign-out.` },
  { key: 'submit-orphans', prompt: `Dimension: SUBMIT + LOST-SUBMIT RECOVERY + PROXY. Review api/ws-proxy.ts (POST without req.signal, ctx.waitUntil, 499 path), src/lib/api.js (submitTask timeout, listPredictions paging and error mapping, timeoutSignal), src/lib/taskResume.js (isOrphan, orphanWindows, planOrphans, submitMayHaveLanded), src/lib/storage.js getPendingTasks, and in src/App.jsx handleGenerate, regenerateTask, recoverOrphans and its triggers. Hunt: an orphan adopting the wrong prediction (another task's, another batch's, a PC's, a retry's), double adoption across two passes or two tabs, an orphan that never resolves (stays pending forever), an orphan failed while WaveSpeed has it, the 'sent' flag / submittingIds bookkeeping leaking (an exception path that never deletes the id would block every lookup forever), saveTasks-before-submit racing later saves, wallClock timers, the 60 s submit timeout firing on a slow but healthy upload, a regression in sync-mode (outputs in submit response) or error messages (402/429/401). Check the proxy compiles as an Edge function and that waitUntil on the context is used correctly.` },
  { key: 'cross-device', prompt: `Dimension: CROSS-DEVICE SYNC OF RUNNING TASKS. Review src/lib/syncReconcile.js (planTaskSync finish/resend/tombstoned-running, applyCloudUpdate), scripts/test-sync-reconcile.mjs, src/lib/supabase.js pullTasks/taskToRow/syncTask, src/lib/storage.js removeFailedSync onlyIf, and in src/App.jsx syncInFlight, pollUntracked, the bootstrap merge, reconcileWithCloud, the persistence effect, savedTaskIds/recoveringIds. Hunt: a result lost (never uploaded because a running pulled row was marked saved, or a finish update marking it saved before IndexedDB/cloud hold the result), a cloud row stuck at processing, ping-pong between devices, the failed-sync queue (200 cap) evicting real writes because of processing entries, a deleted task resurrected, a cancelled task un-cancelled by another device's cloud copy, wrong handling of 'recovered' rows, two devices both polling forever. ${SQL}` },
  { key: 'batch-log', prompt: `Dimension: BATCH HISTORY ENTRY. Review src/lib/batchLog.js, scripts/test-batch-log.mjs, and in src/App.jsx persistLog, the log save effect, the finishLogs effect, handleGenerate's entry at batch start, the History load (getHistory + savedLogIds), deletes of logs (deletingLogIds), Clear/Reset paths, replayLog, planLogSync uploads, and src/lib/supabase.js historyToRow/pullHistory. Hunt: render loops between the two effects, an entry re-uploaded on every load or every render, an entry never finished (tasks missing, regenerated tasks, cancelled tasks, tasks deleted before finishing), wrong totalCost, an open entry overwriting a finished one locally (IndexedDB) or in the queue, deleted entries resurrected by persistLog, replayLog of an open entry, any field lost compared with the old end-of-batch entry. ${SQL}` },
  { key: 'sql-triggers', prompt: `Dimension: SQL TRIGGERS. Review supabase/migrations/20261020000009..13 and every trigger now on public.tasks, public.history, public.favorites, public.settings, public.data_backups (pg_trigger + pg_get_functiondef). Test their behaviour AS ANON with the rolled-back pattern below: upserts on new and existing rows, status transitions, the ownership rule (moves out of the live scope blocked, into it allowed — compute the live scope inside the DO block from app_secrets BEFORE set local role anon, never print it), history open/finished with arrays, objects, null, and empty tasks, and trigger ordering (tasks_keep_finished returning OLD vs _rows_keep_owner changing NEW.device_id — does returning OLD discard an allowed rescue move?). Also check restore_my_backup_phase2 and rename_my_account still work with the new triggers (catalog read of their definitions; a backup restore re-inserting a processing row over a finished one, a rename re-scoping rows). Hunt: any write the app makes that now fails or is silently dropped, SECURITY DEFINER pitfalls (search_path, EXECUTE grants), anything anon can now read that it could not before. ${SQL}` },
  { key: 'regressions', prompt: `Dimension: REGRESSIONS IN EXISTING FEATURES. Using git diff fea3698..ba39483 -- src/App.jsx and the lib files, check that the commits did not break: Cancel, delete/bulk delete of tasks and logs, the cloud archive button (☁, outputs swap), Retry/regenerate, Clear all / Reset Everything (pre-destructive backups), backups restore, the update banner, sign-out and session expiry (timers, effects still running signed out), the honest save status (failedSyncCount), favorites, settings-aware pricing (draftTask/unitQuote/taskUserSettings), the 5 type tabs, the gallery. Also look for React mistakes in the new code: hooks used before declaration in a way that throws (TDZ in effects or useCallback bodies), missing deps that capture stale state, setState inside a setState updater with side effects that run twice under StrictMode. Run the three test scripts and report any failure.` },
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
  { key: 'guarded', ask: 'Look for anything elsewhere that already prevents this: another guard, caller, trigger, grant, server check, React behavior, or browser behavior. Refute if it is already prevented or out of scope per the context.' },
  { key: 'impact', ask: 'Judge real-world impact for the owner (a single admin user on a PC and a 384px Android phone that freezes the app in the background). Refute if it cannot affect real use; otherwise set adjusted_severity honestly.' },
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