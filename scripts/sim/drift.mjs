// Mirror drift: the App.jsx regions app.mjs mirrors, fingerprinted as they read when the mirrors were written (as of
// task B13). When a region changes, the mirror may no longer match the real flow: the smoke test lists such regions so
// the mirror is re-read and updated (a violation found through a stale mirror is not evidence about the shipped code).
//   node scripts/sim/drift.mjs           prints the drifted regions
//   node scripts/sim/drift.mjs --print   prints the current fingerprints (to refresh EXPECTED after updating a mirror)
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const REGIONS = [
  ["senders + confirmIntents (51-100)", "function confirmIntents(kind, ids, at, opts) {", "// ─── LOGIN SCREEN ───"],
  ["applyClearStashes (1516-1565)", "const applyClearStashes = (which, held = {}) => {", "const settleClearStashes = () => {"],
  ["settleClearStashes + giveBackVoided (1565-1581)", "const settleClearStashes = () => {", "// Force-flush all pending cloud writes"],
  ["replayDeleteIntents (1586-1619)", "const replayDeleteIntents = async (kind) => {", "// Queued History uploads (forceSaveAll"],
  ["replayHistoryUploads (1622-1640)", "const replayHistoryUploads = async (queued) => {", "const forceSaveAll = async () => {"],
  ["forceSaveAll (1640-1678)", "const forceSaveAll = async () => {", "// Long-press handler"],
  ["holds / pruneDeleting (1809-1824)", "const deleteHoldsRef = useRef(", "const draftFormRef = useRef(null);"],
  ["page load + mount replay (1914-2112)", "// Load state from IndexedDB + Supabase (gated on authentication)", "// ─── Cross-device sync ───"],
  ["reconcileWithCloud (2141-2469)", "const reconcileWithCloud = useCallback(async () => {", "\n  }, []);"],
  ["persistLog (2494-2517)", "const persistLog = useCallback((entry) => {", "}, [trackedSync]);"],
  ["sendHistoryRewrites + dropLogItemsFor (2522-2565)", "const sendHistoryRewrites = useCallback(", "}, [persistLog]);"],
  ["History save effect (2567-2575)", "// Save NEW logs to IndexedDB", "// A batch's entry is written when it starts"],
  ["persistence effect (2594-2642)", "// Persist completed/failed tasks to IndexedDB", "// Flush pending writes aggressively"],
  ["syncInFlight (2742-2749)", "const syncInFlight = useCallback((t) => {", "// Starts a poll for every running task"],
  ["applyRelinks (2823-2861)", "function applyRelinks(extra = []) {", "const submittingIds = useRef(new Set());"],
  ["flushWsDeletes (2958-3027)", "const flushWsDeletes = useCallback(async () => {", "// Review round 24 #6: every WaveSpeed delete of a generation"],
  ["deleteOnWaveSpeed (3043-3070)", "const deleteOnWaveSpeed = useCallback(", "// ─── DELETE MEANS DELETE"],
  ["forms publication (3377-3415)", "// This tab's Generate form inputs, published for every tab's file flush", "const mediaDuration = url =>"],
  ["settleCloudClear (3079-3093)", "const settleCloudClear = async", "// ─── FILES GO TOO"],
  ["flushFileDeletes (3096-3129)", "const flushFileDeletes = useCallback(async () => {", "// A generation delete reaches everything else"],
  ["planStagePurge + stagePurge (3153-3184)", "const planStagePurge = useCallback(", "const purgeEverywhere = useCallback("],
  ["purgeEverywhere (3184-3214)", "const purgeEverywhere = useCallback(", "// What is not finished yet goes in the toast"],
  ["finishPurge + queue timers (3227-3246)", "const finishPurge = async (plan) => {", "// ─── RESUME POLLING"],
  ["deleteSelectedTasks (3940-4068)", "const deleteSelectedTasks = async () => {", "// Renders the selection toolbar"],
  ["deleteSelectedLogs (4125-4206)", "const deleteSelectedLogs = async () => {", "// Selection toolbar for the generation-log list."],
  ["Clear Logs (5400-5512)", 'createBackup("pre-clear-logs"', ">Clear Logs</button>"],
  ["Clear Outputs (5518-5775)", 'createBackup("pre-clear-outputs"', ">Clear Outputs</button>"],
  ["Reset Everything (5782-6039)", 'createBackup("pre-reset"', ">Reset Everything</button>"],
  ["restore button (6183-6196)", "const r = await restoreBackup(b.id);", "Restore</button>"],
];
// Fingerprints as of task B13 (bf37422 + B13a/B13b/B13c in the working tree; refresh with --print after updating a mirror).
export const EXPECTED = {
  "senders + confirmIntents (51-100)": "8678682aee4e",
  "applyClearStashes (1516-1565)": "3e3fe00ed971",
  "settleClearStashes + giveBackVoided (1565-1581)": "a2ed8d62cadf",
  "replayDeleteIntents (1586-1619)": "ac432417276d",
  "replayHistoryUploads (1622-1640)": "500d93f0ff4a",
  "forceSaveAll (1640-1678)": "cedbc049a0c7",
  "holds / pruneDeleting (1809-1824)": "ffcb494a6dd8",
  "page load + mount replay (1914-2112)": "77b4c4cb1c7e",
  "reconcileWithCloud (2141-2469)": "7bc18f25fd3c",
  "persistLog (2494-2517)": "b53718286f9e",
  "sendHistoryRewrites + dropLogItemsFor (2522-2565)": "bf8fc65f94ba",
  "History save effect (2567-2575)": "730f2d3f73ea",
  "persistence effect (2594-2642)": "cfde1c7f4c52",
  "syncInFlight (2742-2749)": "6bcec5b2487a",
  "applyRelinks (2823-2861)": "61369a846b3a",
  "flushWsDeletes (2958-3027)": "8d48a3cb1113",
  "deleteOnWaveSpeed (3043-3070)": "b23a726dd2b0",
  "forms publication (3377-3415)": "02549e6063c6",
  "settleCloudClear (3079-3093)": "f934e7f9add9",
  "flushFileDeletes (3096-3129)": "403255de70d9",
  "planStagePurge + stagePurge (3153-3184)": "b09144fcd96a",
  "purgeEverywhere (3184-3214)": "80c9a09ba614",
  "finishPurge + queue timers (3227-3246)": "cde06d1df64f",
  "deleteSelectedTasks (3940-4068)": "c62ecc2df06a",
  "deleteSelectedLogs (4125-4206)": "8aacfcfe5257",
  "Clear Logs (5400-5512)": "d6fdb06af849",
  "Clear Outputs (5518-5775)": "82e86f43e833",
  "Reset Everything (5782-6039)": "46ceefb84e88",
  "restore button (6183-6196)": "6e92f9bdc973",
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
