// Tests for the failed-sync queue in src/lib/storage.js (localStorage). Run: node scripts/test-failed-sync.mjs
import assert from "node:assert/strict";

const mem = new Map();
globalThis.localStorage = { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) };
const { addFailedSync, removeFailedSync, getFailedSyncs, sentVersion } = await import("../src/lib/storage.js");

let n = 0, failed = 0;
const test = (name, fn) => {
  try { mem.clear(); fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", e.message.split("\n").filter(Boolean).slice(0, 4).join(" | ")); }
};

// Review wf_d4a468a3-746 #7: a replay or upload that resolves after a newer version of the same row replaced its queue
// entry (the queue dedupes by kind+id) used to clear that newer version, so if its own upload then failed nothing
// was left to retry it.
test("a confirmed upload clears only the exact version it sent", () => {
  const open = { id: "b", tasks: [{ id: "a", status: "pending" }] };
  const done = { id: "b", tasks: [{ id: "a", status: "completed" }] };
  addFailedSync({ kind: "history", id: "b", data: open });
  addFailedSync({ kind: "history", id: "b", data: done });   // replaces it
  removeFailedSync("history", "b", sentVersion(open));        // the open upload resolves late
  assert.deepEqual(getFailedSyncs().map(e => e.data), [done], "the finished version stays queued");
  removeFailedSync("history", "b", sentVersion(done));
  assert.deepEqual(getFailedSyncs(), []);
});

test("without a version check (deletes), the entry is cleared whatever it holds", () => {
  addFailedSync({ kind: "task", id: "t", data: { id: "t", status: "completed" } });
  removeFailedSync("task", "t");
  assert.deepEqual(getFailedSyncs(), []);
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
