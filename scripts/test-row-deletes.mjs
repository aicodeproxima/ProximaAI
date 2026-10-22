// Tests for the batched row deletes in src/lib/supabase.js (review wf_ec400a67-988 #2/#3, 2026-10-22): a replay of a
// large clear's intents sends its ids in chunks (one id list per request kept short), and Clear Outputs / Reset read
// every cloud row before anything is deleted. Run: node scripts/test-row-deletes.mjs
import assert from "node:assert/strict";
import { loadSupabase, fakeClient } from "./lib/load-supabase.mjs";

const store = new Map([["proximaai-user", "owner"]]);
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
console.warn = () => {};
const sb = await loadSupabase();

let n = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", e.message.split("\n")[0]); }
};
const ids = (k) => Array.from({ length: k }, (_, i) => "t" + i);
const inList = (q) => q.ops.find(o => o[0] === "in")?.[2];

for (const [name, table] of [["deleteTasksRemote", "tasks"], ["deleteHistoryRemote", "history"]]) {
  await test(`${name}: 250 ids go in chunks of at most 100, all scoped to this account`, async () => {
    const c = fakeClient(); sb.__setClientForTests(c);
    assert.deepEqual(await sb[name](ids(250)), { ok: true });
    assert.deepEqual(c.calls.map(q => inList(q).length), [100, 100, 50]);
    assert.ok(c.calls.every(q => q.table === table && q.ops.some(o => o[0] === "eq" && o[1] === "device_id" && o[2] === "user:owner")));
    assert.deepEqual(c.calls.flatMap(inList), ids(250));
  });
  await test(`${name}: one refused chunk makes the whole delete not ok (its intents stay queued)`, async () => {
    let k = 0;
    sb.__setClientForTests(fakeClient(() => (++k === 2 ? { data: null, error: { message: "boom" } } : { data: null, error: null })));
    assert.deepEqual(await sb[name](ids(250)), { ok: false, error: "boom" });
  });
}

// #3: Clear Outputs / Reset purge every cloud row, not the 500 newest (or nothing when that read failed).
const rows = (k, from = 0) => Array.from({ length: k }, (_, i) => ({ id: "r" + String(from + i).padStart(5, "0"), device_id: "user:owner", status: "pending", outputs: [], task_id: null }));
await test("pullAllForPurge: every page of every status, mapped like pullTasks / pullHistory", async () => {
  const c = fakeClient((q) => {
    const after = q.ops.find(o => o[0] === "gt");
    if (q.table === "tasks") return { data: after ? rows(3, 1000) : rows(1000), error: null };
    return { data: [{ id: "h1", device_id: "user:owner", tasks: [{ id: "r00001" }], total_cost: 1 }], error: null };
  });
  sb.__setClientForTests(c);
  const r = await sb.pullAllForPurge();
  assert.equal(r.tasks.length, 1003);
  assert.equal(r.tasks[0].status, "pending", "pending rows too (pullTasks skips them)");
  assert.deepEqual(r.history.map(h => [h.id, h.tasks.length, h.totalCost]), [["h1", 1, 1]]);
  assert.ok(c.calls.filter(q => q.table === "tasks").every(q => !q.ops.some(o => o[0] === "in")), "no status filter");
  assert.ok(c.calls.every(q => q.ops.some(o => o[0] === "eq" && o[1] === "device_id" && o[2] === "user:owner")));
});
await test("pullAllForPurge: any failed page answers null, so nothing is cleared", async () => {
  sb.__setClientForTests(fakeClient((q) => (q.ops.find(o => o[0] === "gt") ? { data: null, error: { message: "timeout" } } : { data: rows(1000), error: null })));
  assert.equal(await sb.pullAllForPurge(), null);
  sb.__setClientForTests(fakeClient(() => { throw new TypeError("Failed to fetch"); }));
  assert.equal(await sb.pullAllForPurge(), null);
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
