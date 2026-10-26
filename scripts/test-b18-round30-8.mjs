// Task B18 (review round 30 #8): the K2 strip (batchLog.js restoreStrippedLogs, task B16) compares this pass's History read
// with its tombstone read. Both run in parallel; a restore that commits between them shows its removals in the tombstones
// while History is from before it, so the strip dropped an item the restore brought back History-only, for good (no later
// pass brings it back, and the next ordinary write of that entry removes it everywhere). The pass now re-reads the restore
// marker before stripping and skips the strip when it moved (the next pass reads History after that restore). Written
// first: before the change both tests fail. Run: node scripts/test-b18-round30-8.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const sb = readFileSync(new URL("../src/lib/supabase.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
// B18 verification round 2 (tests #4): the shapes that matter are matched with comments stripped (block comments, then line
// comments not preceded by ':' or a quote, so URLs stay), so a commented-out line cannot satisfy them.
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'\\])\/\/[^\n]*/gm, "$1");
const recCode = (() => {
  const i = code.indexOf("const reconcileWithCloud = useCallback("), j = code.indexOf("}, []);\n", i);
  assert.ok(i >= 0 && j > i, "reconcileWithCloud found in the comment-stripped source");
  return code.slice(i, j);
})();
let n = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", String(e?.message || e).split("\n").slice(0, 3).join(" | ")); }
};

await test("supabase.js pullRestoreAt reads only the marker and answers null when unreadable", () => {
  const fn = sb.slice(sb.indexOf("export async function pullRestoreAt()"), sb.indexOf("\n}\n", sb.indexOf("export async function pullRestoreAt()")));
  assert.ok(fn.length > 0, "pullRestoreAt exists");
  assert.match(fn, /\.eq\("key", "last_restore_at"\)/);
  assert.match(fn, /return null;/);
});

// B18 verification round 3 (tests #3/#4): every App.jsx shape below is read from the comment-stripped source, so a
// commented-out "was:" line next to a weakened one cannot satisfy it; and the writes that matter are counted.
const bootCode = (() => {
  const i = code.indexOf("bootstrapInProgress.current = true;"), j = code.indexOf("const pendingFavoriteWrite = getFailedSyncs()", i);
  assert.ok(i >= 0 && j > i, "bootstrap found in the comment-stripped source");
  return code.slice(i, j);
})();
const effCode = (() => {
  const k = code.indexOf("const done = finishLogs(logs, tasks, Date.now())");
  assert.ok(k > 0, "the finishLogs effect");
  return code.slice(code.lastIndexOf("useEffect(() => {", k), code.indexOf("\n  }, [", k) + 80);
})();
const count = (s, needle) => s.split(needle).length - 1;

await test("the reconcile pass strips only when the marker read after both reads equals the one it read with settings", () => {
  assert.match(recCode, /const stripCandidates = remote\.historyOk \? restoreStrippedLogs\(logsRef\.current, remote\.history \|\| \[\], ids\?\.taskRestoreRemoved \?\? null\) : \[\];/);
  // B18 review (b18 #1): and only for a marker known before the reads (scripts/test-b18-restore-reads-sim.mjs)
  assert.match(recCode, /const markerSame = !stripCandidates\.length \|\| \(guard\.restoreAt <= restoreKnownAt && \(await pullRestoreAt\(\)\) === guard\.restoreAt\);/);
  assert.match(recCode, /const stripped = markerSame && stripCandidates\.length\s*\? restoreStrippedLogs\(logsRef\.current, remote\.history \|\| \[\], ids\?\.taskRestoreRemoved \?\? null\) : \[\];/);
});

// B18 review (b18 #1): a restore newer than what was known before the reads waits for the next pass, at startup too.
await test("wiring: a pass and the startup load wait while the restore is newer than what was known before the reads", () => {
  assert.match(recCode, /const restoreAfterReads = guard\.fresh && guard\.restoreAt > restoreKnownAt;/);
  // B18 verification round 2 (correctness #1, tests #4): finishLogs waits for the whole of a fresh pass (the gate opens
  // only once the restore is handled), and a pass that waits returns after scheduling its re-run (block shape)
  assert.match(recCode, /restorePendingRef\.current = guard\.fresh;\s*if \(guard\.fresh && \(!remote\.historyOk \|\| !ids \|\| restoreAfterReads\)\) \{\s*if \(restoreAfterReads && remote\.historyOk && ids\) setTimeout\(\(\) => reconcileWithCloud\(\), 1000\);\s*return;\s*\}/);
  const known = recCode.indexOf("const restoreKnownAt = knownRestoreAt();");
  assert.ok(known >= 0 && known < recCode.indexOf("pullAllRemoteData()"), "known before the reads");
  assert.equal(count(recCode, "knownRestoreAt()"), 2, "read once before the reads (and once by the F1 step)");
  const at = bootCode.indexOf("const restoreKnownAt = knownRestoreAt();");
  assert.ok(at >= 0 && at < bootCode.indexOf("await pullAllRemoteData()"), "startup: known before the reads");
  assert.equal(count(bootCode, "knownRestoreAt()"), 1, "startup: read once");
  assert.match(bootCode, /const restoreReady = guard\.fresh && remote\.historyOk && guard\.restoreAt <= restoreKnownAt;/);
  assert.equal(count(bootCode, "restorePendingRef.current = "), 1, "startup: one write of the gate");
  assert.match(bootCode, /restorePendingRef\.current = guard\.fresh && !restoreReady;/);
  assert.match(bootCode, /if \(restoreReady\) \{/);
});

// B18 verification (regression #2) and round 3 (tests #3): finishLogs skipped while a restore was pending runs again once a
// pass handled it (the effect reads restorePendingRef, which is not state), and nothing opens the gate earlier in the pass.
await test("wiring: a pass that handles a restore re-runs finishLogs (after taking the cloud's copies, never before)", () => {
  assert.equal(count(recCode, "restorePendingRef.current = "), 2, "the pass writes the gate exactly twice");
  const close = recCode.indexOf("restorePendingRef.current = guard.fresh;");
  const fresh = recCode.indexOf("if (guard.fresh) {", close);
  const open = recCode.indexOf("restorePendingRef.current = false;");
  assert.ok(close >= 0 && fresh > close && open > fresh, "closed for the fresh pass, opened only inside its restore step");
  assert.match(recCode.slice(fresh), /^if \(guard\.fresh\) \{[\s\S]*?markRestoreSeen\(guard\.restoreAt\);\s*restorePendingRef\.current = false;\s*setRestoreSettled\(n => n \+ 1\);\s*\}/);
  assert.equal(count(recCode, "setRestoreSettled("), 1, "bumped once");
  assert.match(code, /const \[restoreSettled, setRestoreSettled\] = useState\(0\);/);
  assert.match(effCode, /^useEffect\(\(\) => \{\s*if \(\(!historySyncReady \|\| restorePendingRef\.current\) && isSupabaseConfigured\(\)\) return;\s*const done = finishLogs/, "the effect's gate");
  assert.match(effCode, /\}, \[tasks, logs, persistLog, historySyncReady, restoreSettled\]\);/, "finishLogs depends on it");
});

// B18 verification (tests #4/#5): the 1-second re-run is in place.
await test("wiring: a pass that waited re-runs after a second", () => {
  assert.match(recCode, /^\s*if \(restoreAfterReads && remote\.historyOk && ids\) setTimeout\(\(\) => reconcileWithCloud\(\), 1000\);$/m);
});

// B18 verification (regression #1) and round 2 (regression #1, tests #2): the held-purge evidence counts this tab's
// debounced queue and its History items only for generations it really keeps (the App.jsx half; the simulator half is
// scripts/test-b18-rerun-evidence-sim.mjs). Round 3 (regression #1): the pass that handles a restore decides none.
await test("wiring: the evidence leaves out queued copies and History items of removed or restore-removed generations", () => {
  assert.match(recCode, /\.\.\.taskSyncQueueRef\.current\.filter\(t => !rmTasks\.has\(t\.id\) && !tombT\.has\(t\.id\)\)\.map\(t => t\.id\)\]\);/);
  assert.match(recCode, /for \(const l of keptLogs\) for \(const i of Array\.isArray\(l\?\.tasks\) \? l\.tasks : \[\]\) if \(i\?\.id && !\(tombT\.has\(i\.id\) && restoreRemoved\?\.has\(i\.id\)\)\) keptTaskIds\.add\(i\.id\);/);
  assert.ok(recCode.indexOf("const tombT = ") >= 0 && recCode.indexOf("const tombT = ") < recCode.indexOf("const keptTaskIds = "), "tombT is read first");
  assert.ok(recCode.indexOf("const restoreRemoved = ") >= 0 && recCode.indexOf("const restoreRemoved = ") < recCode.indexOf("const keptTaskIds = "), "restoreRemoved too");
  assert.match(recCode, /const evidence = \{ restoreKnownAt: guard\.fresh \? -1 : restoreKnownAt,/);
});

// A tab whose storage refuses the write still knows the restore it read (else every pass of that tab would wait).
await test("storage.js knownRestoreAt keeps a noted restore in memory when localStorage refuses the write", async () => {
  const mem = new Map();
  globalThis.localStorage = {
    getItem: k => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { if (k === "proximaai-restore-known") throw new Error("QuotaExceededError"); mem.set(k, String(v)); },
    removeItem: k => mem.delete(k), get length() { return mem.size; }, key: i => [...mem.keys()][i] ?? null,
  };
  const sess = new Map();
  globalThis.sessionStorage = { getItem: k => (sess.has(k) ? sess.get(k) : null), setItem: (k, v) => sess.set(k, String(v)), removeItem: k => sess.delete(k) };
  const S = await import("../src/lib/storage.js");
  assert.equal(S.knownRestoreAt(), 0);
  assert.equal(S.restoreGuard({ last_restore_at: "5000" }).fresh, true);
  assert.equal(mem.has("proximaai-restore-known"), false, "the write was refused");
  assert.equal(S.knownRestoreAt(), 5000, "still known to this page");
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
