// Tests for src/lib/taskResume.js — what happens to in-flight tasks on load. Run: node scripts/test-task-resume.mjs
import assert from "node:assert/strict";
import { planResume, pollOutcome, mergeLoadedTasks, applyPoll, settlePoll, pollTiming, pollErrorAction, RESUME_WINDOW_MS, SUBMIT_GRACE_MS, GONE_ERROR } from "../src/lib/taskResume.js";

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
  assert.equal(pollOutcome({ status: "canceled" }), "gone");
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

test("poll error: WaveSpeed refusing the poll (4xx) fails the task", () => {
  assert.equal(pollErrorAction({ code: 404 }), "fail");
  assert.equal(pollErrorAction({ code: 0, message: "Refusing to poll a non-WaveSpeed URL" }), "fail");
});

test("poll timing: images poll every 3 s for 5 min, 3D every 10 s, video until WaveSpeed answers", () => {
  assert.deepEqual(pollTiming("image"), { interval: 3000, maxPollMs: 300000 });
  assert.deepEqual(pollTiming("i2i"), { interval: 3000, maxPollMs: 300000 });
  assert.deepEqual(pollTiming("i23d"), { interval: 10000, maxPollMs: Infinity });
  assert.deepEqual(pollTiming("t2v"), { interval: 15000, maxPollMs: Infinity });
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
