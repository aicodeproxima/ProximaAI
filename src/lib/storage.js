// ─── ProximaAI IndexedDB Storage Layer ───
// Optimized for: tasks with outputs, generation history, settings, favorites, presets
// Falls back to localStorage if IndexedDB unavailable.

import { planResume, rememberReleased, liveReleased, noteClaimants, liveClaimants, dropClaimants } from "./taskResume.js";
import { FORM_HOLD_ALIVE_MS } from "./fileDelete.js";
import { serverNow } from "./serverClock.js";

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
export function removeFailedSync(kind, id, onlyIf) {
  try {
    const list = getFailedSyncs().filter(e => !(e.kind === kind && e.id === id && (!onlyIf || onlyIf(e))));
    localStorage.setItem(FAILED_KEY, JSON.stringify(list));
  } catch {}
}

// Clear Outputs / Clear Logs / Reset Everything: every removed id's delete intent, written in one go BEFORE the clear
// request fires (CLAUDE.md queue-first), so a tab killed mid-clear replays it and the mount replay keeps those ids
// deleting (review wf_ec400a67-988 #1). Delete intents are never capped.
export function queueDeleteIntents(kind, ids) {
  try {
    const want = new Set((ids || []).filter(Boolean));
    if (!want.size) return;
    const now = serverNow();   // server time: compared with a restore's (restoreGuard)
    const list = getFailedSyncs().filter(e => !(e.kind === kind && want.has(e.id)));
    for (const id of want) list.push({ kind, id, data: id, ts: now, attempts: 1 });
    localStorage.setItem(FAILED_KEY, JSON.stringify(list));
  } catch {}
}
// A restore on any device (settings 'last_restore_at', epoch ms; migration 20261022180000) supersedes every delete
// intent queued before it: replayed, a pending clear would delete what the restore brought back (review round 2).
// Returns the dropped ids per kind, so the caller stops treating them as being deleted.
export function dropDeleteIntentsBefore(ts) {
  const dropped = { task: [], history: [] };
  if (!(ts > 0)) return dropped;
  try {
    const keep = [];
    for (const e of getFailedSyncs()) {
      const kind = e.kind === "task-delete" ? "task" : e.kind === "history-delete" ? "history" : null;
      if (kind && (e.ts || 0) < ts) dropped[kind].push(e.id); else keep.push(e);
    }
    if (dropped.task.length || dropped.history.length) localStorage.setItem(FAILED_KEY, JSON.stringify(keep));
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
const readConfirmed = () => { try { return JSON.parse(localStorage.getItem(CONFIRMED_KEY) || "{}") || {}; } catch { return {}; } };
export function confirmDeleteIntents(kind, ids) {
  settleDeleteIntents(kind, ids);
  if (kind !== "task-delete" && kind !== "history-delete") return;
  try {
    const all = readConfirmed(), now = Date.now(), cut = now - CONFIRMED_FOR_MS;
    for (const k of Object.keys(all)) for (const [id, at] of Object.entries(all[k] || {})) if (!(at > cut)) delete all[k][id];
    all[kind] = all[kind] || {};
    for (const id of ids || []) if (id) all[kind][id] = now;
    localStorage.setItem(CONFIRMED_KEY, JSON.stringify(all));
  } catch {}
}
export function confirmedDeletes(kind) {
  const cut = Date.now() - CONFIRMED_FOR_MS;
  return new Map(Object.entries(readConfirmed()[kind] || {}).filter(([, at]) => at > cut));
}

// The intents a confirmed clear settled (clearOutcome.js clearSettlement), removed in one write.
export function settleDeleteIntents(kind, ids) {
  try {
    const done = new Set(ids || []);
    if (!done.size) return;
    localStorage.setItem(FAILED_KEY, JSON.stringify(getFailedSyncs().filter(e => !(e.kind === kind && done.has(e.id)))));
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
