// ─── ProximaAI IndexedDB Storage Layer ───
// Optimized for: tasks with outputs, generation history, settings, favorites, presets
// Falls back to localStorage if IndexedDB unavailable.

import { planResume, rememberReleased, liveReleased, noteClaimants, liveClaimants, dropClaimants } from "./taskResume.js";

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
// uses (fileDelete.js liveFormPaths, review #3). One key per page load, so a duplicated tab never shares one.
const FORM_KEY = "proximaai-form-inputs:";
const TAB_ID = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const STALE_FORM_KEY_MS = 24 * 60 * 60 * 1000;
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

const FAILED_KEY = "proximaai-failed-syncs";

export function getFailedSyncs() {
  try { return JSON.parse(localStorage.getItem(FAILED_KEY) || "[]"); }
  catch { return []; }
}

export function addFailedSync(entry) {
  try {
    const list = getFailedSyncs();
    // Dedupe by kind+id (don't pile up duplicates for the same task/log)
    const existingIdx = list.findIndex(e => e.kind === entry.kind && e.id === entry.id);
    const withMeta = { ...entry, ts: Date.now(), attempts: (entry.attempts || 0) + 1 };
    if (existingIdx >= 0) list[existingIdx] = withMeta;
    else list.push(withMeta);
    // Cap at 200 entries to prevent unbounded growth. Delete intents are never dropped: a dropped one brings a deleted
    // row back on the next reload (review wf_ec400a67-988 #2). The oldest uploads go first, never the newest entry, and
    // deletes alone may exceed the cap.
    for (let i = 0; list.length > 200 && i < list.length - 1; ) {
      if (/-delete$/.test(list[i].kind)) i++; else list.splice(i, 1);
    }
    localStorage.setItem(FAILED_KEY, JSON.stringify(list));
  } catch {}
}

// For a confirmed upload: clears the queue entry only while it still holds the exact version that was sent.
export const sentVersion = (data) => { const sent = JSON.stringify(data); return (e) => JSON.stringify(e.data) === sent; };

// `onlyIf(entry)`: remove the entry only while it still matches, e.g. still the "processing" version a finished upload
// sent, not the "completed" version that replaced it in the queue meanwhile.
export function removeFailedSync(kind, id, onlyIf) {
  try {
    const list = getFailedSyncs().filter(e => !(e.kind === kind && e.id === id && (!onlyIf || onlyIf(e))));
    localStorage.setItem(FAILED_KEY, JSON.stringify(list));
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

export function clearFailedSyncs() {
  try { localStorage.removeItem(FAILED_KEY); } catch {}
}
