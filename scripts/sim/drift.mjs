// Mirror drift: the App.jsx regions app.mjs mirrors, fingerprinted as they read when the mirrors were written (as of
// task B13). When a region changes, the mirror may no longer match the real flow: the smoke test lists such regions so
// the mirror is re-read and updated (a violation found through a stale mirror is not evidence about the shipped code).
//   node scripts/sim/drift.mjs           prints the drifted regions
//   node scripts/sim/drift.mjs --print   prints the current fingerprints (to refresh EXPECTED after updating a mirror)
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const REGIONS = [
  ["senders + confirmIntents (51-136)", "function confirmIntents(kind, ids, at, opts) {", "// ─── LOGIN SCREEN ───"],
  ["applyClearStashes (1550-1596)", "const applyClearStashes = (which, held = {}) => {", "const settleClearStashes = () => {"],
  ["settleClearStashes + giveBackVoided (1596-1612)", "const settleClearStashes = () => {", "// Force-flush all pending cloud writes"],
  ["replayDeleteIntents (1617-1650)", "const replayDeleteIntents = async (kind) => {", "// Queued History uploads (forceSaveAll"],
  ["replayHistoryUploads (1653-1671)", "const replayHistoryUploads = async (queued) => {", "const forceSaveAll = async () => {"],
  ["forceSaveAll (1671-1709)", "const forceSaveAll = async () => {", "// Long-press handler"],
  ["holds / pruneDeleting (1840-1855)", "const deleteHoldsRef = useRef(", "const draftFormRef = useRef(null);"],
  ["page load + mount replay (1944-2142)", "// Load state from IndexedDB + Supabase (gated on authentication)", "// ─── Cross-device sync ───"],
  ["reconcileWithCloud (2171-2507)", "const reconcileWithCloud = useCallback(async () => {", "\n  }, []);"],
  ["persistLog (2532-2555)", "const persistLog = useCallback((entry) => {", "}, [trackedSync]);"],
  ["sendHistoryRewrites + dropLogItemsFor (2560-2603)", "const sendHistoryRewrites = useCallback(", "}, [persistLog]);"],
  ["History save effect (2605-2613)", "// Save NEW logs to IndexedDB", "// A batch's entry is written when it starts"],
  ["persistence effect (2632-2680)", "// Persist completed/failed tasks to IndexedDB", "// Flush pending writes aggressively"],
  ["syncInFlight (2780-2787)", "const syncInFlight = useCallback((t) => {", "// Starts a poll for every running task"],
  ["applyRelinks (2861-2899)", "function applyRelinks(extra = []) {", "const submittingIds = useRef(new Set());"],
  ["flushWsDeletes (2996-3065)", "const flushWsDeletes = useCallback(async () => {", "// Review round 24 #6: every WaveSpeed delete of a generation"],
  ["deleteOnWaveSpeed (3081-3108)", "const deleteOnWaveSpeed = useCallback(", "// ─── DELETE MEANS DELETE"],
  ["forms publication (3415-3452)", "// This tab's Generate form inputs, published for every tab's file flush", "const mediaDuration = url =>"],
  ["settleCloudClear (3117-3131)", "const settleCloudClear = async", "// ─── FILES GO TOO"],
  ["flushFileDeletes (3134-3167)", "const flushFileDeletes = useCallback(async () => {", "// A generation delete reaches everything else"],
  ["planStagePurge + stagePurge (3191-3222)", "const planStagePurge = useCallback(", "const purgeEverywhere = useCallback("],
  ["purgeEverywhere (3222-3252)", "const purgeEverywhere = useCallback(", "// What is not finished yet goes in the toast"],
  ["finishPurge + queue timers (3265-3284)", "const finishPurge = async (plan) => {", "// ─── RESUME POLLING"],
  ["deleteSelectedTasks (3977-4105)", "const deleteSelectedTasks = async () => {", "// Renders the selection toolbar"],
  ["deleteSelectedLogs (4162-4243)", "const deleteSelectedLogs = async () => {", "// Selection toolbar for the generation-log list."],
  ["Clear Logs (5437-5549)", 'createBackup("pre-clear-logs"', ">Clear Logs</button>"],
  ["Clear Outputs (5555-5812)", 'createBackup("pre-clear-outputs"', ">Clear Outputs</button>"],
  ["Reset Everything (5819-6076)", 'createBackup("pre-reset"', ">Reset Everything</button>"],
  ["restore button (6220-6233)", "const r = await restoreBackup(b.id);", "Restore</button>"],
];
// Fingerprints as of task B13 (bf37422 + B13a/B13b/B13c in the working tree; refresh with --print after updating a mirror).
export const EXPECTED = {
  "senders + confirmIntents (51-136)": "6e944464012e",
  "applyClearStashes (1550-1596)": "70775f47b42f",
  "settleClearStashes + giveBackVoided (1596-1612)": "a2ed8d62cadf",
  "replayDeleteIntents (1617-1650)": "ac432417276d",
  "replayHistoryUploads (1653-1671)": "500d93f0ff4a",
  "forceSaveAll (1671-1709)": "cedbc049a0c7",
  "holds / pruneDeleting (1840-1855)": "ffcb494a6dd8",
  "page load + mount replay (1944-2142)": "77b4c4cb1c7e",
  "reconcileWithCloud (2171-2507)": "44b7cb6494f4",
  "persistLog (2532-2555)": "b53718286f9e",
  "sendHistoryRewrites + dropLogItemsFor (2560-2603)": "bf8fc65f94ba",
  "History save effect (2605-2613)": "730f2d3f73ea",
  "persistence effect (2632-2680)": "cfde1c7f4c52",
  "syncInFlight (2780-2787)": "6bcec5b2487a",
  "applyRelinks (2861-2899)": "61369a846b3a",
  "flushWsDeletes (2996-3065)": "8d48a3cb1113",
  "deleteOnWaveSpeed (3081-3108)": "b23a726dd2b0",
  "forms publication (3415-3452)": "ffc0a0172a69",
  "settleCloudClear (3117-3131)": "f934e7f9add9",
  "flushFileDeletes (3134-3167)": "403255de70d9",
  "planStagePurge + stagePurge (3191-3222)": "b09144fcd96a",
  "purgeEverywhere (3222-3252)": "80c9a09ba614",
  "finishPurge + queue timers (3265-3284)": "cde06d1df64f",
  "deleteSelectedTasks (3977-4105)": "c62ecc2df06a",
  "deleteSelectedLogs (4162-4243)": "8aacfcfe5257",
  "Clear Logs (5437-5549)": "d6fdb06af849",
  "Clear Outputs (5555-5812)": "82e86f43e833",
  "Reset Everything (5819-6076)": "46ceefb84e88",
  "restore button (6220-6233)": "6e92f9bdc973",
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
