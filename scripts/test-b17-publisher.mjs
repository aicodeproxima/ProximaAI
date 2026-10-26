// Task B17 (review round 30 #1/#2): the :unsent publisher (src/lib/unsentPublish.js), without round 29's chain. Written
// first: before the module exists every test fails.
// #1 a publication is sent at once, even while an older write is still unanswered (a frozen page used to hold every later
//    one until it thawed, so a sibling's delete on another device removed a live generation's input; simulator I6-end).
// #2 answers may come back in any order (two tabs, the page-exit write): what this page counts as confirmed only moves
//    forward to the newest set it computed, which is also the one the server keeps (20261025900000).
// Run: node scripts/test-b17-publisher.mjs
import assert from "node:assert/strict";

let P;
try { P = await import("../src/lib/unsentPublish.js"); } catch { P = {}; }
let n = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", String(e?.message || e).split("\n").slice(0, 3).join(" | ")); }
};
// A test harness: a fake clock, a set to publish, and a send whose answers the test releases in any order.
const harness = ({ dueAlways = false } = {}) => {
  let clock = 1000, set = { paths: [], ids: [], predictions: [] };
  const sent = [];
  const pub = P.createUnsentPublisher({
    configured: () => true,
    compute: () => set,
    now: () => clock,
    due: (prev, items) => dueAlways || !prev || prev.paths.join() !== items.join(),
    send: (value) => new Promise((resolve, reject) => sent.push({ value, resolve, reject })),
  });
  return { pub, sent, tick: (ms) => { clock += ms; }, setRows: (ids) => { set = { paths: [], ids, predictions: [] }; } };
};
const flush = () => new Promise(r => setImmediate(r));

await test("#1: a second publication goes out while the first is still unanswered", async () => {
  const h = harness();
  h.setRows(["t2"]);
  const p1 = h.pub.publish();
  h.tick(10); h.setRows(["t2", "t5"]);
  const p2 = h.pub.publish();
  await flush();
  assert.equal(h.sent.length, 2, "both writes issued before either answered");
  assert.deepEqual(h.sent[1].value.ids, ["t2", "t5"]);
  h.sent[1].resolve(); h.sent[0].resolve();
  assert.deepEqual([await p1, await p2], [true, true]);
});

await test("#2: an older write answered after a newer one never becomes the confirmed set", async () => {
  const h = harness();
  h.setRows(["t2"]);
  const p1 = h.pub.publish();
  h.tick(10); h.setRows(["t2", "t5"]);
  const p2 = h.pub.publish();
  await flush();
  h.sent[1].resolve(); await p2;
  h.sent[0].resolve(); await p1;
  assert.equal(h.pub.confirmed().at, 1010);
  assert.deepEqual(h.pub.confirmed().paths, ["id:t2", "id:t5"]);
});

await test("not due: nothing is sent; a failed write answers false and confirms nothing", async () => {
  const h = harness();
  h.setRows(["t2"]);
  const p1 = h.pub.publish(); await flush(); h.sent[0].resolve(); assert.equal(await p1, true);
  assert.equal(await h.pub.publish(), true);
  assert.equal(h.sent.length, 1, "unchanged and confirmed: not sent again");
  h.tick(10); h.setRows(["t2", "t9"]);
  const p2 = h.pub.publish(); await flush(); h.sent[1].reject(new Error("network"));
  assert.equal(await p2, false);
  assert.deepEqual(h.pub.confirmed().paths, ["id:t2"]);
});

await test("the page-exit publication calls onExit first and is sent like any other (no queue to wait in)", async () => {
  let exited = 0, order = [];
  const pub = P.createUnsentPublisher({ configured: () => true, compute: () => ({ paths: ["uploads/a.png"], ids: [], predictions: [] }), now: () => 5,
    due: () => true, onExit: () => { exited++; order.push("exit"); }, send: async () => { order.push("send"); } });
  assert.equal(await pub.publish({ exiting: true }), true);
  assert.deepEqual([exited, order], [1, ["exit", "send"]]);
});

await test("not configured (no cloud): true, nothing sent", async () => {
  let sends = 0;
  const pub = P.createUnsentPublisher({ configured: () => false, compute: () => ({ paths: [], ids: ["x"], predictions: [] }), now: () => 1, due: () => true, send: async () => { sends++; } });
  assert.equal(await pub.publish(), true);
  assert.equal(sends, 0);
});

// B17 review #1/#5: after a backward clock step the server refuses an older stamp (20261025900000 raises PT409 with the
// stored `at`) instead of skipping it silently; the publisher moves its floor above the stored stamp and sends again once.
await test("#1/#5: a stale-stamp refusal moves the floor above the stored stamp and resends once; true only once applied", async () => {
  let clock = 100, floor = 0, stored = 5000;
  const sends = [];
  const pub = P.createUnsentPublisher({
    configured: () => true,
    compute: () => ({ paths: [], ids: ["x"], predictions: [] }),
    now: () => Math.max(clock, floor + 1),
    due: () => true,
    send: async (value) => {
      sends.push(value.at);
      if (value.at < stored) { const e = new Error("stale form publication"); e.code = "PT409"; e.details = String(stored); throw e; }
      stored = value.at;
    },
    staleAt: (e) => (e?.code === "PT409" ? Number(e.details) : NaN),
    advance: (at) => { floor = Math.max(floor, at); },
  });
  assert.equal(await pub.publish(), true);
  assert.deepEqual(sends, [100, 5001]);
  assert.equal(pub.confirmed().at, 5001);
});

// B17 verification (regression #1): up to 3 stale refusals in a row are each answered by a resend above the newest stored
// stamp (overlapping writes can be refused twice while the set changes); a 4th gives up.
await test("#1/#5: stale refusals are retried up to 3 times (each above the newest stored stamp), then false", async () => {
  let clock = 1, floor = 0, stored = 10, sends = 0;
  const pub = P.createUnsentPublisher({ configured: () => true, compute: () => ({ paths: [], ids: ["x"], predictions: [] }),
    now: () => Math.max(clock, floor + 1), due: () => true,
    send: async (value) => { sends++; if (sends <= 3) { stored += 100; } if (value.at < stored) { const e = new Error("stale"); e.code = "PT409"; e.details = String(stored); throw e; } stored = value.at; },
    staleAt: (e) => (e?.code === "PT409" ? Number(e.details) : NaN), advance: (at) => { floor = Math.max(floor, at); } });
  assert.equal(await pub.publish(), true, "refused 3 times by ever-newer stored sets, applied on the 4th send");
  assert.equal(sends, 4);
});
await test("#1/#5: a 4th stale refusal in a row gives up (false), and other errors are not retried", async () => {
  let n = 0;
  const stale = () => { const e = new Error("stale"); e.code = "PT409"; e.details = "9e15"; return e; };
  const pub = P.createUnsentPublisher({ configured: () => true, compute: () => ({ paths: [], ids: ["x"], predictions: [] }), now: () => 1,
    due: () => true, send: async () => { n++; throw stale(); }, staleAt: (e) => (e?.code === "PT409" ? Number(e.details) : NaN), advance: () => {} });
  assert.equal(await pub.publish(), false);
  assert.equal(n, 4, "3 retries, not a loop");
  let m = 0;
  const pub2 = P.createUnsentPublisher({ configured: () => true, compute: () => ({ paths: [], ids: ["x"], predictions: [] }), now: () => 1,
    due: () => true, send: async () => { m++; throw new Error("network"); }, staleAt: () => NaN, advance: () => {} });
  assert.equal(await pub2.publish(), false);
  assert.equal(m, 1);
});

const S = await (async () => {
  const mem = new Map();
  globalThis.localStorage = { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k), get length() { return mem.size; }, key: i => [...mem.keys()][i] ?? null };
  return import("../src/lib/storage.js");
})();
await test("#1/#5: a floor learned from the server is honoured even far ahead of this browser's estimate (own marks stay bounded)", () => {
  assert.equal(typeof S.advanceFormStamp, "function");
  assert.equal(S.formStamp(1_000_000), 1_000_000);
  S.advanceFormStamp(1_000_000 + 7 * 60_000);   // the stored stamp, 7 minutes ahead of a stale estimate
  assert.equal(S.formStamp(1_000_100), 1_000_000 + 7 * 60_000 + 1, "above the server's floor");
  assert.ok(S.formStamp(1_000_200) > 1_000_000 + 7 * 60_000 + 1, "and still monotonic");
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
