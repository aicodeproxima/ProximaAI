// Task B15 (review round 28). Runs the real storage.js with a fake IndexedDB that logs when each transaction is CREATED
// (IndexedDB orders transactions on one store by creation, across tabs: a read created after a write sees it); App.jsx
// wiring is checked from the source. Written first: before the change each test below fails.
// #1/#3 (regressions of B14's deferred stash drop) and #5 (round 27 #3 not closed by it): a voided clear's give-back
//    writes IndexedDB in a transaction created synchronously, before its stash is dropped, and the drop is synchronous
//    again (decided at give-back time); the reconcile reads this browser's stash and queue traces BEFORE its IndexedDB
//    read too, so a pass sees a given-back generation in one of the two whatever the order.
// Run: node scripts/test-b15-round28.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const mem = new Map();
globalThis.localStorage = {
  getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)),
  removeItem: k => mem.delete(k), get length() { return mem.size; }, key: i => [...mem.keys()][i] ?? null,
};
const sess = new Map();
globalThis.sessionStorage = { getItem: k => (sess.has(k) ? sess.get(k) : null), setItem: (k, v) => sess.set(k, String(v)), removeItem: k => sess.delete(k) };
// The fake IndexedDB: open succeeds on the next tick; transaction() logs "<store>:<mode>" at creation; puts land in a Map
// and the transaction completes on the next tick.
const txLog = [], data = { tasks: new Map(), history: new Map() };
const fakeDb = {
  objectStoreNames: { contains: () => true },
  transaction(store, mode = "readonly") {
    txLog.push(`${store}:${mode}`);
    const txn = { oncomplete: null, onerror: null, onabort: null };
    txn.objectStore = () => ({
      put: (v) => { data[store].set(v.id, v); const r = {}; setTimeout(() => r.onsuccess?.()); return r; },
      getAll: () => { const r = { result: [...data[store].values()] }; setTimeout(() => r.onsuccess?.()); return r; },
    });
    setTimeout(() => txn.oncomplete?.());
    return txn;
  },
};
globalThis.window = { indexedDB: { open: () => { const r = {}; setTimeout(() => { r.result = fakeDb; r.onsuccess?.(); }); return r; } } };
globalThis.indexedDB = globalThis.window.indexedDB;
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
  try { await fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", String(e?.message || e).split("\n").filter(Boolean).slice(0, 4).join(" | ")); }
};

await test("saveTasksNow / addHistoryEntriesNow create their transaction before they return (database open)", async () => {
  assert.equal(typeof S.saveTasksNow, "function");
  assert.equal(typeof S.addHistoryEntriesNow, "function");
  await S.addHistoryEntry({ id: "warm" });   // opens the database
  txLog.length = 0;
  const p = S.saveTasksNow([{ id: "x" }]);
  assert.deepEqual(txLog, ["tasks:readwrite"], "created synchronously");
  const q = S.addHistoryEntriesNow([{ id: "L" }]);
  assert.deepEqual(txLog, ["tasks:readwrite", "history:readwrite"]);
  await Promise.all([p, q]);
  assert.ok(data.tasks.has("x") && data.history.has("L"), "written");
});

await test("storedKeptIds is exported: the stash and queue traces a pass reads before IndexedDB", () => {
  assert.equal(typeof S.storedKeptIds, "function");
  S.addFailedSync({ kind: "task", id: "q1", data: { id: "q1" } });
  assert.ok(S.storedKeptIds().task.has("q1"));
});

await test("wiring: the give-back writes IndexedDB synchronously and drops its stash at once (B14's deferral is gone)", () => {
  const apply = between("const applyClearStashes = (which, held = {}) =>", "const settleClearStashes = ");
  assert.match(apply, /saveTasksNow\(\[\.\.\.backTasks, \.\.\.shownTasks\]\);/);   // task B16: + the shown copies
  assert.match(apply, /addHistoryEntriesNow\(\[\.\.\.backLogs, \.\.\.shownLogs\]\);/);
  assert.match(apply, /applyRelinks\(\[\.\.\.heldTasks\.values\(\), \.\.\.backTasks\]\);[^\n]*\n(\s*\/\/[^\n]*\n)*\s*dropGivenBackStash\(s\);/);
  assert.ok(!/givingBackRef|Promise\.allSettled\(writes\)/.test(src), "no deferred drop, no skip set");
});

await test("wiring: the reconcile reads the stash and queue traces before IndexedDB and keeps them (tombstoned ids aside)", () => {
  const rec = between("const reconcileWithCloud = useCallback(", "}, []);\n\n  useEffect(");
  const early = rec.indexOf("const earlyKept = hasHeldPurges() ? storedKeptIds() : null;");
  assert.ok(early > 0 && early < rec.indexOf("const shared = hasHeldPurges() ? await storedEvidenceIds() : null;"), "read first");
  assert.match(rec, /if \(earlyKept\) \{\s*for \(const id of earlyKept\.task\) if \(!tombT\.has\(id\)\) keptTaskIds\.add\(id\);\s*for \(const id of earlyKept\.history\) if \(!tombH\.has\(id\)\) keptLogIds\.add\(id\);\s*\}/);
});

// #4 (Medium) / #2: a History upload that names a generation whose own row is still queued is sent only after a confirmed
//    form-inputs:<browser>:unsent publication names it (a phone frozen right after Generate: its entry reached the cloud,
//    its row did not, and another device deleted the WaveSpeed result of a generation that then landed). The publication
//    also goes out on pagehide and when the page is hidden (Android freezes hidden tabs).
await test("#4: unsentRowsIn names the items whose task row is still queued (not the queued entry itself)", () => {
  assert.equal(typeof S.unsentRowsIn, "function");
  mem.clear();
  S.addFailedSync({ kind: "task", id: "x", data: { id: "x", taskId: "p-x" } });
  S.addFailedSync({ kind: "history", id: "L", data: { id: "L", tasks: [{ id: "x" }, { id: "y" }] } });
  assert.deepEqual(S.unsentRowsIn([{ id: "L", tasks: [{ id: "x" }, { id: "y" }] }]), ["x"]);
  assert.deepEqual(S.unsentRowsIn([{ id: "M", tasks: [{ id: "y" }] }]), [], "y's row was sent: nothing to publish first");
});
await test("#4 wiring: both History senders publish the unsent rows first when an entry needs it, and stop if that fails", () => {
  const send = between("async function sendHistory(entries) {", "// A delete's restore-checked History rewrites");
  // Only when an entry needs it (no await otherwise), and the entries are filtered AGAIN after that write: a delete
  // confirmed while it was on the wire (another tab of this browser) is never uploaded (simulator I3, seed 164).
  assert.equal((send.match(/if \(send\.length && unsentRowsIn\(send\)\.length\) \{(\s*\/\/[^\n]*)?\s*await publishUnsentBefore\(send\);\s*send = uploadable\("history", withoutBlockedItems\(send(, opts)?\)\);/g) || []).length, 2);
  assert.equal((send.match(/if \(send\.length\) await rawSync(History(Batch|Entry))\(/g) || []).length, 2);
  const fn = between("async function publishUnsentBefore(entries) {", "\n}\n");
  assert.match(fn, /if \(unsentRowsIn\(entries\)\.length && !\(await publishUnsent\(\)\)\) throw new Error\(/);
});
await test("#2 wiring: one publishUnsent for the timer, pagehide and the hidden page; no per-component copy", () => {
  const eff = between("// This tab's Generate form inputs, published for every tab's file flush", "const mediaDuration = url =>");
  assert.match(eff, /publishUnsent\(\);/);
  assert.match(eff, /publishUnsent\(\{ exiting: true \}\);/);
  assert.match(eff, /document\.visibilityState === "hidden"\) publishUnsent\(\);/);
  assert.ok(!/cloudUnsentPubRef/.test(src), "the component ref is gone (module-level state: the senders share it)");
});

console.log(`\n${n} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);   // storage.js keeps a BroadcastChannel open when window is defined
