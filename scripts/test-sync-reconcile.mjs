// Tests for src/lib/syncReconcile.js — the cross-device sync decisions. Run: node scripts/test-sync-reconcile.mjs
import assert from "node:assert/strict";
import { planTaskSync, planLogSync, applyCloudUpdate, inputBackfill, releaseRestored, historyRemovals, tombstonedItems, SYNC_GRACE_MS } from "../src/lib/syncReconcile.js";

const NOW = 1_800_000_000_000;
const OLD = NOW - 10 * 60_000;
const task = (id, extra = {}) => ({ id, status: "completed", startTime: OLD, endTime: OLD, outputs: [`https://cdn/${id}.png`], ...extra });
const log = (id, extra = {}) => ({ id, timestamp: OLD, ...extra });
const base = { pending: new Set(), deleting: new Set(), tombstones: new Set(), since: NOW };
let n = 0;
const test = (name, fn) => { fn(); n++; console.log("ok -", name); };

test("adds a task another device created", () => {
  const p = planTaskSync({ ...base, local: [task("a")], cloud: [task("a"), task("b")], cloudIds: new Set(["a", "b"]) });
  assert.deepEqual(p.add.map(t => t.id), ["b"]);
  assert.deepEqual([p.remove, p.upload], [[], []]);
});

test("removes a task the server recorded as deleted (tombstone)", () => {
  const p = planTaskSync({ ...base, tombstones: new Set(["gone"]), local: [task("a"), task("gone")], cloud: [task("a")], cloudIds: new Set(["a"]) });
  assert.deepEqual(p.remove, ["gone"]);
  assert.deepEqual(p.upload, []);
});

test("uploads — never removes — a local-only task the cloud never had", () => {
  const p = planTaskSync({ ...base, local: [task("mine")], cloud: [], cloudIds: new Set() });
  assert.deepEqual(p.upload.map(t => t.id), ["mine"]);
  assert.deepEqual(p.remove, []);
});

test("leaves a pending upload alone (the queue will send it)", () => {
  const p = planTaskSync({ ...base, pending: new Set(["new"]), local: [task("new")], cloud: [], cloudIds: new Set() });
  assert.deepEqual([p.remove, p.upload], [[], []]);
});

test("leaves a task that finished inside the grace window alone", () => {
  const p = planTaskSync({ ...base, local: [task("fresh", { endTime: NOW - SYNC_GRACE_MS + 1000 })], cloud: [], cloudIds: new Set() });
  assert.deepEqual([p.remove, p.upload], [[], []]);
});

test("never uploads a running task (its own submit path does)", () => {
  const local = [task("run", { status: "processing" }), task("q", { status: "pending" })];
  const p = planTaskSync({ ...base, local, cloud: [], cloudIds: new Set() });
  assert.deepEqual([p.remove, p.upload], [[], []]);
});

// Running tasks reach the cloud now, so one can be deleted on another device mid-generation. Finishing it here would
// re-insert it, which clears its tombstone: the deleted task would come back everywhere.
test("removes a running task another device deleted, unless its upload is still queued here", () => {
  const local = [task("run", { status: "processing" }), task("q", { status: "processing" })];
  const p = planTaskSync({ ...base, tombstones: new Set(["run", "q"]), pending: new Set(["q"]), local, cloud: [], cloudIds: new Set() });
  assert.deepEqual(p.remove, ["run"]);
  assert.deepEqual(p.upload, []);
});

test("does nothing destructive or uploading when either cloud read failed", () => {
  const a = planTaskSync({ ...base, tombstones: null, local: [task("a")], cloud: [], cloudIds: new Set() });
  const b = planTaskSync({ ...base, tombstones: new Set(["a"]), local: [task("a")], cloud: [], cloudIds: null });
  assert.deepEqual([a.remove, a.upload, b.remove, b.upload], [[], [], [], []]);
});

test("keeps a tombstoned id that is back in the cloud (restored / re-inserted)", () => {
  const p = planTaskSync({ ...base, tombstones: new Set(["r"]), local: [task("r")], cloud: [task("r")], cloudIds: new Set(["r"]) });
  assert.deepEqual(p.remove, []);
});

test("does not re-add a cloud row this device is deleting", () => {
  const p = planTaskSync({ ...base, deleting: new Set(["d"]), local: [], cloud: [task("d")], cloudIds: new Set(["d"]) });
  assert.deepEqual(p.add, []);
});

test("refreshes outputs another device changed (cloud archive), not while a local upload is pending", () => {
  const cloud = [task("a", { outputs: ["https://supabase/a.png"] }), task("b", { outputs: ["https://supabase/b.png"] })];
  const p = planTaskSync({ ...base, pending: new Set(["b"]), local: [task("a"), task("b")], cloud, cloudIds: new Set(["a", "b"]) });
  assert.deepEqual(p.update, [{ id: "a", outputs: ["https://supabase/a.png"] }]);
});

test("never blanks local outputs from an empty cloud copy", () => {
  const p = planTaskSync({ ...base, local: [task("a")], cloud: [task("a", { outputs: [] })], cloudIds: new Set(["a"]) });
  assert.deepEqual(p.update, []);
});

test("history: adds, removes tombstoned, uploads local-only, skips pending and recent", () => {
  const local = [log("keep"), log("gone"), log("mine"), log("queued"), log("recent", { timestamp: NOW - 5_000 })];
  const p = planLogSync({ ...base, tombstones: new Set(["gone"]), pending: new Set(["queued"]), local,
    cloud: [log("keep"), log("other")], cloudIds: new Set(["keep", "other"]) });
  assert.deepEqual(p.add.map(l => l.id), ["other"]);
  assert.deepEqual(p.remove, ["gone"]);
  assert.deepEqual(p.upload.map(l => l.id), ["mine"]);
});

// ─── Running tasks across devices ───
// A device uploads a task as "processing" right after submit, so another open device can finish it when the first one
// is frozen or closed. Whichever device gets the result first uploads it; the others take that outcome.
const running = (id, extra = {}) => task(id, { status: "processing", taskId: `pred-${id}`, endTime: null, outputs: [], ...extra });

test("adds a task still running on another device (so this one can poll it)", () => {
  const p = planTaskSync({ ...base, local: [], cloud: [running("r")], cloudIds: new Set(["r"]) });
  assert.deepEqual(p.add.map(t => [t.id, t.status]), [["r", "processing"]]);
});

test("takes the outcome another device saved for a task still running here", () => {
  const done = task("r", { taskId: "pred-r", endTime: NOW - 1000, wallClockMs: 9000, inferenceMs: 7000 });
  const failed = task("f", { status: "failed", error: "Generation failed", outputs: [], endTime: NOW - 1000 });
  const p = planTaskSync({ ...base, local: [running("r"), running("f")], cloud: [done, failed], cloudIds: new Set(["r", "f"]) });
  assert.deepEqual(p.update, [
    { id: "r", outputs: done.outputs, finish: { status: "completed", error: null, endTime: NOW - 1000, wallClockMs: 9000, inferenceMs: 7000, nsfw: null } },
    { id: "f", outputs: [], finish: { status: "failed", error: "Generation failed", endTime: NOW - 1000, wallClockMs: 0, inferenceMs: 0, nsfw: null } },
  ]);
});

test("a task being recovered here keeps polling: the cloud's old network failure is not its outcome", () => {
  const stale = task("x", { status: "failed", error: "Failed to fetch", outputs: [], taskId: "pred-x" });
  const p = planTaskSync({ ...base, local: [running("x", { recovered: true }), running("y")],
    cloud: [stale, task("y", { status: "failed", error: "Load failed", outputs: [], taskId: "pred-y" })], cloudIds: new Set(["x", "y"]) });
  assert.deepEqual(p.update, [], "neither a recovered task nor a recoverable failure ends a running one");
  const won = planTaskSync({ ...base, local: [running("x", { recovered: true })], cloud: [task("x", { taskId: "pred-x" })], cloudIds: new Set(["x"]) });
  assert.equal(won.update[0]?.finish?.status, "completed", "another device recovered it first");
});

test("a running cloud copy never overrides a finished task here, and the result is sent again", () => {
  const p = planTaskSync({ ...base, local: [task("d")], cloud: [running("d")], cloudIds: new Set(["d"]) });
  assert.deepEqual(p.update, []);
  assert.deepEqual(p.upload.map(t => t.id), ["d"], "heals a cloud row left at processing");
  const fresh = planTaskSync({ ...base, local: [task("d", { endTime: NOW - 1000 })], cloud: [running("d")], cloudIds: new Set(["d"]) });
  assert.deepEqual(fresh.upload, [], "inside the grace its own upload may still be in flight");
  const queued = planTaskSync({ ...base, pending: new Set(["d"]), local: [task("d")], cloud: [running("d")], cloudIds: new Set(["d"]) });
  assert.deepEqual(queued.upload, [], "the queue will send it");
});

// The server keeps a completed row completed (a cancel or failure from another device never replaces it), so a device
// whose copy says failed — cancelled there, or failed by an older build — takes the completed result instead.
test("a result completed on another device replaces a failure or cancel here", () => {
  const done = task("c", { taskId: "pred-c", endTime: NOW - 1000 });
  const p = planTaskSync({ ...base, local: [task("c", { status: "failed", error: "Cancelled", outputs: [] })], cloud: [done], cloudIds: new Set(["c"]) });
  assert.equal(p.update[0]?.finish?.status, "completed");
  const applied = applyCloudUpdate(task("c", { status: "failed", error: "Cancelled", outputs: [] }), p.update[0]);
  assert.deepEqual([applied.status, applied.error, applied.outputs], ["completed", null, done.outputs]);
  const reverse = planTaskSync({ ...base, local: [task("c")], cloud: [task("c", { status: "failed", error: "Cancelled", outputs: [] })], cloudIds: new Set(["c"]) });
  assert.deepEqual(reverse.update, [], "a cloud failure never replaces a completed result here");
});

test("applying a cloud outcome: only to a task still running here; plain output refreshes as before", () => {
  const u = { id: "r", outputs: ["https://cdn/r.png"], finish: { status: "completed", error: null, endTime: NOW, wallClockMs: 9, inferenceMs: 7, nsfw: null } };
  const applied = applyCloudUpdate(running("r"), u);
  assert.deepEqual([applied.status, applied.outputs, applied.endTime, applied.taskId], ["completed", ["https://cdn/r.png"], NOW, "pred-r"]);
  const doneHere = task("r", { outputs: ["https://cdn/mine.png"] });
  assert.equal(applyCloudUpdate(doneHere, u), doneHere, "completed here meanwhile: kept");
  const failedHere = task("r", { status: "failed", error: "Generation failed", outputs: [] });
  const failedThere = { ...u, outputs: [], finish: { ...u.finish, status: "failed", error: "Cancelled" } };
  assert.equal(applyCloudUpdate(failedHere, failedThere), failedHere, "a failure never replaces a failure here");
  assert.deepEqual(applyCloudUpdate(task("a"), { id: "a", outputs: ["https://supabase/a.png"] }).outputs, ["https://supabase/a.png"]);
});

// Review round 3: rows saved before migration 20261022190000 have null input URLs, so their uploads were invisible to
// delete-everywhere and to paths_in_use. The device that holds the URLs fills in only the columns the cloud lacks.
test("inputBackfill: the input URLs this device has and the cloud row lacks, per column", () => {
  const local = [
    task("a", { endFrameUrl: "e", sourceAudioUrl: "s" }),
    task("b", { refVideoUrl: "r" }),
    task("c", { sourceVideoUrl: "v" }),
    task("d"),
    task("e", { endFrameUrl: "x" }),
  ];
  const cloud = [
    task("a", { endFrameUrl: null, sourceAudioUrl: "s", sourceVideoUrl: null, refVideoUrl: null }),
    task("b", { endFrameUrl: null, sourceAudioUrl: null, sourceVideoUrl: null, refVideoUrl: "r" }),
    task("d", { endFrameUrl: null }),
    task("e", { endFrameUrl: "other" }),
  ];
  assert.deepEqual(inputBackfill(local, cloud), [{ id: "a", end_frame_url: "e" }],
    "b already has it; c has no cloud row; d has nothing; e's cloud value is never overwritten");
});

// Review round 4: ids deleted (and confirmed) earlier this session stay "deleting" here, so after a restore brought them
// back they were never re-added and their WaveSpeed copy was not held. On a restore this tab has not handled, every
// deleting id the cloud holds again is released, unless its own delete intent is still pending.
// Review round 5: only deletes confirmed before this pass's cloud reads began are released (a delete still in flight,
// or one confirmed after the reads, is never released), on every pass, not only on the pass that saw the restore.
test("releaseRestored: confirmed-earlier deletes the cloud holds again; never in-flight, late-confirmed or pending ones", () => {
  const since = 10_000;
  const deleting = new Set(["back", "inflight", "late", "pending", "gone"]);
  const confirmed = new Map([["back", 5_000], ["late", 12_000], ["pending", 5_000], ["gone", 5_000]]);
  const cloud = new Set(["back", "inflight", "late", "pending"]);
  assert.deepEqual(releaseRestored(deleting, ["pending"], cloud, confirmed, since), ["back"]);
  assert.deepEqual(releaseRestored(deleting, [], null, confirmed, since), [], "cloud ids unread: nothing");
});

// Review round 5: a task a restore removed (by_restore tombstone) leaves this device, but its History items stay: the
// restore brought the entry back with them, and stripping them would erase the generation from History and backups.
test("historyRemovals: only tasks a user deleted take their History items with them", () => {
  assert.deepEqual(historyRemovals([{ id: "u" }, { id: "r" }, { id: "x" }], new Set(["r"])).map(t => t.id), ["u", "x"]);
  assert.deepEqual(historyRemovals([{ id: "u" }], null).map(t => t.id), ["u"], "restore removals unknown: as before");
});

// Review round 6: a generation a user deleted on another device whose task this device never held (History-only) still
// leaves this device's History: its id has a user tombstone (not a restore's).
test("tombstonedItems: History items whose generation a user deleted and this device holds no task of", () => {
  const logs = [{ id: "E", tasks: [{ id: "gone" }, { id: "kept" }, { id: "restored" }, { id: "local" }, { outputs: ["x"] }] }];
  const r = tombstonedItems(logs, new Set(["gone", "restored", "local"]), new Set(["restored"]), new Set(["local"]));
  assert.deepEqual(r, ["gone"]);
  assert.deepEqual(tombstonedItems(logs, null, null, new Set()), [], "tombstones unread: nothing");
});

console.log(`\n${n} passed`);
