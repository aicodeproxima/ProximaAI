// Mirror drift: the App.jsx regions app.mjs mirrors, fingerprinted as they read when the mirrors were written (as of
// task B12c). When a region changes, the mirror may no longer match the real flow: the smoke test lists such regions so
// the mirror is re-read and updated (a violation found through a stale mirror is not evidence about the shipped code).
//   node scripts/sim/drift.mjs           prints the drifted regions
//   node scripts/sim/drift.mjs --print   prints the current fingerprints (to refresh EXPECTED after updating a mirror)
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const REGIONS = [
  ["senders + confirmIntents (47-96)", "function confirmIntents(kind, ids, at) {", "// ─── LOGIN SCREEN ───"],
  ["keepGivenBack (1514-1518)", "const keepGivenBack = (tasks = [], logs = [], more = []) => {", "const applyClearStashes = (which, held = {}) => {"],
  ["applyClearStashes (1519-1549)", "const applyClearStashes = (which, held = {}) => {", "const settleClearStashes = () => {"],
  ["settleClearStashes + giveBackVoided (1558-1572)", "const settleClearStashes = () => {", "// Force-flush all pending cloud writes"],
  ["replayDeleteIntents (1579-1610)", "const replayDeleteIntents = async (kind) => {", "// Queued History uploads (forceSaveAll"],
  ["replayHistoryUploads (1615-1631)", "const replayHistoryUploads = async (queued) => {", "const forceSaveAll = async () => {"],
  ["forceSaveAll (1633-1669)", "const forceSaveAll = async () => {", "// Long-press handler"],
  ["holds / pruneDeleting (1802-1817)", "const deleteHoldsRef = useRef(", "const draftFormRef = useRef(null);"],
  ["page load + mount replay (1906-2104)", "// Load state from IndexedDB + Supabase (gated on authentication)", "// ─── Cross-device sync ───"],
  ["reconcileWithCloud (2133-2416)", "const reconcileWithCloud = useCallback(async () => {", "\n  }, []);"],
  ["persistLog (2440-2463)", "const persistLog = useCallback((entry) => {", "}, [trackedSync]);"],
  ["sendHistoryRewrites + dropLogItemsFor (2468-2511)", "const sendHistoryRewrites = useCallback(", "}, [persistLog]);"],
  ["History save effect (2513-2521)", "// Save NEW logs to IndexedDB", "// A batch's entry is written when it starts"],
  ["persistence effect (2540-2588)", "// Persist completed/failed tasks to IndexedDB", "// Flush pending writes aggressively"],
  ["syncInFlight (2688-2694)", "const syncInFlight = useCallback((t) => {", "// Starts a poll for every running task"],
  ["applyRelinks (2757-2791)", "function applyRelinks() {", "const submittingIds = useRef(new Set());"],
  ["flushWsDeletes (2890-2944)", "const flushWsDeletes = useCallback(async () => {", "// Review round 24 #6: every WaveSpeed delete of a generation"],
  ["settleCloudClear (2990-3002)", "const settleCloudClear = async", "// ─── FILES GO TOO"],
  ["flushFileDeletes (3007-3037)", "const flushFileDeletes = useCallback(async () => {", "// A generation delete reaches everything else"],
  ["planStagePurge + stagePurge (3062-3091)", "const planStagePurge = useCallback(", "const purgeEverywhere = useCallback("],
  ["purgeEverywhere (3092-3121)", "const purgeEverywhere = useCallback(", "// What is not finished yet goes in the toast"],
  ["finishPurge + queue timers (3135-3152)", "const finishPurge = async (plan) => {", "// ─── RESUME POLLING"],
  ["deleteSelectedTasks (3838-3964)", "const deleteSelectedTasks = async () => {", "// Renders the selection toolbar"],
  ["deleteSelectedLogs (4023-4102)", "const deleteSelectedLogs = async () => {", "// Selection toolbar for the generation-log list."],
  ["Clear Logs (5298-5404)", 'createBackup("pre-clear-logs"', ">Clear Logs</button>"],
  ["Clear Outputs (5410-5621)", 'createBackup("pre-clear-outputs"', ">Clear Outputs</button>"],
  ["Reset Everything (5628-5861)", 'createBackup("pre-reset"', ">Reset Everything</button>"],
  ["restore button (6005-6018)", "const r = await restoreBackup(b.id);", "Restore</button>"],
];
// Fingerprints as of task B12c (the working tree after d0b3af6 with tasks B12a and B12b; refresh with --print after
// updating a mirror).
export const EXPECTED = {
  "senders + confirmIntents (47-96)": "fe0190dad1a2", "keepGivenBack (1514-1518)": "a10373d915a3",
  "applyClearStashes (1519-1549)": "b3182fa71fc9", "settleClearStashes + giveBackVoided (1558-1572)": "a2ed8d62cadf",
  "replayDeleteIntents (1579-1610)": "ac432417276d", "replayHistoryUploads (1615-1631)": "500d93f0ff4a",
  "forceSaveAll (1633-1669)": "cedbc049a0c7", "holds / pruneDeleting (1802-1817)": "ffcb494a6dd8",
  "page load + mount replay (1906-2104)": "77b4c4cb1c7e", "reconcileWithCloud (2133-2416)": "9a7a1ee9ca60",
  "persistLog (2440-2463)": "b53718286f9e", "sendHistoryRewrites + dropLogItemsFor (2468-2511)": "bf8fc65f94ba",
  "History save effect (2513-2521)": "730f2d3f73ea", "persistence effect (2540-2588)": "cfde1c7f4c52",
  "syncInFlight (2688-2694)": "6bcec5b2487a", "applyRelinks (2757-2791)": "2296b28fc23f",
  "flushWsDeletes (2890-2944)": "b6bf62ce5212", "settleCloudClear (2990-3002)": "f934e7f9add9",
  "flushFileDeletes (3007-3037)": "bff9431ff4aa", "planStagePurge + stagePurge (3062-3091)": "d436df86bff1",
  "purgeEverywhere (3092-3121)": "80c9a09ba614", "finishPurge + queue timers (3135-3152)": "cde06d1df64f",
  "deleteSelectedTasks (3838-3964)": "c62ecc2df06a", "deleteSelectedLogs (4023-4102)": "8aacfcfe5257",
  "Clear Logs (5298-5404)": "43271cfc88bb", "Clear Outputs (5410-5621)": "14f0b0cfe2df",
  "Reset Everything (5628-5861)": "dc43da690ecf", "restore button (6005-6018)": "6e92f9bdc973",
};

const norm = (s) => s.replace(/\r\n/g, "\n").split("\n").map(l => l.trim()).filter(Boolean).join("\n");
export function fingerprints(src) {
  const out = {};
  for (const [name, from, to] of REGIONS) {
    const i = src.indexOf(from);
    const j = i >= 0 ? src.indexOf(to, i + from.length) : -1;
    out[name] = i < 0 || j < 0 ? "missing" : createHash("sha1").update(norm(src.slice(i, j))).digest("hex").slice(0, 12);
  }
  return out;
}
export function mirrorDrift(src = readFileSync(new URL("../../src/App.jsx", import.meta.url), "utf8")) {
  const now = fingerprints(src);
  return Object.keys(EXPECTED).length ? REGIONS.map(([n]) => n).filter(n => now[n] !== EXPECTED[n]) : [];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes("--print")) console.log(JSON.stringify(fingerprints(readFileSync(new URL("../../src/App.jsx", import.meta.url), "utf8")), null, 2));
  else { const d = mirrorDrift(); console.log(d.length ? `mirror drift in: ${d.join("; ")}` : "no mirror drift"); }
}
