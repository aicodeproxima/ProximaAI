// Tests for src/lib/wsDelete.js — deleting a generation in the app also deletes it on WaveSpeed.
// Run: node scripts/test-ws-delete.mjs
import assert from "node:assert/strict";
import { queueDeletes, dueDeletes, settleDeletes, failDeletes, WS_DELETE_CHUNK, RUNNING_RETRY_MS, MAX_RUNNING_ATTEMPTS } from "../src/lib/wsDelete.js";
import { forwardParams } from "../src/lib/wsWebhook.js";

const NOW = 1_800_000_000_000;
let n = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", e.message.split("\n").filter(Boolean).slice(0, 4).join(" | ")); }
};

test("deleted generations are queued by prediction id, running ones marked; tasks without an id are skipped", () => {
  const q = queueDeletes({}, [{ taskId: "p1", status: "completed" }, { taskId: "p2", status: "processing" }, { status: "failed" }, { taskId: "p1", status: "completed" }], NOW);
  assert.deepEqual(Object.keys(q).sort(), ["p1", "p2"]);
  assert.deepEqual([q.p1.running, q.p2.running, q.p1.next], [false, true, NOW]);
});

test("due ids come in chunks the endpoint accepts, never one that is waiting", () => {
  const tasks = Array.from({ length: WS_DELETE_CHUNK + 7 }, (_, i) => ({ taskId: `p${i}`, status: "completed" }));
  let q = queueDeletes({}, tasks, NOW);
  q = { ...q, later: { at: NOW, attempts: 1, next: NOW + 60_000, running: false } };
  const chunks = dueDeletes(q, NOW);
  assert.deepEqual(chunks.map(c => c.length), [WS_DELETE_CHUNK, 7]);
  assert.ok(!chunks.flat().includes("later"));
});

// WaveSpeed answers data.deleted_ids with only what it deleted now; running, unknown, foreign and already-deleted ids are
// skipped silently. A finished one that was skipped cannot become deletable later, so it is done; a running one is
// retried once it can have finished, a few times at most.
test("settling an answer: deleted and skipped-finished are done; skipped-running retries later", () => {
  const q = queueDeletes({}, [{ taskId: "a", status: "completed" }, { taskId: "b", status: "completed" }, { taskId: "r", status: "processing" }], NOW);
  const after = settleDeletes(q, ["a", "b", "r"], ["a"], NOW);
  assert.deepEqual(Object.keys(after), ["r"]);
  assert.deepEqual([after.r.attempts, after.r.next], [1, NOW + RUNNING_RETRY_MS]);
  let last = after;
  for (let i = 1; i < MAX_RUNNING_ATTEMPTS; i++) last = settleDeletes(last, ["r"], [], NOW);
  assert.deepEqual(last, {}, "given up after the last attempt");
});

test("a failed request: transient errors back off and keep, a rejected key waits, a refusal drops", () => {
  const q = queueDeletes({}, [{ taskId: "a", status: "completed" }], NOW);
  const net = failDeletes(q, ["a"], new TypeError("Failed to fetch"), NOW);
  assert.equal(net.a.attempts, 1);
  assert.ok(net.a.next > NOW && net.a.next <= NOW + 30 * 60_000);
  const key = failDeletes(q, ["a"], { code: 401 }, NOW);
  assert.equal(key.a.attempts, 0, "a rejected key is not the request's fault");
  assert.ok(key.a.next > NOW);
  assert.deepEqual(failDeletes(q, ["a"], { code: 400, message: "Invalid request" }, NOW), {});
});

test("the proxy forwards the delete call as is (not a model submit: no result webhook added)", () => {
  const qs = forwardParams(new URLSearchParams(), { method: "POST", path: "api/v3/predictions/delete", body: JSON.stringify({ ids: ["a"] }), webhookOn: true });
  assert.equal(qs.toString(), "");
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
