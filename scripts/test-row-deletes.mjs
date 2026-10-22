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

// #7: before deleting a file, the server says which paths a row of this account (any device, any age) still uses.
store.set("proximaai-session", JSON.stringify({ token: "tok", expires_at: Math.floor(Date.now() / 1000) + 3600, username: "owner" }));
await test("pathsInUseRemote: the server's answer as a Set; a failed call answers null (the queue then waits)", async () => {
  const c = fakeClient(); let seen;
  c.rpc = async (fn, args) => { seen = { fn, args }; return { data: ["a"], error: null }; };
  sb.__setClientForTests(c);
  const r = await sb.pathsInUseRemote(["a", "b"]);
  assert.deepEqual([...r], ["a"]);
  assert.deepEqual(seen, { fn: "paths_in_use", args: { p_session_token: "tok", p_paths: ["a", "b"] } });
  c.rpc = async () => ({ data: null, error: { message: "boom", code: "XX000" } });
  assert.equal(await sb.pathsInUseRemote(["a"]), null);
});

// #6: each browser publishes its Generate forms' uploads to the cloud; the other device's file flush reads them.
await test("pullFormHolds: this account's form-inputs:* setting values; a failed read answers null", async () => {
  const c = fakeClient(() => ({ data: [{ key: "form-inputs:b1", value: { at: 5, paths: ["u/x.png"] } }], error: null }));
  sb.__setClientForTests(c);
  assert.deepEqual(await sb.pullFormHolds(), [{ at: 5, paths: ["u/x.png"] }]);
  const ops = c.calls[0].ops;
  assert.equal(c.calls[0].table, "settings");
  assert.ok(ops.some(o => o[0] === "eq" && o[1] === "device_id" && o[2] === "user:owner"));
  assert.ok(ops.some(o => o[0] === "like" && o[1] === "key" && o[2] === "form-inputs:%"));
  sb.__setClientForTests(fakeClient(() => ({ data: null, error: { message: "403" } })));
  assert.equal(await sb.pullFormHolds(), null);
});

// #10: the lost-submit lookup reads every row of the account started in the window (model, start, prediction id),
// even one still waiting for its id, so a deleted claimant never takes another device's live prediction.
await test("pullTaskStartsInWindow: rows of any device in the window, with or without a prediction id; failure -> null", async () => {
  const c = fakeClient(() => ({ data: [{ id: "t1", model_id: "m", start_time: 5, task_id: null }, { id: "t2", model_id: "m", start_time: 6, task_id: "p2" }], error: null }));
  sb.__setClientForTests(c);
  assert.deepEqual(await sb.pullTaskStartsInWindow(1, 9), [
    { id: "t1", modelId: "m", startTime: 5, taskId: null }, { id: "t2", modelId: "m", startTime: 6, taskId: "p2" }]);
  const ops = c.calls[0].ops;
  assert.ok(!ops.some(o => o[0] === "not"), "rows still waiting for their id count too");
  assert.ok(ops.some(o => o[0] === "gte" && o[1] === "start_time" && o[2] === 1) && ops.some(o => o[0] === "lte" && o[1] === "start_time" && o[2] === 9));
  sb.__setClientForTests(fakeClient(() => ({ data: null, error: { message: "403" } })));
  assert.equal(await sb.pullTaskStartsInWindow(1, 9), null);
});

// Review round 2: a task's end frame / audio / driving video / reference video URLs travel with its cloud row.
await test("taskToRow / pullTasks carry the four input URLs", async () => {
  const t = { id: "t", endFrameUrl: "e", sourceAudioUrl: "a", sourceVideoUrl: "v", refVideoUrl: "r" };
  const row = sb.taskToRow(t);
  assert.deepEqual([row.end_frame_url, row.source_audio_url, row.source_video_url, row.ref_video_url], ["e", "a", "v", "r"]);
  assert.deepEqual([sb.taskToRow({ id: "x" }).end_frame_url, sb.taskToRow({ id: "x" }).ref_video_url], [null, null]);
  sb.__setClientForTests(fakeClient(() => ({ data: [{ id: "t", end_frame_url: "e", source_audio_url: "a", source_video_url: "v", ref_video_url: "r" }], error: null })));
  const [back] = await sb.pullTasks(5);
  assert.deepEqual([back.endFrameUrl, back.sourceAudioUrl, back.sourceVideoUrl, back.refVideoUrl], ["e", "a", "v", "r"]);
});

// Review round 3: a refused or failed settings read must read as "unknown", never as "no settings" ({}): the restore
// check (storage.js restoreGuard) would otherwise see no restore and replay delete intents a restore voided.
await test("pullSettings: rows as a map; a refused or failed read answers null; pullAllRemoteData passes the null on", async () => {
  sb.__setClientForTests(fakeClient((q) => (q.table === "settings" ? { data: [{ key: "last_restore_at", value: 5 }], error: null } : { data: [], error: null })));
  assert.deepEqual(await sb.pullSettings(), { last_restore_at: 5 });
  sb.__setClientForTests(fakeClient((q) => (q.table === "settings" ? { data: null, error: { message: "JWT expired" } } : { data: [], error: null })));
  assert.equal(await sb.pullSettings(), null);
  assert.equal((await sb.pullAllRemoteData()).settings, null);
  sb.__setClientForTests(fakeClient((q) => { if (q.table === "settings") throw new TypeError("Failed to fetch"); return { data: [], error: null }; }));
  assert.equal(await sb.pullSettings(), null);
  assert.equal((await sb.pullAllRemoteData()).settings, null);
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
