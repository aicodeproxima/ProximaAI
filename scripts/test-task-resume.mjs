// Tests for src/lib/taskResume.js — what happens to in-flight tasks on load. Run: node scripts/test-task-resume.mjs
import assert from "node:assert/strict";
import { noteClaimants, claimantLookupNeeded, planClaimOutcomes, lookupStale, planResume, pollOutcome, mergeLoadedTasks, applyPoll, settlePoll, retryTask, pollTiming, nextPollDelay, pollErrorAction, planRepoll, REPOLL_THROTTLE_MS, isOrphan, orphanWindows, planOrphans, submitMayHaveLanded, isInFlight, keyStatusAfter, rememberReleased, liveReleased, rememberClaimants, liveClaimants, dropClaimants, LOOKUP_SKEW_MS, ORPHAN_GRACE_MS, RESUME_WINDOW_MS, GONE_ERROR } from "../src/lib/taskResume.js";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const POLL = "https://api.wavespeed.ai/api/v3/predictions/p1/result";
const task = (id, extra = {}) => ({ id, status: "processing", startTime: NOW - 5 * 60_000, endTime: null, pollUrl: POLL, taskId: "p1", outputs: [], error: null, ...extra });
let n = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", e.message.split("\n").filter(Boolean).slice(0, 4).join(" | ")); }
};

test("resumes a recent in-flight task that has a poll URL", () => {
  const p = planResume([task("a")], NOW);
  assert.deepEqual(p.resume.map(t => t.id), ["a"]);
  assert.deepEqual(p.expire, []);
});

test("still resumes a task interrupted hours ago (its result may still be on WaveSpeed)", () => {
  const p = planResume([task("a", { startTime: NOW - 3 * HOUR })], NOW);
  assert.deepEqual(p.resume.map(t => t.id), ["a"]);
});

test("expires a task past the resume window as failed, without polling it", () => {
  const p = planResume([task("old", { startTime: NOW - RESUME_WINDOW_MS - 1 })], NOW);
  assert.deepEqual(p.resume, []);
  assert.equal(p.expire.length, 1);
  const [t] = p.expire;
  assert.equal(t.id, "old");
  assert.equal(t.status, "failed");
  assert.equal(t.endTime, NOW);
  assert.match(t.error, /expired/i);
  assert.equal(t.pollUrl, POLL, "keeps its provider ids for debugging");
});

test("expires the phone's six-month-old zombies (pending or processing)", () => {
  const rows = [task("z1", { startTime: NOW - 180 * 24 * HOUR }), task("z2", { status: "pending", startTime: NOW - 30 * 24 * HOUR })];
  const p = planResume(rows, NOW);
  assert.deepEqual(p.expire.map(t => [t.id, t.status]), [["z1", "failed"], ["z2", "failed"]]);
});

test("expires an in-flight task with no start time (age unknown)", () => {
  const p = planResume([task("x", { startTime: undefined })], NOW);
  assert.deepEqual(p.expire.map(t => t.id), ["x"]);
});

// A row still "pending" without a prediction id lost its submit response (refresh or app left mid-submit). WaveSpeed
// may have accepted it anyway, so it loads as an orphan for the history lookup, which adopts the id or fails it.
test("loads a task whose submit response was lost as an orphan to look up, at any age inside the window", () => {
  const rows = [task("fresh", { status: "pending", pollUrl: undefined, taskId: undefined, startTime: NOW - 1000 }),
    task("hour", { status: "pending", pollUrl: undefined, taskId: undefined, startTime: NOW - HOUR })];
  const p = planResume(rows, NOW);
  assert.deepEqual(p.orphans.map(t => t.id), ["fresh", "hour"]);
  assert.deepEqual([p.resume, p.expire], [[], []]);
  assert.equal(p.orphans[1].status, "pending");
});

test("fails a lost submit past the 48 h window without looking it up", () => {
  const p = planResume([task("ns", { status: "pending", pollUrl: undefined, taskId: undefined, startTime: NOW - RESUME_WINDOW_MS - 1 })], NOW);
  assert.deepEqual([p.resume, p.orphans], [[], []]);
  assert.equal(p.expire[0].status, "failed");
  assert.match(p.expire[0].error, /before WaveSpeed/i);
});

test("resumes an in-flight row that kept its prediction id but not its poll URL", () => {
  const p = planResume([task("cloud", { pollUrl: undefined, taskId: "pred-7" })], NOW);
  assert.deepEqual(p.resume.map(t => t.pollUrl), ["/api/v3/predictions/pred-7/result"]);
});

test("ignores finished tasks", () => {
  const p = planResume([task("c", { status: "completed", startTime: NOW - 400 * HOUR }), task("f", { status: "failed" })], NOW);
  assert.deepEqual([p.resume, p.expire], [[], []]);
});

test("does not mutate the stored rows", () => {
  const row = task("old", { startTime: NOW - RESUME_WINDOW_MS - 1 });
  planResume([row], NOW);
  assert.equal(row.status, "processing");
});

test("poll outcome: completed with outputs", () => {
  assert.equal(pollOutcome({ status: "completed", outputs: ["https://cdn/x.png"] }), "completed");
});

test("poll outcome: failed", () => {
  assert.equal(pollOutcome({ status: "failed", error: "nsfw" }), "failed");
});

test("poll outcome: a purged prediction (WaveSpeed answers status 'deleted') is gone, not running", () => {
  assert.equal(pollOutcome({ status: "deleted", outputs: [] }), "gone");
  assert.equal(pollOutcome({ status: "expired" }), "gone");
});

test("poll outcome: WaveSpeed's own timeout and cancel end the task as failed, with a clear reason", () => {
  assert.equal(pollOutcome({ status: "timeout" }), "failed");
  assert.equal(pollOutcome({ status: "cancelled" }), "failed");
  assert.equal(applyPoll(task("a"), { status: "timeout" }, NOW).error, "WaveSpeed timed out this generation");
  assert.equal(applyPoll(task("a"), { status: "cancelled" }, NOW).error, "Cancelled on WaveSpeed");
  assert.equal(applyPoll(task("a"), { status: "timeout", error: "queue timeout" }, NOW).error, "queue timeout");
});

test("poll outcome: still running", () => {
  for (const status of ["created", "processing", "pending", "queued"]) assert.equal(pollOutcome({ status }), "running");
  assert.equal(pollOutcome({ status: "completed", outputs: [] }), "running", "outputs not attached yet");
  assert.equal(pollOutcome(null), "running");
});

test("load merge keeps a resumed task the resume effect already put in state", () => {
  // Measured on the phone (2026-10-20): getPendingTasks resolves before getCompletedTasks, so the
  // resumed task is in state first. Replacing state with the saved list dropped it; its poll result was
  // then applied to nothing and the row stayed "processing" forever.
  const resumed = task("r");
  const saved = [task("done", { status: "completed", startTime: NOW - HOUR })];
  const merged = mergeLoadedTasks([resumed], saved);
  assert.deepEqual(merged.map(t => t.id), ["r", "done"]);
});

test("load merge prefers the in-state copy of a task (it is newer than IndexedDB)", () => {
  const live = task("a", { status: "completed", outputs: ["https://cdn/a.png"] });
  const merged = mergeLoadedTasks([live], [task("a", { status: "failed" })]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].status, "completed");
});

test("load merge sorts newest first", () => {
  const merged = mergeLoadedTasks([task("mid", { startTime: 2 })], [task("new", { startTime: 3 }), task("old", { startTime: 1 })]);
  assert.deepEqual(merged.map(t => t.id), ["new", "mid", "old"]);
});

// Every poll loop (new, regenerated, resumed) applies a poll answer the same way.
test("poll answer: a purged prediction fails the task as expired instead of polling forever", () => {
  const t = applyPoll(task("a"), { status: "deleted", outputs: [] }, NOW);
  assert.equal(t.status, "failed");
  assert.equal(t.error, GONE_ERROR);
  assert.equal(t.endTime, NOW);
});

test("poll answer: completed copies outputs, timings and the nsfw flag", () => {
  const t = applyPoll(task("a"), { status: "completed", outputs: ["https://cdn/a.png"], timings: { inference: 1234 }, has_nsfw_contents: [false] }, NOW);
  assert.equal(t.status, "completed");
  assert.deepEqual(t.outputs, ["https://cdn/a.png"]);
  assert.equal(t.wallClockMs, 5 * 60_000);
  assert.equal(t.inferenceMs, 1234);
  assert.deepEqual(t.nsfw, [false]);
});

test("poll answer: failed keeps WaveSpeed's error", () => {
  const t = applyPoll(task("a"), { status: "failed", error: "nsfw detected" }, NOW);
  assert.equal(t.status, "failed");
  assert.equal(t.error, "nsfw detected");
});

test("poll answer: still running returns null (poll again)", () => {
  assert.equal(applyPoll(task("a"), { status: "processing" }, NOW), null);
});

// Older builds failed a task on the first network drop ("Failed to fetch" when the phone left the app) or declared an
// image "Timeout" before polling once more. WaveSpeed had accepted it (prediction id saved), so the result can still
// be fetched while WaveSpeed keeps it.
const dropped = (id, extra = {}) => task(id, { status: "failed", error: "Failed to fetch", endTime: NOW - 60_000, ...extra });

test("recovers a task an older build failed on a network drop: it polls again as processing", () => {
  const p = planResume([dropped("r1")], NOW);
  assert.deepEqual(p.resume.map(t => t.id), ["r1"]);
  const [t] = p.resume;
  assert.equal(t.status, "processing");
  assert.equal(t.error, null);
  assert.equal(t.endTime, null);
  assert.equal(t.pollUrl, POLL);
  assert.equal(t.recovered, true);
  assert.deepEqual(p.expire, []);
});

test("recovers the other network-drop and early-timeout messages", () => {
  const errors = ["Load failed", "NetworkError when attempting to fetch resource.", "Poll error", "Poll error (resumed)", "Timeout", "Timeout (resumed)"];
  const p = planResume(errors.map((error, i) => dropped(`e${i}`, { error })), NOW);
  assert.equal(p.resume.length, errors.length);
});

test("rebuilds the poll URL from the prediction id when only the cloud copy exists (no pollUrl)", () => {
  const [t] = planResume([dropped("r2", { pollUrl: undefined, taskId: "pred-9" })], NOW).resume;
  assert.equal(t.pollUrl, "/api/v3/predictions/pred-9/result");
});

test("never recovers answers WaveSpeed gave, a cancel, a task without a prediction id, or one past the window", () => {
  const rows = [
    dropped("flagged", { error: "Content flagged as potentially sensitive. Please try different prompts" }),
    dropped("cancel", { error: "Cancelled" }),
    dropped("noid", { taskId: null, pollUrl: undefined }),
    dropped("old", { startTime: NOW - RESUME_WINDOW_MS - 1 }),
    task("done", { status: "completed", outputs: ["https://cdn/x.png"] }),
  ];
  assert.deepEqual(planResume(rows, NOW).resume, []);
});

test("a Retry starts clean: no WaveSpeed ids, backup files or flags from the original", () => {
  const original = task("orig", { status: "completed", outputs: ["https://cdn/a.png"], endTime: NOW - 1000, wallClockMs: 9000,
    isArchived: true, archivedOutputs: ["https://x/a.png"], archivedPaths: ["user/orig-0.png"], nsfw: [false], recovered: true });
  const r = retryTask(original, { id: "retry1", now: NOW, seed: "42" });
  for (const k of ["taskId", "pollUrl", "isArchived", "archivedOutputs", "archivedPaths", "nsfw", "recovered"]) assert.equal(r[k], undefined, k);
  assert.deepEqual({ id: r.id, status: r.status, startTime: r.startTime, endTime: r.endTime, outputs: r.outputs, error: r.error, seed: r.seed },
    { id: "retry1", status: "pending", startTime: NOW, endTime: null, outputs: [], error: null, seed: "42" });
  assert.equal(r.modelId, original.modelId, "keeps what defines the generation");
  assert.equal(original.taskId, "p1", "does not mutate the original");
});

test("a Retry whose submit failed is never 'recovered' with the original's result", () => {
  const r = retryTask(task("orig"), { id: "retry2", now: NOW, seed: "1" });
  const failed = { ...r, status: "failed", error: "Failed to fetch", endTime: NOW + 1000 };
  assert.deepEqual(planResume([failed], NOW + 2000).resume, []);
});

test("a late poll answer never overwrites a task that is no longer in flight (cancelled while the request ran)", () => {
  const cancelled = task("a", { status: "failed", error: "Cancelled", endTime: NOW - 1000 });
  const after = settlePoll(cancelled, t => applyPoll(t, { status: "completed", outputs: ["https://cdn/a.png"] }, NOW));
  assert.equal(after, cancelled);
});

test("a poll answer still applies to an in-flight task", () => {
  const after = settlePoll(task("a"), t => applyPoll(t, { status: "completed", outputs: ["https://cdn/a.png"] }, NOW));
  assert.equal(after.status, "completed");
});

test("poll error: signed out or no key stops the loop without failing the task", () => {
  assert.equal(pollErrorAction({ code: 401, session: true }), "stop");
  assert.equal(pollErrorAction({ code: 400, noKey: true }), "stop");
});

test("poll error: rate limits, network drops and server errors retry instead of failing the task", () => {
  assert.equal(pollErrorAction({ code: 429 }), "retry");
  assert.equal(pollErrorAction(new TypeError("Failed to fetch")), "retry");
  assert.equal(pollErrorAction({ code: 502 }), "retry");
});

test("poll error: a request timeout or abort (DOMException, which carries a numeric legacy code) retries", () => {
  assert.equal(pollErrorAction(new DOMException("signal timed out", "TimeoutError")), "retry");
  assert.equal(pollErrorAction(new DOMException("The operation was aborted.", "AbortError")), "retry");
});

// WaveSpeed rejecting the key (401/403 — e.g. the server still holds a revoked key) says nothing about the task. Failing
// it would lose it for good: "Unauthorized" is not a recoverable error. The loop stops, the key shows as rejected, and
// saving a working key restarts every stopped poll (the resume effect re-runs when keyBlocked clears).
test("poll error: a rejected key stops the poll without failing the task", () => {
  assert.equal(pollErrorAction({ code: 401, message: "Unauthorized" }), "stop");
  assert.equal(pollErrorAction({ code: 403, message: "Forbidden" }), "stop");
  assert.equal(keyStatusAfter({ code: 401 }), "invalid");
  assert.equal(keyStatusAfter({ code: 403 }), "invalid");
  assert.equal(keyStatusAfter({ code: 400, noKey: true }), "missing");
  assert.equal(keyStatusAfter({ code: 401, session: true }), null, "a dead session is not the key's fault");
  assert.equal(keyStatusAfter(new TypeError("Failed to fetch")), null);
});

test("poll error: a 408 request timeout retries", () => {
  assert.equal(pollErrorAction({ code: 408 }), "retry");
});

test("poll error: WaveSpeed refusing the poll (4xx) fails the task", () => {
  assert.equal(pollErrorAction({ code: 404 }), "fail");
  assert.equal(pollErrorAction({ code: 0, message: "Refusing to poll a non-WaveSpeed URL" }), "fail");
});

// No client-side give-up: a task with a prediction id ends only on WaveSpeed's answer or the 48 h window. Images
// that are still running after 5 minutes (or come back from a phone that was away) just poll less often.
test("poll delay: images every 3 s for 5 min, then every 30 s; 3D every 10 s; video every 15 s", () => {
  assert.equal(nextPollDelay("image", 60_000), 3000);
  assert.equal(nextPollDelay("i2i", 299_000), 3000);
  assert.equal(nextPollDelay("image", 301_000), 30000);
  assert.equal(nextPollDelay("i2i", 3 * HOUR), 30000);
  assert.equal(nextPollDelay("i23d", 10 * HOUR), 10000);
  assert.equal(nextPollDelay("t2v", 10 * HOUR), 15000);
});

test("an image still running after 5 minutes is never failed by the app's clock", () => {
  assert.equal(pollTiming("image").maxPollMs, undefined, "no client deadline");
  assert.equal(applyPoll(task("a", { startTime: NOW - 20 * 60_000 }), { status: "processing" }, NOW), null, "still running = poll again");
});

// Coming back to the app (visible again, restored from the back/forward cache, or back online) re-polls every running
// task at once. While the phone was away its timers were frozen and the poll in flight was cut, so the next check
// would otherwise wait out a full interval or retry backoff (up to a minute for a slow image).
test("re-poll on return: every running task with a prediction id, nothing else", () => {
  const rows = [task("run"), task("pend", { status: "pending", pollUrl: undefined, taskId: undefined }), task("done", { status: "completed" }),
    task("bad", { status: "failed" }), task("rec", { recovered: true }), task("noUrl", { pollUrl: undefined })];
  const p = planRepoll(rows, NOW, 0);
  assert.deepEqual(p.kick.map(t => t.id), ["run", "rec", "noUrl"]);
  assert.equal(p.kick.find(t => t.id === "noUrl").pollUrl, "/api/v3/predictions/p1/result", "poll URL rebuilt from the prediction id");
  assert.equal(p.at, NOW);
});
test("re-poll on return: a task past the 48 h window is left to its loop to expire", () => {
  assert.deepEqual(planRepoll([task("old", { startTime: NOW - RESUME_WINDOW_MS - 1 })], NOW, 0).kick, []);
});
test("re-poll on return: focus + visibility + online firing together re-poll once", () => {
  const first = planRepoll([task("a")], NOW, 0);
  assert.equal(first.kick.length, 1);
  const burst = planRepoll([task("a")], NOW + REPOLL_THROTTLE_MS - 1, first.at);
  assert.deepEqual(burst.kick, [], "inside the throttle");
  assert.equal(burst.at, first.at, "a skipped burst does not extend the throttle");
  assert.equal(planRepoll([task("a")], NOW + REPOLL_THROTTLE_MS, first.at).kick.length, 1);
});
test("re-poll on return: nothing running leaves the throttle untouched", () => {
  assert.deepEqual(planRepoll([task("d", { status: "completed" })], NOW, 0), { kick: [], at: 0 });
});

// ─── Lost submits: WaveSpeed's history lookup (POST /api/v3/predictions) ───
// No idempotency key exists, so the documented recovery is: find a prediction for the same model created when the
// task was submitted, adopt its id, and fail the task only once a lookup that answered shows nothing.
const orphan = (id, extra = {}) => task(id, { status: "pending", pollUrl: undefined, taskId: undefined, modelId: "bytedance/seedream-v4", startTime: NOW - 60_000, ...extra });
const item = (id, extra = {}) => ({ id, model: "bytedance/seedream-v4", status: "processing", created_at: new Date(NOW - 58_000).toISOString(),
  urls: { get: `https://api.wavespeed.ai/api/v3/predictions/${id}/result` }, ...extra });

test("orphan: a pending task without an id, not being submitted right now", () => {
  const busy = new Set(["sub"]);
  assert.equal(isOrphan(orphan("o"), busy, NOW), true);
  assert.equal(isOrphan(orphan("sub"), busy, NOW), false, "its submit is still in flight in this tab");
  assert.equal(isOrphan(orphan("p", { taskId: "x" }), busy, NOW), false, "has an id: the poll loop owns it");
  assert.equal(isOrphan(orphan("c", { status: "failed" }), busy, NOW), false);
  assert.equal(isOrphan(orphan("old", { startTime: NOW - RESUME_WINDOW_MS - 1 }), busy, NOW), false);
});

test("lookup windows: one per cluster of submits, padded for clock skew and a slow submit", () => {
  const w = orphanWindows([orphan("a"), orphan("b", { startTime: NOW - 59_000 }), orphan("c", { startTime: NOW - 3 * HOUR })]);
  assert.equal(w.length, 2, "a and b share a window");
  assert.deepEqual(w[0], { after: NOW - 3 * HOUR - LOOKUP_SKEW_MS, before: NOW - 3 * HOUR + ORPHAN_GRACE_MS });
  assert.deepEqual(w[1], { after: NOW - 60_000 - LOOKUP_SKEW_MS, before: NOW - 59_000 + ORPHAN_GRACE_MS });
});

test("adopts the matching prediction and polls its result URL", () => {
  const { adopt, fail } = planOrphans([orphan("o")], [item("pred-1")], new Set(), NOW);
  assert.deepEqual(fail, []);
  assert.equal(adopt.length, 1);
  const t = adopt[0];
  assert.deepEqual([t.id, t.status, t.taskId, t.pollUrl], ["o", "processing", "pred-1", "https://api.wavespeed.ai/api/v3/predictions/pred-1/result"]);
});

test("never adopts a prediction another task owns, another model's, or one from outside the submit window", () => {
  const items = [item("owned"), item("other-model", { model: "kwaivgi/kling-v2" }), item("too-early", { created_at: new Date(NOW - 60_000 - LOOKUP_SKEW_MS - 1).toISOString() }),
    item("too-late", { created_at: new Date(NOW - 60_000 + ORPHAN_GRACE_MS + 1).toISOString() }), item("bad-date", { created_at: "soon" }), { model: "bytedance/seedream-v4" }];
  const { adopt } = planOrphans([orphan("o")], items, new Set(["owned"]), NOW);
  assert.deepEqual(adopt, []);
});

test("two lost submits of the same model get one prediction each, oldest first", () => {
  const { adopt } = planOrphans([orphan("second", { startTime: NOW - 59_000 }), orphan("first")],
    [item("p-late", { created_at: new Date(NOW - 57_000).toISOString() }), item("p-early")], new Set(), NOW);
  assert.deepEqual(adopt.map(t => [t.id, t.taskId]), [["first", "p-early"], ["second", "p-late"]]);
});

test("no match: fails the task once the grace has passed, keeps waiting before", () => {
  const late = planOrphans([orphan("o", { startTime: NOW - ORPHAN_GRACE_MS - 1 })], [], new Set(), NOW);
  assert.equal(late.fail.length, 1);
  assert.equal(late.fail[0].status, "failed");
  assert.match(late.fail[0].error, /before WaveSpeed/i);
  const early = planOrphans([orphan("o", { startTime: NOW - 10_000 })], [], new Set(), NOW);
  assert.deepEqual([early.adopt, early.fail], [[], []]);
});

// Cancel while the submit is on the wire: its response must not turn the cancelled task back into a running one.
test("a submit response for a task cancelled meanwhile changes nothing", () => {
  const cancelled = orphan("c", { status: "failed", error: "Cancelled" });
  assert.equal(isInFlight(cancelled), false);
  assert.equal(isInFlight(undefined), false, "deleted meanwhile");
  assert.equal(isInFlight(orphan("p")), true);
  assert.equal(settlePoll(cancelled, t => ({ ...t, status: "processing", taskId: "pred-1" })), cancelled);
});

test("matches the history item shape WaveSpeed documents (slug model, nanosecond created_at)", () => {
  // Verbatim item from wavespeed.ai/docs/predictions-api (checked 2026-10-20), moved to this task's submit time.
  const doc = { id: "e6832d4abffb4d79bfbca19783fca133", model: "wavespeed-ai/z-image/turbo", outputs: ["https://example.com/output/example.jpeg"],
    urls: { get: "https://api.wavespeed.ai/api/v3/predictions/e6832d4abffb4d79bfbca19783fca133/result" }, status: "completed",
    created_at: "2025-05-19T06:09:15.948268264Z", error: "", timings: { inference: 25729 } };
  const start = Date.parse("2025-05-19T06:09:14.000Z");
  const { adopt } = planOrphans([orphan("o", { modelId: "wavespeed-ai/z-image/turbo", startTime: start })], [doc], new Set(), start + 5000);
  assert.equal(adopt[0]?.taskId, "e6832d4abffb4d79bfbca19783fca133");
});

// Regression review wf_9ad3cd3b-5c8 #1: a "prefer created after the start" tie-break (cbbb695) swapped two same-model
// lost submits whenever the device clock ran slightly ahead of WaveSpeed. Leftovers of deleted or cancelled tasks are
// excluded by ownership (released ids, cloud ids), so oldest-to-oldest pairing is right under any uniform skew.
test("two same-model orphans keep their own predictions when the device clock runs ahead", () => {
  const a = orphan("A", { startTime: NOW - 60_000 }), b = orphan("B", { startTime: NOW - 59_000 });
  for (const skew of [200, 700, 3000, 20_000]) {
    const items = [item("PB", { created_at: new Date(NOW - 59_000 + 300 - skew).toISOString() }),
      item("PA", { created_at: new Date(NOW - 60_000 + 300 - skew).toISOString() })];
    const { adopt } = planOrphans([b, a], items, new Set(), NOW);
    assert.deepEqual(adopt.map(t => [t.id, t.taskId]), [["A", "PA"], ["B", "PB"]], `clock ${skew} ms ahead`);
  }
});

// Round-3 review wf_393b4699-2d7 #1: a task cancelled while its submit was on the wire, whose response never came, has no
// prediction id to release. It stays a claimant: paired in time order like an orphan, never adopted. Only while there are
// at least as many predictions as tasks (otherwise one of them never reached WaveSpeed, and live tasks come first).
const claimant = (id, startTime, extra = {}) => ({ id, modelId: "bytedance/seedream-v4", startTime, ...extra });
test("a cancelled submit's prediction goes to its claimant, not to the next same-model lost submit", () => {
  const a = claimant("A", NOW - 68_000), b = orphan("B", { startTime: NOW - 60_000 });
  const items = [item("PA", { created_at: new Date(NOW - 67_800).toISOString() }), item("PB", { created_at: new Date(NOW - 59_700).toISOString() })];
  const r = planOrphans([b], items, new Set(), NOW, [a]);
  assert.deepEqual(r.adopt.map(t => [t.id, t.taskId]), [["B", "PB"]]);
  assert.deepEqual(r.claimed, ["PA"]);
  assert.deepEqual(r.resolved, ["A"]);
});
test("when the cancelled submit never reached WaveSpeed, the live task still gets its own prediction", () => {
  const r = planOrphans([orphan("B", { startTime: NOW - 60_000 })], [item("PB", { created_at: new Date(NOW - 59_700).toISOString() })],
    new Set(), NOW, [claimant("A", NOW - 68_000)]);
  assert.deepEqual(r.adopt.map(t => t.taskId), ["PB"]);
  assert.deepEqual(r.claimed, []);
});
// Round-4 review wf_f0f800c6-0ab #1: the "enough predictions" count was per model across every window, so a dead
// claimant from half an hour ago switched claimant protection off for the current batch. It is per cluster of
// overlapping windows now, and a claimant whose window has closed is dropped.
test("an old dead claimant does not switch off protection for the current batch, and is dropped", () => {
  const dead = claimant("D", NOW - 30 * 60_000), c = claimant("C", NOW - 70_000), o = orphan("O", { startTime: NOW - 60_000 });
  const items = [item("Pc", { created_at: new Date(NOW - 69_000).toISOString() }), item("Po", { created_at: new Date(NOW - 59_000).toISOString() })];
  const r = planOrphans([o], items, new Set(), NOW, [dead, c]);
  assert.deepEqual(r.adopt.map(t => t.taskId), ["Po"]);
  assert.deepEqual(r.claimed, ["Pc"]);
  assert.deepEqual(r.resolved.sort(), ["C", "D"], "C matched; D's window closed with nothing to claim");
});
// Round-5 review wf_5d9498dc-619: a refused or malformed history lookup (items = [] though nothing answered) dropped a
// closed-window claimant, and the next answered pass gave its prediction to a sibling. Only a lookup that answered
// may drop one.
test("a refused lookup never drops a claimant; the answered pass after it still pairs correctly", () => {
  const a = claimant("A", NOW - 125_000), b = orphan("B", { startTime: NOW - 110_000 });
  const refused = planOrphans([b], [], new Set(), NOW, [a], { answered: false });
  assert.deepEqual(refused.resolved, []);
  const items = [item("pA", { created_at: new Date(NOW - 124_500).toISOString() }), item("pB", { created_at: new Date(NOW - 109_500).toISOString() })];
  const answered = planOrphans([b], items, new Set(), NOW + 20_000, [a]);
  assert.deepEqual([answered.adopt.map(t => t.taskId), answered.claimed], [["pB"], ["pA"]]);
});

// Round-6 review wf_c5014fa6-227: discarding every item when one window was refused failed orphans whose own window
// had answered with their prediction (for good). Items from windows that answered are kept; only claimants whose own
// window was refused are kept from being dropped.
test("one refused window does not cost an orphan in another window its prediction", () => {
  const o1 = orphan("O1", { startTime: NOW - 180_000 }), c2 = claimant("C2", NOW - 125_000, { modelId: "kwaivgi/kling-v2" });
  const answeredFor = (t) => t.id === "O1"; // O1's window answered, C2's was refused
  const r = planOrphans([o1], [item("pO1", { created_at: new Date(NOW - 179_500).toISOString() })], new Set(), NOW, [c2], { answeredFor });
  assert.deepEqual([r.adopt.map(t => t.taskId), r.fail, r.resolved], [["pO1"], [], []]);
});

test("a claimant whose window is still open and has no prediction yet stays", () => {
  const r = planOrphans([orphan("O", { startTime: NOW - 10_000 })], [], new Set(), NOW, [claimant("C", NOW - 20_000)]);
  assert.deepEqual(r.resolved, []);
});

// Review wf_9d0e3664-ab7 #3: a claimant from Clear Outputs / Reset Everything is a DELETED generation; when its
// prediction turns up it must be deleted on WaveSpeed too (a plain Cancel's claimant is not: cancel is not delete).
test("a claim says which claimant took which prediction, and whether that claimant was deleted", () => {
  const map = rememberClaimants({}, [claimant("C", NOW - 70_000)], NOW, { deleted: true });
  const [c] = liveClaimants(map, NOW);
  assert.equal(c.deleted, true);
  const r = planOrphans([orphan("O", { startTime: NOW - 60_000 })],
    [item("Pc", { created_at: new Date(NOW - 69_000).toISOString() }), item("Po", { created_at: new Date(NOW - 59_000).toISOString() })], new Set(), NOW, [c]);
  assert.deepEqual(r.claims, [{ claimantId: "C", predictionId: "Pc", deleted: true }]);
  assert.equal(liveClaimants(rememberClaimants({}, [claimant("K", NOW)], NOW), NOW)[0].deleted, false, "a cancel's claimant");
});

test("claimants are kept an hour and dropped once resolved", () => {
  let m = rememberClaimants({}, [claimant("A", NOW - 1000), { id: "noModel", startTime: NOW }], NOW);
  assert.deepEqual(liveClaimants(m, NOW + 59 * 60_000).map(c => c.id), ["A", "noModel"]);
  assert.deepEqual(liveClaimants(m, NOW + 61 * 60_000), []);
  m = dropClaimants(m, ["A"]);
  assert.deepEqual(liveClaimants(m, NOW).map(c => c.id), ["noModel"]);
});

test("a released leftover from just before is skipped by ownership, not by timing", () => {
  const items = [item("leftover", { created_at: new Date(NOW - 75_000).toISOString() }), item("own")];
  const { adopt } = planOrphans([orphan("o")], items, liveReleased(rememberReleased({}, ["leftover"], NOW), NOW), NOW);
  assert.equal(adopt[0].taskId, "own");
});

test("released prediction ids (deleted tasks) are remembered for an hour, then forgotten", () => {
  const map = rememberReleased({}, ["p1", null, "p2"], NOW);
  assert.deepEqual(Object.keys(map).sort(), ["p1", "p2"]);
  assert.deepEqual([...liveReleased(map, NOW + 59 * 60_000)].sort(), ["p1", "p2"]);
  assert.deepEqual([...liveReleased(map, NOW + 61 * 60_000)], []);
  assert.deepEqual(Object.keys(rememberReleased(map, ["p3"], NOW + 61 * 60_000)), ["p3"], "old entries pruned on write");
});

// A prediction deleted on WaveSpeed (from this app or WaveSpeed's site) stays in its history with status "deleted" and
// no outputs; it must never be adopted, so it never shows up here.
test("a lost submit never adopts a prediction WaveSpeed lists as deleted", () => {
  const { adopt } = planOrphans([orphan("o")], [item("gone", { status: "deleted" }), item("own", { created_at: new Date(NOW - 57_000).toISOString() })], new Set(), NOW);
  assert.equal(adopt[0]?.taskId, "own");
});

test("a failed submit may have reached WaveSpeed on a network drop, timeout or 5xx, never on a refusal", () => {
  assert.equal(submitMayHaveLanded(new TypeError("Failed to fetch")), true, "the phone left the app mid-submit");
  assert.equal(submitMayHaveLanded(new DOMException("signal timed out", "TimeoutError")), true, "numeric legacy .code is not an HTTP status");
  assert.equal(submitMayHaveLanded(new SyntaxError("Unexpected end of JSON input")), true, "response cut off mid-body");
  assert.equal(submitMayHaveLanded({ code: 502, message: "Upstream error" }), true);
  for (const e of [{ code: 402 }, { code: 400 }, { code: 429 }, { code: 401, session: true }, { code: 400, noKey: true }])
    assert.equal(submitMayHaveLanded(e), false, JSON.stringify(e));
});

test("a prediction without a result URL is polled by its id", () => {
  const { adopt } = planOrphans([orphan("o")], [item("pred-2", { urls: undefined })], new Set(), NOW);
  assert.equal(adopt[0].pollUrl, "/api/v3/predictions/pred-2/result");
});

// ─── Review #10 (2026-10-22): a task cancelled during its submit and then deleted has its prediction deleted ───
test("bulk delete flips a cancelled claimant to deleted (with a fresh hour), and its prediction is then deleted", () => {
  const k = { id: "K", status: "pending", modelId: "bytedance/seedream-v4", startTime: NOW - 70_000 };
  let m = noteClaimants({}, [k], NOW - 69_000);
  assert.equal(liveClaimants(m, NOW)[0].deleted, false);
  m = noteClaimants(m, [{ ...k, status: "failed", error: "Cancelled" }], NOW, { deleted: true });
  const [c] = liveClaimants(m, NOW);
  assert.deepEqual({ id: c.id, deleted: c.deleted, startTime: c.startTime, modelId: c.modelId },
    { id: "K", deleted: true, startTime: NOW - 70_000, modelId: "bytedance/seedream-v4" });
  assert.equal(m.K.at, NOW, "a flip restarts the claimant hour");
  const r = planOrphans([], [item("Pk", { created_at: new Date(NOW - 69_000).toISOString() })], new Set(), NOW, liveClaimants(m, NOW));
  assert.deepEqual(r.claims, [{ claimantId: "K", predictionId: "Pk", deleted: true }]);
  assert.deepEqual(r.resolved, ["K"]);
});

test("only a waiting task or an earlier claimant is recorded; deleted never flips back; expired entries stay gone", () => {
  const pend = { id: "P", status: "pending", modelId: "m", startTime: NOW };
  const refused = { id: "R", status: "failed", modelId: "m", startTime: NOW };
  const landed = { id: "L", status: "processing", taskId: "pL", modelId: "m", startTime: NOW };
  const m = noteClaimants({ L: { modelId: "m", startTime: NOW, at: NOW, deleted: false } }, [pend, refused, landed], NOW, { deleted: true });
  assert.equal(m.P.deleted, true); assert.equal(m.R, undefined); assert.equal(m.L.deleted, false);
  assert.deepEqual(noteClaimants({}, [refused], NOW), {});
  assert.deepEqual(noteClaimants({ X: { modelId: "m", startTime: NOW - 2 * HOUR, at: NOW - 2 * HOUR, deleted: false } }, [{ id: "X", status: "failed" }], NOW, { deleted: true }), {});
  let d = noteClaimants({}, [{ id: "D", status: "pending", modelId: "m", startTime: NOW }], NOW, { deleted: true });
  d = noteClaimants(d, [{ id: "D", status: "pending", modelId: "m", startTime: NOW }], NOW + 1000);
  assert.equal(d.D.deleted, true);
});

// Review wf_ec400a67-988 #9: a cancel lost to a freeze, deleted more than an hour later, still gets its prediction
// deleted: the delete records a deleted claimant without a live entry, and deleted claimants live 48 h.
test("a task cancelled mid-submit and deleted hours later becomes a deleted claimant that lives 48 h", () => {
  const T = NOW;
  const c = { id: "c", status: "failed", error: "Cancelled", modelId: "m", startTime: T };
  const m = noteClaimants({}, [c], T + 2 * HOUR, { deleted: true });
  assert.equal(m.c?.deleted, true);
  assert.deepEqual(liveClaimants(m, T + 2 * HOUR + 30 * 60_000).map(x => [x.id, x.deleted]), [["c", true]]);
  assert.equal(liveClaimants(m, T + 2 * HOUR + 47 * HOUR).length, 1, "still there inside 48 h");
  assert.equal(liveClaimants(m, T + 2 * HOUR + 49 * HOUR).length, 0, "gone after 48 h");
  assert.deepEqual(noteClaimants({}, [{ ...c, error: "Insufficient credits" }], T, { deleted: true }), {}, "a refused submit never reached WaveSpeed");
  const k = noteClaimants({}, [{ id: "k", status: "pending", modelId: "m", startTime: T }], T);
  assert.equal(liveClaimants(k, T + 2 * HOUR).length, 0, "a cancelled-only claimant still lives an hour");
});

test("claim outcomes: link a cancelled claimant's prediction, delete a deleted one's, never delete on a guess; stale lookups decide nothing", () => {
  const claims = [{ claimantId: "K", predictionId: "pK", deleted: false }, { claimantId: "H", predictionId: "pH", deleted: false },
    { claimantId: "G", predictionId: "pG", deleted: false }, { claimantId: "D", predictionId: "pD", deleted: true }];
  const tasks = [{ id: "K", status: "failed", error: "Cancelled" }, { id: "H", status: "failed", taskId: "x" }];
  assert.deepEqual(planClaimOutcomes(claims, tasks), { attach: [{ id: "K", predictionId: "pK" }], del: ["pD"] });
  assert.equal(claimantLookupNeeded([], [{ id: "C", deleted: false }]), true);
  assert.equal(claimantLookupNeeded([orphan("O")], []), true);
  assert.equal(claimantLookupNeeded([], []), false);
  assert.equal(lookupStale(5, 5, 0), false); assert.equal(lookupStale(5, 6, 0), true); assert.equal(lookupStale(5, 5, 1), true);
  const r = planOrphans([], [], new Set(), NOW, [{ id: "C", modelId: "bytedance/seedream-v4", startTime: NOW - 5 * 60_000, deleted: true }]);
  assert.deepEqual(r.resolved, ["C"]); assert.deepEqual(r.claims, []);
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
