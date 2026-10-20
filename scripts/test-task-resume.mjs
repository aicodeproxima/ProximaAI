// Tests for src/lib/taskResume.js — what happens to in-flight tasks on load. Run: node scripts/test-task-resume.mjs
import assert from "node:assert/strict";
import { planResume, pollOutcome, mergeLoadedTasks, applyPoll, settlePoll, retryTask, pollTiming, nextPollDelay, pollErrorAction, RESUME_WINDOW_MS, SUBMIT_GRACE_MS, GONE_ERROR } from "../src/lib/taskResume.js";

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

test("fails a task that never got a provider id once the submit grace has passed", () => {
  const p = planResume([task("ns", { status: "pending", pollUrl: undefined, taskId: undefined, startTime: NOW - SUBMIT_GRACE_MS - 1 })], NOW);
  assert.deepEqual(p.resume, []);
  assert.equal(p.expire[0].status, "failed");
  assert.match(p.expire[0].error, /never reached WaveSpeed|before WaveSpeed/i);
});

test("leaves a just-submitted task without a provider id alone (another tab may be submitting it)", () => {
  const p = planResume([task("fresh", { status: "pending", pollUrl: undefined, startTime: NOW - 1000 })], NOW);
  assert.deepEqual([p.resume, p.expire], [[], []]);
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

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
