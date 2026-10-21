// Tests for src/lib/purge.js and batchLog.js purgeLogsForDeleted — "delete means delete" (owner, 2026-10-21):
// deleting generations removes their files and History everywhere it can reach. Run: node scripts/test-purge.mjs
import assert from "node:assert/strict";
import { storagePathOf, storagePathsToDelete } from "../src/lib/purge.js";
import { purgeLogsForDeleted } from "../src/lib/batchLog.js";

const S = "https://vhznmpxlcjbdzntmfvvy.supabase.co/storage/v1/object/public/generations/";
let n = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", e.message.split("\n").filter(Boolean).slice(0, 4).join(" | ")); }
};

test("only our own storage URLs map to a path; WaveSpeed's and others don't", () => {
  assert.equal(storagePathOf(S + "uploads/user_X/a.png"), "uploads/user_X/a.png");
  assert.equal(storagePathOf(S + "user_X/arch%20ive.png?t=1"), "user_X/arch ive.png");
  assert.equal(storagePathOf("https://d1q70pf5vjeyhc.cloudfront.net/predictions/x/a.png"), null);
  assert.equal(storagePathOf(""), null);
  assert.equal(storagePathOf(undefined), null);
});

test("a delete removes its uploads and archives, but never a file a kept generation or History entry still uses", () => {
  const removed = [
    { id: "t1", sourceImageUrl: S + "uploads/u/src1.png", sourceImageUrls: [S + "uploads/u/src1.png", S + "uploads/u/src2.png"], outputs: [S + "u/out1.png"], archivedPaths: ["u/out1.png"] },
    { id: "t2", endFrameUrl: S + "uploads/u/end.png", sourceAudioUrl: S + "uploads/u/voice.mp3", outputs: ["https://cdn.example/x.png"] },
  ];
  const kept = [{ id: "t3", sourceImageUrl: S + "uploads/u/src2.png", outputs: [] }];
  const keptLogs = [{ id: "L9", sourceVideoUrl: S + "uploads/u/voice.mp3", tasks: [] }];
  assert.deepEqual(storagePathsToDelete(removed, kept, keptLogs).sort(), ["u/out1.png", "uploads/u/end.png", "uploads/u/src1.png"]);
});

test("History: an entry whose generations are all deleted goes; a mixed one loses only the deleted items", () => {
  const logs = [
    { id: "b1", tasks: [{ id: "a", status: "completed", cost: 0.04, outputs: ["x"] }, { id: "b", status: "completed", cost: 0.05, outputs: ["y"] }], totalCost: 0.09 },
    { id: "b2", tasks: [{ id: "c", status: "completed", cost: 0.02, outputs: ["z"] }], totalCost: 0.02 },
    { id: "b3", tasks: [{ id: "d", status: "completed", cost: 0.01, outputs: ["w"] }], totalCost: 0.01 },
  ];
  const removed = [{ id: "a", batchId: "b1" }, { id: "c", batchId: "b2" }];
  const kept = [{ id: "b", batchId: "b1" }, { id: "d", batchId: "b3" }];
  const r = purgeLogsForDeleted(logs, removed, kept);
  assert.deepEqual(r.remove, ["b2"]);
  assert.deepEqual(r.rewrite.map(l => [l.id, l.tasks.map(i => i.id), l.totalCost]), [["b1", ["b"], 0.05]]);
});

test("History: entries from before items carried ids are matched by batch, and by outputs when partly kept", () => {
  const legacy = [
    { id: "old1", tasks: [{ model: "M", status: "completed", cost: 0.04, outputs: ["https://cdn/o1.png"] }], totalCost: 0.04 },
    { id: "old2", tasks: [{ model: "M", status: "completed", cost: 0.04, outputs: ["https://cdn/o2.png"] }, { model: "N", status: "completed", cost: 0.03, outputs: ["https://cdn/o3.png"] }], totalCost: 0.07 },
  ];
  const removed = [{ id: "t1", batchId: "old1", outputs: ["https://cdn/o1.png"] }, { id: "t2", batchId: "old2", outputs: ["https://cdn/o2.png"] }];
  const kept = [{ id: "t3", batchId: "old2", outputs: ["https://cdn/o3.png"] }];
  const r = purgeLogsForDeleted(legacy, removed, kept);
  assert.deepEqual(r.remove, ["old1"]);
  assert.deepEqual(r.rewrite.map(l => [l.id, l.tasks.map(i => i.outputs[0]), l.totalCost]), [["old2", ["https://cdn/o3.png"], 0.03]]);
});

test("History on another device (removeEntries: false): items are dropped, whole entries are left to the deleting device", () => {
  const logs = [{ id: "b2", tasks: [{ id: "c", status: "completed", cost: 0.02, outputs: ["z"] }], totalCost: 0.02 }];
  const r = purgeLogsForDeleted(logs, [{ id: "c", batchId: "b2" }], [], { removeEntries: false });
  assert.deepEqual(r.remove, []);
  assert.deepEqual(r.rewrite.map(l => l.tasks.length), [0]);
});

test("entries untouched by the delete are never rewritten", () => {
  const logs = [{ id: "b9", tasks: [{ id: "q", status: "completed", cost: 0.01, outputs: ["q"] }], totalCost: 0.01 }];
  assert.deepEqual(purgeLogsForDeleted(logs, [{ id: "a", batchId: "b1" }], []), { remove: [], rewrite: [] });
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
