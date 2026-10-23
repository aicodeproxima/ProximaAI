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
  ["applyClearStashes (1514-1556)", "const applyClearStashes = (which, held = {}) => {", "const settleClearStashes = () => {"],
  ["settleClearStashes + giveBackVoided (1556-1572)", "const settleClearStashes = () => {", "// Force-flush all pending cloud writes"],
  ["replayDeleteIntents (1577-1610)", "const replayDeleteIntents = async (kind) => {", "// Queued History uploads (forceSaveAll"],
  ["replayHistoryUploads (1613-1631)", "const replayHistoryUploads = async (queued) => {", "const forceSaveAll = async () => {"],
  ["forceSaveAll (1631-1669)", "const forceSaveAll = async () => {", "// Long-press handler"],
  ["holds / pruneDeleting (1800-1815)", "const deleteHoldsRef = useRef(", "const draftFormRef = useRef(null);"],
  ["page load + mount replay (1904-2102)", "// Load state from IndexedDB + Supabase (gated on authentication)", "// ─── Cross-device sync ───"],
  ["reconcileWithCloud (2131-2459)", "const reconcileWithCloud = useCallback(async () => {", "\n  }, []);"],
  ["persistLog (2484-2507)", "const persistLog = useCallback((entry) => {", "}, [trackedSync]);"],
  ["sendHistoryRewrites + dropLogItemsFor (2512-2555)", "const sendHistoryRewrites = useCallback(", "}, [persistLog]);"],
  ["History save effect (2557-2565)", "// Save NEW logs to IndexedDB", "// A batch's entry is written when it starts"],
  ["persistence effect (2584-2632)", "// Persist completed/failed tasks to IndexedDB", "// Flush pending writes aggressively"],
  ["syncInFlight (2732-2739)", "const syncInFlight = useCallback((t) => {", "// Starts a poll for every running task"],
  ["applyRelinks (2813-2851)", "function applyRelinks(extra = []) {", "const submittingIds = useRef(new Set());"],
  ["flushWsDeletes (2948-3010)", "const flushWsDeletes = useCallback(async () => {", "// Review round 24 #6: every WaveSpeed delete of a generation"],
  ["deleteOnWaveSpeed (3026-3053)", "const deleteOnWaveSpeed = useCallback(", "// ─── DELETE MEANS DELETE"],
  ["forms publication (3360-3390)", "// This tab's Generate form inputs, published for every tab's file flush", "const mediaDuration = url =>"],
  ["settleCloudClear (3062-3076)", "const settleCloudClear = async", "// ─── FILES GO TOO"],
  ["flushFileDeletes (3079-3112)", "const flushFileDeletes = useCallback(async () => {", "// A generation delete reaches everything else"],
  ["planStagePurge + stagePurge (3136-3167)", "const planStagePurge = useCallback(", "const purgeEverywhere = useCallback("],
  ["purgeEverywhere (3167-3197)", "const purgeEverywhere = useCallback(", "// What is not finished yet goes in the toast"],
  ["finishPurge + queue timers (3210-3229)", "const finishPurge = async (plan) => {", "// ─── RESUME POLLING"],
  ["deleteSelectedTasks (3915-4043)", "const deleteSelectedTasks = async () => {", "// Renders the selection toolbar"],
  ["deleteSelectedLogs (4100-4181)", "const deleteSelectedLogs = async () => {", "// Selection toolbar for the generation-log list."],
  ["Clear Logs (5375-5487)", 'createBackup("pre-clear-logs"', ">Clear Logs</button>"],
  ["Clear Outputs (5493-5743)", 'createBackup("pre-clear-outputs"', ">Clear Outputs</button>"],
  ["Reset Everything (5750-6007)", 'createBackup("pre-reset"', ">Reset Everything</button>"],
  ["restore button (6151-6164)", "const r = await restoreBackup(b.id);", "Restore</button>"],
];
// Fingerprints as of task B13 (bf37422 + B13a/B13b/B13c in the working tree; refresh with --print after updating a mirror).
export const EXPECTED = {
  "senders + confirmIntents (51-100)": "8678682aee4e",
  "applyClearStashes (1514-1556)": "7cd936934346",
  "settleClearStashes + giveBackVoided (1556-1572)": "a2ed8d62cadf",
  "replayDeleteIntents (1577-1610)": "ac432417276d",
  "replayHistoryUploads (1613-1631)": "500d93f0ff4a",
  "forceSaveAll (1631-1669)": "cedbc049a0c7",
  "holds / pruneDeleting (1800-1815)": "ffcb494a6dd8",
  "page load + mount replay (1904-2102)": "77b4c4cb1c7e",
  "reconcileWithCloud (2131-2459)": "3df87148dd88",
  "persistLog (2484-2507)": "b53718286f9e",
  "sendHistoryRewrites + dropLogItemsFor (2512-2555)": "bf8fc65f94ba",
  "History save effect (2557-2565)": "730f2d3f73ea",
  "persistence effect (2584-2632)": "cfde1c7f4c52",
  "syncInFlight (2732-2739)": "6bcec5b2487a",
  "applyRelinks (2813-2851)": "61369a846b3a",
  "flushWsDeletes (2948-3010)": "181eeff62a41",
  "deleteOnWaveSpeed (3026-3053)": "b23a726dd2b0",
  "forms publication (3360-3390)": "b15d2dd72e2b",
  "settleCloudClear (3062-3076)": "f934e7f9add9",
  "flushFileDeletes (3079-3112)": "403255de70d9",
  "planStagePurge + stagePurge (3136-3167)": "b09144fcd96a",
  "purgeEverywhere (3167-3197)": "80c9a09ba614",
  "finishPurge + queue timers (3210-3229)": "cde06d1df64f",
  "deleteSelectedTasks (3915-4043)": "c62ecc2df06a",
  "deleteSelectedLogs (4100-4181)": "8aacfcfe5257",
  "Clear Logs (5375-5487)": "d6fdb06af849",
  "Clear Outputs (5493-5743)": "4d0c893147e3",
  "Reset Everything (5750-6007)": "46ceefb84e88",
  "restore button (6151-6164)": "6e92f9bdc973",
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
