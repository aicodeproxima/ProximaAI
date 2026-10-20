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
export function planOrphans(orphans, items, owned, now) {
  // created_at carries nanoseconds ("2025-05-19T06:09:15.948268264Z"); trimmed to ms so every engine parses it.
  const pool = items
    .map(i => ({ i, at: Date.parse(String(i?.created_at || "").replace(/(\.\d{3})\d+/, "$1")) }))
    .filter(x => x.i?.id && !owned.has(x.i.id) && Number.isFinite(x.at))
    .sort((a, b) => a.at - b.at);
  const used = new Set(), adopt = [], fail = [];
  const sameModel = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();
  for (const t of [...orphans].sort((a, b) => a.startTime - b.startTime)) {
    // Oldest orphan takes the oldest fit: right under any uniform clock skew between this device and WaveSpeed (a
    // "prefer created after the start" rule swapped same-model siblings when the device clock ran ahead). Leftovers of
    // deleted or cancelled tasks never get here: they are in `owned` (released ids, cloud ids).
    const hit = pool.find(x => !used.has(x.i.id) && sameModel(x.i.model, t.modelId)
      && x.at >= t.startTime - LOOKUP_SKEW_MS && x.at <= t.startTime + ORPHAN_GRACE_MS);
    if (hit) {
      used.add(hit.i.id);
      adopt.push({ ...t, status: "processing", taskId: hit.i.id, pollUrl: hit.i.urls?.get || pollUrlFor({ taskId: hit.i.id }) });
    } else if (now - t.startTime > ORPHAN_GRACE_MS) fail.push(failTask(t, now, UNSUBMITTED_ERROR));
  }
  return { adopt, fail };
}

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
