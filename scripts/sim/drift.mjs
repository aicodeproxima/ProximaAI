// Mirror drift: the App.jsx regions app.mjs mirrors, fingerprinted as they read when the mirrors were written (as of
// task B13). When a region changes, the mirror may no longer match the real flow: the smoke test lists such regions so
// the mirror is re-read and updated (a violation found through a stale mirror is not evidence about the shipped code).
//   node scripts/sim/drift.mjs           prints the drifted regions
//   node scripts/sim/drift.mjs --print   prints the current fingerprints (to refresh EXPECTED after updating a mirror)
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const REGIONS = [
  ["senders + confirmIntents (54-158)", "function confirmIntents(kind, ids, at, opts) {", "// ─── LOGIN SCREEN ───"],
  ["applyClearStashes (1607-1657)", "const applyClearStashes = (which, held = {}) => {", "const settleClearStashes = () => {"],
  ["settleClearStashes + giveBackVoided (1657-1673)", "const settleClearStashes = () => {", "// Force-flush all pending cloud writes"],
  ["replayDeleteIntents (1678-1711)", "const replayDeleteIntents = async (kind) => {", "// Queued History uploads (forceSaveAll"],
  ["replayHistoryUploads (1714-1732)", "const replayHistoryUploads = async (queued) => {", "const forceSaveAll = async () => {"],
  ["forceSaveAll (1732-1770)", "const forceSaveAll = async () => {", "// Long-press handler"],
  ["holds / pruneDeleting (1901-1916)", "const deleteHoldsRef = useRef(", "const draftFormRef = useRef(null);"],
  ["page load + mount replay (2005-2210)", "// Load state from IndexedDB + Supabase (gated on authentication)", "// ─── Cross-device sync ───"],
  ["reconcileWithCloud (2242-2621)", "const reconcileWithCloud = useCallback(async () => {", "\n  }, []);"],
  ["persistLog (2646-2669)", "const persistLog = useCallback((entry) => {", "}, [trackedSync]);"],
  ["sendHistoryRewrites + dropLogItemsFor (2674-2717)", "const sendHistoryRewrites = useCallback(", "}, [persistLog]);"],
  ["History save effect (2719-2727)", "// Save NEW logs to IndexedDB", "// A batch's entry is written when it starts"],
  ["persistence effect (2746-2794)", "// Persist completed/failed tasks to IndexedDB", "// Flush pending writes aggressively"],
  ["syncInFlight (2897-2904)", "const syncInFlight = useCallback((t) => {", "// Starts a poll for every running task"],
  ["applyRelinks (2979-3017)", "function applyRelinks(extra = []) {", "const submittingIds = useRef(new Set());"],
  ["flushWsDeletes (3116-3190)", "const flushWsDeletes = useCallback(async () => {", "// Review round 24 #6: every WaveSpeed delete of a generation"],
  ["deleteOnWaveSpeed (3206-3233)", "const deleteOnWaveSpeed = useCallback(", "// ─── DELETE MEANS DELETE"],
  ["forms publication (3552-3588)", "// This tab's Generate form inputs, published for every tab's file flush", "const mediaDuration = url =>"],
  ["settleCloudClear (3242-3256)", "const settleCloudClear = async", "// ─── FILES GO TOO"],
  ["flushFileDeletes (3259-3293)", "const flushFileDeletes = useCallback(async () => {", "// A generation delete reaches everything else"],
  ["planStagePurge + stagePurge (3317-3348)", "const planStagePurge = useCallback(", "const purgeEverywhere = useCallback("],
  ["purgeEverywhere (3348-3378)", "const purgeEverywhere = useCallback(", "// What is not finished yet goes in the toast"],
  ["finishPurge + queue timers (3391-3410)", "const finishPurge = async (plan) => {", "// ─── RESUME POLLING"],
  ["deleteSelectedTasks (4126-4254)", "const deleteSelectedTasks = async () => {", "// Renders the selection toolbar"],
  ["deleteSelectedLogs (4311-4392)", "const deleteSelectedLogs = async () => {", "// Selection toolbar for the generation-log list."],
  ["Clear Logs (5660-5772)", 'createBackup("pre-clear-logs"', ">Clear Logs</button>"],
  ["Clear Outputs (5778-6035)", 'createBackup("pre-clear-outputs"', ">Clear Outputs</button>"],
  ["Reset Everything (6042-6299)", 'createBackup("pre-reset"', ">Reset Everything</button>"],
  ["restore button (6443-6456)", "const r = await restoreBackup(b.id);", "Restore</button>"],
];
// Fingerprints as of task B13 (bf37422 + B13a/B13b/B13c in the working tree; refresh with --print after updating a mirror).
export const EXPECTED = {
  "senders + confirmIntents (54-158)": "161b64aae67f",
  "applyClearStashes (1607-1657)": "61b3dd0d45bf",
  "settleClearStashes + giveBackVoided (1657-1673)": "a2ed8d62cadf",
  "replayDeleteIntents (1678-1711)": "ac432417276d",
  "replayHistoryUploads (1714-1732)": "500d93f0ff4a",
  "forceSaveAll (1732-1770)": "cedbc049a0c7",
  "holds / pruneDeleting (1901-1916)": "ffcb494a6dd8",
  "page load + mount replay (2005-2210)": "851d5935dbce",
  "reconcileWithCloud (2242-2621)": "b1c97f755e5e",
  "persistLog (2646-2669)": "b53718286f9e",
  "sendHistoryRewrites + dropLogItemsFor (2674-2717)": "bf8fc65f94ba",
  "History save effect (2719-2727)": "730f2d3f73ea",
  "persistence effect (2746-2794)": "cfde1c7f4c52",
  "syncInFlight (2897-2904)": "6bcec5b2487a",
  "applyRelinks (2979-3017)": "61369a846b3a",
  "flushWsDeletes (3116-3190)": "79770b7e13ed",
  "deleteOnWaveSpeed (3206-3233)": "b23a726dd2b0",
  "forms publication (3552-3588)": "f1b3943050a9",
  "settleCloudClear (3242-3256)": "f934e7f9add9",
  "flushFileDeletes (3259-3293)": "e760e5029d4a",
  "planStagePurge + stagePurge (3317-3348)": "b09144fcd96a",
  "purgeEverywhere (3348-3378)": "80c9a09ba614",
  "finishPurge + queue timers (3391-3410)": "cde06d1df64f",
  "deleteSelectedTasks (4126-4254)": "c62ecc2df06a",
  "deleteSelectedLogs (4311-4392)": "8aacfcfe5257",
  "Clear Logs (5660-5772)": "d6fdb06af849",
  "Clear Outputs (5778-6035)": "82e86f43e833",
  "Reset Everything (6042-6299)": "46ceefb84e88",
  "restore button (6443-6456)": "6e92f9bdc973",
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
