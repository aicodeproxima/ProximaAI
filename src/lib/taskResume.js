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

// Splits stored rows into in-flight tasks whose poll can resume and failed copies of those that cannot.
export function planResume(rows, now) {
  const resume = [], expire = [];
  for (const t of rows) {
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

// Adds the IndexedDB snapshot to state without dropping what is already there. On load the resume effect's
// read resolves first (measured on the phone), so replacing state wiped the tasks it had just resumed.
export function mergeLoadedTasks(current, loaded) {
  const have = new Set(current.map(t => t.id));
  return [...current, ...loaded.filter(t => !have.has(t.id))].sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
}
