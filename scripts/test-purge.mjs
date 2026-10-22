// Tests for src/lib/purge.js and batchLog.js purgeLogsForDeleted — "delete means delete" (owner, 2026-10-21):
// deleting generations removes their files and History everywhere it can reach. Run: node scripts/test-purge.mjs
import assert from "node:assert/strict";
import { storagePathOf, storagePathsToDelete, planPurge, pathsInUse, ownedPaths, publicUrlOf } from "../src/lib/purge.js";
import { purgeLogsForDeleted, mergeLogs } from "../src/lib/batchLog.js";

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

test("History on another device (removeEntries: false): items are dropped; an entry left with none is removed (#8)", () => {
  const logs = [{ id: "b2", tasks: [{ id: "c", status: "completed", cost: 0.02, outputs: ["z"] }], totalCost: 0.02 }];
  const r = purgeLogsForDeleted(logs, [{ id: "c", batchId: "b2" }], [], { removeEntries: false });
  assert.deepEqual(r.remove, ["b2"], "review wf_ec400a67-988 #8: an empty entry used to be kept with 0 items");
  assert.deepEqual(r.rewrite, []);
});

test("entries untouched by the delete are never rewritten", () => {
  const logs = [{ id: "b9", tasks: [{ id: "q", status: "completed", cost: 0.01, outputs: ["q"] }], totalCost: 0.01 }];
  assert.deepEqual(purgeLogsForDeleted(logs, [{ id: "a", batchId: "b1" }], []), { remove: [], rewrite: [] });
});

// ─── Review #5 (2026-10-22): the whole purge is planned once, before any network call (App.jsx stagePurge) ───
test("planPurge with history:false + alsoLogs: the caller's removed entries go, their files with them", () => {
  const L1 = { id: "L1", sourceImageUrl: S + "uploads/u/a.png", tasks: [{ id: "t1", outputs: [S + "u/o1.png"] }] };
  const L2 = { id: "L2", sourceImageUrl: S + "uploads/u/b.png", tasks: [] };
  const p = planPurge([L1, L2], [], [{ id: "t1", outputs: [S + "u/o1.png"] }], { history: false, alsoLogs: [L1] });
  assert.deepEqual(p.paths, ["uploads/u/a.png"]);
  assert.deepEqual(p.goneLogs, [L1]);
  assert.deepEqual(p.keptLogs, [L2]);
});

test("planPurge: a partly kept legacy entry is rewritten, and only the removed item's file goes", () => {
  const logs = [{ id: "B", tasks: [{ outputs: [S + "u/x.png"] }, { outputs: [S + "u/y.png"] }] }];
  const p = planPurge(logs, [{ id: "tx", batchId: "B", outputs: [S + "u/x.png"] }], [{ id: "ty", batchId: "B", outputs: [S + "u/y.png"] }]);
  assert.deepEqual(p.remove, []);
  assert.equal(p.rewrite.length, 1);
  assert.deepEqual(p.rewrite[0].tasks.map(i => i.outputs[0]), [S + "u/y.png"]);
  assert.deepEqual(p.paths, ["u/x.png"]);
});

test("pathsInUse covers form-shaped objects and skips empties", () => {
  const used = pathsInUse([{ sourceImageUrl: S + "uploads/u/form.png", endFrameUrl: S + "uploads/u/end.png" }, null]);
  assert.ok(used.has("uploads/u/form.png") && used.has("uploads/u/end.png"));
});

test("ownedPaths ignores what is being deleted; an entry left with none of its items owns nothing", () => {
  const tasks = [{ id: "t1", outputs: [S + "u/a.png"] }, { id: "t2", outputs: [S + "u/b.png"] }];
  const logs = [{ id: "L", sourceImageUrl: S + "uploads/u/s.png", tasks: [{ id: "t2", outputs: [S + "u/b.png"] }] },
                { id: "M", tasks: [{ id: "t9", outputs: [S + "u/c.png"] }] }];
  assert.deepEqual([...ownedPaths(tasks, logs, { taskIds: new Set(["t2"]), logIds: new Set(["M"]) })], ["u/a.png"]);
});

// ─── Review #4 (2026-10-22): an entry keeps the items whose task this device lacks ───
{
  const L = () => [{ id: "b1", sourceImageUrl: S + "uploads/u/s1.png", totalCost: 0.09, tasks: [
    { id: "t1", status: "completed", cost: 0.04, outputs: [S + "u/o1.png"] },
    { id: "t2", status: "completed", cost: 0.05, outputs: [S + "u/o2.png"] },
    { id: "t3", status: "pending", cost: 0.03, outputs: [] }] }];
  const removed = [{ id: "t1", batchId: "b1", outputs: [S + "u/o1.png"] }, { id: "t2", batchId: "b1", outputs: [S + "u/o2.png"] }];
  const brief = (r) => ({ remove: r.remove, rewrite: r.rewrite.map(l => [l.id, l.tasks.map(i => i.id), l.totalCost]) });

  test("#4: an item whose task is elsewhere (other device, beyond the 500 loaded) keeps its entry", () => {
    assert.deepEqual(brief(purgeLogsForDeleted(L(), removed, [{ id: "x", batchId: "b9" }])), { remove: [], rewrite: [["b1", ["t3"], 0]] });
  });
  test("#4: a fully deleted entry still goes; Clear Outputs (all) removes every hit entry", () => {
    assert.deepEqual(purgeLogsForDeleted(L(), [...removed, { id: "t3", batchId: "b1" }], []).remove, ["b1"]);
    assert.deepEqual(purgeLogsForDeleted(L(), removed, [], { all: true }).remove, ["b1"]);
  });
  test("#4: planPurge keeps the source upload while items are outstanding; all:true takes everything", () => {
    const p = planPurge(L(), [removed[0]], []);
    assert.deepEqual(p.remove, []);
    assert.deepEqual(p.paths, ["u/o1.png"]);
    assert.deepEqual(planPurge(L(), removed, [], { all: true }).paths.sort(), ["u/o1.png", "u/o2.png", "uploads/u/s1.png"]);
  });
}

// Review wf_ec400a67-988 #8: an entry left with no items is removed, even on the sync path (removeEntries: false).
test("#8: an entry whose last item another device deleted is removed, not kept empty", () => {
  const E = [{ id: "E", tasks: [{ id: "a", status: "completed", outputs: [] }] }];
  assert.deepEqual(purgeLogsForDeleted(E, [{ id: "a" }], [], { removeEntries: false }), { remove: ["E"], rewrite: [] });
  const F = [{ id: "F", tasks: [{ id: "a", status: "completed" }, { id: "b", status: "completed" }] }];
  assert.deepEqual(purgeLogsForDeleted(F, [{ id: "a" }], [], { removeEntries: false }).remove, [], "items left: rewritten as before");
});

// Review round 2: Clear Outputs plans over this device's History AND the cloud's (entries beyond the loaded ones), so
// every hit entry goes and its files are no longer kept "in use" by a forgotten cloud copy.
test("Clear Outputs: cloud-only History entries are planned too (mergeLogs; local copies win)", () => {
  const local = [{ id: "L1", tasks: [{ id: "t1", status: "completed", outputs: [S + "u/a.png"] }] }];
  const cloud = [{ id: "L1", tasks: [] }, { id: "C9", sourceImageUrl: S + "uploads/u/old.png", tasks: [{ id: "t9", status: "completed", outputs: [S + "u/z.png"] }] }];
  const merged = mergeLogs(local, cloud);
  assert.deepEqual(merged.map(l => l.id), ["L1", "C9"]);
  assert.equal(merged[0], local[0], "the local copy wins");
  const p = planPurge(merged, [{ id: "t1" }, { id: "t9", outputs: [S + "u/z.png"] }], [], { all: true });
  assert.deepEqual(p.remove.sort(), ["C9", "L1"]);
  assert.ok(p.paths.includes("u/z.png") && p.paths.includes("uploads/u/old.png"));
});

test("publicUrlOf round-trips through storagePathOf", () => {
  const url = publicUrlOf("https://x.supabase.co/", "user_X/arch ive.png");
  assert.equal(url, "https://x.supabase.co/storage/v1/object/public/generations/user_X/arch%20ive.png");
  assert.equal(storagePathOf(url), "user_X/arch ive.png");
  assert.equal(publicUrlOf("", "p"), null);
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
