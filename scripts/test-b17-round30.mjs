// Task B17 (review round 30). Runs the real storage.js. Written first: before the change each test below fails.
// #3 a pending clear's stashed History upload that names a generation whose delete is FINAL no longer counts as unsent:
//    unsentGenerations (published in form-inputs:<browser>:unsent, held by every device's WaveSpeed flush) must not keep
//    that generation's id, prediction or files (before, they were held until holdHeldIds gave up after 48 h, and then
//    the WaveSpeed result was never deleted).
// Run: node scripts/test-b17-round30.mjs
import assert from "node:assert/strict";

const mem = new Map();
globalThis.localStorage = {
  getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)),
  removeItem: k => mem.delete(k), get length() { return mem.size; }, key: i => [...mem.keys()][i] ?? null,
};
const sess = new Map();
globalThis.sessionStorage = { getItem: k => (sess.has(k) ? sess.get(k) : null), setItem: (k, v) => sess.set(k, String(v)), removeItem: k => sess.delete(k) };
const S = await import("../src/lib/storage.js");

let n = 0, failed = 0;
const test = async (name, fn) => {
  try { mem.clear(); await fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", String(e?.message || e).split("\n").filter(Boolean).slice(0, 4).join(" | ")); }
};
const BASE = "https://x.supabase.co/storage/v1/object/public/generations/";

// A clear queued at T took queued entry L (items g and k) into its stash; g's own row and k's row too.
const stash = () => {
  const T = Date.now() - 60_000;
  assert.ok(S.writeClearStash(T, S.buildClearStash({
    uploads: [
      { kind: "history", id: "L", data: { id: "L", tasks: [
        { id: "g", taskId: "ws-g", outputs: [`${BASE}user_x/g-0.png`] },
        { id: "k", taskId: "ws-k", outputs: [`${BASE}user_x/k-0.png`] }] } },
      { kind: "task", id: "g", data: { id: "g", taskId: "ws-g", sourceImageUrl: `${BASE}uploads/s/g-in.png` } },
      { kind: "task", id: "k", data: { id: "k", taskId: "ws-k", sourceImageUrl: `${BASE}uploads/s/k-in.png` } },
    ],
    tasks: [], logs: [] })));
  return T;
};

await test("#3 control: while nothing is decided, the stash's generations count as unsent", () => {
  stash();
  const u = S.unsentGenerations();
  assert.deepEqual([u.ids.sort(), u.predictions.sort()], [["g", "k"], ["ws-g", "ws-k"]]);
});

await test("#3: a generation whose delete is final leaves the unsent set (id, prediction, its files); the others stay", () => {
  stash();
  S.confirmDeleteIntents("task-delete", ["g"], Date.now());
  assert.ok(S.confirmStates("task-delete").final.has("g"), "premise: g's delete is final");
  const u = S.unsentGenerations();
  assert.deepEqual([u.ids.sort(), u.predictions.sort()], [["k"], ["ws-k"]]);
  assert.ok(!u.paths.includes("uploads/s/g-in.png") && !u.paths.some(p => p.includes("g-0")), `g's files not held: ${u.paths}`);
  assert.ok(u.paths.includes("uploads/s/k-in.png"), "k's input still held");
  assert.deepEqual(S.unsentRowsIn([{ id: "M", tasks: [{ id: "g" }, { id: "k" }] }]), ["k"]);
});

await test("#3: a History entry whose own delete is final leaves the unsent set as a whole", () => {
  stash();
  S.confirmDeleteIntents("history-delete", ["L"], Date.now());
  const u = S.unsentGenerations();
  // L's items are gone with L; g's and k's own rows are still stashed (their deletes are not decided)
  assert.deepEqual(u.ids.sort(), ["g", "k"]);
  assert.ok(!u.paths.some(p => p.includes("-0.png")), `L's output files not held: ${u.paths}`);
});

// B17 verification: after a stale-stamp refusal the form row is resent with its set computed again (resending the set
// computed before the newer stored row would erase that newer hold), and the sent {at, paths} is what is remembered.
await test("wiring: sendFormRow recomputes its set on the resend; both callers pass the recompute and keep what was sent", async () => {
  const { readFileSync } = await import("node:fs");
  const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.match(app, /const again = formStamp\(serverNow\(\)\), fresh = recompute\(\);\s*await syncSetting\("form-inputs:" \+ browserId\(\), \{ at: again, paths: fresh \}\);\s*return \{ at: again, paths: fresh \};/);
  assert.match(app, /sendFormRow\(mine, localFormPaths\)\.then\(\(sent\) => \{ cloudFormPubRef\.current = sent; \}\)/);
  assert.match(app, /sendFormRow\(mine, localFormPaths\)\.catch\(\(\) => \{\}\);/);
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
