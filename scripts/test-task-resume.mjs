// Tests for src/lib/taskResume.js — what happens to in-flight tasks on load. Run: node scripts/test-task-resume.mjs
import assert from "node:assert/strict";
import { planResume, pollOutcome, mergeLoadedTasks, applyPoll, settlePoll, retryTask, pollTiming, nextPollDelay, pollErrorAction, planRepoll, REPOLL_THROTTLE_MS, isOrphan, orphanWindows, planOrphans, submitMayHaveLanded, isInFlight, LOOKUP_SKEW_MS, ORPHAN_GRACE_MS, RESUME_WINDOW_MS, GONE_ERROR } from "../src/lib/taskResume.js";

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
  assert.deepEqual(planOrphans([orphan("o", { startTime: NOW - 10_000 })], [], new Set(), NOW), { adopt: [], fail: [] });
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

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
