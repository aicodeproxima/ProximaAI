// Owner ruling 2026-10-23 (simulator I7-info): when a restore CANCELS a delete and the generation does not come back, its
// stored files and WaveSpeed result are deleted (CLAUDE.md "kept if the generation came back, deleted if it did not").
// Before, the cancelled delete's put-back (keepGivenBack) cancelled the holds at once, so a generation the restore removed
// anyway kept its files forever. Now the put-back leaves the holds waiting and the next pass that read the cloud after
// that restore decides them; a copy stored in IndexedDB of an id the cloud tombstones (user or restore) is a leftover the
// next load removes, not evidence that the generation lives.
// Runs the real storage.js and purge.js; App.jsx wiring is checked from the source. Written first: before the change the
// wiring tests fail (keepGivenBack still cancels; the shared copies are taken whole).
// Run: node scripts/test-b13d-restore-ruling.mjs
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
const P = await import("../src/lib/purge.js");
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
const gen = (id) => ({ id, taskId: `pred-${id}`, status: "completed", startTime: Date.now() - 600_000, sourceImageUrl: `${BASE}uploads/scope/${id}-src.png`, outputs: [`${BASE}scope/${id}-out.png`] });
const filesQueued = () => Object.keys(S.readFileDeletes()).sort();
const wsQueued = () => Object.keys(S.readWsDeletes()).sort();
const held = () => JSON.parse(mem.get("proximaai-held-purges-v3") || "{}");
const heldPaths = () => Object.values(held()).flatMap(g => Object.keys(g.files || {})).sort();
// A delete of `x` reserved at T (its files and WaveSpeed result held), then cancelled by a restore.
const deleteThenVoid = (x, T) => {
  const st = P.planDeleteStage([], [x], [], { history: false, holdAt: T });
  assert.ok(S.reserveDelete({ intents: [{ kind: "task-delete", ids: [x.id], at: T }], holdAt: T, hold: st.hold }));
  S.voidDeleteIntents("task-delete", [x.id], T);
  assert.ok(S.knownRestoreAt() > T, "premise: the void makes the restore known");
};
const evidence = ({ present = [], local = [] } = {}) => ({ restoreKnownAt: S.knownRestoreAt(),
  task: { present, local: new Set(local), complete: true }, history: { present: [], local: new Set(), complete: true } });

await test("the put-back changes nothing held: a flush without the cloud's evidence leaves everything waiting", () => {
  const T = Date.now() - 60_000, x = gen("x");
  deleteThenVoid(x, T);
  S.releaseHeldPurges(Date.now());   // what every flush runs
  assert.deepEqual([filesQueued(), wsQueued(), heldPaths()], [[], [], ["scope/x-out.png", "uploads/scope/x-src.png"]]);
});

await test("the restore removed it (absent from the cloud and every copy): files and WaveSpeed result go", () => {
  const T = Date.now() - 60_000, x = gen("x");
  deleteThenVoid(x, T);
  S.releaseHeldPurges(Date.now(), evidence());
  assert.deepEqual([filesQueued(), wsQueued(), heldPaths()], [["scope/x-out.png", "uploads/scope/x-src.png"], ["pred-x"], []]);
});

await test("the restore kept it (its row in the cloud) or this browser still holds it: nothing of it is deleted", () => {
  const T = Date.now() - 60_000;
  deleteThenVoid(gen("x"), T);
  S.releaseHeldPurges(Date.now(), evidence({ present: ["x"] }));
  assert.deepEqual([filesQueued(), wsQueued(), heldPaths()], [[], [], []]);
  mem.clear();
  deleteThenVoid(gen("y"), T);
  S.releaseHeldPurges(Date.now(), evidence({ local: ["y"] }));   // given back and kept here (local-only)
  assert.deepEqual([filesQueued(), wsQueued(), heldPaths()], [[], [], []]);
});

await test("storage: the `alive` option of releaseHeldPurges is gone (no caller decides a hold without the cloud)", () => {
  assert.ok(!/opts\?\.alive|alive: opts/.test(readFileSync(new URL("../src/lib/storage.js", import.meta.url), "utf8")));
});

await test("wiring: no put-back cancels holds any more (keepGivenBack removed; every void site still relinks)", () => {
  assert.ok(!/const keepGivenBack|keepGivenBack\s*\(/.test(src), "keepGivenBack is gone (no definition, no call)");
  assert.ok(!/releaseHeldPurges\([^)]*alive/.test(src), "no release with an alive set");
  const apply = between("const applyClearStashes = (which, held = {}) =>", "const settleClearStashes = ");
  // Task B14 (review round 27 #3) rewrote the anchor: the stash is dropped after the give-back's IndexedDB writes.
  // Task B15 (review round 28 #1/#3) restored the synchronous drop (rewritten anchor).
  assert.match(apply, /applyRelinks\(\[\.\.\.heldTasks\.values\(\), \.\.\.backTasks\]\);[^\n]*\n\s*dropGivenBackStash\(s\);/);
});

await test("wiring: a shared IndexedDB copy of an id the cloud tombstones (or this pass removes) is not evidence", () => {
  const rec = between("const reconcileWithCloud = useCallback(", "}, []);\n\n  useEffect(");
  assert.match(rec, /const tombT = ids\.taskTombstones instanceof Set \? ids\.taskTombstones : new Set\(\), tombH = ids\.historyTombstones instanceof Set \? ids\.historyTombstones : new Set\(\);/);
  assert.match(rec, /if \(shared\) \{\s*for \(const id of shared\.task\) if \(!tombT\.has\(id\) && !rmTasks\.has\(id\)\) keptTaskIds\.add\(id\);\s*for \(const id of shared\.history\) if \(!tombH\.has\(id\) && !rmLogs\.has\(id\)\) keptLogIds\.add\(id\);\s*\}/);
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
