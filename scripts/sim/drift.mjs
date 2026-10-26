// Mirror drift: the App.jsx regions app.mjs mirrors, fingerprinted as they read when the mirrors were written (as of
// task B13). When a region changes, the mirror may no longer match the real flow: the smoke test lists such regions so
// the mirror is re-read and updated (a violation found through a stale mirror is not evidence about the shipped code).
//   node scripts/sim/drift.mjs           prints the drifted regions
//   node scripts/sim/drift.mjs --print   prints the current fingerprints (to refresh EXPECTED after updating a mirror)
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const REGIONS = [
  ["senders + confirmIntents (57-161)", "function confirmIntents(kind, ids, at, opts) {", "// ─── LOGIN SCREEN ───"],
  ["applyClearStashes (1797-1847)", "const applyClearStashes = (which, held = {}) => {", "const settleClearStashes = () => {"],
  ["settleClearStashes + giveBackVoided (1847-1863)", "const settleClearStashes = () => {", "// Force-flush all pending cloud writes"],
  ["replayDeleteIntents (1868-1901)", "const replayDeleteIntents = async (kind) => {", "// Queued History uploads (forceSaveAll"],
  ["replayHistoryUploads (1904-1922)", "const replayHistoryUploads = async (queued) => {", "const forceSaveAll = async () => {"],
  ["forceSaveAll (1922-1960)", "const forceSaveAll = async () => {", "// Long-press handler"],
  ["holds / pruneDeleting (2091-2106)", "const deleteHoldsRef = useRef(", "const draftFormRef = useRef(null);"],
  ["page load + mount replay (2197-2402)", "// Load state from IndexedDB + Supabase (gated on authentication)", "// ─── Cross-device sync ───"],
  ["reconcileWithCloud (2434-2813)", "const reconcileWithCloud = useCallback(async () => {", "\n  }, []);"],
  ["persistLog (2838-2861)", "const persistLog = useCallback((entry) => {", "}, [trackedSync]);"],
  ["sendHistoryRewrites + dropLogItemsFor (2866-2909)", "const sendHistoryRewrites = useCallback(", "}, [persistLog]);"],
  ["History save effect (2911-2919)", "// Save NEW logs to IndexedDB", "// A batch's entry is written when it starts"],
  ["persistence effect (2938-2986)", "// Persist completed/failed tasks to IndexedDB", "// Flush pending writes aggressively"],
  ["syncInFlight (3089-3096)", "const syncInFlight = useCallback((t) => {", "// Starts a poll for every running task"],
  ["applyRelinks (3171-3209)", "function applyRelinks(extra = []) {", "const submittingIds = useRef(new Set());"],
  ["flushWsDeletes (3308-3382)", "const flushWsDeletes = useCallback(async () => {", "// Review round 24 #6: every WaveSpeed delete of a generation"],
  ["deleteOnWaveSpeed (3398-3425)", "const deleteOnWaveSpeed = useCallback(", "// ─── DELETE MEANS DELETE"],
  ["forms publication (3744-3782)", "// This tab's Generate form inputs, published for every tab's file flush", "const mediaDuration = url =>"],
  ["settleCloudClear (3434-3448)", "const settleCloudClear = async", "// ─── FILES GO TOO"],
  ["flushFileDeletes (3451-3485)", "const flushFileDeletes = useCallback(async () => {", "// A generation delete reaches everything else"],
  ["planStagePurge + stagePurge (3509-3540)", "const planStagePurge = useCallback(", "const purgeEverywhere = useCallback("],
  ["purgeEverywhere (3540-3570)", "const purgeEverywhere = useCallback(", "// What is not finished yet goes in the toast"],
  ["finishPurge + queue timers (3583-3602)", "const finishPurge = async (plan) => {", "// ─── RESUME POLLING"],
  ["deleteSelectedTasks (4320-4448)", "const deleteSelectedTasks = async () => {", "// Renders the selection toolbar"],
  ["deleteSelectedLogs (4505-4586)", "const deleteSelectedLogs = async () => {", "// Selection toolbar for the generation-log list."],
  ["Clear Logs (5882-5994)", 'createBackup("pre-clear-logs"', ">Clear Logs</button>"],
  ["Clear Outputs (6000-6257)", 'createBackup("pre-clear-outputs"', ">Clear Outputs</button>"],
  ["Reset Everything (6264-6521)", 'createBackup("pre-reset"', ">Reset Everything</button>"],
  ["restore button (6665-6678)", "const r = await restoreBackup(b.id);", "Restore</button>"],
];
// Fingerprints as of task B13 (bf37422 + B13a/B13b/B13c in the working tree; refresh with --print after updating a mirror).
export const EXPECTED = {
  "senders + confirmIntents (57-161)": "161b64aae67f",
  "applyClearStashes (1797-1847)": "61b3dd0d45bf",
  "settleClearStashes + giveBackVoided (1847-1863)": "a2ed8d62cadf",
  "replayDeleteIntents (1868-1901)": "ac432417276d",
  "replayHistoryUploads (1904-1922)": "500d93f0ff4a",
  "forceSaveAll (1922-1960)": "cedbc049a0c7",
  "holds / pruneDeleting (2091-2106)": "ffcb494a6dd8",
  "page load + mount replay (2197-2402)": "851d5935dbce",
  "reconcileWithCloud (2434-2813)": "b1c97f755e5e",
  "persistLog (2838-2861)": "b53718286f9e",
  "sendHistoryRewrites + dropLogItemsFor (2866-2909)": "bf8fc65f94ba",
  "History save effect (2911-2919)": "730f2d3f73ea",
  "persistence effect (2938-2986)": "cfde1c7f4c52",
  "syncInFlight (3089-3096)": "6bcec5b2487a",
  "applyRelinks (3171-3209)": "61369a846b3a",
  "flushWsDeletes (3308-3382)": "79770b7e13ed",
  "deleteOnWaveSpeed (3398-3425)": "b23a726dd2b0",
  "forms publication (3744-3782)": "d1161f0e9d5b",
  "settleCloudClear (3434-3448)": "f934e7f9add9",
  "flushFileDeletes (3451-3485)": "e760e5029d4a",
  "planStagePurge + stagePurge (3509-3540)": "b09144fcd96a",
  "purgeEverywhere (3540-3570)": "80c9a09ba614",
  "finishPurge + queue timers (3583-3602)": "cde06d1df64f",
  "deleteSelectedTasks (4320-4448)": "c62ecc2df06a",
  "deleteSelectedLogs (4505-4586)": "8aacfcfe5257",
  "Clear Logs (5882-5994)": "d6fdb06af849",
  "Clear Outputs (6000-6257)": "82e86f43e833",
  "Reset Everything (6264-6521)": "46ceefb84e88",
  "restore button (6665-6678)": "6e92f9bdc973",
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
