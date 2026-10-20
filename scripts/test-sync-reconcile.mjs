// Tests for src/lib/syncReconcile.js — the cross-device sync decisions. Run: node scripts/test-sync-reconcile.mjs
import assert from "node:assert/strict";
import { planTaskSync, planLogSync, SYNC_GRACE_MS } from "../src/lib/syncReconcile.js";

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

test("never touches a running task", () => {
  const local = [task("run", { status: "processing" }), task("q", { status: "pending" })];
  const p = planTaskSync({ ...base, tombstones: new Set(["run"]), local, cloud: [], cloudIds: new Set() });
  assert.deepEqual([p.remove, p.upload], [[], []]);
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

console.log(`\n${n} passed`);
