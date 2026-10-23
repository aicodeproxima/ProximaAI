// Mirror drift: the App.jsx regions app.mjs mirrors, fingerprinted as they read when the mirrors were written (commit
// a79a43c). When a region changes, the mirror may no longer match the real flow: the smoke test lists such regions so
// the mirror is re-read and updated (a violation found through a stale mirror is not evidence about the shipped code).
//   node scripts/sim/drift.mjs           prints the drifted regions
//   node scripts/sim/drift.mjs --print   prints the current fingerprints (to refresh EXPECTED after updating a mirror)
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const REGIONS = [
  ["senders + confirmIntents (38-86)", "function confirmIntents(kind, ids, at) {", "// ─── LOGIN SCREEN ───"],
  ["applyClearStashes (1501-1530)", "const applyClearStashes = (which, held = {}) => {", "const settleClearStashes = () => {"],
  ["settleClearStashes + giveBackVoided (1539-1553)", "const settleClearStashes = () => {", "// Force-flush all pending cloud writes"],
  ["replayDeleteIntents (1560-1591)", "const replayDeleteIntents = async (kind) => {", "// Queued History uploads (forceSaveAll"],
  ["replayHistoryUploads (1596-1612)", "const replayHistoryUploads = async (queued) => {", "const forceSaveAll = async () => {"],
  ["forceSaveAll (1614-1650)", "const forceSaveAll = async () => {", "// Long-press handler"],
  ["holds / pruneDeleting (1783-1797)", "const deleteHoldsRef = useRef(", "const draftFormRef = useRef(null);"],
  ["page load + mount replay (1887-2082)", "// Load state from IndexedDB + Supabase (gated on authentication)", "// ─── Cross-device sync ───"],
  ["reconcileWithCloud (2113-2316)", "const reconcileWithCloud = useCallback(async () => {", "\n  }, []);"],
  ["persistLog (2340-2363)", "const persistLog = useCallback((entry) => {", "}, [trackedSync]);"],
  ["sendHistoryRewrites + dropLogItemsFor (2368-2411)", "const sendHistoryRewrites = useCallback(", "}, [persistLog]);"],
  ["History save effect (2413-2419)", "// Save NEW logs to IndexedDB", "// A batch's entry is written when it starts"],
  ["persistence effect (2440-2486)", "// Persist completed/failed tasks to IndexedDB", "// Flush pending writes aggressively"],
  ["syncInFlight (2588-2594)", "const syncInFlight = useCallback((t) => {", "// Starts a poll for every running task"],
  ["settleCloudClear (2771-2783)", "const settleCloudClear = async", "// ─── FILES GO TOO"],
  ["stagePurge (2839-2878)", "const stagePurge = useCallback(", "const purgeEverywhere = useCallback("],
  ["purgeEverywhere (2879-2911)", "const purgeEverywhere = useCallback(", "// Both delete queues also run"],
  ["deleteSelectedTasks (3597-3705)", "const deleteSelectedTasks = async () => {", "// Renders the selection toolbar"],
  ["deleteSelectedLogs (3764-3834)", "const deleteSelectedLogs = async () => {", "// Selection toolbar for the generation-log list."],
  ["Clear Logs (5028-5129)", 'createBackup("pre-clear-logs"', ">Clear Logs</button>"],
  ["Clear Outputs (5130-5331)", 'createBackup("pre-clear-outputs"', ">Clear Outputs</button>"],
  ["Reset Everything (5332-5556)", 'createBackup("pre-reset"', ">Reset Everything</button>"],
  ["restore button (5696-5712)", "const r = await restoreBackup(b.id);", "Restore</button>"],
];
// Fingerprints at a79a43c (refresh with --print after updating a mirror).
export const EXPECTED = {
  "senders + confirmIntents (38-86)": "fe0190dad1a2", "applyClearStashes (1501-1530)": "9a4e7e425f8c",
  "settleClearStashes + giveBackVoided (1539-1553)": "a2ed8d62cadf", "replayDeleteIntents (1560-1591)": "ac432417276d",
  "replayHistoryUploads (1596-1612)": "500d93f0ff4a", "forceSaveAll (1614-1650)": "cedbc049a0c7",
  "holds / pruneDeleting (1783-1797)": "ffcb494a6dd8", "page load + mount replay (1887-2082)": "77b4c4cb1c7e",
  "reconcileWithCloud (2113-2316)": "5d4f5a37e9ef", "persistLog (2340-2363)": "b53718286f9e",
  "sendHistoryRewrites + dropLogItemsFor (2368-2411)": "bf8fc65f94ba", "History save effect (2413-2419)": "730f2d3f73ea",
  "persistence effect (2440-2486)": "cfde1c7f4c52", "syncInFlight (2588-2594)": "6bcec5b2487a",
  "settleCloudClear (2771-2783)": "f934e7f9add9", "stagePurge (2839-2878)": "c8e432611901",
  "purgeEverywhere (2879-2911)": "9ea02a6e982d", "deleteSelectedTasks (3597-3705)": "2b8b415b3899",
  "deleteSelectedLogs (3764-3834)": "b5eb9ab86475", "Clear Logs (5028-5129)": "602b7064ea6f",
  "Clear Outputs (5130-5331)": "44b25a2c3314", "Reset Everything (5332-5556)": "f0f3e83d9c22",
  "restore button (5696-5712)": "6e92f9bdc973",
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
