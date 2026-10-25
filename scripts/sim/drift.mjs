// Mirror drift: the App.jsx regions app.mjs mirrors, fingerprinted as they read when the mirrors were written (as of
// task B13). When a region changes, the mirror may no longer match the real flow: the smoke test lists such regions so
// the mirror is re-read and updated (a violation found through a stale mirror is not evidence about the shipped code).
//   node scripts/sim/drift.mjs           prints the drifted regions
//   node scripts/sim/drift.mjs --print   prints the current fingerprints (to refresh EXPECTED after updating a mirror)
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const REGIONS = [
  ["senders + confirmIntents (53-149)", "function confirmIntents(kind, ids, at, opts) {", "// ─── LOGIN SCREEN ───"],
  ["applyClearStashes (1598-1648)", "const applyClearStashes = (which, held = {}) => {", "const settleClearStashes = () => {"],
  ["settleClearStashes + giveBackVoided (1648-1664)", "const settleClearStashes = () => {", "// Force-flush all pending cloud writes"],
  ["replayDeleteIntents (1669-1702)", "const replayDeleteIntents = async (kind) => {", "// Queued History uploads (forceSaveAll"],
  ["replayHistoryUploads (1705-1723)", "const replayHistoryUploads = async (queued) => {", "const forceSaveAll = async () => {"],
  ["forceSaveAll (1723-1761)", "const forceSaveAll = async () => {", "// Long-press handler"],
  ["holds / pruneDeleting (1892-1907)", "const deleteHoldsRef = useRef(", "const draftFormRef = useRef(null);"],
  ["page load + mount replay (1996-2195)", "// Load state from IndexedDB + Supabase (gated on authentication)", "// ─── Cross-device sync ───"],
  ["reconcileWithCloud (2224-2569)", "const reconcileWithCloud = useCallback(async () => {", "\n  }, []);"],
  ["persistLog (2594-2617)", "const persistLog = useCallback((entry) => {", "}, [trackedSync]);"],
  ["sendHistoryRewrites + dropLogItemsFor (2622-2665)", "const sendHistoryRewrites = useCallback(", "}, [persistLog]);"],
  ["History save effect (2667-2675)", "// Save NEW logs to IndexedDB", "// A batch's entry is written when it starts"],
  ["persistence effect (2694-2742)", "// Persist completed/failed tasks to IndexedDB", "// Flush pending writes aggressively"],
  ["syncInFlight (2845-2852)", "const syncInFlight = useCallback((t) => {", "// Starts a poll for every running task"],
  ["applyRelinks (2927-2965)", "function applyRelinks(extra = []) {", "const submittingIds = useRef(new Set());"],
  ["flushWsDeletes (3064-3138)", "const flushWsDeletes = useCallback(async () => {", "// Review round 24 #6: every WaveSpeed delete of a generation"],
  ["deleteOnWaveSpeed (3154-3181)", "const deleteOnWaveSpeed = useCallback(", "// ─── DELETE MEANS DELETE"],
  ["forms publication (3500-3537)", "// This tab's Generate form inputs, published for every tab's file flush", "const mediaDuration = url =>"],
  ["settleCloudClear (3190-3204)", "const settleCloudClear = async", "// ─── FILES GO TOO"],
  ["flushFileDeletes (3207-3241)", "const flushFileDeletes = useCallback(async () => {", "// A generation delete reaches everything else"],
  ["planStagePurge + stagePurge (3265-3296)", "const planStagePurge = useCallback(", "const purgeEverywhere = useCallback("],
  ["purgeEverywhere (3296-3326)", "const purgeEverywhere = useCallback(", "// What is not finished yet goes in the toast"],
  ["finishPurge + queue timers (3339-3358)", "const finishPurge = async (plan) => {", "// ─── RESUME POLLING"],
  ["deleteSelectedTasks (4075-4203)", "const deleteSelectedTasks = async () => {", "// Renders the selection toolbar"],
  ["deleteSelectedLogs (4260-4341)", "const deleteSelectedLogs = async () => {", "// Selection toolbar for the generation-log list."],
  ["Clear Logs (5609-5721)", 'createBackup("pre-clear-logs"', ">Clear Logs</button>"],
  ["Clear Outputs (5727-5984)", 'createBackup("pre-clear-outputs"', ">Clear Outputs</button>"],
  ["Reset Everything (5991-6248)", 'createBackup("pre-reset"', ">Reset Everything</button>"],
  ["restore button (6392-6405)", "const r = await restoreBackup(b.id);", "Restore</button>"],
];
// Fingerprints as of task B13 (bf37422 + B13a/B13b/B13c in the working tree; refresh with --print after updating a mirror).
export const EXPECTED = {
  "senders + confirmIntents (53-149)": "8e7ae823dfed",
  "applyClearStashes (1598-1648)": "61b3dd0d45bf",
  "settleClearStashes + giveBackVoided (1648-1664)": "a2ed8d62cadf",
  "replayDeleteIntents (1669-1702)": "ac432417276d",
  "replayHistoryUploads (1705-1723)": "500d93f0ff4a",
  "forceSaveAll (1723-1761)": "cedbc049a0c7",
  "holds / pruneDeleting (1892-1907)": "ffcb494a6dd8",
  "page load + mount replay (1996-2195)": "378ceec2d879",
  "reconcileWithCloud (2224-2569)": "43cc9ba421e9",
  "persistLog (2594-2617)": "b53718286f9e",
  "sendHistoryRewrites + dropLogItemsFor (2622-2665)": "bf8fc65f94ba",
  "History save effect (2667-2675)": "730f2d3f73ea",
  "persistence effect (2694-2742)": "cfde1c7f4c52",
  "syncInFlight (2845-2852)": "6bcec5b2487a",
  "applyRelinks (2927-2965)": "61369a846b3a",
  "flushWsDeletes (3064-3138)": "79770b7e13ed",
  "deleteOnWaveSpeed (3154-3181)": "b23a726dd2b0",
  "forms publication (3500-3537)": "1726e915b91c",
  "settleCloudClear (3190-3204)": "f934e7f9add9",
  "flushFileDeletes (3207-3241)": "e760e5029d4a",
  "planStagePurge + stagePurge (3265-3296)": "b09144fcd96a",
  "purgeEverywhere (3296-3326)": "80c9a09ba614",
  "finishPurge + queue timers (3339-3358)": "cde06d1df64f",
  "deleteSelectedTasks (4075-4203)": "c62ecc2df06a",
  "deleteSelectedLogs (4260-4341)": "8aacfcfe5257",
  "Clear Logs (5609-5721)": "d6fdb06af849",
  "Clear Outputs (5727-5984)": "82e86f43e833",
  "Reset Everything (5991-6248)": "46ceefb84e88",
  "restore button (6392-6405)": "6e92f9bdc973",
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
