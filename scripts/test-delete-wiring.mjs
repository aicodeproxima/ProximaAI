// Structural checks of the delete wiring in src/App.jsx that its unit-tested helpers cannot see (review round 9). The
// handlers need React, IndexedDB and the network, so these read the source: each check names the defect it guards.
// Run: node scripts/test-delete-wiring.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const between = (from, to) => {
  const i = src.indexOf(from);
  assert.ok(i >= 0, `missing: ${from}`);
  const j = src.indexOf(to, i + from.length);
  assert.ok(j > i, `missing after ${from}: ${to}`);
  return src.slice(i, j);
};

let n = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", e.message.split("\n")[0]); }
};

const stage = () => between("const stagePurge = useCallback(", "const purgeEverywhere = useCallback(");
const outputs = () => between('createBackup("pre-clear-outputs"', ">Clear Outputs</button>");
const reset = () => between('createBackup("pre-reset"', ">Reset Everything</button>");
const purge = () => between("const purgeEverywhere = useCallback(", "}, [flushWsDeletes");

test("stagePurge removes every History entry it drops locally from IndexedDB, not only the ones it sends", () => {
  assert.match(stage(), /deleteHistoryEntries\(plan\.remove\)/);
  assert.doesNotMatch(purge(), /deleteHistoryEntries\(/, "the sent subset is no longer the IndexedDB delete");
});
test("stagePurge trims the queued upload of a rewrite it leaves to the server", () => {
  assert.match(stage(), /replaceQueuedUpload\("history", l\.id, l\)/);
});
test("a delete's History rewrites are queued with its queue time and sent restore-checked", () => {
  assert.match(stage(), /queuedAt: historyQueuedAt/);
  assert.match(purge(), /sendHistoryRewrites\(/);
  assert.match(between("const sendHistoryRewrites = useCallback(", "}, []);"), /upsertQueuedHistory\(entries, queuedAt\)/);
  assert.doesNotMatch(purge(), /persistLog\(/, "no plain upsert of a delete's rewrite");
});
test("queued History uploads replay through one helper (restore-checked rewrites, deleting items left out)", () => {
  const helper = between("const replayHistoryUploads = async", "\n  };");
  assert.match(helper, /upsertQueuedHistory\(/);
  assert.match(helper, /withoutDeleting\(/);
  assert.equal(src.match(/await replayHistoryUploads\(/g)?.length, 2, "forceSaveAll and the mount replay");
  assert.doesNotMatch(src, /syncHistoryEntry\(f\.data\)|historyRetries/, "the old direct replays are gone");
});
test("the reconcile pass never uploads a History item this device is deleting", () => {
  assert.match(between("const logUploads =", "setFailedSyncCount"), /withoutDeleting\(/);
});
test("every voided delete puts its claimant records back (bulk delete, Clear Outputs, Reset)", () => {
  assert.equal(src.match(/putBackClaimants\(/g)?.length, 3);
  assert.equal(src.match(/claimantRecords\(/g)?.length, 3);
  assert.doesNotMatch(src, /resolveClaimants\(voided\)/);
});
// Review round 10 (F6): Reset's four restore-checked calls could be half-voided; it is one reset_queued_rows call now.
test("Reset clears History, generations, settings and favorites in ONE restore-checked call at its snapshot time", () => {
  const h = reset();
  assert.match(h, /await resetQueuedRemote\(resetAt, clearedTaskIds, clearedLogIds\)/);
  assert.doesNotMatch(src, /clearQueuedRemote\([^)]*resetAt/, "no separate clears at the reset's time");
  assert.doesNotMatch(src, /clearSettingsRemote|clearFavoritesRemote|deleteTaskRemote\b/);
  assert.match(h, /queueDeleteIntents\("task-delete", clearedTaskIds, resetAt\)/);
  assert.match(h, /queueDeleteIntents\("history-delete", clearedLogIds, resetAt\)/);
});
test("clears name the ids their device knew (Clear Outputs: rows only; the server tombstones History-only ones)", () => {
  assert.match(outputs(), /clearQueuedRemote\("task", queuedAt, rowIds\)/);
  assert.match(src, /clearQueuedRemote\("history", queuedAt, clearedLogIds\)/, "Clear Logs");
  assert.match(outputs(), /settleCloudClear\(\{ tasks: rowIds \}\)/);
});
// Review round 10 (F5): a bound taken after the purge read deleted rows uploaded during the read without purging them.
test("Clear Outputs and Reset take their snapshot time BEFORE their purge read, and skip History created after it", () => {
  for (const [name, h, v] of [["Clear Outputs", outputs(), "clearAt"], ["Reset", reset(), "resetAt"]]) {
    const snap = h.indexOf(`const ${v} = serverNow() - CLOCK_MARGIN_MS`), read = h.indexOf("await pullAllForPurge()");
    assert.ok(snap >= 0 && read > snap, `${name}: snapshot before the read`);
    assert.match(h, new RegExp(`createdAt[^;]*> ${v}`), `${name}: later History skipped`);
  }
  assert.match(outputs(), /stagePurge\([^;]*at: clearAt/);
  assert.match(outputs(), /queueDeleteIntents\("task-delete", clearedTaskIds, clearAt\)/);
  assert.match(stage(), /queueDeleteIntents\("history-delete", send\.remove, at\)/);
});
// Review round 10 (F2): a confirmed delete kept in deletingIds stripped a generation a later restore brought back.
test("History uploads leave out only generations whose delete is still in flight", () => {
  assert.equal(src.match(/withoutDeleting\([^;]*pendingDeleteIds\("task-delete"\)\)/g)?.length, 2);
  assert.doesNotMatch(src, /withoutDeleting\([^;]*deletingIds\.current/);
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
