// ─── ProximaAI IndexedDB Storage Layer ───
// Optimized for: tasks with outputs, generation history, settings, favorites, presets
// Falls back to localStorage if IndexedDB unavailable.

import { planResume, rememberReleased, liveReleased, noteClaimants, liveClaimants, dropClaimants, putBackClaimantRecords } from "./taskResume.js";
import { FORM_HOLD_ALIVE_MS } from "./fileDelete.js";
import { serverNow } from "./serverClock.js";
import { releaseRestored } from "./syncReconcile.js";
import { withoutDeleting } from "./batchLog.js";

const DB_NAME = "proximaai";
const DB_VERSION = 3;

const STORES = {
  settings: { keyPath: "key" },
  history: { keyPath: "id", autoIncrement: false, indexes: [{ name: "by_timestamp", keyPath: "timestamp" }] },
  favorites: { keyPath: "id", autoIncrement: false },
  presets: { keyPath: "modelId" },
  tasks: { keyPath: "id", autoIncrement: false, indexes: [{ name: "by_status", keyPath: "status" }, { name: "by_startTime", keyPath: "startTime" }] },
};

// Limits
const MAX_TASKS = 500;
const MAX_HISTORY = 1000;
const PRUNE_BATCH = 50; // How many to delete when pruning

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error("IndexedDB not available"));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      for (const [name, config] of Object.entries(STORES)) {
        let store;
        if (!db.objectStoreNames.contains(name)) {
          store = db.createObjectStore(name, { keyPath: config.keyPath, autoIncrement: config.autoIncrement || false });
        } else {
          store = e.currentTarget.transaction.objectStore(name);
        }
        // Create indexes if defined
        if (config.indexes) {
          for (const idx of config.indexes) {
            if (!store.indexNames.contains(idx.name)) {
              store.createIndex(idx.name, idx.keyPath, { unique: false });
            }
          }
        }
      }
      // Migrate from old "prism" DB if upgrading
      // Old data will be re-loaded via migrateFromLocalStorage on first run
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch(err => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

async function tx(storeName, mode = "readonly") {
  const db = await openDB();
  return db.transaction(storeName, mode).objectStore(storeName);
}

function wrapRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Batch write helper — uses a single transaction for multiple puts
async function batchPut(storeName, items) {
  if (!items.length) return;
  try {
    const db = await openDB();
    const txn = db.transaction(storeName, "readwrite");
    const store = txn.objectStore(storeName);
    for (const item of items) {
      try { store.put(item); } catch {}
    }
    await new Promise((res, rej) => { txn.oncomplete = res; txn.onerror = () => rej(txn.error); });
  } catch {}
}

// Batch delete helper
async function batchDelete(storeName, ids) {
  if (!ids.length) return;
  try {
    const db = await openDB();
    const txn = db.transaction(storeName, "readwrite");
    const store = txn.objectStore(storeName);
    for (const id of ids) {
      try { store.delete(id); } catch {}
    }
    await new Promise((res, rej) => { txn.oncomplete = res; txn.onerror = () => rej(txn.error); });
  } catch {}
}

// ─── Settings ───

export async function getSetting(key) {
  try {
    const store = await tx("settings");
    const result = await wrapRequest(store.get(key));
    return result?.value ?? null;
  } catch {
    const raw = localStorage.getItem(`proximaai-${key}`) || localStorage.getItem(`prism-${key}`);
    if (raw === null) return null;
    try { return JSON.parse(raw); } catch { return raw; }
  }
}

export async function setSetting(key, value) {
  try {
    const store = await tx("settings", "readwrite");
    await wrapRequest(store.put({ key, value }));
  } catch {
    localStorage.setItem(`proximaai-${key}`, typeof value === "string" ? value : JSON.stringify(value));
  }
}

// ─── History (Generation Logs) ───

export async function addHistoryEntry(entry) {
  try {
    const store = await tx("history", "readwrite");
    await wrapRequest(store.put(entry));
  } catch {
    try {
      const logs = JSON.parse(localStorage.getItem("proximaai-logs") || "[]");
      logs.unshift(entry);
      if (logs.length > 200) logs.length = 200;
      localStorage.setItem("proximaai-logs", JSON.stringify(logs));
    } catch {}
  }
}

export async function getHistory(limit = 500) {
  try {
    const store = await tx("history");
    const all = await wrapRequest(store.getAll());
    all.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    // Auto-prune if over limit
    if (all.length > MAX_HISTORY) {
      const toDelete = all.slice(MAX_HISTORY).map(h => h.id);
      batchDelete("history", toDelete); // fire-and-forget
    }
    return limit ? all.slice(0, limit) : all;
  } catch {
    try {
      return JSON.parse(localStorage.getItem("proximaai-logs") || localStorage.getItem("prism-logs") || "[]");
    } catch { return []; }
  }
}

// Every History entry this device stores, not only the 500 loaded (Clear Logs / Reset plan over them, review round 14),
// newest first; the localStorage fallback when IndexedDB is unavailable. Nothing is pruned or written.
export async function allStoredHistory() {
  try {
    const store = await tx("history");
    const all = (await wrapRequest(store.getAll())) || [];
    return all.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  } catch {
    try {
      const logs = JSON.parse(localStorage.getItem("proximaai-logs") || "[]");
      return Array.isArray(logs) ? logs.filter(l => l && l.id) : [];
    } catch { return []; }
  }
}

export async function clearHistory() {
  try {
    const store = await tx("history", "readwrite");
    await wrapRequest(store.clear());
  } catch {
    localStorage.removeItem("proximaai-logs");
    localStorage.removeItem("prism-logs");
  }
}

// Bulk-delete a list of history (generation-log) ids from IndexedDB. Also scrubs the
// localStorage fallback array (used when IndexedDB is unavailable) so deletes stick.
export async function deleteHistoryEntries(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return;
  await batchDelete("history", ids);
  try {
    const idSet = new Set(ids);
    const logs = JSON.parse(localStorage.getItem("proximaai-logs") || "[]");
    if (Array.isArray(logs) && logs.length) {
      localStorage.setItem("proximaai-logs", JSON.stringify(logs.filter(l => !idSet.has(l.id))));
    }
  } catch {}
}

// ─── Favorites ───

export async function addFavorite(entry) {
  try {
    const store = await tx("favorites", "readwrite");
    await wrapRequest(store.put(entry));
  } catch {}
}

export async function getFavorites() {
  try {
    const store = await tx("favorites");
    return await wrapRequest(store.getAll());
  } catch { return []; }
}

export async function removeFavorite(id) {
  try {
    const store = await tx("favorites", "readwrite");
    await wrapRequest(store.delete(id));
  } catch {}
}

// ─── Presets ───

export async function setPreset(modelId, params) {
  try {
    const store = await tx("presets", "readwrite");
    await wrapRequest(store.put({ modelId, params, updatedAt: Date.now() }));
  } catch {}
}

export async function getPreset(modelId) {
  try {
    const store = await tx("presets");
    const result = await wrapRequest(store.get(modelId));
    return result?.params ?? null;
  } catch { return null; }
}

// ─── Task Persistence ───

export async function saveTask(task) {
  try {
    // Strip large unnecessary fields to save space — keep outputs, drop intermediate state
    const slim = {
      id: task.id, batchId: task.batchId, modelId: task.modelId,
      modelName: task.modelName, provider: task.provider, price: task.price,
      status: task.status, startTime: task.startTime, endTime: task.endTime,
      wallClockMs: task.wallClockMs, inferenceMs: task.inferenceMs,
      outputs: task.outputs, error: task.error,
      genType: task.genType, prompt: task.prompt, negPrompt: task.negPrompt,
      resolution: task.resolution, duration: task.duration,
      seed: task.seed, aspectRatio: task.aspectRatio,
      sourceImageUrl: task.sourceImageUrl,
      sourceImageUrls: task.sourceImageUrls,
      sourceAudioUrl: task.sourceAudioUrl,
      sourceVideoUrl: task.sourceVideoUrl,
      endFrameUrl: task.endFrameUrl,
      refVideoUrl: task.refVideoUrl,
      numImages: task.numImages,
      // Cloud-archive metadata — persisted so a bulk-delete after reload can still
      // clean up the storage-bucket objects this task owns (else they orphan).
      isArchived: task.isArchived, archivedOutputs: task.archivedOutputs, archivedPaths: task.archivedPaths,
      // Polling resumption fields — lets us continue in-flight generations after
      // browser/tab close, refresh, or OS kill
      pollUrl: task.pollUrl, taskId: task.taskId,
    };
    const store = await tx("tasks", "readwrite");
    await wrapRequest(store.put(slim));
  } catch {}
}

export async function saveTasks(taskList) {
  await batchPut("tasks", taskList);
}

export async function deleteTask(id) {
  try {
    const store = await tx("tasks", "readwrite");
    await wrapRequest(store.delete(id));
  } catch {}
}

// Bulk-delete a list of task ids from IndexedDB in a single transaction.
export async function deleteTasks(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return;
  await batchDelete("tasks", ids);
}

// Every task this device stores, any status, not only the 500 loaded (Reset plans over them, review round 14). Nothing
// is pruned or written; none when IndexedDB is unavailable.
export async function allStoredTasks() {
  try {
    const store = await tx("tasks");
    return (await wrapRequest(store.getAll())) || [];
  } catch { return []; }
}

export async function getCompletedTasks(limit = 200) {
  try {
    const store = await tx("tasks");
    const all = await wrapRequest(store.getAll());
    // In-flight rows that can no longer be resumed are failed and written back first, so they load,
    // persist and sync like any finished task instead of staying "processing" in IndexedDB forever.
    const { expire } = planResume(all, Date.now());
    if (expire.length) await batchPut("tasks", expire);
    const terminal = [...all.filter(t => t.status === "completed" || t.status === "failed"), ...expire];
    terminal.sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
    // Auto-prune beyond limit
    if (terminal.length > MAX_TASKS) {
      const toDelete = terminal.slice(MAX_TASKS).map(t => t.id);
      batchDelete("tasks", toDelete); // fire-and-forget
    }
    return limit ? terminal.slice(0, limit) : terminal;
  } catch { return []; }
}

// Returns in-flight tasks whose poll can still be resumed after a page refresh, tab close or OS kill, plus lost
// submits (no prediction id) for the history lookup (see taskResume.js). The ones past WaveSpeed's retention are
// failed by getCompletedTasks on the same load.
export async function getPendingTasks() {
  try {
    const store = await tx("tasks");
    const all = await wrapRequest(store.getAll());
    const { resume, orphans } = planResume(all, Date.now());
    return [...resume, ...orphans];
  } catch { return []; }
}

export async function clearTasks() {
  try {
    const store = await tx("tasks", "readwrite");
    await wrapRequest(store.clear());
  } catch {}
}

// ─── Storage Stats ───

export async function getStorageStats() {
  try {
    const taskStore = await tx("tasks");
    const taskCount = await wrapRequest(taskStore.count());
    const histStore = await tx("history");
    const histCount = await wrapRequest(histStore.count());
    const favStore = await tx("favorites");
    const favCount = await wrapRequest(favStore.count());
    // Estimate size via navigator.storage if available
    let usedMB = null;
    if (navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      usedMB = ((est.usage || 0) / (1024 * 1024)).toFixed(1);
    }
    return { tasks: taskCount, history: histCount, favorites: favCount, usedMB };
  } catch { return { tasks: 0, history: 0, favorites: 0, usedMB: null }; }
}

// ─── Migration from localStorage + old "prism" DB ───

// Helper: read all data from an old IndexedDB store
function readOldStore(db, storeName) {
  return new Promise((resolve) => {
    if (!db.objectStoreNames.contains(storeName)) { resolve([]); return; }
    try {
      const txn = db.transaction(storeName, "readonly");
      const store = txn.objectStore(storeName);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    } catch { resolve([]); }
  });
}

// Helper: open old DB without triggering version upgrade
function openOldDB(name, version) {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(name, version);
      req.onupgradeneeded = () => { req.transaction.abort(); resolve(null); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

export async function migrateFromLocalStorage() {
  // Check if we already migrated
  const migrated = localStorage.getItem("proximaai-migrated");
  if (migrated) return;

  try {
    // 1. Migrate from old "prism" IndexedDB (MUST happen first, before localStorage cleanup)
    const oldDb = await openOldDB("prism", 2);
    if (oldDb) {
      try {
        // Read ALL stores from old DB
        const oldTasks = await readOldStore(oldDb, "tasks");
        const oldHistory = await readOldStore(oldDb, "history");
        const oldSettings = await readOldStore(oldDb, "settings");
        const oldFavorites = await readOldStore(oldDb, "favorites");
        const oldPresets = await readOldStore(oldDb, "presets");

        oldDb.close();

        // Write to new DB
        if (oldTasks.length > 0) await batchPut("tasks", oldTasks);
        if (oldHistory.length > 0) await batchPut("history", oldHistory);
        if (oldFavorites.length > 0) await batchPut("favorites", oldFavorites);
        if (oldPresets.length > 0) await batchPut("presets", oldPresets);
        for (const s of oldSettings) {
          if (s?.key && s?.value !== undefined) await setSetting(s.key, s.value);
        }

        // Delete old DB after successful migration
        try { indexedDB.deleteDatabase("prism"); } catch {}
      } catch {
        try { oldDb.close(); } catch {}
      }
    }

    // 2. Migrate from localStorage (fallback keys)
    // (The WaveSpeed key now lives only on the server; an old browser copy is discarded, not migrated.)
    if (localStorage.getItem("prism-api-key")) localStorage.removeItem("prism-api-key");

    const oldLogs = localStorage.getItem("prism-logs");
    if (oldLogs) {
      let logs;
      try { logs = JSON.parse(oldLogs); } catch { logs = []; }
      if (logs.length > 0) await batchPut("history", logs);
      localStorage.removeItem("prism-logs");
    }

    for (const key of ["defaultImageRes", "defaultVideoDur"]) {
      const val = localStorage.getItem(`prism-${key}`);
      if (val) {
        try { await setSetting(key, JSON.parse(val)); } catch { await setSetting(key, val); }
        localStorage.removeItem(`prism-${key}`);
      }
    }

    // Mark migration as done so it doesn't run again
    localStorage.setItem("proximaai-migrated", "1");
  } catch {
    // Migration failed silently — old data preserved as fallback
  }
}

// ─── Failed-sync retry queue ─────────────────────────────────────────────
// Cloud writes that fail (network, rate-limit, tab-close mid-debounce) get
// persisted here. On next mount, we replay them. Keeps us honest — failures
// never vanish silently, and "saved" status never lies.
// Prediction ids no task carries any more (deleted, or answered after a cancel), so the lost-submit lookup never adopts
// them (taskResume.js rememberReleased). Survives a reload: an orphan is often looked up on the next load.
const RELEASED_KEY = "proximaai-released-predictions";
const readReleased = () => { try { return JSON.parse(localStorage.getItem(RELEASED_KEY) || "{}") || {}; } catch { return {}; } };
export function releasePredictions(ids) {
  const list = (ids || []).filter(Boolean);
  if (!list.length) return;
  try { localStorage.setItem(RELEASED_KEY, JSON.stringify(rememberReleased(readReleased(), list, Date.now()))); } catch {}
}
export const releasedPredictions = () => liveReleased(readReleased(), Date.now());

// Prediction deletes waiting to reach WaveSpeed (rules in wsDelete.js). Its own small queue: a mass delete must never
// evict entries from the 200-entry failed-sync queue.
const WS_DELETES_KEY = "proximaai-ws-deletes";
export const readWsDeletes = () => { try { return JSON.parse(localStorage.getItem(WS_DELETES_KEY) || "{}") || {}; } catch { return {}; } };
export const writeWsDeletes = (q) => { try { localStorage.setItem(WS_DELETES_KEY, JSON.stringify(q || {})); } catch {} };

// Files of deleted generations still to delete (fileDelete.js). Left alone by sign-out: those paths still need deleting.
const FILE_DELETES_KEY = "proximaai-file-deletes";
export const readFileDeletes = () => { try { return JSON.parse(localStorage.getItem(FILE_DELETES_KEY) || "{}") || {}; } catch { return {}; } };
export const writeFileDeletes = (q) => { try { localStorage.setItem(FILE_DELETES_KEY, JSON.stringify(q || {})); } catch {} };

// The Generate form's input paths, published per tab so no tab's file flush deletes a file another tab's form still
// uses (fileDelete.js liveFormPaths, review #3). One key per tab: its id lives in sessionStorage, which survives Chrome
// discarding or killing the tab, so the page that reopens in it takes over the old key. Its form starts empty, so a
// hold left by a page killed while frozen is released at once instead of lasting FORM_HOLD_ALIVE_MS (review round 3).
// A duplicated tab copies sessionStorage too: while the original still heartbeats (its key is fresh), the duplicate
// takes a new id; document.wasDiscarded marks Chrome restoring this very tab.
const FORM_KEY = "proximaai-form-inputs:";
const TAB_KEY = "proximaai-tab-id";
const TAB_TAKEOVER_MS = 2 * 60 * 1000;   // two missed heartbeats (App.jsx publishes every minute)
export function pickTabId(stored, keyAt, wasDiscarded, now, fresh) {
  if (!stored) return fresh;
  if (wasDiscarded) return stored;
  return Number.isFinite(keyAt) && now - keyAt < TAB_TAKEOVER_MS ? fresh : stored;
}
let PREV_TAB_ID = null;   // the stored id this page set aside because its key looked alive (tabPresence decides)
const TAB_ID = (() => {
  const fresh = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  try {
    const stored = sessionStorage.getItem(TAB_KEY);
    let keyAt = NaN;
    try { keyAt = JSON.parse(localStorage.getItem(FORM_KEY + stored))?.at; } catch {}
    const id = pickTabId(stored, keyAt, globalThis.document?.wasDiscarded === true, Date.now(), fresh);
    if (stored && id !== stored) PREV_TAB_ID = stored;
    sessionStorage.setItem(TAB_KEY, id);
    return id;
  } catch { return fresh; }
})();
// A key that only looked alive (review round 4): a tab Chrome killed and reopened within TAB_TAKEOVER_MS reads like a
// duplicate. So the page asks this browser's other tabs whether that id is live; its owner answers at once. No answer
// within waitMs: the key belonged to a dead page and is released, instead of holding its uploads for 7 days. Every page
// answers for its own id. (A duplicate made of a frozen tab loses that tab's hold until it thaws and republishes.)
const TAB_PING_MS = 1500;
export function tabPresence({ id, prevId = null, open = () => new BroadcastChannel("proximaai-tabs"), waitMs = TAB_PING_MS, release }) {
  let ch;
  try { ch = open(); } catch { return null; }
  let pending = prevId;
  ch.onmessage = (e) => {
    const m = e?.data || {};
    if (m.ask && m.ask === id) ch.postMessage({ have: id });
    if (pending && m.have === pending) pending = null;
  };
  if (pending) {
    ch.postMessage({ ask: pending });
    setTimeout(() => { if (pending) { const p = pending; pending = null; release?.(p); } }, waitMs);
  }
  return ch;
}
if (typeof window !== "undefined" && typeof BroadcastChannel !== "undefined") {
  tabPresence({ id: TAB_ID, prevId: PREV_TAB_ID, release: (p) => { try { localStorage.removeItem(FORM_KEY + p); } catch {} } });
}
// Another tab's key is pruned only once its hold has lapsed: a frozen tab's form still holds its uploads (review round 2).
const STALE_FORM_KEY_MS = FORM_HOLD_ALIVE_MS;
export function publishFormPaths(paths, now = Date.now()) {
  try {
    localStorage.setItem(FORM_KEY + TAB_ID, JSON.stringify({ at: now, paths: paths || [] }));
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (!k?.startsWith(FORM_KEY) || k === FORM_KEY + TAB_ID) continue;
      let at = NaN; try { at = JSON.parse(localStorage.getItem(k))?.at; } catch {}
      if (!(now - at <= STALE_FORM_KEY_MS)) localStorage.removeItem(k);
    }
  } catch {}
}
export function readFormPublications() {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(FORM_KEY)) { try { out.push(JSON.parse(localStorage.getItem(k))); } catch {} }
    }
  } catch {}
  return out;
}
export function forgetFormPaths() { try { localStorage.removeItem(FORM_KEY + TAB_ID); } catch {} }
// One id per browser, shared by its tabs: the key of this browser's cloud form publication (review wf_ec400a67-988 #6).
export function browserId() {
  try {
    let id = localStorage.getItem("proximaai-browser-id");
    if (!id) { id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8); localStorage.setItem("proximaai-browser-id", id); }
    return id;
  } catch { return "unknown"; }
}

// Tasks cancelled or cleared before their submit gave a prediction id: the lost-submit lookup pairs them with their
// prediction so no other task adopts it (taskResume.js planOrphans `claimants`).
const CLAIMANTS_KEY = "proximaai-orphan-claimants";
const readClaimants = () => { try { return JSON.parse(localStorage.getItem(CLAIMANTS_KEY) || "{}") || {}; } catch { return {}; } };
const writeClaimants = (m) => { try { localStorage.setItem(CLAIMANTS_KEY, JSON.stringify(m)); } catch {} };
// Cancel records a waiting task; deletes pass `deleted: true`, which also flips a cancelled claimant to deleted
// (taskResume.js noteClaimants: the rules live in the pure function).
export function recordClaimants(tasks, opts) {
  writeClaimants(noteClaimants(readClaimants(), tasks || [], Date.now(), opts));
}
export const storedClaimants = () => liveClaimants(readClaimants(), Date.now());
export function resolveClaimants(ids) { if (ids?.length) writeClaimants(dropClaimants(readClaimants(), ids)); }
// The records of these ids as they are now, taken before a delete records them, so a voided delete can put them back.
export function claimantRecords(ids) {
  const m = readClaimants(), out = {};
  for (const id of ids || []) if (m[id]) out[id] = m[id];
  return out;
}
export function putBackClaimants(ids, before) { if (ids?.length) writeClaimants(putBackClaimantRecords(readClaimants(), ids, before)); }

const FAILED_KEY = "proximaai-failed-syncs";

export function getFailedSyncs() {
  try { return JSON.parse(localStorage.getItem(FAILED_KEY) || "[]"); }
  catch { return []; }
}

export function addFailedSync(entry) {
  // Task B7a, the last guard: a task / History upload of an id the SHARED delete state blocks (a delete intent pending in
  // any tab, or a confirmed delete no restore brought back) is never queued, so no replay can send it.
  if ((entry?.kind === "task" || entry?.kind === "history") && uploadBlockedIds(entry.kind).has(entry.id)) return;
  try {
    const list = getFailedSyncs();
    // Dedupe by kind+id (don't pile up duplicates for the same task/log)
    const existingIdx = list.findIndex(e => e.kind === entry.kind && e.id === entry.id);
    const withMeta = { ...entry, ts: serverNow(), attempts: (entry.attempts || 0) + 1 };
    if (existingIdx >= 0) list[existingIdx] = withMeta;
    else list.push(withMeta);
    // Cap the uploads at 200 entries to prevent unbounded growth. Delete intents are never dropped (a dropped one brings
    // a deleted row back on the next reload, review wf_ec400a67-988 #2) and do not count toward the cap (review round 2:
    // 200+ queued deletes used to push out every upload, a delete's History rewrites included). The oldest uploads go
    // first, never the newest entry.
    const isDelete = (e) => /-delete$/.test(e.kind);
    let uploads = list.filter(e => !isDelete(e)).length;
    for (let i = 0; uploads > 200 && i < list.length - 1; ) {
      if (isDelete(list[i])) i++; else { list.splice(i, 1); uploads--; }
    }
    localStorage.setItem(FAILED_KEY, JSON.stringify(list));
  } catch {}
}

// For a confirmed upload: clears the queue entry only while it still holds the exact version that was sent.
export const sentVersion = (data) => { const sent = JSON.stringify(data); return (e) => JSON.stringify(e.data) === sent; };

// `onlyIf(entry)`: remove the entry only while it still matches, e.g. still the "processing" version a finished upload
// sent, not the "completed" version that replaced it in the queue meanwhile.
// A queued upload's data replaced in place, its queue time and attempts kept (review round 9): a delete whose History
// work the server does still trims an entry's queued upload, which would otherwise bring the deleted items back when it
// replays. Nothing queued: nothing is added. Says whether one was replaced.
export function replaceQueuedUpload(kind, id, data) {
  try {
    const list = getFailedSyncs();
    const i = list.findIndex(e => e.kind === kind && e.id === id);
    if (i < 0) return false;
    list[i] = { ...list[i], data };
    localStorage.setItem(FAILED_KEY, JSON.stringify(list));
    return true;
  } catch { return false; }
}

export function removeFailedSync(kind, id, onlyIf) {
  try {
    const list = getFailedSyncs().filter(e => !(e.kind === kind && e.id === id && (!onlyIf || onlyIf(e))));
    localStorage.setItem(FAILED_KEY, JSON.stringify(list));
  } catch {}
}

// Clear Outputs / Clear Logs / Reset Everything: every removed id's delete intent, written in one go BEFORE the clear
// request fires (CLAUDE.md queue-first), so a tab killed mid-clear replays it and the mount replay keeps those ids
// deleting (review wf_ec400a67-988 #1). Delete intents are never capped.
export function queueDeleteIntents(kind, ids, at) {
  // Returns the queue time, so the action's first send carries it (review round 7): a restore between queueing and
  // sending then voids it, as it would a replay. `at`: a time the caller took earlier (Clear Outputs / Reset stamp the
  // snapshot taken before their purge read, review round 10); default now.
  const now = at ?? serverNow();   // server time: compared with a restore's (restoreGuard)
  try {
    const want = new Set((ids || []).filter(Boolean));
    if (!want.size) return now;
    const all = getFailedSyncs();
    const movedFrom = new Set(all.filter(e => e.kind === kind && want.has(e.id) && (e.ts || 0) !== now).map(e => e.ts || 0));
    const list = all.filter(e => !(e.kind === kind && want.has(e.id)));
    for (const id of want) list.push({ kind, id, data: id, ts: now, attempts: 1 });
    localStorage.setItem(FAILED_KEY, JSON.stringify(list));
    if (movedFrom.size) noteStashMoves(movedFrom, now);
  } catch {}
  return now;
}
// The ids with a queued delete intent of this kind: deletes still in flight (review round 10). A confirmed one has left
// the queue, and its id may be one a later restore brought back.
// `exceptAt`: leave out the intents queued at that time (one clear's own intents, review round 15 S1).
export function pendingDeleteIds(kind, { exceptAt } = {}) {
  const out = new Set();
  const skip = exceptAt != null && Number.isFinite(Number(exceptAt)) ? Number(exceptAt) : null;
  for (const e of getFailedSyncs()) if (e.kind === kind && e.id && (skip == null || (e.ts || 0) !== skip)) out.add(e.id);
  return out;
}
// Whether any delete intent (task or History) queued at this time is still pending: one clear's intents share its
// queue time, so while one of them is left, that clear is neither voided nor confirmed as a whole (round 15 S1).
export function intentsPendingAt(at) {
  const ts = Number(at);
  if (!Number.isFinite(ts)) return false;
  return getFailedSyncs().some(e => (e.kind === "task-delete" || e.kind === "history-delete") && (e.ts || 0) === ts);
}
// A restore on any device (settings 'last_restore_at', epoch ms; migration 20261022180000) supersedes every delete
// intent queued before it: replayed, a pending clear would delete what the restore brought back (review round 2).
// Returns the dropped ids per kind, so the caller stops treating them as being deleted.
export function dropDeleteIntentsBefore(ts) {
  const dropped = { task: [], history: [] };
  if (!(ts > 0)) return dropped;
  try {
    const keep = [], times = new Set();
    for (const e of getFailedSyncs()) {
      const kind = e.kind === "task-delete" ? "task" : e.kind === "history-delete" ? "history" : null;
      if (kind && (e.ts || 0) < ts) { dropped[kind].push(e.id); times.add(e.ts || 0); } else keep.push(e);
    }
    if (dropped.task.length || dropped.history.length) {
      localStorage.setItem(FAILED_KEY, JSON.stringify(keep));
      recordVoidedAt(times);   // voided by that restore (review round 18 #3)
    }
  } catch {}
  return dropped;
}

// The restore check every replay of delete intents goes through (review round 3). It voids first and only then reports
// the intents still pending, so a caller marks as "being deleted" only ids that survived the void. `settings`: the cloud
// settings map, or null when it could not be read: then the restore time is unknown, nothing is dropped, and the caller
// must not replay delete intents this pass (they stay queued, and still keep their rows from being re-seeded).
// `fresh`: a restore this device has not handled yet (markRestoreSeen). Only then is anything dropped: the delete
// intents and the History rewrites queued before it (a delete's trimmed copy of an entry would be uploaded over the
// restored one). Once handled, nothing queued later is compared with it (a clock running behind cannot void a delete
// made after the restore). The caller then takes the cloud's copies of shared entries (batchLog.js restoredVersions)
// and marks the restore seen.
// "Handled" is per tab (review round 4): each open tab must adopt the restored History and release its own deleting ids,
// so the shared key only seeds a tab that loads later (its IndexedDB copy is already adopted).
const SEEN_RESTORE_KEY = "proximaai-seen-restore";
const seenRestore = () => { try { return Number(localStorage.getItem(SEEN_RESTORE_KEY)) || 0; } catch { return 0; } };
let handledRestore = seenRestore();
export function markRestoreSeen(ts) {
  if (ts > handledRestore) handledRestore = ts;
  try { if (ts > seenRestore()) localStorage.setItem(SEEN_RESTORE_KEY, String(ts)); } catch {}
}
export function restoreGuard(settings) {
  const known = !!settings;
  const restoreAt = known ? Number(settings.last_restore_at) || 0 : 0;
  const fresh = known && restoreAt > handledRestore;
  if (known && restoreAt > 0) noteRestoreKnown(restoreAt);   // task B9: confirms queued before it are superseded
  const voided = fresh ? dropDeleteIntentsBefore(restoreAt) : { task: [], history: [] };
  if (fresh) {
    try {
      const all = getFailedSyncs(), keep = all.filter(e => !(e.kind === "history" && (e.ts || 0) < restoreAt));
      if (keep.length !== all.length) localStorage.setItem(FAILED_KEY, JSON.stringify(keep));
    } catch {}
  }
  const pending = { task: [], history: [] };
  for (const e of getFailedSyncs()) {
    if (e.kind === "task-delete") pending.task.push(e.id);
    else if (e.kind === "history-delete") pending.history.push(e.id);
  }
  return { known, fresh, restoreAt, voided, pending };
}

// Task ids whose own delete intent, queued at or after the last restore (`restoreAt`, server ms), is still pending: their
// rows are going, so they do not hold back their own WaveSpeed copy (App.jsx flushWsDeletes). An older intent is voided
// by that restore, which kept the row (review round 6). `restoreAt` null (unreadable): none.
export function deletesGoingSince(restoreAt) {
  const out = new Set();
  if (restoreAt == null || !Number.isFinite(Number(restoreAt))) return out;
  for (const f of getFailedSyncs()) if (f.kind === "task-delete" && f.id && (f.ts || 0) >= Number(restoreAt)) out.add(f.id);
  return out;
}

// The queued delete intents of one kind grouped by queue time, oldest first: the server-checked replay
// (delete_queued_rows) sends one call per group, and a whole action shares one time (queueDeleteIntents).
export function intentGroups(kind) {
  const byTs = new Map();
  for (const f of getFailedSyncs()) {
    if (f.kind !== kind || !f.id) continue;
    const ts = f.ts || 0;
    if (!byTs.has(ts)) byTs.set(ts, []);
    byTs.get(ts).push(f.id);
  }
  return [...byTs.entries()].sort((a, b) => a[0] - b[0]);
}

// A delete the cloud confirmed: its intents leave the queue, and the browser records when (review round 5). A later pass
// whose reads began after that, and whose cloud holds the id again, knows a restore brought it back (only a restore
// re-inserts a tombstoned id) and releases it (syncReconcile.js releaseRestored). Shared by the browser's tabs (another
// tab may have pre-loaded the intent this one confirmed, review round 6) and kept 30 days.
const CONFIRMED_KEY = "proximaai-confirmed-deletes";
const CONFIRMED_FOR_MS = 30 * 24 * 60 * 60 * 1000;
// Task B9 (review round 22 #3): every shared record is read defensively. A malformed value (a forged or corrupted key: a
// top-level or per-kind entry that is not a plain object) reads as empty for that part, so no write that follows can
// throw on it; the next write stores the cleaned value (the same layout older builds read).
const plainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const readKinds = (key) => {
  try {
    const v = JSON.parse(localStorage.getItem(key) || "{}");
    if (!plainObject(v)) return {};
    const out = {};
    for (const [k, m] of Object.entries(v)) if (plainObject(m)) out[k] = m;
    return out;
  } catch { return {}; }
};
const readConfirmed = () => readKinds(CONFIRMED_KEY);
// Task B8a (review round 21 #6): every record's value is a plain server time (withoutConfirmedUploads compares it with
// upload stamps), exactly as the builds before 21d8266 write it: a tab still running such a build prunes the record with
// `if (!(at > cut)) delete`, which deleted every {at, seq} object 21d8266 wrote. The confirm sequence (releaseRestored
// compares it with a pass's start) lives in its own key, kind -> id -> seq, pruned with the record. An id without one
// (written by an older build) is seq 0, i.e. confirmed before any pass. A 21d8266 {at, seq} object still reads (its own
// seq wins) and is rewritten in the new layout by the next confirm.
const CONFIRM_SEQS_KEY = "proximaai-confirmed-seqs";
const readConfirmSeqs = () => readKinds(CONFIRM_SEQS_KEY);   // an unreadable sequence counts as 0 (confirmRecord)
const recordAt = (v) => (v && typeof v === "object" ? Number(v.at) || 0 : Number(v) || 0);
const confirmRecord = (v, seq) => (v && typeof v === "object" ? { at: recordAt(v), seq: Number(v.seq) || 0 } : { at: recordAt(v), seq: Number(seq) || 0 });
// The sequences of ids no longer in the record go (an older build's prune or forget left them behind).
const pruneConfirmSeqs = (seqs, all) => {
  for (const k of Object.keys(seqs)) {
    for (const id of Object.keys(seqs[k] || {})) if (!(all[k] && id in all[k])) delete seqs[k][id];
    if (!Object.keys(seqs[k] || {}).length) delete seqs[k];
  }
  return seqs;
};
const writeConfirmSeqs = (seqs) => {
  if (Object.keys(seqs).length) localStorage.setItem(CONFIRM_SEQS_KEY, JSON.stringify(seqs));
  else localStorage.removeItem(CONFIRM_SEQS_KEY);
};
// Task B7a (review round 20 #4): "confirmed before this pass" is decided by ORDER, not by time. A shared counter (every
// tab of this browser) numbers each confirm call; a reconcile pass takes the counter value at its start
// (confirmSeqNow), and a confirm made after that has a seq >= it, whatever the server-clock offset did meanwhile.
const CONFIRM_SEQ_KEY = "proximaai-confirm-seq";
export function confirmSeqNow() {
  try { return Math.max(1, Math.floor(Number(localStorage.getItem(CONFIRM_SEQ_KEY))) || 1); } catch { return 1; }
}
function takeConfirmSeq() {
  const seq = confirmSeqNow();
  try { localStorage.setItem(CONFIRM_SEQ_KEY, String(seq + 1)); } catch {}
  return seq;
}
// ─── Task B9 (review round 22): a confirm keeps its QUEUE time; a restore after it supersedes it ───
// The server answers "deleted" for a delete queued at T only if no restore marker newer than T existed when it ran
// (delete_queued_rows voids queued_at < last_restore_at). So a "deleted" answer for T, whenever this browser handles it,
// means the server deleted BEFORE every restore whose marker R > T: such a restore supersedes that confirm, and whether
// the id lives is then decided by the cloud's content after the restore (sharedDeleteState), not by the record.
// The queue time lives in its own key (the two keys above keep the exact layout older builds read): kind -> id ->
// { q: the confirmed group's queue time, c: the record's own time (the entry belongs to that record only: an older
// build's forget + confirm leaves a stale entry, whose c then differs), r: the restore marker a pass already checked it
// against (resolved as final) }. A record without a matching entry (an older build's) counts its own time as its queue
// time: the queue time is never later than it, so that never makes a record superseded when it is not.
const CONFIRM_QUEUED_KEY = "proximaai-confirmed-queued";
const readConfirmQueued = () => readKinds(CONFIRM_QUEUED_KEY);
const queuedEntry = (e, at) => (plainObject(e) && Number(e.c) === at && Number.isFinite(Number(e.q)) ? e : null);
const pruneConfirmQueued = (qs, all) => {
  for (const k of Object.keys(qs)) {
    for (const [id, e] of Object.entries(qs[k] || {})) if (!(all[k] && id in all[k]) || !queuedEntry(e, recordAt(all[k][id]))) delete qs[k][id];
    if (!Object.keys(qs[k] || {}).length) delete qs[k];
  }
  return qs;
};
const writeConfirmQueued = (qs) => {
  if (Object.keys(qs).length) localStorage.setItem(CONFIRM_QUEUED_KEY, JSON.stringify(qs));
  else localStorage.removeItem(CONFIRM_QUEUED_KEY);
};
// The latest restore marker this browser knows of (server ms), shared by its tabs: read by restoreGuard from the cloud
// settings, handled (markRestoreSeen), or implied by a void answer (a restore newer than the voided group exists:
// voidDeleteIntents). Records queued before it are superseded.
const RESTORE_KNOWN_KEY = "proximaai-restore-known";
const storedRestoreKnown = () => { try { return Number(localStorage.getItem(RESTORE_KNOWN_KEY)) || 0; } catch { return 0; } };
export function knownRestoreAt() { return Math.max(storedRestoreKnown(), seenRestore(), handledRestore); }
export function noteRestoreKnown(ts) {
  const t = Number(ts);
  if (!(t > 0) || !Number.isFinite(t)) return;
  try { if (t > storedRestoreKnown()) localStorage.setItem(RESTORE_KNOWN_KEY, String(t)); } catch {}
}

// ─── Task B9 (review round 22 #2): delete calls in flight, shared by the browser's tabs ───
// Every delete call (task or History, any path) records its ids and queue time here BEFORE it fires and removes them once
// its answer is handled (App.jsx: a confirm or a void removes the ids it answers, the call's `finally` the rest). While a
// call is in flight its ids may already be deleted on the server even though no intent is left for them (a stale tab's
// clear re-queued them at its own time and that time was voided), so every OTHER call's give-back keeps them and no tab
// uploads them. A tab killed mid-call leaves its entry; it lapses after FLIGHT_FOR_MS. Layout: call -> { tab, at, until
// (device ms), ids: { "task-delete": [...], "history-delete": [...] } }.
const FLIGHT_KEY = "proximaai-deletes-in-flight";
const FLIGHT_FOR_MS = 30 * 60 * 1000;
const readFlights = () => {
  try { const v = JSON.parse(localStorage.getItem(FLIGHT_KEY) || "{}"); return plainObject(v) ? v : {}; } catch { return {}; }
};
const writeFlights = (m) => {
  if (Object.keys(m).length) localStorage.setItem(FLIGHT_KEY, JSON.stringify(m)); else localStorage.removeItem(FLIGHT_KEY);
};
const liveFlight = (f, now) => plainObject(f) && Number(f.until) > now && plainObject(f.ids);
// `parts`: { "task-delete": ids, "history-delete": ids }; `at`: the call's queue time. Returns the call's key (null: nothing).
export function beginDeleteFlight(parts, at) {
  const ids = {};
  for (const [kind, list] of Object.entries(parts || {})) {
    if (kind !== "task-delete" && kind !== "history-delete") continue;
    const l = [...new Set((list || []).filter(Boolean).map(String))];
    if (l.length) ids[kind] = l;
  }
  if (!Object.keys(ids).length) return null;
  const call = `${TAB_ID}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  try {
    const m = readFlights(), now = Date.now();
    for (const k of Object.keys(m)) if (!liveFlight(m[k], now)) delete m[k];
    m[call] = { tab: TAB_ID, at: Number(at) || 0, until: now + FLIGHT_FOR_MS, ids };
    localStorage.setItem(FLIGHT_KEY, JSON.stringify(m));
  } catch {}
  return call;
}
// The call's `finally`: whatever of it is left goes.
export function endDeleteFlight(call) {
  if (!call) return;
  try { const m = readFlights(); if (m[call]) { delete m[call]; writeFlights(m); } } catch {}
}
// An answer handled for these ids of the group queued at `at` (confirmDeleteIntents / voidDeleteIntents): this tab's
// calls of that group stop holding them. Another tab's call of the same group keeps its own entry until its answer.
function landFlightIds(kind, ids, at) {
  const ts = Number(at), gone = new Set((ids || []).filter(Boolean));
  if (!Number.isFinite(ts) || !gone.size) return;
  try {
    const m = readFlights();
    let changed = false;
    for (const [call, f] of Object.entries(m)) {
      if (!plainObject(f) || f.tab !== TAB_ID || Number(f.at) !== ts || !plainObject(f.ids) || !Array.isArray(f.ids[kind])) continue;
      const left = f.ids[kind].filter(id => !gone.has(id));
      if (left.length === f.ids[kind].length) continue;
      changed = true;
      if (left.length) f.ids[kind] = left; else delete f.ids[kind];
      if (!Object.keys(f.ids).length) delete m[call];
    }
    if (changed) writeFlights(m);
  } catch {}
}
// The ids of this kind some delete call of this browser (any tab) has in flight.
export function inFlightIds(kind) {
  const out = new Set(), now = Date.now();
  for (const f of Object.values(readFlights())) if (liveFlight(f, now) && Array.isArray(f.ids[kind])) for (const id of f.ids[kind]) if (id) out.add(id);
  return out;
}

// Returns the archived file paths of confirmed tasks that a clear's stash held (forgetStashedIds): the caller queues
// them for deletion through the file-delete queue.
// Task B7b (review round 20 #7): `at` is the queue time of the group the cloud answered (App.jsx passes it at every
// confirm site). Only intents queued at or before it are settled: an id a later delete re-queued (its intent moved to a
// later time, e.g. after a restore brought it back) keeps that intent, so that delete is still sent (the server answers
// "deleted" if nothing is left). `at` omitted: every queue time (no App.jsx caller; scripts/test-delete-wiring.mjs).
// Task B8a (review round 21 #8): the clean-up is bounded the same way. Only the stashes of clears queued at or before
// `at` lose the confirmed ids, and only queued uploads stamped at or before `at` are dropped: a later delete's stash and a
// later upload (both after a restore brought the id back) keep their content for that later delete to decide.
// Task B9 (review round 22 #1): the confirm record is ALWAYS written, with the group's queue time `at` (the B8c rule that
// skipped an id pending at a later time is gone: a stale tab's clear re-queues an id with no restore at all, and the skip
// let that clear's void give back a generation the server had already deleted). A record queued before a restore this
// browser knows of is superseded (sharedDeleteState decides it from the cloud after that restore; until then it waits).
// Review round 22 #3: the sequence, the queue time and the record are three writes, each in its own try, and a malformed
// value of any of them cannot make another throw. Only a record that could not be written leaves the intents settled
// nothing: the replay then sends that group again and its answer records it.
export function confirmDeleteIntents(kind, ids, at) {
  const isDelete = kind === "task-delete" || kind === "history-delete";
  const list = [...new Set((ids || []).filter(Boolean))];
  const bound = at == null ? null : Number(at);
  const queuedAt = bound != null && Number.isFinite(bound) ? bound : null;
  if (isDelete && list.length) {
    // Server time, like the queued uploads' stamps (addFailedSync) that withoutConfirmedUploads compares it with: a
    // device clock off by more than a few ms would otherwise keep a stale upload or drop a real one (round 19
    // follow-up, scripts/test-confirm-clock.mjs). The sequence orders it against reconcile passes (round 20 #4).
    const all = readConfirmed(), now = serverNow(), cut = now - CONFIRMED_FOR_MS, seq = takeConfirmSeq(), moved = {};
    for (const k of Object.keys(all)) for (const [id, v] of Object.entries(all[k])) {
      if (!(recordAt(v) > cut)) { delete all[k][id]; continue; }
      // A 21d8266 object: back to a plain number, its seq into the separate key (round 21 #6).
      if (v && typeof v === "object") { all[k][id] = recordAt(v); (moved[k] = moved[k] || {})[id] = Number(v.seq) || 0; }
    }
    all[kind] = all[kind] || {};
    for (const id of list) all[kind][id] = now;
    // The sequences first, then the queue times: a reader that sees the new time also finds both.
    try {
      const seqs = readConfirmSeqs();
      for (const [k, m] of Object.entries(moved)) seqs[k] = { ...(seqs[k] || {}), ...m };
      seqs[kind] = seqs[kind] || {};
      for (const id of list) seqs[kind][id] = seq;
      writeConfirmSeqs(pruneConfirmSeqs(seqs, all));
    } catch {}
    try {
      const qs = readConfirmQueued();
      qs[kind] = qs[kind] || {};
      for (const id of list) {
        if (queuedAt != null) qs[kind][id] = { q: queuedAt, c: now };
        else delete qs[kind][id];
      }
      writeConfirmQueued(pruneConfirmQueued(qs, all));
    } catch {}
    try { localStorage.setItem(CONFIRMED_KEY, JSON.stringify(all)); }
    catch {
      // Not recorded: nothing settled, the replay sends this group again. The sequences just written for it go (a later
      // confirm without its own sequence must not inherit this earlier one).
      try {
        const seqs = readConfirmSeqs();
        for (const id of list) if (seqs[kind]?.[id] === seq) delete seqs[kind][id];
        if (seqs[kind] && !Object.keys(seqs[kind]).length) delete seqs[kind];
        writeConfirmSeqs(seqs);
      } catch {}
      return [];
    }
  }
  settleDeleteIntents(kind, ids, at);
  landFlightIds(kind, list, at);   // this call's answer is handled for these ids (review round 22 #2)
  if (!isDelete) return [];
  // A delete the cloud confirmed is never given back by a later void of its clear (review round 15 S2), up to its time.
  const paths = forgetStashedIds(kind, ids, at);
  // Nor uploaded again (review round 19 #2): a queued upload of a confirmed id (one a give-back put back while its delete
  // was pending, or a stale tab's) would re-insert a row the server holds no tombstone for. Up to its time (round 21 #8).
  dropQueuedUploadsOf(kind === "task-delete" ? "task" : "history", ids, at);
  return paths;
}
// A new delete of these ids starts: their older confirmations no longer say anything (a restore brought them back and
// they are going again). Task B8a (review round 21 #2/#7): called only right after that delete's own intents are queued
// (App.jsx), so the pending intent blocks the id in every tab from then on and releaseRestored skips it; called earlier,
// a delete aborted before queueing (a failed safety backup) left the id with neither record nor intent. Forgotten, not
// kept: kept, a void of the new delete would leave this older record behind, and every put-back upload of the id would be
// dropped as a confirmed delete's (uploadable) until a pass released it.
export function forgetConfirmed(kind, ids) {
  try {
    const all = readConfirmed();
    if (!all[kind]) return;
    for (const id of ids || []) delete all[kind][id];
    localStorage.setItem(CONFIRMED_KEY, JSON.stringify(all));
    try { writeConfirmSeqs(pruneConfirmSeqs(readConfirmSeqs(), all)); } catch {}
    try { writeConfirmQueued(pruneConfirmQueued(readConfirmQueued(), all)); } catch {}
  } catch {}
}
// The live records of one kind (recorded within 30 days): id -> { at, seq, q, r }.
function confirmRecords(kind) {
  const cut = serverNow() - CONFIRMED_FOR_MS, seqs = readConfirmSeqs()[kind] || {}, qs = readConfirmQueued()[kind] || {};
  return Object.entries(readConfirmed()[kind] || {}).map(([id, v]) => {
    const rec = confirmRecord(v, seqs[id]), e = queuedEntry(qs[id], rec.at);
    return [id, { ...rec, q: e ? Number(e.q) : rec.at, r: e ? Number(e.r) || 0 : 0 }];
  }).filter(([, r]) => r.at > cut);
}
// Superseded: queued before a restore this browser knows of (`known`) that no pass has checked it against yet.
const supersededBy = (rec, known) => rec.q < known && rec.r < known;
// id -> the confirm's server time, recorded within 30 days (final and superseded alike).
export function confirmedDeletes(kind) {
  return new Map(confirmRecords(kind).map(([id, r]) => [id, r.at]));
}
// id -> the confirm's sequence (confirmSeqNow), for the same records (0: none recorded).
export function confirmSeqs(kind) {
  return new Map(confirmRecords(kind).map(([id, r]) => [id, r.seq]));
}
// id -> the confirmed group's queue time (the record's own time for a record an older build wrote).
export function confirmQueuedAt(kind) {
  return new Map(confirmRecords(kind).map(([id, r]) => [id, r.q]));
}
// The confirmed ids of one kind split by the restore this browser knows of: `final` (the delete stands) and `superseded`
// (a restore came after it; the cloud decides at the next pass, sharedDeleteState).
export function confirmStates(kind) {
  const known = knownRestoreAt(), final = new Set(), superseded = new Set();
  for (const [id, r] of confirmRecords(kind)) (supersededBy(r, known) ? superseded : final).add(id);
  return { final, superseded };
}
// A restore brought these confirmed ids back (syncReconcile.js releaseRestored): their records go, so every tab may
// upload them again. Re-checked at the write: a record confirmed again at or after `sinceSeq` (deleted again during
// the pass) stays. Returns the ids released.
export function releaseConfirmed(kind, ids, sinceSeq) {
  const out = [];
  try {
    const all = readConfirmed(), recs = all[kind], seqs = readConfirmSeqs();
    if (!recs) return out;
    const own = seqs[kind] || {};
    for (const id of ids || []) if (id in recs && confirmRecord(recs[id], own[id]).seq < sinceSeq) { delete recs[id]; out.push(id); }
    if (out.length) {
      localStorage.setItem(CONFIRMED_KEY, JSON.stringify(all));
      try { writeConfirmSeqs(pruneConfirmSeqs(seqs, all)); } catch {}
      try { writeConfirmQueued(pruneConfirmQueued(readConfirmQueued(), all)); } catch {}
    }
  } catch {}
  return out;
}
// Task B9 (review round 22 #4/#6): the superseded records a pass can decide. `restoreKnownAt`: the restore marker this
// browser knew BEFORE the pass's cloud reads began (so the reads show the cloud after it); only records queued before it
// and not yet checked against it are decided. `present`: every id the cloud holds after the restore (task rows, items of
// cloud History entries, the restore's own removals: by_restore tombstones) -> released (the restore brought it back:
// its record goes). `complete`: the evidence was read in full, so an id absent from all of it stays deleted: the record
// becomes final (checked against `restoreKnownAt`; a later restore supersedes it again). Returns the released ids.
export function resolveSuperseded(kind, present, { restoreKnownAt, complete = false } = {}) {
  const out = [];
  const known = Number(restoreKnownAt);
  if (!(known > 0) || !(present instanceof Set)) return out;
  try {
    const all = readConfirmed(), recs = all[kind];
    if (!recs) return out;
    const qs = readConfirmQueued();
    let checked = false;
    for (const [id, r] of confirmRecords(kind)) {
      if (!supersededBy(r, known)) continue;
      if (present.has(id)) { delete recs[id]; out.push(id); }
      else if (complete) { (qs[kind] = qs[kind] || {})[id] = { q: r.q, c: r.at, r: known }; checked = true; }
    }
    if (out.length) {
      localStorage.setItem(CONFIRMED_KEY, JSON.stringify(all));
      try { writeConfirmSeqs(pruneConfirmSeqs(readConfirmSeqs(), all)); } catch {}
    }
    if (out.length || checked) { try { writeConfirmQueued(pruneConfirmQueued(qs, all)); } catch {} }
  } catch {}
  return out;
}

// ─── Task B7a (review round 20 #1, #3, #5, #8): the SHARED delete state decides every upload ───
// Several tabs may be open; the failed-sync queue (delete intents) and the confirmed-deletes record are shared by them,
// while each tab's React state and deletingIds are its own and may be stale (a frozen background tab). So no tab
// uploads a task / History row whose id has a delete intent pending in ANY tab, or whose delete was confirmed and not
// released by a restore (releaseConfirmed). Task B9 (review round 22): nor one a delete call of any tab has in flight.
// `kind`: "task" / "history". The ids whose uploads are blocked.
export function uploadBlockedIds(kind) {
  const del = kind === "task" ? "task-delete" : kind === "history" ? "history-delete" : null;
  if (!del) return new Set();
  return new Set([...pendingDeleteIds(del), ...inFlightIds(del), ...confirmedDeletes(del).keys()]);
}
// Task B9 (review round 22 #5/#7): what a History upload does with the items of deleted tasks. Only items of FINAL
// confirmed task ids are stripped (an entry left with no item is not sent: `skip`, its queued copy may go). A PENDING
// delete's own transaction strips its items server-side (delete_queued_rows), and the server strips tombstoned items from
// any later upload, so a pending id needs no strip here: stripping it lost the item for good when that delete was voided.
// An entry holding an item of a SUPERSEDED confirm (not decided yet) or of a delete call in flight is held back
// (`defer`: neither sent nor dropped, its queued copy stays): sent now, it could be the very cloud copy a pass takes as
// proof that the restore brought the generation back. Returns { upload, skip, defer }.
export function historyUploadPlan(entries) {
  const { final, superseded } = confirmStates("task-delete");
  const hold = new Set([...superseded, ...inFlightIds("task-delete")]);
  const ready = [], defer = [];
  for (const l of entries || []) {
    const items = Array.isArray(l?.tasks) ? l.tasks : [];
    (items.some(i => i?.id && hold.has(i.id) && !final.has(i.id)) ? defer : ready).push(l);
  }
  const { upload, skip } = withoutDeleting(ready, final);
  return { upload, skip, defer: defer.map(l => l?.id) };
}
// Every History sender passes its entries through this before uploadable (task B8a, review round 21 #1/#5): the entries
// to send now (historyUploadPlan).
export function withoutBlockedItems(entries) {
  return historyUploadPlan(entries).upload;
}
// The one upload filter (App.jsx sends every task / History upload through it): `items` (rows, queue entries or ids)
// without the blocked ones. A FINAL confirmed id's queued uploads leave the queue (none can ever be sent: addFailedSync
// refuses them, so one still queued is a stale copy); a pending, in-flight or superseded one's stay (that delete, call or
// the next pass decides: a void or a release sends them later).
export function uploadable(kind, items) {
  const list = Array.isArray(items) ? items : [...(items || [])];
  const del = kind === "task" ? "task-delete" : kind === "history" ? "history-delete" : null;
  if (!del) return list;
  const pending = pendingDeleteIds(del), flying = inFlightIds(del), { final, superseded } = confirmStates(del);
  const out = [], dead = new Set();
  for (const x of list) {
    const id = typeof x === "string" ? x : x?.id;
    if (!id) continue;
    if (final.has(id)) dead.add(id);
    else if (!superseded.has(id) && !pending.has(id) && !flying.has(id)) out.push(x);
  }
  if (dead.size) dropQueuedUploadsOf(kind, [...dead]);
  return out;
}
// One reconcile pass's view of the shared delete state for `kind` ("task" / "history"), App.jsx reconcileWithCloud:
//   released: the confirmed ids a restore brought back: superseded records the cloud holds again after the restore
//             (resolveSuperseded, task B9: task rows, items of cloud History entries, the restore's own removals), and
//             records whose rows are back (in `cloudIds`, confirmed before the pass began, `sinceSeq`, no intent pending
//             and no call in flight): their records go (releaseConfirmed), so they are added and uploaded again;
//   deleting: this tab's `deleting` plus every pending intent, every id in flight and every confirmed id not released
//             (the plans' input: nothing in it is added, removed or uploaded by the pass);
//   stale(rows): the ids of these local rows whose delete is FINAL and that the cloud lacks: this tab's stale copy goes
//             (delete means delete in every tab). A superseded one waits for the pass that decides it. `cloudIds` null
//             (unread): none, and nothing is released.
// `restoreKnownAt`: knownRestoreAt() taken before the pass's reads; `evidence`: { present: more ids the cloud holds after
// the restore, complete: whether every source was read } (resolveSuperseded). Omitted: no superseded record is decided.
export function sharedDeleteState(kind, { deleting = new Set(), cloudIds = null, sinceSeq, restoreKnownAt, evidence } = {}) {
  const del = kind === "task" ? "task-delete" : "history-delete";
  const known = cloudIds instanceof Set;
  const resolved = known && restoreKnownAt > 0
    ? resolveSuperseded(del, new Set([...cloudIds, ...(evidence?.present || [])]), { restoreKnownAt, complete: evidence ? evidence.complete === true : true })
    : [];
  const pending = pendingDeleteIds(del), flying = inFlightIds(del);
  const seqs = confirmSeqs(del);
  const back = known ? releaseRestored(seqs.keys(), new Set([...pending, ...flying]), cloudIds, seqs, sinceSeq) : [];
  const released = [...resolved, ...(back.length ? releaseConfirmed(del, back, sinceSeq) : [])];
  const { final, superseded } = confirmStates(del);
  const confirmed = new Set([...final, ...superseded]);
  const all = new Set([...(deleting || []), ...pending, ...flying, ...confirmed]);
  return { released, deleting: all, confirmed, final, superseded,
    stale: (rows) => (known ? (rows || []).filter(r => r?.id && final.has(r.id) && !cloudIds.has(r.id)).map(r => r.id) : []) };
}
// Task B7a (review round 20 #8): which of this tab's "being deleted" ids no longer are, derived each pass: no intent of
// this kind pending in the shared queue, no call of any tab in flight for it (task B9), and no hold of this tab left.
// `holds`: id -> Set of holds; an object is a delete call of this tab still running (its intent may not be queued yet,
// e.g. during the safety backup), a number is a queue time whose intents still pending keep the id (History entries a
// task delete's server work removes). A confirmed id stays excluded through the shared confirmed record, not through
// this set.
export function settledDeletingIds(deleting, kind, holds) {
  const pending = pendingDeleteIds(kind), flying = inFlightIds(kind);
  const out = [];
  for (const id of deleting || []) {
    if (pending.has(id) || flying.has(id)) continue;
    const h = holds?.get?.(id);
    if (h && [...h].some(x => (x && typeof x === "object") || (typeof x === "number" && intentsPendingAt(x)))) continue;
    out.push(id);
  }
  return out;
}

// A recorded confirmation (confirmedDeletes, 30 days) also stops a queued upload of that id (review round 19 #2/#3).
// Upload entries queued at or before the id's confirm (a stale copy a give-back put back keeps its original queue time)
// are removed and left out; one queued after it (the id came back by a restore and changed here) is kept. The mount
// replay, forceSaveAll and replayHistoryUploads pass their queued uploads through this. Returns the entries to send.
// Task B9: a superseded confirm's uploads are left out but stay queued (the next pass may release the id).
export function withoutConfirmedUploads(entries) {
  const confirmed = { task: confirmedDeletes("task-delete"), history: confirmedDeletes("history-delete") };
  const superseded = { task: confirmStates("task-delete").superseded, history: confirmStates("history-delete").superseded };
  const out = [];
  for (const e of entries || []) {
    const at = confirmed[e?.kind]?.get(e?.id);
    if (at != null && !((e.ts || 0) > at)) {
      if (!superseded[e.kind].has(e.id)) removeFailedSync(e.kind, e.id, f => (f.ts || 0) === (e.ts || 0));
      continue;
    }
    out.push(e);
  }
  return out;
}
// The queued uploads of this kind ("task" / "history") for these ids, removed in one write. `upTo` (a confirmed group's
// queue time, round 21 #8): only entries stamped at or before it; omitted: all of them.
function dropQueuedUploadsOf(upKind, ids, upTo) {
  try {
    const gone = new Set((ids || []).filter(Boolean));
    if (!gone.size) return;
    const bound = upTo == null ? Infinity : Number(upTo);
    if (Number.isNaN(bound)) return;
    const all = getFailedSyncs(), keep = all.filter(e => !(e.kind === upKind && gone.has(e.id) && (e.ts || 0) <= bound));
    if (keep.length !== all.length) localStorage.setItem(FAILED_KEY, JSON.stringify(keep));
  } catch {}
}

// The intents a confirmed delete settled (confirmDeleteIntents only: App.jsx never calls it directly, round 19 #3).
// `upTo`: the answered group's queue time; only intents queued at or before it go (task B7b, review round 20 #7). Omitted
// (null / undefined): every queue time of these ids. Removed in one write.
export function settleDeleteIntents(kind, ids, upTo) {
  try {
    const done = new Set(ids || []);
    if (!done.size) return;
    const bound = upTo == null ? Infinity : Number(upTo);
    if (Number.isNaN(bound)) return;   // an unreadable time settles nothing: the replay sends that group again
    localStorage.setItem(FAILED_KEY, JSON.stringify(getFailedSyncs().filter(e => !(e.kind === kind && done.has(e.id) && (e.ts || 0) <= bound))));
  } catch {}
}
// Review round 19 #1: a void answer is about ONE group, the intents queued at `at`. An id a later delete re-queued (its
// intent moved to a later time) keeps that intent: that delete is still pending. Removed in one write.
export function settleDeleteIntentsAt(kind, ids, at) {
  try {
    const done = new Set(ids || []), ts = Number(at);
    if (!done.size || !Number.isFinite(ts)) return;
    localStorage.setItem(FAILED_KEY, JSON.stringify(getFailedSyncs().filter(e => !(e.kind === kind && done.has(e.id) && (e.ts || 0) === ts))));
  } catch {}
}

// A rename moves every cloud row to the new account name; a favorites retry queued under the old name must follow it, or
// it is never sent nor removed. One account per browser (the app has a single owner), so any other scope is an earlier
// name of this account. When both names hold one, the newer snapshot wins.
export function rekeyFavoriteRetries(scope) {
  try {
    const list = getFailedSyncs();
    const favs = list.filter(e => e.kind === "model-favorites");
    if (!favs.some(e => e.scope !== scope)) return;
    const newest = favs.reduce((a, b) => ((b.data?.updatedAt || 0) > (a.data?.updatedAt || 0) ? b : a));
    const rest = list.filter(e => e.kind !== "model-favorites");
    localStorage.setItem(FAILED_KEY, JSON.stringify([...rest, { ...newest, id: scope, scope }]));
  } catch {}
}

// Clear Outputs / Reset Everything: a queued upload of a cleared row must never replay, or a generation whose upload had
// failed (never in the cloud, so no tombstone stops it) comes back. Returns the dropped ids per kind.
export function dropQueuedUploads(kinds) {
  const dropped = Object.fromEntries(kinds.map(k => [k, []]));
  try {
    const keep = [];
    for (const e of getFailedSyncs()) (kinds.includes(e.kind) ? dropped[e.kind].push(e.id) : keep.push(e));
    localStorage.setItem(FAILED_KEY, JSON.stringify(keep));
  } catch {}
  return dropped;
}

// Clear Outputs / Clear Logs / Reset act on what existed at their server-time snapshot (review round 13): the queued
// uploads are read BEFORE it (peek), only the planned ids leave the queue afterwards (take), and a voided clear puts the
// exact entries back (putBack). An upload queued after the snapshot (a generation started meanwhile) is never touched.
// The queued upload entries of these kinds, as copies; nothing is removed.
export function peekQueuedUploads(kinds) {
  const want = new Set(kinds || []);
  return getFailedSyncs().filter(e => want.has(e.kind)).map(e => ({ ...e }));
}
// Removes only the entries of this kind whose id is in `ids` and returns them (exact entries: ts, attempts, data).
export function takeQueuedUploads(kind, ids) {
  const want = new Set((ids || []).filter(Boolean));
  if (!want.size) return [];
  try {
    const taken = [], keep = [];
    for (const e of getFailedSyncs()) (e.kind === kind && want.has(e.id) ? taken.push(e) : keep.push(e));
    if (taken.length) localStorage.setItem(FAILED_KEY, JSON.stringify(keep));
    return taken;
  } catch { return []; }
}
// Re-inserts these exact entries (same ts/attempts/data) unless an entry of the same kind+id is queued already: that one
// was queued after the take, so it is newer and wins.
export function putBackQueuedUploads(entries) {
  if (!entries?.length) return;
  try {
    const list = getFailedSyncs();
    const have = new Set(list.map(e => `${e.kind}\u0000${e.id}`));
    for (const e of entries) {
      const key = `${e?.kind}\u0000${e?.id}`;
      if (!e?.kind || have.has(key)) continue;
      list.push(e); have.add(key);
    }
    localStorage.setItem(FAILED_KEY, JSON.stringify(list));
  } catch {}
}

// A clear whose call got no answer may be voided later, at a replay, by a restore that landed after it (restoreGuard,
// or the server's restore check). The rule then is that nothing of this device is lost (review round 14), but the
// in-memory copies the clear kept for its own voided branch are gone with the page. So before it takes anything from the
// queue, the clear stores what the cloud cannot give back: the queued upload entries it takes, and the planned
// tasks / History entries that only this device holds (not in its cloud read, no queued upload). Keyed by the clear's
// queue time (its intents' ts). Dropped when the clear answers, or once none of its intents is left queued.
const CLEAR_STASH_PREFIX = "proximaai-clear-stash:";
// The stash of one clear, kept small: only what the cloud does not have. `uploads`: the queue entries the clear will
// take; `tasks` / `logs`: the planned local items; `cloudTaskIds` / `cloudLogIds`: ids the cloud read held (null = no
// read: every planned local item counts as local-only). An item whose upload is stashed is carried by that entry.
export function buildClearStash({ uploads = [], tasks = [], logs = [], cloudTaskIds = null, cloudLogIds = null } = {}) {
  const queued = new Set((uploads || []).map(e => `${e?.kind}\u0000${e?.id}`));
  const local = (items, kind, cloud) => (items || []).filter(x => x && x.id && !(cloud && cloud.has(x.id)) && !queued.has(`${kind}\u0000${x.id}`));
  return { uploads: (uploads || []).filter(e => e && e.kind && e.id), tasks: local(tasks, "task", cloudTaskIds), logs: local(logs, "history", cloudLogIds) };
}
// Says whether it was stored (a full localStorage refuses it; the clear goes on, as it did before stashes existed).
// Optional parts (review round 15), stored only when present: `favorites` (Reset: the local favorites state it replaced,
// S3) and `archives` (task id -> an archive that finished while this clear held its task, S5).
export function writeClearStash(at, stash) {
  if (!Number.isFinite(Number(at))) return false;
  try {
    const out = { uploads: stash?.uploads || [], tasks: stash?.tasks || [], logs: stash?.logs || [], at: Number(at) };
    if (stash?.favorites) out.favorites = stash.favorites;
    if (stash?.archives && Object.keys(stash.archives).length) out.archives = stash.archives;
    if (Array.isArray(stash?.movedTo) && stash.movedTo.length) out.movedTo = stash.movedTo;
    localStorage.setItem(CLEAR_STASH_PREFIX + Number(at), JSON.stringify(out));
    return true;
  } catch { return false; }
}
const parseStash = (raw, at) => {
  const s = JSON.parse(raw || "null");
  if (!s) return null;
  const out = { uploads: Array.isArray(s.uploads) ? s.uploads : [], tasks: Array.isArray(s.tasks) ? s.tasks : [], logs: Array.isArray(s.logs) ? s.logs : [], at };
  if (s.favorites && typeof s.favorites === "object") out.favorites = s.favorites;
  if (s.archives && typeof s.archives === "object" && Object.keys(s.archives).length) out.archives = s.archives;
  if (Array.isArray(s.movedTo)) { const m = s.movedTo.map(Number).filter(Number.isFinite); if (m.length) out.movedTo = m; }
  return out;
};
// Every stored stash, oldest first.
export function readClearStashes() {
  const out = [];
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(CLEAR_STASH_PREFIX)) keys.push(k); }
    for (const k of keys) {
      const at = Number(k.slice(CLEAR_STASH_PREFIX.length));
      if (!Number.isFinite(at)) continue;
      try { const s = parseStash(localStorage.getItem(k), at); if (s) out.push(s); } catch {}
    }
  } catch {}
  return out.sort((a, b) => a.at - b.at);
}
// One clear's stash, or null.
export function readClearStash(at) {
  if (!Number.isFinite(Number(at))) return null;
  try { return parseStash(localStorage.getItem(CLEAR_STASH_PREFIX + Number(at)), Number(at)); } catch { return null; }
}
export function dropClearStash(at) {
  try { localStorage.removeItem(CLEAR_STASH_PREFIX + Number(at)); } catch {}
}
// The archived file paths a stash's archive records hold.
export function stashArchivePaths(stash) {
  return Object.values(stash?.archives || {}).flatMap(a => (Array.isArray(a?.paths) ? a.paths : [])).filter(Boolean);
}
// Confirmed deletes leave every stash (review round 15 S2): a later void of the clear must not give back an item whose
// delete already succeeded, nor its taken upload. Returns the archived paths of confirmed tasks' archive records (S5:
// their files go through the file-delete queue now).
// `upTo` (task B8a, review round 21 #8): the confirmed group's queue time; only the stashes of clears queued at or before
// it. A later clear's stash (the id came back by a restore and was cleared again) keeps it: that clear's own void gives it
// back, its confirm drops it. Omitted: every stash. (Task B9: a late confirm of an earlier group records the id again,
// with that group's queue time; the later stash keeps it, and its give-back asks giveBackRule, which keeps a superseded
// record's id until a pass decides it.)
export function forgetStashedIds(kind, ids, upTo) {
  const gone = new Set((ids || []).filter(Boolean));
  const paths = [];
  if (!gone.size || (kind !== "task-delete" && kind !== "history-delete")) return paths;
  const bound = upTo == null ? Infinity : Number(upTo);
  if (Number.isNaN(bound)) return paths;
  const isTask = kind === "task-delete", upKind = isTask ? "task" : "history", field = isTask ? "tasks" : "logs";
  for (const s of readClearStashes()) {
    if (s.at > bound) continue;
    let changed = false;
    const items = s[field].filter(x => !gone.has(x?.id));
    const uploads = s.uploads.filter(e => !(e?.kind === upKind && gone.has(e.id)));
    if (items.length !== s[field].length || uploads.length !== s.uploads.length) changed = true;
    const archives = { ...(s.archives || {}) };
    if (isTask) for (const id of Object.keys(archives)) if (gone.has(id)) { paths.push(...stashArchivePaths({ archives: { [id]: archives[id] } })); delete archives[id]; changed = true; }
    if (changed) writeClearStash(s.at, { ...s, [field]: items, uploads, archives });
  }
  return paths;
}
// An archive that finished while a clear held its task (review round 15 S5): recorded in the stash of the clear whose
// task-delete intent for that task is still pending (by its queue time). Says whether it was recorded; false (no such
// clear, no stash, or no room): the caller queues the uploaded files for deletion, as before.
// `record`: { task: the archived version (null when every upload failed), paths: the uploaded paths }.
export function recordStashArchive(taskId, record) {
  if (!taskId) return false;
  const intent = getFailedSyncs().find(e => e.kind === "task-delete" && e.id === taskId);
  if (!intent) return false;
  const s = readClearStash(intent.ts || 0);
  if (!s) return false;
  const prev = s.archives?.[taskId];
  const paths = [...new Set([...(Array.isArray(prev?.paths) ? prev.paths : []), ...(record?.paths || [])])];
  return writeClearStash(s.at, { ...s, archives: { ...(s.archives || {}), [taskId]: { task: record?.task || prev?.task || null, paths } } });
}
// What a voided clear's stash gives back (review round 15 S1), or null while ANY of its intents (task or History, at
// its queue time) is still pending: that clear is not settled yet, and its remaining group's own void or confirm decides
// (a task group voided first must not give back the stash while its History group still holds the entries back).
// Review round 19 #2: NOTHING of an id queued for deletion again by ANOTHER clear or delete (another queue time) comes
// back: not its task / History entry, not its queued upload, not its archive record. All of it stays in the stash's kept
// part (dropGivenBackStash), so that time's void gives it back and its confirm drops it (forgetStashedIds: archive paths
// deleted then). Nothing is moved to another stash nor orphaned to the file-delete queue while that delete is pending.
// Task B8b (review round 21 #3): the per-id decision goes through giveBackRule, the same one inlineVoidPutBack uses, so
// an id confirmed after the clear's queue time (another tab's delete confirmed while this clear read the cloud, its stash
// written only afterwards) is left out here too. `goneArchivePaths`: the archived files of such ids' archive records,
// for the caller's file-delete queue (their delete is confirmed; the record is not given back nor kept).
export function stashGiveBack(stash) {
  if (!stash || intentsPendingAt(stash.at)) return null;
  const decide = giveBackRule(stash.at);
  const { tasks, logs } = stashedItems(stash, { decide });
  const parts = splitStash(stash, decide);
  return { uploads: parts.back.uploads, tasks, logs, archives: parts.back.archives, favorites: stash.favorites || null,
    goneArchivePaths: stashArchivePaths({ archives: parts.gone.archives }) };
}
// THE give-back rule (task B8b, review round 21 #3) of a voided clear queued at `at`, for one id of kind "task" or
// "history", shared by the stash give-back (stashGiveBack / stashedItems / splitStash / dropGivenBackStash) and the
// inline voided branches (inlineVoidPutBack). Task B9 (review round 22):
// - "keep": pending deletion of its kind at ANOTHER time, or in flight in a delete call of any tab (its answer may still
//   be "deleted": the server may have deleted it already), or its confirm is SUPERSEDED by a restore and no pass has
//   decided it yet: kept (its time's void gives it back, its confirm drops it; a kept stash part is decided again at the
//   next give-back, once the call answered or the pass decided);
// - "gone": its delete is a FINAL confirm (no restore this browser knows of came after its queue time);
// - "back": everything else (and every upload entry of another kind).
// The B8b comparison "confirmed after the clear's queue time" is gone: a voided clear always has a restore after it
// (noted by voidDeleteIntents / restoreGuard), so a confirm queued before the clear is superseded, never final.
// Returns (kind, id) => decision.
export function giveBackRule(at) {
  const ts = Number(at);
  const pending = { task: pendingDeleteIds("task-delete", { exceptAt: ts }), history: pendingDeleteIds("history-delete", { exceptAt: ts }) };
  const flying = { task: inFlightIds("task-delete"), history: inFlightIds("history-delete") };
  const states = { task: confirmStates("task-delete"), history: confirmStates("history-delete") };
  return (kind, id) => {
    if (kind !== "task" && kind !== "history") return "back";
    if (!id) return "gone";
    if (pending[kind].has(id) || flying[kind].has(id) || states[kind].superseded.has(id)) return "keep";
    return states[kind].final.has(id) ? "gone" : "back";
  };
}
// A stash's uploads and archive records, split into what a give-back returns (`back`), what belongs to an id still
// pending deletion at another time (`kept`) and what belongs to an id confirmed after the clear (`gone`). `decide`: a
// giveBackRule (or, for older callers, the pending-elsewhere task / History sets).
function splitStash(stash, decide, deletingLogs) {
  const rule = typeof decide === "function" ? decide : setsRule(decide, deletingLogs);
  const back = { uploads: [], archives: {} }, kept = { uploads: [], archives: {} }, gone = { uploads: [], archives: {} };
  const part = (d) => (d === "keep" ? kept : d === "gone" ? gone : back);
  for (const e of stash?.uploads || []) part(rule(e?.kind, e?.id)).uploads.push(e);
  for (const [id, rec] of Object.entries(stash?.archives || {})) part(rule("task", id)).archives[id] = rec;
  return { back, kept, gone };
}
const setsRule = (deletingTasks = new Set(), deletingLogs = new Set()) => (kind, id) =>
  ((kind === "task" ? deletingTasks : kind === "history" ? deletingLogs : null)?.has(id) ? "keep" : "back");
// The local items a voided clear's stash gives back: its tasks and History entries plus the data of the upload entries
// it took, each id once, only those the rule gives back (`decide`, a giveBackRule; without one, none that is in
// `deletingTasks` / `deletingLogs`).
export function stashedItems(stash, { deletingTasks = new Set(), deletingLogs = new Set(), decide = null } = {}) {
  const rule = decide || setsRule(deletingTasks, deletingLogs);
  const pick = (items, kind) => {
    const byId = new Map();
    for (const x of [...(items || []), ...(stash?.uploads || []).filter(e => e?.kind === kind).map(e => e.data)])
      if (x && typeof x === "object" && x.id && !byId.has(x.id) && rule(kind, x.id) === "back") byId.set(x.id, x);
    return [...byId.values()];
  };
  return { tasks: pick(stash?.tasks, "task"), logs: pick(stash?.logs, "history") };
}

// Review round 16 #5: an id a clear queued may be queued again by a later clear or delete (queueDeleteIntents moves its
// intent to the newer queue time). The earlier clear can then end with no intent of its own while the later one is still
// pending, and dropping its stash as "confirmed" would throw away what it holds (a Reset's real favorites, the uploads it
// took). So every stash whose clear lost ids to time `to` (or that already points at a time that lost them: a plain
// delete keeps no stash) records `to` in `movedTo`, and it is decided only once every one of those times is (stashDecision).
// Task B5: it stays under its own key until then (the merge into the newest pending target, moveClearStash, is gone: a
// stash whose ids moved to TWO times followed only the newest one, and lost the other's ids when that one was confirmed).
function noteStashMoves(fromTimes, to) {
  for (const s of readClearStashes()) {
    if (s.at === to) continue;
    const moved = s.movedTo || [];
    if (!(fromTimes.has(s.at) || moved.some(t => fromTimes.has(t))) || moved.includes(to)) continue;
    writeClearStash(s.at, { ...s, movedTo: [...moved, to] });
  }
}
// The favorites a stash gives back when `newer` (a later Reset's) and `older` (an earlier one's) meet: when the later
// reset replaced the earlier one's emptied state (its updatedAt is the earlier resetAt), the earlier state comes back,
// guarded by the later reset's time; otherwise (a choice made in between) the later one's.
export function chainStashFavorites(newer, older) {
  if (!newer) return older || null;
  if (older && older.resetAt > 0 && newer.updatedAt === older.resetAt)
    return { ...older, scope: newer.scope || older.scope, resetAt: newer.resetAt };
  return newer;
}
// A Reset's favoritesBefore (round 16 #5): while an earlier unsettled Reset's stash holds favorites whose resetAt is the
// current favorites' updatedAt, the current favorites are that reset's emptied state, so the earlier favoritesBefore
// (its setting, updatedAt and queued upload) is what this reset replaces. `scope`: the favorites scope of this device.
export function chainedFavoritesBefore(before, scope) {
  if (!before) return before;
  const stashes = readClearStashes().reverse();
  for (const s of stashes) {
    const f = s.favorites;
    if (!f || !(f.resetAt > 0) || f.resetAt !== before.updatedAt) continue;
    if (f.scope && scope && f.scope !== scope) continue;
    return { ...before, byType: f.byType, updatedAt: f.updatedAt, setting: f.setting ?? null, queued: Array.isArray(f.queued) ? f.queued : [] };
  }
  return before;
}
// Task B5: what a settle pass does with a stash (App.jsx settleClearStashes). "wait" while an intent is pending at its own
// queue time or at ANY time its ids moved to (movedTo): each of those voids or confirms its own ids. Once none is:
// "give-back" if one of them is a recorded voided time (what is left in it is only content whose deletes were not
// confirmed: confirmed ids already left every stash, forgetStashedIds), otherwise "drop" (its archive paths deleted).
// Stashes merged by older builds (content inside a target's stash) simply follow that target.
export function stashDecision(stash, voided = voidedTimes()) {
  if (!stash) return "wait";
  const times = [stash.at, ...(stash.movedTo || [])];
  if (times.some(t => intentsPendingAt(t))) return "wait";
  return times.some(t => voided.has(t)) ? "give-back" : "drop";
}
// After a give-back (App.jsx applyClearStashes): the stash goes, except everything stashGiveBack left out because its id is
// still pending deletion at another time: its local items, its queued upload entries and its archive records (round 19
// #2: those were put back / moved / orphaned before). That kept part stays under this key and follows the times those
// ids are pending at (added to `movedTo`), so that time's own void gives it back (as a follower) and its confirm removes
// it (forgetStashedIds, archive paths deleted then). Task B5: dropping the whole stash lost them on a later void.
export function dropGivenBackStash(stash) {
  if (!stash) return;
  // The same rule as the give-back (task B8b, review round 21 #3): only the "keep" part stays.
  const decide = giveBackRule(stash.at);
  const tasks = (stash.tasks || []).filter(x => x?.id && decide("task", x.id) === "keep");
  const logs = (stash.logs || []).filter(x => x?.id && decide("history", x.id) === "keep");
  const { kept } = splitStash(stash, decide);
  if (tasks.length || logs.length || kept.uploads.length || Object.keys(kept.archives).length) {
    // The times the kept ids are pending at, so the kept part is decided by them (stashDecision, stashFollowers).
    const keptTasks = new Set([...tasks.map(x => x.id), ...kept.uploads.filter(e => e.kind === "task").map(e => e.id), ...Object.keys(kept.archives)]);
    const keptLogs = new Set([...logs.map(x => x.id), ...kept.uploads.filter(e => e.kind === "history").map(e => e.id)]);
    const times = new Set((stash.movedTo || []).filter(t => t !== stash.at));
    for (const e of getFailedSyncs()) {
      const ts = e.ts || 0;
      if (ts !== stash.at && ((e.kind === "task-delete" && keptTasks.has(e.id)) || (e.kind === "history-delete" && keptLogs.has(e.id)))) times.add(ts);
    }
    if (writeClearStash(stash.at, { uploads: kept.uploads, tasks, logs, archives: kept.archives, movedTo: [...times] })) return;
  }
  dropClearStash(stash.at);
}
// Task B7b (review round 20 #2/#6): what the INLINE voided branch of Clear Outputs, Reset and Clear Logs may put back from
// its in-memory copies, by the same rule a later void's give-back follows (stashGiveBack / splitStash / stashedItems):
// - an id still pending deletion of its kind at ANOTHER time (another tab's delete, a clear pressed again), in flight in
//   a delete call of any tab, or whose confirm a restore superseded and no pass has decided yet (task B9, review round
//   22) is not put back: its items and taken uploads join the clear's stash at `at` as the kept part (the caller's
//   applyClearStashes then keeps it there: dropGivenBackStash), so that time's void, that call's answer or that pass
//   decides it at the next give-back;
// - an id whose delete is a FINAL confirm is left out entirely (a confirmed delete never comes back; its confirm already
//   took it out of every stash and the upload queue);
// - everything else comes back; the uploads only through the shared upload filter (uploadable).
// Task B8b (review round 21 #3): the per-id decision is giveBackRule, the one stashGiveBack uses, so both answer the
// same for the same id (an id confirmed between the clear's snapshot and its stash write was given back by the stash).
// Call it after the clear's own intents are settled (voidDeleteIntents at `at`). `held`: { tasks, logs, uploads }: the
// tasks and History entries the clear removed here and the queue entries it took. Returns them, filtered.
export function inlineVoidPutBack(at, { tasks = [], logs = [], uploads = [] } = {}) {
  const ts = Number(at);
  const decide = giveBackRule(ts);
  const kept = { tasks: [], logs: [], uploads: [] };
  const split = (items, kind, field) => {
    const out = [];
    for (const x of items || []) {
      const d = decide(kind, x?.id);
      if (d === "keep") kept[field].push(x); else if (d === "back") out.push(x);
    }
    return out;
  };
  const backTasks = split(tasks, "task", "tasks"), backLogs = split(logs, "history", "logs");
  const backUploads = [];
  for (const e of uploads || []) {
    if (!e?.kind) continue;
    const d = decide(e.kind, e.id);
    if (d === "keep") kept.uploads.push(e); else if (d === "back") backUploads.push(e);
  }
  if (kept.tasks.length || kept.logs.length || kept.uploads.length) {
    const s = readClearStash(ts) || { uploads: [], tasks: [], logs: [] };
    const merge = (have, add, key) => { const ids = new Set(add.map(key)); return [...add, ...(have || []).filter(x => !ids.has(key(x)))]; };
    const ukey = (e) => `${e?.kind}\u0000${e?.id}`;
    writeClearStash(ts, { ...s, tasks: merge(s.tasks, kept.tasks, x => x?.id), logs: merge(s.logs, kept.logs, x => x?.id), uploads: merge(s.uploads, kept.uploads, ukey) });
  }
  return {
    tasks: backTasks, logs: backLogs,
    uploads: [...uploadable("task", backUploads.filter(e => e.kind === "task")), ...uploadable("history", backUploads.filter(e => e.kind === "history")),
      ...backUploads.filter(e => e.kind !== "task" && e.kind !== "history")],
  };
}
// Review round 17 (#1, #3, #6): a stash's fate follows the clear its ids moved to. The followers of the clear at `ts`:
// stashes with no intent of their own pending whose `movedTo` includes `ts` (transitive: noteStashMoves records every
// later time on a stash already pointing at one that lost ids). None while an intent at `ts` is still pending: that
// clear is not settled yet, and its remaining group's void or confirm decides (as stashGiveBack waits, round 15 S1).
export function stashFollowers(ts) {
  const at = Number(ts);
  const out = new Set();
  if (!Number.isFinite(at) || intentsPendingAt(at)) return out;
  for (const s of readClearStashes()) if (s.at !== at && (s.movedTo || []).includes(at) && !intentsPendingAt(s.at)) out.add(s.at);
  return out;
}
// Which stashes a VOIDED clear at `ts` gives back (App.jsx applyClearStashes): its own (with whatever an older build's
// merge put into it) and its followers. Read before any settle pass can drop a follower as confirmed.
export function voidedClearStashes(ts) {
  const at = Number(ts), followers = stashFollowers(at);
  return (s) => s === at || followers.has(s);
}
// Review round 18 #3: that a delete or clear was VOIDED is a recorded fact, not a duty of each call site. An inline void
// of a plain delete (no stash of its own) once settled its intents without giving back the stashes whose ids had moved to
// it, and the next settleClearStashes dropped them as confirmed (their archive files queued for deletion). So every void
// goes through voidDeleteIntents, which settles AND records the queue time here; settleClearStashes then gives back
// (App.jsx applyClearStashes), never drops, a settled stash tied to a recorded time (stashTiedToVoided). That also covers
// a follower whose own last group settles only after its target's void was handled (two tabs). Confirmed ids already
// left every stash (forgetStashedIds), so a give-back never returns a confirmed delete. Shared by the browser's tabs;
// a time is kept while a stash refers to it (its `at` or `movedTo`), and 30 days at most.
const VOIDED_AT_KEY = "proximaai-voided-at";
const VOIDED_FOR_MS = 30 * 24 * 60 * 60 * 1000;
const readVoidedAt = () => {
  try { const v = JSON.parse(localStorage.getItem(VOIDED_AT_KEY) || "{}"); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; }
};
// The recorded voided queue times (server ms), recorded within 30 days.
export function voidedTimes() {
  const cut = Date.now() - VOIDED_FOR_MS, out = new Set();
  for (const [t, rec] of Object.entries(readVoidedAt())) { const at = Number(t); if (Number.isFinite(at) && rec > cut) out.add(at); }
  return out;
}
// Drops the times no stash refers to any more, and those recorded over 30 days ago.
export function pruneVoidedAt() {
  try {
    const all = readVoidedAt(), keys = Object.keys(all);
    if (!keys.length) { if (localStorage.getItem(VOIDED_AT_KEY) != null) localStorage.removeItem(VOIDED_AT_KEY); return; }
    const refs = new Set();
    for (const s of readClearStashes()) { refs.add(s.at); for (const t of s.movedTo || []) refs.add(t); }
    const cut = Date.now() - VOIDED_FOR_MS;
    let changed = false;
    for (const k of keys) if (!(all[k] > cut) || !refs.has(Number(k))) { delete all[k]; changed = true; }
    if (!changed) return;
    if (Object.keys(all).length) localStorage.setItem(VOIDED_AT_KEY, JSON.stringify(all)); else localStorage.removeItem(VOIDED_AT_KEY);
  } catch {}
}
// Records these queue times (one or a list/Set) as voided.
export function recordVoidedAt(times) {
  const list = (times instanceof Set || Array.isArray(times) ? [...times] : [times]).map(Number).filter(Number.isFinite);
  if (!list.length) return;
  try {
    const all = readVoidedAt(), now = Date.now();
    for (const t of list) all[t] = now;
    localStorage.setItem(VOIDED_AT_KEY, JSON.stringify(all));
  } catch {}
  pruneVoidedAt();
}
// The one way a void answer leaves the queue: settles the voided intents of the group queued at `at` (only that group,
// round 19 #1: an id re-queued at a later time keeps its intent) and records `at`. The caller then gives back
// applyClearStashes(voidedClearStashes(at)) at once; the record covers what it cannot see yet. Returns the ids that are
// no longer being deleted (no intent of this kind left at any time): only those may leave the caller's deleting set.
export function voidDeleteIntents(kind, ids, at) {
  settleDeleteIntentsAt(kind, ids, at);
  if ((ids || []).some(Boolean)) {
    recordVoidedAt(at);
    // Task B9 (review round 22): a void answer proves a restore newer than `at`: every confirm queued before `at` is
    // superseded by it. And this call's answer is handled for these ids (in flight no more).
    noteRestoreKnown(at);
    landFlightIds(kind, ids, at);
  }
  const still = pendingDeleteIds(kind);
  return (ids || []).filter(id => id && !still.has(id));
}
// Whether this stash is decided and tied to a voided time: nothing pending at its own queue time nor at any time its ids
// moved to (task B5), and one of them recorded voided. Such a stash is given back, never dropped as confirmed.
export function stashTiedToVoided(stash, voided = voidedTimes()) {
  if (!stash || intentsPendingAt(stash.at) || !voided.size) return false;
  return stashDecision(stash, voided) === "give-back";
}
// Clear Logs' stash (round 16 #6): every planned History entry the cloud lacks, loaded or stored only, plus the uploads
// it takes (an entry with a stashed upload is carried by it). `cloudLogIds`: the cloud's History ids read before the
// snapshot, or null when the read failed (then every planned entry without a stashed upload). `loadedOnly`: the
// fallback for a full localStorage.
export function clearLogsStash({ loaded = [], stored = [], uploads = [], planned, cloudLogIds = null } = {}) {
  const isPlanned = (x) => x && x.id && (!planned || planned.has(x.id));
  const loadedLogs = (loaded || []).filter(isPlanned);
  const loadedIds = new Set(loadedLogs.map(l => l.id));
  const storedOnly = (stored || []).filter(l => isPlanned(l) && !loadedIds.has(l.id));
  const ups = (uploads || []).filter(e => e?.kind === "history" && isPlanned(e));
  return {
    full: buildClearStash({ uploads: ups, logs: [...loadedLogs, ...storedOnly], cloudLogIds }),
    loadedOnly: buildClearStash({ uploads: ups, logs: loadedLogs, cloudLogIds }),
  };
}

export function clearFailedSyncs() {
  try { localStorage.removeItem(FAILED_KEY); } catch {}
}
