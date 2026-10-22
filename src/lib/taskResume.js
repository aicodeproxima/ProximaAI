// What happens to tasks a closed / reloaded / OS-killed tab left in flight (pure — tested by
// scripts/test-task-resume.mjs).
//
// IndexedDB holds a "processing" row (with its WaveSpeed poll URL) from submit until the poll saves the
// result. If the tab dies first, the next load resumes the poll while WaveSpeed can still have the result,
// and otherwise fails the row so it loads, persists and syncs like any finished task — instead of staying
// "processing" forever where nothing renders, prunes or syncs it. WaveSpeed purges predictions and then
// answers status "deleted": all 62 tasks stuck on the phone did, the youngest 54 h old (checked 2026-10-20),
// although its docs say outputs expire "within 7 days".

export const RESUME_WINDOW_MS = 48 * 60 * 60 * 1000; // inside the youngest purge measured (54 h)
// A lost submit (no prediction id) is looked up in WaveSpeed's history for a prediction created between LOOKUP_SKEW_MS
// before its start (device vs WaveSpeed clock) and ORPHAN_GRACE_MS after it (a slow submit); it fails only when a
// lookup that answered finds nothing and the grace has passed.
export const LOOKUP_SKEW_MS = 30 * 1000;
export const ORPHAN_GRACE_MS = 2 * 60 * 1000;

export const EXPIRED_ERROR = "Expired: the app closed before this finished, and WaveSpeed no longer keeps the result";
export const GONE_ERROR = "Expired: WaveSpeed deleted the result before the app could fetch it";
export const UNSUBMITTED_ERROR = "Interrupted before WaveSpeed accepted the request";

const IN_FLIGHT = new Set(["pending", "processing"]);
const GONE = new Set(["deleted", "expired"]);
// Terminal failures WaveSpeed reports besides "failed" (its docs list timeout and cancelled); before 2026-10-20 a
// "timeout" answer kept a video polling for the whole 48 h window.
const FAILED_REASON = { failed: "Generation failed", timeout: "WaveSpeed timed out this generation", cancelled: "Cancelled on WaveSpeed", canceled: "Cancelled on WaveSpeed" };

export const failTask = (task, now, error) => ({ ...task, status: "failed", error, endTime: now });

// Failures that older builds recorded for a network drop (the phone leaving the app aborts the poll request) or for an
// image "Timeout" declared before one last poll. WaveSpeed had already accepted these tasks, so while it keeps the
// result they can be fetched; errors WaveSpeed itself returned (flagged content, failed generation) stay final.
const NETWORK_FAILURE = /^(Failed to fetch|Load failed|NetworkError when attempting to fetch resource\.?|Network request failed|Poll error( \(resumed\))?|Timeout( \(resumed\))?)$/;
export const pollUrlFor = (t) => t.pollUrl || (t.taskId ? `/api/v3/predictions/${t.taskId}/result` : null);
export function isRecoverableFailure(t, now) {
  return t?.status === "failed" && !!t.taskId && NETWORK_FAILURE.test(t.error || "") && now - (t.startTime || 0) <= RESUME_WINDOW_MS;
}

// Splits stored rows into in-flight tasks whose poll can resume (plus wrongly failed ones to recover, flagged
// `recovered`), orphans whose submit response was lost (no prediction id: the history lookup decides them), and
// failed copies of in-flight tasks past the window.
export function planResume(rows, now) {
  const resume = [], expire = [], orphans = [];
  for (const t of rows) {
    if (isRecoverableFailure(t, now)) {
      resume.push({ ...t, status: "processing", error: null, endTime: null, pollUrl: pollUrlFor(t), recovered: true });
      continue;
    }
    if (!IN_FLIGHT.has(t.status)) continue;
    const pollUrl = pollUrlFor(t);
    if (now - (t.startTime || 0) > RESUME_WINDOW_MS) expire.push(failTask(t, now, pollUrl ? EXPIRED_ERROR : UNSUBMITTED_ERROR));
    else if (!pollUrl) orphans.push(t);
    else resume.push(t.pollUrl === pollUrl ? t : { ...t, pollUrl });
  }
  return { resume, expire, orphans };
}

// ─── Lost submits ───
// A submit cut off by a refresh or by the phone leaving the app has no prediction id, but WaveSpeed may have accepted
// (and billed) it. WaveSpeed has no idempotency key; its documented recovery is the history endpoint: find a prediction
// for the same model created when the task was submitted and adopt its id. A task whose submit is still in flight in
// this tab (`submitting`) is not an orphan yet.
export function isOrphan(t, submitting, now) {
  return t?.status === "pending" && !t.taskId && !submitting.has(t.id) && now - (t.startTime || 0) <= RESUME_WINDOW_MS;
}

// Prediction ids of tasks that were deleted (here or on another device) or whose submit answered after a cancel. No
// task carries them any more, so without this a lost submit of the same model could adopt one. Kept an hour, far past
// any lookup window, as {predictionId: releasedAt}.
const RELEASED_TTL_MS = 60 * 60 * 1000;
export function rememberReleased(map, ids, now) {
  const out = {};
  for (const [id, at] of Object.entries(map || {})) if (now - at <= RELEASED_TTL_MS) out[id] = at;
  for (const id of ids) if (id) out[id] = now;
  return out;
}
export const liveReleased = (map, now) => new Set(Object.entries(map || {}).filter(([, at]) => now - at <= RELEASED_TTL_MS).map(([id]) => id));

// Whether a failed submit may still have reached WaveSpeed, so the task waits for the history lookup instead of
// failing: anything fetch itself threw (network drop, timeout, a body cut off mid-read) or a 5xx without an id.
// A refusal (4xx: balance, validation, rate limit) or a missing session or key never did.
export function submitMayHaveLanded(e) {
  if (e?.session || e?.noKey) return false;
  if (e instanceof Error || typeof e?.code !== "number") return true;
  return e.code >= 500;
}

// The history ranges to fetch: one per cluster of lost submits (a batch shares one), as {after, before} in ms.
export function orphanWindows(orphans) {
  const spans = orphans.map(t => [t.startTime - LOOKUP_SKEW_MS, t.startTime + ORPHAN_GRACE_MS]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [after, before] of spans) {
    const last = out[out.length - 1];
    if (last && after <= last.before) last.before = Math.max(last.before, before);
    else out.push({ after, before });
  }
  return out;
}

// Matches lost submits to history items: same model, created inside the task's submit window, not owned by another
// task. Oldest task takes the oldest match, so a batch of the same model gets one prediction each. `items` must be
// from a lookup that answered; a task without a match fails once ORPHAN_GRACE_MS has passed.
// `claimants`: tasks cancelled (or cleared) while their submit had no prediction id yet ({id, modelId, startTime}). A
// claimant pairs in time order like an orphan but is never adopted: its prediction is returned in `claimed` (to
// release) and the claimant in `resolved` (to drop). Claimants of a model take part only while that model has at least
// as many predictions in the window as tasks; with fewer, one of them never reached WaveSpeed, and live tasks come
// first rather than lose their own result to a submit that may never have landed.
// `answeredFor(task)`: whether the lookup window holding that task answered (a refused window gives no items though
// nothing answered). Only a claimant whose own window answered is dropped. `answered: false` = no window answered.
export function planOrphans(orphans, items, owned, now, claimants = [], { answered = true, answeredFor } = {}) {
  const didAnswer = answeredFor || (() => answered);
  // created_at carries nanoseconds ("2025-05-19T06:09:15.948268264Z"); trimmed to ms so every engine parses it.
  const pool = items
    .map(i => ({ i, at: Date.parse(String(i?.created_at || "").replace(/(\.\d{3})\d+/, "$1")) }))
    // A prediction deleted on WaveSpeed stays in its history as "deleted" (no outputs): never adopt it.
    .filter(x => x.i?.id && !owned.has(x.i.id) && Number.isFinite(x.at) && x.i.status !== "deleted")
    .sort((a, b) => a.at - b.at);
  const used = new Set(), adopt = [], fail = [], claimed = [], resolved = [], claims = [];
  const model = (m) => String(m || "").toLowerCase();
  const inWindow = (x, t) => x.at >= t.startTime - LOOKUP_SKEW_MS && x.at <= t.startTime + ORPHAN_GRACE_MS;
  const groups = new Map();
  for (const [t, claim] of [...orphans.map(t => [t, false]), ...claimants.map(c => [c, true])]) {
    const k = model(t.modelId);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push({ t, claim });
  }
  const closed = (t) => now - t.startTime > ORPHAN_GRACE_MS;
  for (const [k, parts] of groups) {
    // The count rule applies per cluster of overlapping windows: a claimant from half an hour ago must not decide
    // whether the current batch's claimants take part.
    parts.sort((a, b) => a.t.startTime - b.t.startTime);
    const clusters = [];
    for (const p of parts) {
      const last = clusters[clusters.length - 1];
      if (last && p.t.startTime - LOOKUP_SKEW_MS <= last.until) {
        last.parts.push(p);
        last.until = Math.max(last.until, p.t.startTime + ORPHAN_GRACE_MS);
      } else clusters.push({ parts: [p], until: p.t.startTime + ORPHAN_GRACE_MS });
    }
    for (const c of clusters) {
      const fits = pool.filter(x => model(x.i.model) === k && c.parts.some(p => inWindow(x, p.t)));
      const withClaimants = fits.length >= c.parts.length;
      // Oldest takes the oldest fit: right under any uniform clock skew between this device and WaveSpeed (a "prefer
      // created after the start" rule swapped same-model siblings when the device clock ran ahead). Leftovers of
      // deleted tasks are in `owned`; cancelled ones without an id are claimants.
      // `exact` (review round 2): every member is a deleted claimant, each took one prediction, and the cluster holds no
      // other unowned prediction of the model. Then every prediction here is one of theirs (unambiguousDeletes).
      const ownClaims = [];
      for (const { t, claim } of c.parts) {
        const hit = claim && !withClaimants ? null : fits.find(x => !used.has(x.i.id) && inWindow(x, t));
        if (hit) used.add(hit.i.id);
        if (claim) {
          if (hit) { claimed.push(hit.i.id); resolved.push(t.id); ownClaims.push({ claimantId: t.id, predictionId: hit.i.id, deleted: !!t.deleted }); }
          else if (closed(t) && didAnswer(t)) resolved.push(t.id);   // its window closed and answered with nothing: done
          continue;
        }
        if (hit) adopt.push({ ...t, status: "processing", taskId: hit.i.id, pollUrl: hit.i.urls?.get || pollUrlFor({ taskId: hit.i.id }) });
        else if (closed(t)) fail.push(failTask(t, now, UNSUBMITTED_ERROR));
      }
      const exact = fits.length === c.parts.length && ownClaims.length === c.parts.length && c.parts.every(p => p.claim && p.t.deleted);
      const span = { model: k, lo: c.parts[0].t.startTime - LOOKUP_SKEW_MS, hi: c.until, members: c.parts.map(p => p.t.id) };
      claims.push(...ownClaims.map(x => ({ ...x, exact, ...span })));
    }
  }
  return { adopt, fail, claimed, resolved, claims };
}

// Claimants kept across reloads, as {taskId: {modelId, startTime, at}}; an hour, like released ids. `deleted`: the
// claimant was deleted (bulk delete / Clear Outputs / Reset Everything / another device's delete), not just cancelled:
// its prediction is then deleted on WaveSpeed as well once it turns up, so it is kept RESUME_WINDOW_MS (48 h, inside
// WaveSpeed's purge) in case the app stays closed past the hour (review wf_ec400a67-988 #9).
const claimantTtl = (c) => (c?.deleted ? RESUME_WINDOW_MS : RELEASED_TTL_MS);
export function rememberClaimants(map, tasks, now, { deleted = false } = {}) {
  const out = {};
  for (const [id, c] of Object.entries(map || {})) if (now - c.at <= claimantTtl(c)) out[id] = c;
  for (const t of tasks) if (t?.id) out[t.id] = { modelId: t.modelId, startTime: t.startTime, at: now, deleted: !!deleted };
  return out;
}
export const liveClaimants = (map, now) => Object.entries(map || {}).filter(([, c]) => now - c.at <= claimantTtl(c))
  .map(([id, c]) => ({ id, modelId: c.modelId, startTime: c.startTime, deleted: !!c.deleted }));
export function dropClaimants(map, ids) {
  const out = { ...(map || {}) };
  for (const id of ids) delete out[id];
  return out;
}
// What Cancel, bulk delete, Clear Outputs, Reset Everything and another device's delete record (storage.js
// recordClaimants). A task still waiting for its submit's answer (pending, no prediction id) becomes a claimant. With
// `deleted`, a claimant a Cancel recorded earlier (the task now shows failed, still without an id: its answer was lost
// to a freeze or reload) is flipped to deleted, with a fresh hour, so its prediction is deleted on WaveSpeed once the
// lookup finds it (review #10). A task with an id is never one (its prediction goes by id). A failed task never
// recorded never reached WaveSpeed. Deleted never flips back.
export function noteClaimants(map, tasks, now, { deleted = false } = {}) {
  const live = rememberClaimants(map, [], now);
  const waiting = [];
  for (const t of tasks || []) {
    if (!t?.id || t.taskId) continue;
    if (t.status === "pending") waiting.push(t);
    else if (deleted && live[t.id]) live[t.id] = { ...live[t.id], deleted: true, at: now };
    // A cancel whose claimant expired (the app was closed past the hour): deleting it still deletes its prediction
    // (review wf_ec400a67-988 #9). Only a Cancel: a refused submit never reached WaveSpeed.
    else if (deleted && t.error === "Cancelled") live[t.id] = { modelId: t.modelId, startTime: t.startTime, at: now, deleted: true };
  }
  const out = rememberClaimants(live, waiting, now, { deleted });
  for (const t of waiting) if (live[t.id]?.deleted) out[t.id].deleted = true;
  return out;
}
// The lost-submit lookup runs for orphans and for claimants alone: a cancelled one learns its prediction id (linked to
// its task), a deleted one has it deleted.
export const claimantLookupNeeded = (orphans, claimants) => orphans.length > 0 || claimants.length > 0;
// What the lookup does with its claims. Deleted: the prediction is deleted on WaveSpeed. Cancelled, with its task here
// still without an id: the id is linked to the task, so any later delete (any device) reaches it. Cancelled with the
// task not here: only released, never deleted on a guess.
export function planClaimOutcomes(claims, tasks) {
  const byId = new Map((tasks || []).map(t => [t.id, t]));
  const attach = [], del = [];
  for (const c of claims || []) {
    if (c.deleted) { del.push(c.predictionId); continue; }
    const t = byId.get(c.claimantId);
    if (t && !t.taskId) attach.push({ id: t.id, predictionId: c.predictionId });
  }
  return { attach, del };
}
// Review wf_ec400a67-988 #10 and round 2: a deleted claimant pairs by model and time, so its prediction is deleted only
// when the pairing is unambiguous. Its cluster (planOrphans) must be `exact`: all deleted claimants, as many unowned
// predictions of the model as members (one alone, or a whole batch). And no other cloud row of the model without a
// prediction id (another device's, any status) may have started where its prediction could land in the cluster's span
// [lo, hi]: from ORPHAN_GRACE_MS before it to LOOKUP_SKEW_MS after. A row with an id owns a prediction kept out of the
// pool already. Otherwise it is only released: never delete what may be another device's live generation.
// `cloudRows`: pullTaskStartsInWindow rows covering [lo - ORPHAN_GRACE_MS, hi + LOOKUP_SKEW_MS].
export function unambiguousDeletes(claims, cloudRows) {
  const model = (m) => String(m || "").toLowerCase();
  return (claims || []).filter(c => c.deleted && c.exact && !(cloudRows || []).some(r =>
    !c.members.includes(r.id) && model(r.modelId) === c.model && (!r.taskId || r.taskId === c.predictionId)
    && r.startTime + ORPHAN_GRACE_MS >= c.lo && r.startTime - LOOKUP_SKEW_MS <= c.hi)).map(c => c.predictionId);
}
// A submit that started while the lookup awaited may own a prediction the listing showed while its task has no id
// yet: such a pass decides nothing.
export const lookupStale = (seqAtStart, seqNow, submitting) => seqNow !== seqAtStart || submitting > 0;

// "completed" | "failed" | "gone" (purged, never coming back) | "running" (poll again).
export function pollOutcome(data) {
  const status = data?.status;
  if (status === "completed" && data.outputs?.length > 0) return "completed";
  if (status in FAILED_REASON) return "failed";
  if (GONE.has(status)) return "gone";
  return "running";
}

// Applies one poll answer to a task: the updated task, or null while it is still running. Shared by every
// poll loop (new, regenerated, resumed), so a purged prediction can never keep a live loop polling forever.
export function applyPoll(task, data, now) {
  switch (pollOutcome(data)) {
    case "completed": {
      const wallClock = now - task.startTime;
      return { ...task, status: "completed", outputs: data.outputs, endTime: now, wallClockMs: wallClock,
        inferenceMs: data?.timings?.inference || wallClock, nsfw: data?.has_nsfw_contents };
    }
    case "failed": return { ...task, status: "failed", error: data.error || FAILED_REASON[data.status] || "Generation failed", endTime: now };
    case "gone": return failTask(task, now, GONE_ERROR);
    default: return null;
  }
}

// A Retry is a new generation. It must not inherit the original's WaveSpeed ids or backup files: a failed retry
// would otherwise be "recovered" with the original's result, and deleting the retry would delete the original's
// backed-up files.
const PER_RUN_FIELDS = ["taskId", "pollUrl", "isArchived", "archivedOutputs", "archivedPaths", "nsfw", "recovered", "submitUnknown"];
export function retryTask(original, { id, now, seed }) {
  const t = { ...original, id, status: "pending", startTime: now, endTime: null, wallClockMs: 0, inferenceMs: 0,
    outputs: [], error: null, seed };
  for (const k of PER_RUN_FIELDS) delete t[k];
  return t;
}

// Applies a poll loop's update only while the task is still in flight. A request already on the wire when the
// user cancels (or another path finishes the task) must not overwrite that outcome when it resolves.
export function settlePoll(task, fn) {
  return IN_FLIGHT.has(task?.status) ? fn(task) : task;
}
export const isInFlight = (task) => IN_FLIGHT.has(task?.status);

// What a failed poll means: "stop" (signed out, no key saved, or WaveSpeed rejected the key: the resume effect restarts
// it once that is fixed), "retry" (rate limit, request timeout, network drop, proxy/WaveSpeed 5xx), or "fail"
// (WaveSpeed refused the poll itself). A phone that loses signal mid-poll used to fail the task on the first fetch
// error, and a rejected key failed every running task as "Unauthorized", which no recovery picks up again.
const isHttp = (e) => !(e instanceof Error) && typeof e?.code === "number";
export function pollErrorAction(e) {
  if (e?.session || e?.noKey) return "stop";
  // HTTP refusals from api.js are plain objects {code: status}. Anything fetch itself throws is transient: a TypeError
  // on a network drop, or a DOMException TimeoutError/AbortError, whose legacy numeric .code is not an HTTP status.
  if (!isHttp(e)) return "retry";
  if (e.code === 401 || e.code === 403) return "stop";
  if (e.code === 408 || e.code === 429 || e.code >= 500) return "retry";
  return "fail";
}
// The key status a failed WaveSpeed call implies: "missing" (none saved), "invalid" (WaveSpeed rejected it), or null.
export function keyStatusAfter(e) {
  if (e?.noKey) return "missing";
  if (e?.session || !isHttp(e)) return null;
  return e.code === 401 || e.code === 403 ? "invalid" : null;
}

// How often to poll. There is no client-side give-up: a task with a prediction id ends only on WaveSpeed's answer or
// the 48 h resume window. (A 5-minute image deadline used to fail images whose phone had simply been away.) Images poll
// fast for 5 minutes, then every 30 s; 3D every 10 s; video every 15 s.
export function pollTiming(genType) {
  if (genType === "image" || genType === "i2i") return { interval: 3000, slowAfterMs: 300000, slowInterval: 30000 };
  const interval = genType === "i23d" ? 10000 : 15000;
  return { interval, slowAfterMs: Infinity, slowInterval: interval };
}
export function nextPollDelay(genType, elapsedMs) {
  const t = pollTiming(genType);
  return elapsedMs > t.slowAfterMs ? t.slowInterval : t.interval;
}

// Which running tasks to re-poll right away when the app comes back (visible again, restored from the back/forward
// cache, back online). A phone that left the app froze its timers and cut the poll in flight, so the next check would
// otherwise wait out a full interval or retry backoff. Focus, visibility and online often fire together: one re-poll
// per REPOLL_THROTTLE_MS. Rows without a prediction id are still mid-submit and have nothing to poll.
export const REPOLL_THROTTLE_MS = 5000;
export function planRepoll(tasks, now, lastAt) {
  if (now - lastAt < REPOLL_THROTTLE_MS) return { kick: [], at: lastAt };
  const kick = [];
  for (const t of tasks) {
    const pollUrl = IN_FLIGHT.has(t.status) && now - (t.startTime || 0) <= RESUME_WINDOW_MS ? pollUrlFor(t) : null;
    if (pollUrl) kick.push(t.pollUrl === pollUrl ? t : { ...t, pollUrl });
  }
  return { kick, at: kick.length ? now : lastAt };
}

// Adds the IndexedDB snapshot to state without dropping what is already there. On load the resume effect's
// read resolves first (measured on the phone), so replacing state wiped the tasks it had just resumed.
export function mergeLoadedTasks(current, loaded) {
  const have = new Set(current.map(t => t.id));
  return [...current, ...loaded.filter(t => !have.has(t.id))].sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
}
