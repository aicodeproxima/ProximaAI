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
export const SUBMIT_GRACE_MS = 10 * 60 * 1000;       // a row without a poll URL may still be mid-submit in another tab

export const EXPIRED_ERROR = "Expired: the app closed before this finished, and WaveSpeed no longer keeps the result";
export const GONE_ERROR = "Expired: WaveSpeed deleted the result before the app could fetch it";
export const UNSUBMITTED_ERROR = "Interrupted before WaveSpeed accepted the request";

const IN_FLIGHT = new Set(["pending", "processing"]);
const GONE = new Set(["deleted", "expired", "canceled", "cancelled"]);

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
// `recovered`) and failed copies of in-flight tasks that cannot resume.
export function planResume(rows, now) {
  const resume = [], expire = [];
  for (const t of rows) {
    if (isRecoverableFailure(t, now)) {
      resume.push({ ...t, status: "processing", error: null, endTime: null, pollUrl: pollUrlFor(t), recovered: true });
      continue;
    }
    if (!IN_FLIGHT.has(t.status)) continue;
    const age = now - (t.startTime || 0);
    if (!t.pollUrl) { if (age > SUBMIT_GRACE_MS) expire.push(failTask(t, now, UNSUBMITTED_ERROR)); }
    else if (age > RESUME_WINDOW_MS) expire.push(failTask(t, now, EXPIRED_ERROR));
    else resume.push(t);
  }
  return { resume, expire };
}

// "completed" | "failed" | "gone" (purged, never coming back) | "running" (poll again).
export function pollOutcome(data) {
  const status = data?.status;
  if (status === "completed" && data.outputs?.length > 0) return "completed";
  if (status === "failed") return "failed";
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
    case "failed": return { ...task, status: "failed", error: data.error || "Generation failed", endTime: now };
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

// What a failed poll means: "stop" (signed out / no key saved: the resume effect restarts it later),
// "retry" (rate limit, network drop, proxy/WaveSpeed 5xx), or "fail" (WaveSpeed refused the poll).
// A phone that loses signal mid-poll used to fail the task on the first fetch error.
export function pollErrorAction(e) {
  if (e?.session || e?.noKey) return "stop";
  const code = e?.code;
  if (typeof code !== "number" || code === 429 || code >= 500) return "retry";
  return "fail";
}

// Images poll fast and give up after 5 minutes of polling; 3D and video poll slower until WaveSpeed answers.
export function pollTiming(genType) {
  if (genType === "image" || genType === "i2i") return { interval: 3000, maxPollMs: 300000 };
  return { interval: genType === "i23d" ? 10000 : 15000, maxPollMs: Infinity };
}

// Adds the IndexedDB snapshot to state without dropping what is already there. On load the resume effect's
// read resolves first (measured on the phone), so replacing state wiped the tasks it had just resumed.
export function mergeLoadedTasks(current, loaded) {
  const have = new Set(current.map(t => t.id));
  return [...current, ...loaded.filter(t => !have.has(t.id))].sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
}
