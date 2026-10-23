// Task B16 (review round 29). Runs the real storage.js; App.jsx wiring is checked from the source. Written first: before
// the change each test below fails.
// #1 publishUnsent writes are serialized: each computes its set after the previous write settled, so the module state
//    (unsentPub) always names what the server applied last (an older set could land last and erase a newer one).
// #2 a voided clear's give-back writes EVERY generation and entry it keeps to IndexedDB before dropping its stash, this
//    tab's newer copy for the ones its state still shows (before, only the ones missing from this tab's state, so another
//    tab's pass saw the kept generation nowhere once the stash was gone).
// #3/#4 a row a pending clear took into its stash still counts as not uploaded: it is published in
//    form-inputs:<browser>:unsent (paths, ids, prediction ids) and gates the History senders (a restore that voids the
//    clear puts it back in the queue and it uploads).
// Run: node scripts/test-b16-round29.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const mem = new Map();
globalThis.localStorage = {
  getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)),
  removeItem: k => mem.delete(k), get length() { return mem.size; }, key: i => [...mem.keys()][i] ?? null,
};
const sess = new Map();
globalThis.sessionStorage = { getItem: k => (sess.has(k) ? sess.get(k) : null), setItem: (k, v) => sess.set(k, String(v)), removeItem: k => sess.delete(k) };
const S = await import("../src/lib/storage.js");
const src = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const between = (from, to) => {
  const i = src.indexOf(from);
  assert.ok(i >= 0, `missing: ${from}`);
  const j = src.indexOf(to, i + from.length);
  assert.ok(j > i, `missing after ${from}: ${to}`);
  return src.slice(i, j);
};

let n = 0, failed = 0;
const test = async (name, fn) => {
  try { mem.clear(); await fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", String(e?.message || e).split("\n").filter(Boolean).slice(0, 4).join(" | ")); }
};
const BASE = "https://x.supabase.co/storage/v1/object/public/generations/";

// A clear queued at T that took X's queued row upload (and an entry naming X) into its stash.
const stashX = () => {
  const T = Date.now() - 60_000;
  assert.ok(S.writeClearStash(T, S.buildClearStash({
    uploads: [{ kind: "task", id: "x", data: { id: "x", taskId: "pred-x", sourceImageUrl: `${BASE}uploads/s/in.png` } },
              { kind: "history", id: "L", data: { id: "L", tasks: [{ id: "y", taskId: "pred-y" }] } }],
    tasks: [], logs: [] })));
};

await test("#3/#4: unsentGenerations names the rows and entries a pending clear's stash holds", () => {
  stashX();
  const u = S.unsentGenerations();
  assert.deepEqual([u.ids.sort(), u.predictions.sort(), u.paths], [["x", "y"], ["pred-x", "pred-y"], ["uploads/s/in.png"]]);
  assert.ok(S.unsentUploadPaths().has("uploads/s/in.png"), "and the paths this browser's own flush holds");
});

await test("#3/#4: the History gate counts a row held in a stash as not uploaded", () => {
  stashX();
  assert.deepEqual(S.unsentRowsIn([{ id: "M", tasks: [{ id: "x" }] }]), ["x"]);
});

await test("#1 wiring: publishUnsent chains its writes (one at a time, each computing its set after the previous settled)", () => {
  const pub = between("let unsentPub = null", "async function publishUnsentBefore(entries) {");
  assert.match(pub, /let unsentChain = Promise\.resolve\(\);/);
  assert.match(pub, /function publishUnsent\(opts = \{\}\) \{\s*if \(opts\.exiting\) return publishUnsentOnce\(opts\);[^\n]*\n\s*const p = unsentChain\.then\(\(\) => publishUnsentOnce\(opts\)\);\s*unsentChain = p\.catch\(\(\) => \{\}\);\s*return p;\s*\}/);
  assert.match(pub, /async function publishUnsentOnce\(\{ exiting = false \} = \{\}\) \{/);
});

await test("#2 wiring: the give-back writes the kept generations this tab already shows too (its own copy), before the drop", () => {
  const apply = between("const applyClearStashes = (which, held = {}) =>", "const settleClearStashes = ");
  assert.match(apply, /const shownTasks = tasks\.filter\(t => haveTasks\.has\(t\.id\) && !heldTasks\.has\(t\.id\)\)\.map\(t => tasksRef\.current\.find\(x => x\.id === t\.id\) \|\| t\);/);
  assert.match(apply, /const shownLogs = logs\.filter\(l => haveLogs\.has\(l\.id\) && !heldLogs\.has\(l\.id\)\)\.map\(l => logsRef\.current\.find\(x => x\.id === l\.id\) \|\| l\);/);
  assert.match(apply, /saveTasksNow\(\[\.\.\.backTasks, \.\.\.shownTasks\]\);/);
  assert.match(apply, /addHistoryEntriesNow\(\[\.\.\.backLogs, \.\.\.shownLogs\]\);/);
  assert.ok(apply.indexOf("saveTasksNow([...backTasks, ...shownTasks]);") < apply.indexOf("dropGivenBackStash(s);"), "before the drop");
});

// K2 client side (migration 20261024100000): the server strips from a History upload an item whose generation a restore
// removed when its stored entry lacks it. This tab's copy of such an entry drops that item too (else the two differ for
// good: simulator I4 under --server v3); an item the cloud's copy holds (a restore's History-only comeback) stays.
const B = await import("../src/lib/batchLog.js");
await test("K2: restoreStrippedLogs drops restore-removed items the cloud's copy lacks, keeps the rest, recomputes the total", () => {
  assert.equal(typeof B.restoreStrippedLogs, "function");
  const local = [{ id: "L5", tasks: [{ id: "t6", status: "completed", cost: 1 }, { id: "t7", status: "completed", cost: 2 }], totalCost: 3 },
                 { id: "L6", tasks: [{ id: "t8", status: "completed", cost: 4 }], totalCost: 4 }];
  const cloud = [{ id: "L5", tasks: [{ id: "t6" }] }, { id: "L6", tasks: [{ id: "t8" }] }];
  const out = B.restoreStrippedLogs(local, cloud, new Set(["t7", "t8"]));
  assert.deepEqual(out.map(l => [l.id, l.tasks.map(i => i.id), l.totalCost]), [["L5", ["t6"], 1]], "t8 stays: the cloud's L6 holds it");
  assert.deepEqual(B.restoreStrippedLogs(local, [], new Set(["t7"])), [], "an entry the cloud lacks: not decided here");
  assert.deepEqual(B.restoreStrippedLogs(local, cloud, null), [], "restore removals unread: nothing");
});
await test("K2 wiring: the reconcile applies it once the cloud's History and the tombstones were read", () => {
  const rec = between("const reconcileWithCloud = useCallback(", "}, []);\n\n  useEffect(");
  assert.match(rec, /const stripped = remote\.historyOk \? restoreStrippedLogs\(logsRef\.current, remote\.history \|\| \[\], ids\?\.taskRestoreRemoved \?\? null\) : \[\];/);
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
