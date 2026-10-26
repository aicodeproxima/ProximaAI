// ─── ProximaAI IndexedDB Storage Layer ───
// Optimized for: tasks with outputs, generation history, settings, favorites, presets
// Falls back to localStorage if IndexedDB unavailable.

import { planResume, rememberReleased, liveReleased, noteClaimants, liveClaimants, dropClaimants, putBackClaimantRecords } from "./taskResume.js";
import { FORM_HOLD_ALIVE_MS, queueFileDeletes } from "./fileDelete.js";
import { pathsInUse, ENTRY_OWNER } from "./purge.js";
import { queueDeletes } from "./wsDelete.js";
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
let dbHandle = null;   // the open database once dbPromise resolved (task B15: transactions created synchronously)

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
    request.onsuccess = () => {
      dbHandle = request.result;
      try { dbHandle.onclose = () => { dbHandle = null; dbPromise = null; }; } catch {}
      resolve(request.result);
    };
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

// Task B13b (simulator I2, seed 12378): which of `stored` (copies a voided clear gives back to IndexedDB that this tab's
// state lacks) a page load would show next to `loaded` (this tab's state after the give-back): the newest `limit` of both
// by `time` (getHistory / getCompletedTasks load the newest 500). Those go back into state too, as loaded (saved). A
// voided Reset or Clear Logs gave back the entries it found only in IndexedDB to IndexedDB alone ("beyond the loaded
// ones"), but an entry an earlier clear of this tab, still in its call, had just taken out of state is one of the loaded
// ones: it stayed out of state, so no pass uploaded it, and its upload a restore had dropped (restoreGuard) never came
// back: the entry was lost from the cloud while every device thought it kept.
export const LOAD_LIMIT = 500;
export function intoLoadedView(stored, loaded, { time = () => 0, limit = LOAD_LIMIT } = {}) {
  const have = new Set((loaded || []).map(x => x?.id).filter(Boolean));
  const cands = (stored || []).filter(x => x?.id && !have.has(x.id));
  if (!cands.length) return [];
  const all = [...(loaded || []).filter(x => x?.id), ...cands].sort((a, b) => (Number(time(b)) || 0) - (Number(time(a)) || 0));
  const top = new Set(all.slice(0, limit).map(x => x.id));
  return cands.filter(x => top.has(x.id));
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

// Task B15 (review round 28 #1/#3/#5): puts `items` into `storeName` in a transaction CREATED before this returns when
// the database is open. IndexedDB orders the transactions on one store by creation, across tabs: a read another tab
// creates after this call sees the write. A voided clear's give-back writes this way and only then drops its stash, so
// another tab's pass finds the given-back generation in the stash (read before its IndexedDB read) or in IndexedDB.
// Database not open yet (or the call throws): the async path. Resolves once written (or failed).
function putNow(storeName, items, fallback) {
  if (!Array.isArray(items) || !items.length) return Promise.resolve();
  if (!dbHandle) return fallback();
  try {
    const txn = dbHandle.transaction(storeName, "readwrite");
    const store = txn.objectStore(storeName);
    for (const item of items) { try { store.put(item); } catch {} }
    return new Promise((res) => { txn.oncomplete = () => res(); txn.onerror = () => res(); txn.onabort = () => res(); });
  } catch { return fallback(); }
}
export const saveTasksNow = (taskList) => putNow("tasks", taskList, () => saveTasks(taskList));
export const addHistoryEntriesNow = (entries) => putNow("history", entries, () => Promise.all((entries || []).map(addHistoryEntry)));

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
// Review round 24 #2/#4: says whether the write was stored (false: a full localStorage refused it). Callers that move
// items out of another key (releaseHeldPurges) remove them there only when it was.
export const writeWsDeletes = (q) => { try { localStorage.setItem(WS_DELETES_KEY, JSON.stringify(q || {})); return true; } catch { return false; } };

// Files of deleted generations still to delete (fileDelete.js). Left alone by sign-out: those paths still need deleting.
const FILE_DELETES_KEY = "proximaai-file-deletes";
export const readFileDeletes = () => { try { return JSON.parse(localStorage.getItem(FILE_DELETES_KEY) || "{}") || {}; } catch { return {}; } };
export const writeFileDeletes = (q) => { try { localStorage.setItem(FILE_DELETES_KEY, JSON.stringify(q || {})); return true; } catch { return false; } };

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
  // Review round 23 #1 (guard): a dead page's form key goes, and so do its delete calls in flight (a previous build
  // wrote this tab id as their `tab`).
  tabPresence({ id: TAB_ID, prevId: PREV_TAB_ID, release: (p) => { try { localStorage.removeItem(FORM_KEY + p); } catch {} dropFlightsOfTab(p); } });
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
// Task B13c (simulator class B): the bucket paths this browser's queued, not yet uploaded task and History rows use (the
// failed-sync queue, shared by its tabs: a closing tab never withdraws them). Published with the forms' holds and held
// by this browser's own flush: a batch input a sibling row still waiting to upload here needs (a frozen phone) is in no
// other device's view, no cloud row and, once this form let go of it, no form hold, so another device deleted it and the
// sibling landed later without its input. Once the row is sent it leaves the queue, and the path leaves the set at the
// next publication (by then the cloud row holds it: paths_in_use).
export function unsentUploadPaths() {
  try {
    return pathsInUse(unsentUploads().map(f => f.data));
  } catch { return new Set(); }
}
// The task and History uploads this browser has not sent yet: the failed-sync queue, and (task B16, review round 29
// #3/#4) the ones a pending clear took into its stash, which a restore that voids that clear puts back and sends.
// Task B17 (review round 30 #3): only what can still be sent. A row or entry whose delete is FINAL never uploads (addFailedSync
// and uploadable refuse it), and neither does the item of a final generation inside an entry (withoutDeleting strips it),
// so neither is counted: a stashed entry still naming a generation deleted after the clear held its files and WaveSpeed
// result on every device until the hold lapsed (48 h), and then the result was never deleted. Pending, in-flight and
// superseded deletes still count: a void or a restore may send those rows.
function unsentUploads() {
  const isUpload = (f) => (f?.kind === "task" || f?.kind === "history") && f.data && typeof f.data === "object";
  let stashed = [];
  try { stashed = readClearStashes().flatMap(s => (Array.isArray(s?.uploads) ? s.uploads : [])); } catch {}
  const goneTasks = confirmStates("task-delete").final, goneLogs = confirmStates("history-delete").final;
  const out = [];
  for (const f of [...getFailedSyncs().filter(isUpload), ...stashed.filter(isUpload)]) {
    if (f.kind === "task") { if (!goneTasks.has(f.data.id ?? f.id)) out.push(f); continue; }
    if (goneLogs.has(f.data.id ?? f.id)) continue;
    const items = Array.isArray(f.data.tasks) ? f.data.tasks : [];
    const left = items.filter(i => !(i?.id && goneTasks.has(i.id)));
    if (left.length === items.length) out.push(f);
    else if (left.length) out.push({ ...f, data: { ...f.data, tasks: left } });
  }
  return out;
}
// Task B14 (review round 27 #5/#7): what this browser's queued, not yet uploaded rows hold, published in its own settings row
// (App.jsx: form-inputs:<browser>:unsent, a key no previous build writes): their paths, the ids of the generations they
// carry (task rows and the items of History entries) and those generations' prediction ids. Another device's WaveSpeed
// flush holds a prediction it names: the generation may still land (a frozen phone's queue) and keep its result.
// Task B15 (review round 28 #4): the items of these History entries whose own task row is still queued here (not yet in
// the cloud). A History upload naming one is sent only after a confirmed :unsent publication names it (App.jsx
// publishUnsentBefore): another device that sees the entry then holds that generation's files and WaveSpeed result.
export function unsentRowsIn(entries) {
  try {
    const queued = new Set(unsentUploads().filter(f => f.kind === "task" && f.id).map(f => String(f.id)));   // task B16: stashed too
    const out = new Set();
    for (const l of entries || []) for (const i of Array.isArray(l?.tasks) ? l.tasks : []) if (i?.id && queued.has(String(i.id))) out.add(String(i.id));
    return [...out];
  } catch { return []; }
}
export function unsentGenerations() {
  const ids = new Set(), predictions = new Set();
  try {
    for (const f of unsentUploads()) {   // task B16 (review round 29 #3/#4): with the uploads a pending clear stashed
      const d = f.data;
      for (const g of f.kind === "task" ? [d] : (Array.isArray(d.tasks) ? d.tasks : [])) {
        if (typeof g?.id === "string" && g.id) ids.add(g.id);
        if (typeof g?.taskId === "string" && g.taskId) predictions.add(g.taskId);
      }
    }
  } catch {}
  return { paths: [...unsentUploadPaths()], ids: [...ids], predictions: [...predictions] };
}
// The providers an account last had a key for (provider names only, never a key or its fingerprint), per account (the
// token's subject), so a failed read on a flaky connection does not switch a kie.ai account's model list to WaveSpeed's
// and block Generate (S3 review #9). Read only until the server answers.
const PROVIDER_KEYS_CACHE = "proximaai-provider-keys:";
export function cachedProviderKeys(account) {
  try {
    const v = JSON.parse(localStorage.getItem(PROVIDER_KEYS_CACHE + account) || "null");
    return Array.isArray(v) ? v.filter(p => typeof p === "string") : null;
  } catch { return null; }
}
export function cacheProviderKeys(account, providers) {
  try { localStorage.setItem(PROVIDER_KEYS_CACHE + account, JSON.stringify([...providers])); } catch {}
}
// The `at` of this browser's cloud form publications (form-inputs:<browser> and its :unsent row; S3 second verification
// A): the server-aligned clock, made monotonic across this browser's tabs through a mark they share. Each tab estimates
// the server's clock on its own, up to about a second apart, and the server keeps the newest `at` of a row
// (20261025900000), so a newer set stamped lower would be skipped. A mark more than 5 minutes ahead of the clock is
// ignored (a clock once set far forward must not keep every later stamp in the future, where holds never lapse).
// A floor learned from the server (advanceFormStamp: the stamp a stale-stamp refusal names, B17 review #1/#5) is honoured
// whatever this browser's estimate says: the server accepted that stamp against its own clock, so it is never far ahead.
const FORM_STAMP_KEY = "proximaai-form-stamp";
const FORM_FLOOR_KEY = "proximaai-form-stamp-floor";
export function formStamp(now) {
  let last = 0, floor = 0;
  try { last = Number(localStorage.getItem(FORM_STAMP_KEY)) || 0; } catch {}
  try { floor = Number(localStorage.getItem(FORM_FLOOR_KEY)) || 0; } catch {}
  const base = Math.max(Math.floor(now), floor + 1);   // the server's floor counts as "now" for the 5-minute bound
  const at = last > base + 300000 ? base : Math.max(base, last + 1);
  try { localStorage.setItem(FORM_STAMP_KEY, String(at)); } catch {}
  return at;
}
export function advanceFormStamp(at) {
  const v = Math.floor(Number(at));
  if (!Number.isFinite(v)) return;
  try { if (v > (Number(localStorage.getItem(FORM_FLOOR_KEY)) || 0)) localStorage.setItem(FORM_FLOOR_KEY, String(v)); } catch {}
}
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
// Task B12a (review round 25 #1/#9/#16/#17): a delete RESERVES first. Every user delete that can stop for "storage full"
// (bulk delete, History delete, Clear Logs, Clear Outputs, Reset) computes its whole plan without changing anything, then
// calls this as its FIRST state change: its delete intents (`intents`: [{ kind, ids, at }], one failed-sync write) AND
// the hold of its files and WaveSpeed ids (`hold` for `holdAt`, holdPurgeDeletes), each write checked. Only once both are
// stored does the delete change anything else (state, IndexedDB, the upload queue, the debounced queue, the Generate form,
// favorites, stashes). false: neither is stored (the intent write is put back exactly as it was), nothing else ran, and
// the caller stops with the honest storage-full message: there is nothing to undo. An id the intents move from an earlier
// queue time is recorded on that time's stash (noteStashMoves) only after both writes succeeded. Replaces round 24's
// take-back (intentsOf / takeBackDeleteIntents), whose callers had already changed state they then had to put back.
// Task B13a (review round 26 #4): a clear's STASH is part of its reservation (`stash`: { at: the clear's queue time,
// value: the stash, fallback: a smaller stash to store when `value` does not fit (Clear Logs' loaded-only one) }). It is
// written after the intents and the hold, checked; if neither it nor its fallback fits, the whole reservation is refused
// and every key it wrote (the failed-sync queue, the hold, the stash's own key) gets back its exact previous string: the
// clear stops with the storage-full message and nothing changed. Before, the stash was written after the reservation
// with its result ignored, so on a nearly full origin a clear went on without it and a later void lost this device's
// local-only data.
export function reserveDelete({ intents = [], holdAt = null, hold = null, stash = null } = {}) {
  const groups = (intents || []).map(g => ({ kind: g?.kind, at: Number(g?.at), ids: [...new Set((g?.ids || []).filter(Boolean))] }))
    .filter(g => (g.kind === "task-delete" || g.kind === "history-delete") && g.ids.length);
  if (groups.some(g => !Number.isFinite(g.at))) return false;
  const stashAt = stash ? Number(stash.at) : NaN;
  if (stash && !Number.isFinite(stashAt)) return false;
  const stashKey = stash ? CLEAR_STASH_PREFIX + stashAt : null;
  let before, beforeHeld, beforeStash;
  try {
    before = localStorage.getItem(FAILED_KEY);
    beforeHeld = localStorage.getItem(HELD_PURGE_KEY);
    beforeStash = stashKey ? localStorage.getItem(stashKey) : null;
  } catch { return false; }
  const moves = [];
  const wrote = { failed: false, held: false, stash: false };
  const putBack = (key, prev) => { try { if (prev == null) localStorage.removeItem(key); else localStorage.setItem(key, prev); } catch {} };
  try {
    if (groups.length) {
      let list = getFailedSyncs();
      for (const g of groups) {
        const want = new Set(g.ids);
        const movedFrom = new Set(list.filter(e => e.kind === g.kind && want.has(e.id) && (e.ts || 0) !== g.at).map(e => e.ts || 0));
        list = list.filter(e => !(e.kind === g.kind && want.has(e.id)));
        for (const id of want) list.push({ kind: g.kind, id, data: id, ts: g.at, attempts: 1 });
        if (movedFrom.size) moves.push([movedFrom, g.at]);
      }
      localStorage.setItem(FAILED_KEY, JSON.stringify(list));
      wrote.failed = true;
    }
    if (hold && holdAt != null) {
      wrote.held = true;   // put back on any refusal below (an unchanged string is put back harmlessly)
      if (!holdPurgeDeletes(holdAt, hold)) throw new Error("hold refused");
    }
    if (stash) {
      wrote.stash = true;
      if (!writeClearStash(stashAt, stash.value) && !(stash.fallback && writeClearStash(stashAt, stash.fallback))) throw new Error("stash refused");
    }
  } catch {
    if (wrote.stash) putBack(stashKey, beforeStash);
    if (wrote.held) putBack(HELD_PURGE_KEY, beforeHeld);
    if (wrote.failed) putBack(FAILED_KEY, before);
    return false;
  }
  for (const [from, to] of moves) noteStashMoves(from, to);
  return true;
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
// Task B18 review (b18 #1): a value the storage refused is kept in this page's memory, so that tab still knows it (a
// reconcile pass waits while the marker it reads is newer than this; it must not wait for good).
let refusedRestore = 0;
export function knownRestoreAt() { return Math.max(storedRestoreKnown(), seenRestore(), handledRestore, refusedRestore); }
export function noteRestoreKnown(ts) {
  const t = Number(ts);
  if (!(t > 0) || !Number.isFinite(t)) return;
  try { if (t > storedRestoreKnown()) localStorage.setItem(RESTORE_KNOWN_KEY, String(t)); }
  catch { if (t > refusedRestore) refusedRestore = t; }
}

// ─── Task B9 (review round 22 #2): delete calls in flight, shared by the browser's tabs ───
// Every delete call (task or History, any path) records its ids and queue time here BEFORE it fires and removes them once
// its answer is handled (App.jsx: a confirm or a void removes the ids it answers, the call's `finally` the rest). While a
// call is in flight its ids may already be deleted on the server even though no intent is left for them (a stale tab's
// clear re-queued them at its own time and that time was voided), so every OTHER call's give-back keeps them and no tab
// uploads them. A tab killed mid-call leaves its entry; it lapses after FLIGHT_FOR_MS. Layout: call -> { tab, at, until
// (device ms), ids: { "task-delete": [...], "history-delete": [...] } }.
// Review round 23 #1: a dead page's entry held the ids for 30 minutes (a restore's result stayed missing on that device).
// Fields added to the same layout (a previous build still reads tab / at / until / ids, and lapses entries by `until`):
// `tab` is now the writing tab's flight id (FLIGHT_TAB: kept in sessionStorage, generated once, so a reload keeps it and
// removes its own leftovers at load: its calls died with the page), `t` the device ms the call began and `max` the
// longest such a call can run. Another tab's entry lapses `max` after `t`: the delete RPCs have no client-side timeout,
// and the server ends each statement within the anon role's 3 s statement_timeout, so FLIGHT_CALL_MS (3 s + a network
// margin) per request of 100 ids (deleteQueuedRemote's chunks) bounds the server work of a call that reached it. This
// tab's own entries stay until its call's `finally` (or `until`, as before).
const FLIGHT_KEY = "proximaai-deletes-in-flight";
const FLIGHT_FOR_MS = 30 * 60 * 1000;
export const FLIGHT_CALL_MS = 60 * 1000;
const FLIGHT_TAB_KEY = "proximaai-flight-tab";
const PAGE_LOADED_AT = Date.now();
const newFlightTab = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
let FLIGHT_TAB = (() => {
  try {
    const s = globalThis.sessionStorage?.getItem(FLIGHT_TAB_KEY);
    if (s) return s;
    const id = newFlightTab();
    globalThis.sessionStorage?.setItem(FLIGHT_TAB_KEY, id);
    return id;
  } catch { return newFlightTab(); }
})();
export const flightTabId = () => FLIGHT_TAB;
const readFlights = () => {
  try { const v = JSON.parse(localStorage.getItem(FLIGHT_KEY) || "{}"); return plainObject(v) ? v : {}; } catch { return {}; }
};
const writeFlights = (m) => {
  if (Object.keys(m).length) localStorage.setItem(FLIGHT_KEY, JSON.stringify(m)); else localStorage.removeItem(FLIGHT_KEY);
};
// When the call began: `t`, or for a previous build's entry (no `t`) its `until` less the 30 minutes it added.
const flightBegan = (f) => (Number(f.t) > 0 ? Number(f.t) : Number(f.until) - FLIGHT_FOR_MS);
const flightMax = (f) => (Number(f.max) > 0 ? Number(f.max) : FLIGHT_CALL_MS);
const liveFlight = (f, now) => plainObject(f) && Number(f.until) > now && plainObject(f.ids)
  && (f.tab === FLIGHT_TAB || now - flightBegan(f) < flightMax(f));
// `parts`: { "task-delete": ids, "history-delete": ids }; `at`: the call's queue time. Returns the call's key (null: nothing).
export function beginDeleteFlight(parts, at) {
  const ids = {};
  for (const [kind, list] of Object.entries(parts || {})) {
    if (kind !== "task-delete" && kind !== "history-delete") continue;
    const l = [...new Set((list || []).filter(Boolean).map(String))];
    if (l.length) ids[kind] = l;
  }
  if (!Object.keys(ids).length) return null;
  const call = `${FLIGHT_TAB}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  try {
    const m = readFlights(), now = Date.now();
    for (const k of Object.keys(m)) if (!liveFlight(m[k], now)) delete m[k];
    const requests = Math.max(1, ...Object.values(ids).map(l => Math.ceil(l.length / 100)));
    m[call] = { tab: FLIGHT_TAB, at: Number(at) || 0, until: now + FLIGHT_FOR_MS, ids, t: now, max: requests * FLIGHT_CALL_MS };
    localStorage.setItem(FLIGHT_KEY, JSON.stringify(m));
  } catch {}
  return call;
}
// The entries of tab `tab` that began before `before` (device ms) go: that page's calls died with it.
export function dropFlightsOfTab(tab, before = Infinity) {
  if (!tab) return;
  try {
    const m = readFlights();
    let changed = false;
    for (const [call, f] of Object.entries(m)) if (plainObject(f) && f.tab === tab && !(Number(f.t) >= before)) { delete m[call]; changed = true; }
    if (changed) writeFlights(m);
  } catch {}
}
// At load (review round 23 #1): a duplicated tab copies sessionStorage, so the page first asks this browser's other pages
// whether its flight id is live (as tabPresence does for the form key). An answer: this page is the copy and takes a new
// id (the original's calls keep their entries). No answer within waitMs: the id's earlier entries were left by this tab's
// previous page and go.
export function flightPresence({ id, open, waitMs = TAB_PING_MS, onTaken, onFree, current = () => id }) {
  let ch;
  try { ch = open(); } catch { onFree?.(); return null; }
  let pending = true;
  ch.onmessage = (e) => {
    const m = e?.data || {};
    if (!pending && m.flightAsk && m.flightAsk === current()) ch.postMessage({ flightHave: m.flightAsk });
    if (pending && m.flightHave === id) { pending = false; onTaken?.(); }
  };
  ch.postMessage({ flightAsk: id });
  setTimeout(() => { if (pending) { pending = false; onFree?.(); } }, waitMs);
  return ch;
}
if (typeof window !== "undefined" && typeof BroadcastChannel !== "undefined") {
  const asked = FLIGHT_TAB;
  flightPresence({ id: asked, open: () => new BroadcastChannel("proximaai-flights"), current: () => FLIGHT_TAB,
    onTaken: () => { FLIGHT_TAB = newFlightTab(); try { globalThis.sessionStorage?.setItem(FLIGHT_TAB_KEY, FLIGHT_TAB); } catch {} },
    onFree: () => dropFlightsOfTab(asked, PAGE_LOADED_AT) });
} else {
  dropFlightsOfTab(FLIGHT_TAB, PAGE_LOADED_AT);
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
      if (!plainObject(f) || f.tab !== FLIGHT_TAB || Number(f.at) !== ts || !plainObject(f.ids) || !Array.isArray(f.ids[kind])) continue;
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

// ─── Review round 23 #3: a delete's file and WaveSpeed deletes follow its outcome ───
// A delete (bulk delete, Clear Outputs, Reset) used to put its files and WaveSpeed ids straight into the shared queues
// before its call (App.jsx stagePurge), so any flush (the reconcile's, the 60 s interval, another tab's) deleted them
// while the delete was unanswered, and a restore that voided it later gave back generations whose outputs were gone. Now
// they are queued HELD for that delete's queue time, in their own key (the two queues keep their exact layout; a previous
// build never sees a held item), still before any network call. Each held item names its owners: the generations (task
// ids) or History entries ("history:<id>") it belongs to. Layout: queue time -> { files: { path: [owners] }, ws: {
// predictionId: its wsDelete.js queue entry (tid = generation id) }, h: the History intents' queue time when it differs }.
// Review round 24 #1/#3/#5: an owner whose delete ended WITHOUT a final confirm at or after the hold (voided by the server,
// dropped by restoreGuard, a flight that lapsed, a record a pass released) is UNDECIDED, not alive: the restore that
// voided it may not have brought it back. Each owner is
// - "gone": its delete is a FINAL confirm queued at or after the hold time, or, at a reconcile pass whose cloud reads
//   began after a restore newer than the hold time (releaseHeldPurges' `evidence`), the cloud lacks it (no task row, no
//   item of a History entry; History owners: no entry) and nothing of this browser keeps it;
// - "alive": at such a pass, the cloud holds it or this browser keeps it (its state, a clear stash, a queued upload);
// - "wait": otherwise (pending at any time, in a call of any tab that has not lapsed its 30 minutes, superseded, or no
//   such pass yet).
// An item goes to its queue once every owner is gone, is cancelled once any owner is alive (a path a kept generation uses
// is never deleted), and waits otherwise. No answer: it stays held, and the durable intent's replay decides.
// An item with NO owners (task B12a, review round 25 #4: the paths of a History entry without items whose removal rides
// on the task delete, e.g. the clear's own transaction) follows that delete as a whole: as if every owner its hold group
// names owned it (all gone: queued; one alive: cancelled; otherwise it waits with them).
//
// THE KEY RULE (task B12a, review round 25 #5): a tab may still run the previous build, and it shares this localStorage.
// Whenever the rule that decides held items changes so that a previous build would decide them differently (round 24
// keeps an undecided owner where a79a43c cancels it), the holds move to a NEW key that no previous build reads, and the
// old key's items are migrated into it once, when a page of the new build starts (migrateLegacyHeldPurges). A previous
// build then never sees, and so never cancels or queues, an item held under the new rule; its own holds (written under
// its key after the migration) stay its own. The layout is unchanged. The queues (proximaai-file-deletes,
// proximaai-ws-deletes) keep their key, layout and meaning.
// Task B13a (review round 26 #1) adds the owner "entry:<id>" under this key without moving it: the previous build that
// reads it (bf37422) takes such an owner for an unknown generation id, so it never CANCELS that item (it waits without
// restore evidence, and with it sends the item, as its owner-less rule did when every generation of the group was gone;
// the flushes' ownership and paths_in_use checks still keep a path a kept entry uses), and older builds never read it.
// Task B13a (review round 26 #3/#5) applies this rule to confirm records: FINAL_CONFIRMS_KEY below.
// Task B13b (simulator class D) decides an undecided owner "gone" from a user tombstone the pass read (heldPurgeRule) under
// this key without moving it: a previous build reading it only waits where this one sends (it never cancels such an
// item), and once sent the item has left the hold.
// Task B14 (review round 27 #4) applied this rule again: the owner ruling of 2026-10-23 (the restore's own removals are not
// "present", a voided put-back no longer cancels, IndexedDB copies of tombstoned ids are not kept) makes a previous build
// (bf37422) CANCEL items this build sends, so the holds moved from v2 to v3; both older keys are migrated and read only
// as guards (heldDeleteRefs).
const HELD_PURGE_KEY = "proximaai-held-purges-v3";
// Previous builds' keys, oldest first: v1 (rounds 23-24: a79a43c, d0b3af6), v2 (rounds 25-26: bf37422, 3d14d8a).
const LEGACY_HELD_PURGE_KEYS = ["proximaai-held-purges", "proximaai-held-purges-v2"];
const HISTORY_OWNER = "history:";
const readHeldPurges = () => {
  try { const v = JSON.parse(localStorage.getItem(HELD_PURGE_KEY) || "{}"); return plainObject(v) ? v : {}; } catch { return {}; }
};
const writeHeldPurges = (m) => {
  if (Object.keys(m).length) localStorage.setItem(HELD_PURGE_KEY, JSON.stringify(m)); else localStorage.removeItem(HELD_PURGE_KEY);
};
// Moves the previous key's held items into the new key (owners merged per path, a WaveSpeed entry kept if present), then
// removes the old key, only once the new key's write was stored (a full localStorage keeps them where they are, for the
// next start). Idempotent. Runs when this module loads.
export function migrateLegacyHeldPurges() {
  for (const key of LEGACY_HELD_PURGE_KEYS) migrateHeldPurgesFrom(key);
}
function migrateHeldPurgesFrom(legacyKey) {
  try {
    const raw = localStorage.getItem(legacyKey);
    if (raw == null) return;
    let old = {};
    try { const v = JSON.parse(raw); if (plainObject(v)) old = v; } catch {}
    const m = readHeldPurges();
    for (const [k, g] of Object.entries(old)) {
      if (!Number.isFinite(Number(k)) || !plainObject(g)) continue;
      const cur = plainObject(m[k]) ? m[k] : {};
      const files = plainObject(cur.files) ? { ...cur.files } : {}, ws = plainObject(cur.ws) ? { ...cur.ws } : {};
      for (const [p, owners] of Object.entries(plainObject(g.files) ? g.files : {})) {
        if (!p) continue;
        files[p] = [...new Set([...(Array.isArray(files[p]) ? files[p] : []), ...(Array.isArray(owners) ? owners : []).filter(o => typeof o === "string" && o)])];
      }
      for (const [pid, e] of Object.entries(plainObject(g.ws) ? g.ws : {})) if (pid && plainObject(e) && !ws[pid]) ws[pid] = e;
      const h = Number.isFinite(Number(cur.h)) ? Number(cur.h) : Number.isFinite(Number(g.h)) ? Number(g.h) : NaN;
      m[k] = { files, ws, ...(Number.isFinite(h) ? { h } : {}) };
    }
    writeHeldPurges(m);
    localStorage.removeItem(legacyKey);
  } catch {}
}
migrateLegacyHeldPurges();
// Holds `files` (path -> owner ids) and `ws` (prediction id -> wsDelete.js queue entry) for the delete queued at `at`;
// `historyAt`: the queue time of its History intents (bulk delete: their own). Says whether it was stored. Review round 24
// #2/#4/#7: false means the caller's delete must stop before any server call (no direct queueing, which deleted a pending
// delete's files and results before its outcome). Task B12a: a delete writes it inside its reservation (reserveDelete),
// before anything else changes. Nothing to hold: true, nothing written.
export function holdPurgeDeletes(at, { files = {}, ws = {}, historyAt = null } = {}) {
  const ts = Number(at);
  if (!Number.isFinite(ts)) return false;
  const addFiles = Object.entries(files || {}).filter(([p]) => p), addWs = Object.entries(ws || {}).filter(([pid, e]) => pid && plainObject(e));
  if (!addFiles.length && !addWs.length) return true;
  try {
    const m = readHeldPurges();
    const g = plainObject(m[ts]) ? m[ts] : {};
    const gf = plainObject(g.files) ? { ...g.files } : {}, gw = plainObject(g.ws) ? { ...g.ws } : {};
    for (const [p, owners] of addFiles) {
      gf[p] = [...new Set([...(Array.isArray(gf[p]) ? gf[p] : []), ...(Array.isArray(owners) ? owners : []).filter(Boolean).map(String)])];
    }
    for (const [pid, e] of addWs) if (!gw[pid]) gw[pid] = e;
    const h = historyAt == null ? NaN : Number(historyAt);
    m[ts] = { files: gf, ws: gw, ...(Number.isFinite(h) && h !== ts ? { h } : Number.isFinite(Number(g.h)) ? { h: Number(g.h) } : {}) };
    localStorage.setItem(HELD_PURGE_KEY, JSON.stringify(m));
    return true;
  } catch { return false; }
}
// Review round 24 #6: the queue time a WaveSpeed delete of generation `id` that arrives late (a submit answered after its
// task was deleted, a deleted claimant's prediction found by the lookup) is held for: its pending task-delete intent (the
// latest), a delete call of any tab still within its 30 minutes, or a superseded confirm (the pass decides). null: its
// delete is FINAL here (queued directly, as before). undefined: nothing here says it is being deleted.
export function deleteHoldAt(id) {
  if (!id) return undefined;
  const key = String(id);
  let at = null;
  for (const e of getFailedSyncs()) if (e.kind === "task-delete" && e.id === key && (at == null || (e.ts || 0) > at)) at = e.ts || 0;
  if (at != null) return at;
  const now = Date.now();
  for (const f of Object.values(readFlights())) {
    if (plainObject(f) && Number(f.until) > now && plainObject(f.ids) && Array.isArray(f.ids["task-delete"]) && f.ids["task-delete"].includes(key)
      && Number.isFinite(Number(f.at)) && (at == null || Number(f.at) > at)) at = Number(f.at);
  }
  if (at != null) return at;
  const { final, superseded } = confirmStates("task-delete");
  if (superseded.has(key)) return confirmQueuedAt("task-delete").get(key) ?? undefined;
  return final.has(key) ? null : undefined;
}
// Task B12a (review round 25 #2): an entry of the WaveSpeed queue whose generation's delete is still pending or in a call
// (queued directly by a previous build, or before round 24) moves into that delete's hold (deleteHoldAt of its tid), so
// that delete's OUTCOME decides it, with no time cap: sent once it is final, cancelled if the generation is kept. It
// leaves the queue only once the hold is stored. Returns the prediction ids it could not move (the caller keeps them
// waiting, uncapped: wsDelete.js waitHeldIds).
export function holdDeletingWsEntries(predictionIds) {
  const left = [];
  const q = readWsDeletes(), moved = [];
  for (const pid of predictionIds || []) {
    const e = q[pid];
    if (!plainObject(e)) continue;
    const at = e.tid ? deleteHoldAt(String(e.tid)) : undefined;
    if (at == null || !holdPurgeDeletes(at, { ws: { [pid]: e } })) { left.push(pid); continue; }
    moved.push(pid);
  }
  if (moved.length) {
    const now = readWsDeletes();
    for (const pid of moved) delete now[pid];
    // Not removed (a full localStorage): it is in both, harmless; the next flush moves it again (already held: kept once).
    writeWsDeletes(now);
  }
  return left;
}
// ─── Task B12b (review round 25 #6/#7/#11-#15): late results and archives follow their generation's delete ───
// A WaveSpeed result that turned up for a generation whose delete was undecided (a submit answered late, a deleted
// claimant's prediction found by the lookup) and an archive that finished meanwhile are held for that delete. If the
// generation is kept (the delete aborted, was voided, or a restore brought it back), the hold is cancelled, and the
// generation must get its result or archive back: a relink. Layout (its own key, shared by the browser's tabs):
// generation id -> { p: prediction id, pr: 1 once ready, a: { patch: { outputs, archivedOutputs, archivedPaths },
// paths: [...] }, ar: 1 once ready, at: device ms written }. Written WITH the hold (holdLateResult / holdArchiveFiles:
// relink first, then the hold, both checked), marked ready by the release that cancels the item (releaseHeldPurges), and
// dropped by one that sends it ("go": the generation is gone). App.jsx applyRelinks applies the ready parts to a
// generation it holds: the prediction id is linked (a waiting lost submit instead has it un-released, so its lookup
// adopts it), the archive re-applied. A ready entry no tab applies goes RELINK_FOR_MS after it became ready, a held one
// whose hold went some other way RELINK_PENDING_FOR_MS after it was written.
const RELINK_KEY = "proximaai-relinks";
const RELINK_FOR_MS = 7 * 24 * 60 * 60 * 1000;
const RELINK_PENDING_FOR_MS = 30 * 24 * 60 * 60 * 1000;
const readRelinks = () => {
  try { const v = JSON.parse(localStorage.getItem(RELINK_KEY) || "{}"); return plainObject(v) ? v : {}; } catch { return {}; }
};
const writeRelinks = (m) => {
  if (Object.keys(m).length) localStorage.setItem(RELINK_KEY, JSON.stringify(m)); else localStorage.removeItem(RELINK_KEY);
};
// Adds the pending relink of generation `tid` (p: prediction id; a: { patch, paths }). Says whether it was stored.
function noteRelink(tid, { p = null, a = null } = {}) {
  if (!tid) return false;
  try {
    const m = readRelinks(), cur = plainObject(m[tid]) ? { ...m[tid] } : {};
    if (p) { if (cur.p !== p) delete cur.pr; cur.p = p; }
    if (a) { cur.a = { patch: plainObject(a.patch) ? a.patch : {}, paths: [...new Set([...(plainObject(cur.a) && Array.isArray(cur.a.paths) ? cur.a.paths : []), ...(a.paths || [])])] }; delete cur.ar; }
    m[tid] = { ...cur, at: Date.now() };
    writeRelinks(m);
    return true;
  } catch { return false; }
}
// The relinks one release's decisions settle: `items` [{ part: "ws" | "files", key, d: "go" | "cancel", owners }].
// Returns { ok: the write was stored (or nothing to write), needs: the "part\0key" items whose cancel needed it }.
function settleRelinks(items) {
  const needs = new Set();
  let m;
  try { m = readRelinks(); } catch { return { ok: true, needs }; }
  if (!Object.keys(m).length) return { ok: true, needs };
  let changed = false;
  for (const { part, key, d, owners } of items || []) {
    for (const tid of owners || []) {
      const r = plainObject(m[tid]) ? m[tid] : null;
      if (!r) continue;
      if (part === "ws" && r.p === key) {
        if (d === "cancel") { if (!r.pr) { m[tid] = { ...r, pr: 1, at: Date.now() }; changed = true; } needs.add(`ws\u0000${key}`); }
        else { const { p, pr, ...rest } = r; m[tid] = rest; changed = true; }
      } else if (part === "files" && plainObject(r.a) && Array.isArray(r.a.paths) && r.a.paths.includes(key)) {
        if (d === "cancel") { if (!r.ar) { m[tid] = { ...r, ar: 1, at: Date.now() }; changed = true; } needs.add(`files\u0000${key}`); }
        else { const { a, ar, ...rest } = r; m[tid] = rest; changed = true; }
      }
      const left = m[tid];
      if (plainObject(left) && !left.p && !left.a) { delete m[tid]; changed = true; }
    }
  }
  if (!changed) return { ok: true, needs };
  try { writeRelinks(m); return { ok: true, needs }; } catch { return { ok: false, needs }; }
}
// A late result of generation `tid` (wsDelete.js queue entry `entry`, its prediction `pid`) held for that generation's
// delete queued at `at`: the relink first, then the hold. Says whether both were stored.
export function holdLateResult(at, tid, pid, entry) {
  if (!tid || !pid || !plainObject(entry)) return false;
  if (!noteRelink(String(tid), { p: pid })) return false;
  return holdPurgeDeletes(at, { ws: { [pid]: entry } });
}
// An archive of generation `tid` that finished while its delete was undecided (review round 25 #13): its uploaded paths
// are held for that delete with owner `tid` (never queued straight for deletion), and the archived version (`patch`) is
// kept for a relink, so a kept generation gets its archive back. Says whether both were stored.
export function holdArchiveFiles(at, tid, paths, patch) {
  const list = [...new Set((paths || []).filter(Boolean))];
  if (!tid || !list.length) return true;
  if (patch && !noteRelink(String(tid), { a: { patch, paths: list } })) return false;
  return holdPurgeDeletes(at, { files: Object.fromEntries(list.map(p => [p, [String(tid)]])) });
}
// Task B13a (review round 26 #6): a pending or ready relink is part of its generation. A new delete of that generation
// holds the relink's prediction and archive paths with it (purge.js planDeleteStage / App.jsx deleteOnWaveSpeed read
// them here: generation id -> { p: prediction id | null, paths: [archive paths] }), so its outcome decides them with the
// rest (sent once it is final, the relink dropped; kept and still ready if it is voided).
export function relinksOf(ids) {
  const want = new Set((ids || []).filter(Boolean).map(String)), out = new Map();
  if (!want.size) return out;
  try {
    for (const [tid, r] of Object.entries(readRelinks())) {
      if (!want.has(tid) || !plainObject(r)) continue;
      const paths = plainObject(r.a) && Array.isArray(r.a.paths) ? r.a.paths.filter(p => typeof p === "string" && p) : [];
      const p = typeof r.p === "string" && r.p ? r.p : null;
      if (p || paths.length) out.set(tid, { p, paths });
    }
  } catch {}
  return out;
}
// And a relink whose generation's delete is FINAL here (storage deleteHoldAt null: a confirm no restore superseded, nothing
// pending or in a call) is not left to lapse: its prediction id goes to the WaveSpeed queue (with its generation id, so
// the flush still asks whether that generation is live) and its archive paths to the file queue (the flush's ownership
// and paths_in_use checks still apply), unless a hold still holds them (that hold decides). Each part leaves the relink
// only once its queue holds it (read back). Runs first in every readyRelinks (App.jsx applyRelinks, after each release).
// Returns { ws, files } queued.
export function settleFinalRelinks(now = Date.now()) {
  const out = { ws: [], files: [] };
  try {
    const m = readRelinks(), tids = Object.keys(m);
    if (!tids.length) return out;
    const held = { ws: new Set(), files: new Set() };
    for (const g of Object.values(readHeldPurges())) {
      if (!plainObject(g)) continue;
      for (const p of Object.keys(plainObject(g.files) ? g.files : {})) held.files.add(p);
      for (const pid of Object.keys(plainObject(g.ws) ? g.ws : {})) held.ws.add(pid);
    }
    const ws = {}, files = new Set(), parts = [];
    for (const tid of tids) {
      const r = m[tid];
      if (!plainObject(r) || deleteHoldAt(tid) !== null) continue;
      const p = typeof r.p === "string" && r.p && !held.ws.has(r.p) ? r.p : null;
      const paths = (plainObject(r.a) && Array.isArray(r.a.paths) ? r.a.paths : []).filter(x => typeof x === "string" && x && !held.files.has(x));
      if (p) Object.assign(ws, queueDeletes({}, [{ id: tid, taskId: p, status: "processing" }], now));
      for (const x of paths) files.add(x);
      if (p || paths.length) parts.push([tid, p, paths]);
    }
    if (!parts.length) return out;
    let wsIn = new Set(), filesIn = new Set();
    if (Object.keys(ws).length) {
      const q = readWsDeletes();
      for (const [pid, e] of Object.entries(ws)) if (!q[pid]) q[pid] = e;
      writeWsDeletes(q);
      wsIn = new Set(Object.keys(readWsDeletes()));
    }
    if (files.size) {
      writeFileDeletes(queueFileDeletes(readFileDeletes(), [...files], now));
      filesIn = new Set(Object.keys(readFileDeletes()));
    }
    const done = [];
    for (const [tid, p, paths] of parts) {
      const d = {};
      if (p && wsIn.has(p)) { d.p = true; out.ws.push(p); }
      const allIn = paths.length && paths.every(x => filesIn.has(x));
      if (allIn) { d.a = true; out.files.push(...paths); }
      if (d.p || d.a) done.push([tid, d]);
    }
    if (done.length) dropRelinks(done);
  } catch {}
  return out;
}
// The relinks ready to apply: generation id -> { p (ready prediction id) | null, a (ready archive patch) | null }.
export function readyRelinks(now = Date.now()) {
  const out = new Map();
  settleFinalRelinks();   // task B13a: a relink of a generation whose delete is final is sent, never left to lapse
  try {
    const m = readRelinks();
    let changed = false;
    for (const [tid, r] of Object.entries(m)) {
      const life = r && (r.pr || r.ar) ? RELINK_FOR_MS : RELINK_PENDING_FOR_MS;   // ready: 7 days to be applied; held: 30
      if (!plainObject(r) || !(now - Number(r.at) <= life)) { delete m[tid]; changed = true; continue; }
      const p = r.pr && r.p ? r.p : null, a = r.ar && plainObject(r.a) ? r.a.patch || {} : null;
      if (p || a) out.set(tid, { p, a });
    }
    if (changed) writeRelinks(m);
  } catch {}
  return out;
}
// The applied parts of these relinks go: `done` generation id -> { p: true, a: true } (the part applied or no longer
// needed).
export function dropRelinks(done) {
  try {
    const m = readRelinks();
    let changed = false;
    for (const [tid, parts] of done || []) {
      const r = plainObject(m[tid]) ? { ...m[tid] } : null;
      if (!r) continue;
      if (parts?.p) { delete r.p; delete r.pr; }
      if (parts?.a) { delete r.a; delete r.ar; }
      if (!r.p && !r.a) delete m[tid]; else m[tid] = r;
      changed = true;
    }
    if (changed) writeRelinks(m);
  } catch {}
}
// A prediction id given back to its waiting lost submit (applyRelinks): no longer released, so its lookup adopts it.
export function unreleasePredictions(ids) {
  const gone = new Set((ids || []).filter(Boolean));
  if (!gone.size) return;
  try {
    const m = readReleased();
    let changed = false;
    for (const id of gone) if (id in m) { delete m[id]; changed = true; }
    if (changed) localStorage.setItem(RELEASED_KEY, JSON.stringify(m));
  } catch {}
}
// A delete that ABORTED before its reservation (bulk delete: failed safety backup, storage full; review round 25 #6/#11/
// #14): the late results held for these generations while nothing records their delete (deleteHoldAt undefined: no
// intent, no call, no confirm) leave the hold, and their relinks become ready (the caller applies them: the kept task
// gets its prediction id back). Returns the prediction ids released.
export function releaseAbortedLate(ids) {
  const want = new Set((ids || []).filter(Boolean).map(String)), out = [];
  if (!want.size) return out;
  try {
    const m = readHeldPurges(), rl = readRelinks();
    let changed = false;
    for (const [k, g] of Object.entries(m)) {
      if (!plainObject(g) || !plainObject(g.ws)) continue;
      const ws = { ...g.ws };
      for (const [pid, e] of Object.entries(ws)) {
        const tid = plainObject(e) && e.tid ? String(e.tid) : "";
        if (!want.has(tid) || deleteHoldAt(tid) !== undefined) continue;
        rl[tid] = { ...(plainObject(rl[tid]) ? rl[tid] : {}), p: pid, pr: 1, at: Date.now() };   // ready now
        delete ws[pid];
        out.push(pid);
        changed = true;
      }
      m[k] = { ...g, ws };
    }
    if (!changed) return out;
    writeRelinks(rl);   // the relinks first: refused, nothing leaves the hold
    for (const k of Object.keys(m)) {
      const g = m[k];
      if (plainObject(g) && !Object.keys(plainObject(g.files) ? g.files : {}).length && !Object.keys(plainObject(g.ws) ? g.ws : {}).length) delete m[k];
    }
    writeHeldPurges(m);
  } catch { return []; }
  return out;
}

// Review round 24 #6: a late submit's prediction id, kept on the copies of its task that clear stashes hold (and their
// stashed uploads), so a voided clear gives the generation back WITH its result. Says whether any copy took it.
export function recordStashPrediction(taskId, predictionId) {
  if (!taskId || !predictionId) return false;
  let any = false;
  for (const s of readClearStashes()) {
    let changed = false;
    const fix = (x) => (x && typeof x === "object" && x.id === taskId && !x.taskId ? ((changed = true), { ...x, taskId: predictionId }) : x);
    const tasks = s.tasks.map(fix);
    const uploads = s.uploads.map(e => (e?.kind === "task" && e.id === taskId ? { ...e, data: fix(e.data) } : e));
    if (changed && writeClearStash(s.at, { ...s, tasks, uploads })) any = true;
  }
  return any;
}
// What this browser keeps outside a tab's state: the content of every clear stash (a void gives it back) and every
// queued upload. Task ids (tasks, History items, archive records) and History entry ids.
export function storedKeptIds() {   // exported: task B15 (review round 28 #5), the pass reads it before IndexedDB too
  const task = new Set(), history = new Set();
  const addLog = (l) => { if (!l || typeof l !== "object") return; if (l.id) history.add(String(l.id)); for (const i of Array.isArray(l.tasks) ? l.tasks : []) if (i?.id) task.add(String(i.id)); };
  for (const s of readClearStashes()) {
    for (const t of s.tasks) if (t?.id) task.add(String(t.id));
    for (const l of s.logs) addLog(l);
    for (const id of Object.keys(s.archives || {})) task.add(id);
    for (const e of s.uploads) { if (e?.kind === "task" && e.id) task.add(String(e.id)); else if (e?.kind === "history") { if (e.id) history.add(String(e.id)); addLog(e.data); } }
  }
  for (const e of getFailedSyncs()) { if (e.kind === "task" && e.id) task.add(String(e.id)); else if (e.kind === "history") { if (e.id) history.add(String(e.id)); addLog(e.data); } }
  return { task, history };
}
const toIdSet = (v) => new Set([...(v instanceof Set || Array.isArray(v) ? v : [])].filter(Boolean).map(String));
// Task B12b (review round 25 #10): what this BROWSER keeps in IndexedDB, which every tab shares (another tab may have
// given a generation back from a voided clear into its own state and IndexedDB while this tab's state lost it): the
// stored task ids, History entry ids and the ids of their items. The reconcile pass adds them to its `local` evidence.
// null when IndexedDB could not be read: the pass then decides nothing from absence. `read`: { tasks, history } async
// readers (tests); default IndexedDB.
export async function storedEvidenceIds(read = null) {
  try {
    const getAll = async (name) => { const store = await tx(name); return (await wrapRequest(store.getAll())) || []; };
    const [tasks, logs] = await Promise.all([read?.tasks ? read.tasks() : getAll("tasks"), read?.history ? read.history() : getAll("history")]);
    if (!Array.isArray(tasks) || !Array.isArray(logs)) return null;
    const task = new Set(), history = new Set();
    for (const t of tasks) if (t?.id) task.add(String(t.id));
    for (const l of logs) {
      if (!l?.id) continue;
      history.add(String(l.id));
      for (const i of Array.isArray(l.tasks) ? l.tasks : []) if (i?.id) task.add(String(i.id));
    }
    return { task, history };
  } catch { return null; }
}
// Whether anything is held (the pass reads IndexedDB and asks the server only then).
export function hasHeldPurges() { return Object.keys(readHeldPurges()).length > 0; }
// Task B12b (review round 25 #3): the generation owners the pass's evidence would decide "gone" (absent from every read and
// from this browser). The pass confirms them with the server (generations_live: a tasks row or a live History item, any
// age) when its History read was capped (only the newest entries), before releaseHeldPurges decides.
export function heldGoneCandidates(evidence, now = Date.now()) {
  const out = new Set();
  try {
    const m = readHeldPurges();
    const rule = heldPurgeRule(now, evidence, { probe: (kind, id, d) => { if (kind === "task-delete" && d === "gone") out.add(id); } });
    for (const [k, g] of Object.entries(m)) {
      const at = Number(k);
      if (!Number.isFinite(at) || !plainObject(g)) continue;
      const hAt = Number.isFinite(Number(g.h)) ? Number(g.h) : at;
      const files = plainObject(g.files) ? g.files : {}, ws = plainObject(g.ws) ? g.ws : {};
      const groupOwners = [...new Set([...Object.values(files).flatMap(o => (Array.isArray(o) ? o : [])),
        ...Object.values(ws).map(e => (plainObject(e) && e.tid ? String(e.tid) : ""))].filter(o => typeof o === "string" && o))];
      for (const owners of Object.values(files)) rule(owners, at, hAt, groupOwners);
      for (const e of Object.values(ws)) if (plainObject(e) && e.tid) rule([String(e.tid)], at, hAt);
    }
  } catch {}
  return [...out];
}
// One held item's fate: "go", "cancel" or "wait" (the owner rules above). `evidence` (App.jsx reconcileWithCloud, after
// its plans): { restoreKnownAt: knownRestoreAt() taken before the pass's cloud reads, task: { present: generation ids the
// cloud holds (task rows and items of History entries), local: ids this tab keeps, complete: every source read },
// history: { present: History entry ids, local, complete } }. It decides undecided owners only when its restore is the
// latest this browser knows (a restore learned during the pass: the reads may predate it) and newer than the hold time.
// `opts.probe(kind, id, decision)` sees every evidence decision (heldGoneCandidates). Owner ruling 2026-10-23: a voided
// clear's put-back no longer marks its owners alive here (task B12b's `opts.alive`, removed): a restore that cancelled a
// delete may also have removed the generation, so the next pass that read the cloud after it decides (kept if the
// generation came back or this browser keeps it, deleted if not; CLAUDE.md).
function heldPurgeRule(now, evidence, { probe = null } = {}) {
  const flights = Object.values(readFlights()).filter(f => plainObject(f) && Number(f.until) > now && plainObject(f.ids));
  const kinds = {};
  for (const kind of ["task-delete", "history-delete"]) {
    const { final, superseded } = confirmStates(kind);
    // In flight for the hold: any tab's call within its 30 minutes (not only the call bound inFlightIds uses): a frozen
    // tab may still hand its answer, and a give-back, to the generation (review round 24 #3). Waiting only delays a delete.
    const flying = new Set();
    for (const f of flights) for (const id of Array.isArray(f.ids[kind]) ? f.ids[kind] : []) if (id) flying.add(String(id));
    kinds[kind] = { final, superseded, q: confirmQueuedAt(kind), pending: pendingDeleteIds(kind), flying };
  }
  const rk = Number(evidence?.restoreKnownAt);
  const usable = rk > 0 && rk >= knownRestoreAt();
  // Task B13b (simulator class D): the pass's reads show the cloud after every restore this browser knows of (none was
  // learned during the pass; no restore at all counts). Only then may a tombstone it read decide an owner.
  const current = Number.isFinite(rk) && rk >= 0 && rk >= knownRestoreAt();
  let stored = null;
  const sets = {};   // per rule (never cached on the caller's evidence object: the pass may add to it, task B12b)
  const seen = (kind, id) => {
    const e = evidence?.[kind === "task-delete" ? "task" : "history"];
    if (!e || e.complete !== true) return "wait";
    const s = sets[kind] || (sets[kind] = { present: toIdSet(e.present), local: toIdSet(e.local), tomb: toIdSet(e.tombstoned) });
    stored = stored || storedKeptIds();
    // Task B14 (review round 27 #1): a queued upload or a stash's copy of an id the pass read as tombstoned (a user's
    // delete or the restore's own removal; `tombstoned`) is not kept: the server never inserts a tombstoned id.
    const keptHere = !s.tomb.has(id) && (kind === "task-delete" ? stored.task : stored.history).has(id);
    const d = s.present.has(id) || s.local.has(id) || keptHere ? "alive" : "gone";
    if (probe) probe(kind, id, d);
    return d;
  };
  // Task B13b (simulator class D): ids the pass read as DELETED in the cloud (`evidence.task.deleted`: user task
  // tombstones, a restore's own excluded; `evidence.history.deleted`: History tombstones).
  const deletedOf = (kind) => {
    const key = kind === "task-delete" ? "task" : "history";
    const s = sets[`deleted:${key}`] || (sets[`deleted:${key}`] = toIdSet(evidence?.[key]?.deleted));
    return s;
  };
  // `raw`: an undecided owner is returned as "ev" (its fate rests on restore evidence) instead of being decided.
  const owner = (o, at, hAt, raw = false) => {
    const isLog = o.startsWith(HISTORY_OWNER), kind = isLog ? "history-delete" : "task-delete", k = kinds[kind];
    const id = isLog ? o.slice(HISTORY_OWNER.length) : o, since = isLog ? hAt : at;
    if (k.pending.has(id) || k.flying.has(id)) return "wait";
    const q = k.q.get(id);
    if (q != null && q >= since) {
      if (k.final.has(id)) return "gone";
      if (k.superseded.has(id)) return "wait";   // the next pass decides the record first
    }
    // Task B13b (simulator class D): an undecided owner that a user deleted elsewhere (another browser's delete: the
    // server's tombstone) is gone without waiting for a restore's evidence, which may never come: a pass whose reads show
    // the cloud after every restore known here, with complete evidence, that read a tombstone for it while neither the
    // cloud (no row, no History item) nor this browser keeps it. A tombstone exists only while the id is absent (any
    // insert, a restore's or an upload's, clears it), so a generation a restore brought back is never "gone" here.
    // Anything else: the rules below, as before (a final confirm in the shared record at or after the hold is "gone"
    // above already).
    if (current && deletedOf(kind).has(id) && seen(kind, id) === "gone") return "gone";
    if (raw) return "ev";
    // Undecided: only a pass that read the cloud after a restore newer than the hold time decides it.
    return usable && rk > since ? seen(kind, id) : "wait";
  };
  // An item without owners follows its delete as a whole (task B12a, review round 25 #4: an item-less History entry's
  // paths, purge.js pathOwners): decided by every owner its hold group names (`groupOwners`: the generations and entries
  // of that same delete), as one item they all own; a group naming no owner at all follows the delete's queue time
  // (pending or in a call: wait; voided: cancel; settled otherwise: go).
  const voided = voidedTimes();
  const group = (at) => (intentsPendingAt(at) || flights.some(f => Number(f.at) === at)
    ? "wait" : voided.has(at) ? "cancel" : "go");
  const clean = (v) => (Array.isArray(v) ? v.filter(o => typeof o === "string" && o) : []);
  const isEntry = (o) => o.startsWith(ENTRY_OWNER);
  // Task B13a (review round 26 #1): an "entry:<id>" owner (an item-less History entry whose removal rides on the delete,
  // purge.js pathOwners). The delete's own outcome decides it as before: its group (every other owner of the hold) still
  // pending, in a call or superseded: wait; confirmed for all of them: gone. When the
  // outcome rests on a restore's evidence (an owner voided or dropped, or the owner-less group voided), the ENTRY decides:
  // a pass that read the cloud after a restore newer than its time keeps it if the entry is back (cloud or this browser)
  // and sends it if not, like a "history:<id>" owner. Without such evidence it follows the group as before.
  const entry = (o, at, hAt, groupOwners) => {
    const id = o.slice(ENTRY_OWNER.length);
    const others = groupOwners.filter(x => !isEntry(x));
    const d = others.length ? others.map(x => owner(x, at, hAt, true)) : [{ wait: "wait", go: "gone", cancel: "ev" }[group(at)]];
    if (d.includes("wait")) return "wait";
    if (d.every(x => x === "gone")) return "gone";
    if (usable && rk > hAt) return seen("history-delete", id);
    return "wait";   // no usable evidence yet: it waits, as the group does
  };
  const decide = (list, at, hAt, groupOwners = []) => {
    const d = list.map(o => (isEntry(o) ? entry(o, at, hAt, groupOwners) : owner(o, at, hAt)));
    return d.includes("alive") ? "cancel" : d.every(x => x === "gone") ? "go" : "wait";
  };
  return (owners, at, hAt, groupOwners) => {
    const list = clean(owners), all = clean(groupOwners).filter(o => !isEntry(o));
    if (list.length) return decide(list, at, hAt, all);
    return all.length ? decide(all, at, hAt) : group(at);
  };
}
// Decides every held item (App.jsx runs it before each flush, and with `evidence` in each reconcile pass;
// confirmDeleteIntents and voidDeleteIntents after their answer): "go" items are queued (files: fileDelete.js
// queueFileDeletes; WaveSpeed: the stored entry, due now), then leave the hold; "cancel" items leave it unqueued; "wait"
// items stay. Review round 24 #2/#4: an item leaves the hold only once its queue holds it (the write stored and read back):
// a full localStorage leaves it held for the next release, still counted by heldPurgeLeft. Returns { files, ws (queued),
// cancelled, kept (decided "go" but left held: the queue write failed) }.
// Task B12b (review round 25 #6/#7/#12/#13/#14/#15): a cancelled item whose generation waits for a relink (relinks below: a late result or
// an archive held while its delete was undecided) marks that relink ready, in the same step and BEFORE the item leaves the
// hold (a refused write keeps the item held for the next release); a "go" item drops it (the generation is gone).
export function releaseHeldPurges(now = Date.now(), evidence = null) {
  const out = { files: [], ws: [], cancelled: 0, kept: 0 };
  try {
    const m = readHeldPurges(), keys = Object.keys(m);
    if (!keys.length) return out;
    const rule = heldPurgeRule(now, evidence);
    const decided = [], goFiles = new Set(), wsGo = {};
    let changed = false;
    for (const k of keys) {
      const at = Number(k), g = m[k];
      if (!Number.isFinite(at) || !plainObject(g)) { delete m[k]; changed = true; continue; }
      const hAt = Number.isFinite(Number(g.h)) ? Number(g.h) : at;
      const files = plainObject(g.files) ? g.files : {}, ws = plainObject(g.ws) ? g.ws : {};
      // Every owner this delete's hold names (task B12a: what an owner-less item of it follows).
      const groupOwners = [...new Set([...Object.values(files).flatMap(o => (Array.isArray(o) ? o : [])),
        ...Object.values(ws).map(e => (plainObject(e) && e.tid ? String(e.tid) : ""))].filter(o => typeof o === "string" && o))];
      for (const [p, owners] of Object.entries(files)) {
        const d = rule(owners, at, hAt, groupOwners);
        if (d === "wait") continue;
        decided.push([k, "files", p, d]);
        if (d === "go") goFiles.add(p);
      }
      for (const [pid, e] of Object.entries(ws)) {
        const d = plainObject(e) ? rule(e.tid ? [String(e.tid)] : [], at, hAt) : "cancel";
        if (d === "wait") continue;
        decided.push([k, "ws", pid, d]);
        if (d === "go" && !wsGo[pid]) wsGo[pid] = e;
      }
    }
    // The queues first, then the hold: a page killed in between leaves the item in both (queued twice is harmless). Each
    // write is checked by reading the queue back: only what it holds leaves the hold.
    const filesIn = new Set(), wsIn = new Set();
    if (goFiles.size) {
      writeFileDeletes(queueFileDeletes(readFileDeletes(), [...goFiles], now));
      const q = readFileDeletes();
      for (const p of goFiles) if (q[p]) filesIn.add(p);
    }
    if (Object.keys(wsGo).length) {
      const q = readWsDeletes();
      for (const [pid, e] of Object.entries(wsGo)) if (!q[pid]) q[pid] = { ...e, at: now, attempts: 0, next: now };
      writeWsDeletes(q);
      const back = readWsDeletes();
      for (const pid of Object.keys(wsGo)) if (back[pid]) wsIn.add(pid);
    }
    // The relinks these decisions settle (task B12b): written before the hold changes; refused, every cancel that needed
    // one stays held (decided again by the next release).
    const queuedGo = ([, part, key, d]) => d === "go" && (part === "files" ? filesIn.has(key) : wsIn.has(key));
    const relinked = settleRelinks(decided.filter(x => x[3] === "cancel" || queuedGo(x)).map(([k, part, key, d]) => ({ part, key, d,
      owners: part === "ws" ? (plainObject(m[k]?.ws?.[key]) && m[k].ws[key].tid ? [String(m[k].ws[key].tid)] : []) : (Array.isArray(m[k]?.files?.[key]) ? m[k].files[key].map(String) : []) })));
    for (const [k, part, key, d] of decided) {
      const ok = (d === "cancel" && (relinked.ok || !relinked.needs.has(`${part}\u0000${key}`))) || queuedGo([k, part, key, d]);
      if (!ok) { out.kept++; continue; }
      if (d === "cancel") out.cancelled++;
      const g = m[k];
      const map = plainObject(g[part]) ? { ...g[part] } : {};
      delete map[key];
      m[k] = { ...g, [part]: map };
      changed = true;
    }
    for (const k of Object.keys(m)) {
      const g = m[k];
      if (plainObject(g) && !Object.keys(plainObject(g.files) ? g.files : {}).length && !Object.keys(plainObject(g.ws) ? g.ws : {}).length) { delete m[k]; changed = true; }
    }
    out.files = [...filesIn];
    out.ws = [...wsIn];
    if (changed) writeHeldPurges(m);
  } catch {}
  return out;
}
// What of these paths / prediction ids is still held (the toast's note: not deleted yet).
export function heldPurgeLeft(paths = [], predictionIds = []) {
  const files = new Set(), ws = new Set();
  for (const g of Object.values(readHeldPurges())) {
    if (!plainObject(g)) continue;
    for (const p of Object.keys(plainObject(g.files) ? g.files : {})) files.add(p);
    for (const pid of Object.keys(plainObject(g.ws) ? g.ws : {})) ws.add(pid);
  }
  return { files: (paths || []).filter(p => files.has(p)).length, ws: (predictionIds || []).filter(id => ws.has(id)).length };
}
// The defensive guard of both flushes (review round 23 #3): a path or prediction id a hold still covers, or that a stored
// clear stash holds (its tasks, its History entries, the data of its taken uploads, its archive records: a voided clear
// gives them back), is not deleted through the queues meanwhile, whoever else queued it.
export function heldDeleteRefs() {
  const paths = new Set(), predictions = new Set();
  // Task B12a (review round 25 #5): the holds a tab still on the previous build wrote under its key after this page's
  // migration guard the flushes too (read only: that build decides them).
  const legacy = [];
  for (const key of LEGACY_HELD_PURGE_KEYS) {
    try { const v = JSON.parse(localStorage.getItem(key) || "{}"); if (plainObject(v)) legacy.push(...Object.values(v)); } catch {}
  }
  for (const g of [...Object.values(readHeldPurges()), ...legacy]) {
    if (!plainObject(g)) continue;
    for (const p of Object.keys(plainObject(g.files) ? g.files : {})) paths.add(p);
    for (const pid of Object.keys(plainObject(g.ws) ? g.ws : {})) predictions.add(pid);
  }
  for (const s of readClearStashes()) {
    const items = [...s.tasks, ...s.logs, ...s.uploads.map(e => e?.data), ...Object.values(s.archives || {}).map(a => a?.task)].filter(x => x && typeof x === "object");
    for (const p of pathsInUse(items)) paths.add(p);
    for (const p of stashArchivePaths(s)) paths.add(p);
    for (const x of items) if (typeof x.taskId === "string" && x.taskId) predictions.add(x.taskId);
  }
  return { paths, predictions };
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
// Task B13a (review round 26 #3/#5): `opts.assumed` (Clear Outputs' unnamed History-only ids whose row a read found in
// the cloud: the server left it alone): the confirm is recorded WITHOUT the final mark (FINAL_CONFIRMS_KEY), so a row of
// it is released, never deleted again. Every other confirm is marked final first (before its record: a pass in between
// sees a marked id with its intent still pending, and waits).
export function confirmDeleteIntents(kind, ids, at, { assumed = false } = {}) {
  const isDelete = kind === "task-delete" || kind === "history-delete";
  const list = [...new Set((ids || []).filter(Boolean))];
  const bound = at == null ? null : Number(at);
  const queuedAt = bound != null && Number.isFinite(bound) ? bound : null;
  if (isDelete && list.length) {
    // Server time, like the queued uploads' stamps (addFailedSync) that withoutConfirmedUploads compares it with: a
    // device clock off by more than a few ms would otherwise keep a stale upload or drop a real one (round 19
    // follow-up, scripts/test-confirm-clock.mjs). The sequence orders it against reconcile passes (round 20 #4).
    const all = readConfirmed(), now = serverNow(), cut = now - CONFIRMED_FOR_MS, seq = takeConfirmSeq(), moved = {};
    // The final mark carries the record's queue time (the group's, or the record's own time when none is given).
    writeFinalMarks(kind, list, assumed ? null : (queuedAt ?? now));
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
  releaseHeldPurges();   // review round 23 #3: the files and WaveSpeed copies this confirm decided go to their queues
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
    writeFinalMarks(kind, ids, null);   // task B13a: the mark goes with its record
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
      writeFinalMarks(kind, out, null);   // task B13a: released here, so not a vanished mark
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
      writeFinalMarks(kind, out, null);   // task B13a: a restore brought them back
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
// Review round 23 #4: `strip: false` is for the immediate senders that run without a fresh restore read (persistLog and
// its sendHistoryEntry): "final" there rests on restore knowledge that can lag the cloud (a restore made elsewhere that
// no tab here has read yet brought the item back), so they never strip on their own. An entry holding a FINAL item is
// deferred too (queued as given, not sent); the reconcile pass and the replays, which run restoreGuard first, strip it.
export function historyUploadPlan(entries, { strip = true } = {}) {
  const { final, superseded } = confirmStates("task-delete");
  const hold = new Set([...superseded, ...inFlightIds("task-delete")]);
  const ready = [], defer = [];
  for (const l of entries || []) {
    const items = Array.isArray(l?.tasks) ? l.tasks : [];
    const held = items.some(i => i?.id && hold.has(i.id) && !final.has(i.id)) || (!strip && items.some(i => i?.id && final.has(i.id)));
    (held ? defer : ready).push(l);
  }
  const { upload, skip } = withoutDeleting(ready, final);
  return { upload, skip, defer: defer.map(l => l?.id) };
}
// Every History sender passes its entries through this before uploadable (task B8a, review round 21 #1/#5): the entries
// to send now (historyUploadPlan; `opts.strip` as there).
export function withoutBlockedItems(entries, opts) {
  return historyUploadPlan(entries, opts).upload;
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
// Task B12b (simulator finding F1, scripts/sim b0b9878): a confirm is released ONLY on restore evidence (the superseded
// rule above: a restore this browser knows of came after its queue time, and the cloud holds the id after it). A FINAL
// confirm whose id simply shows up in the cloud again is NOT a restore (a late upload landed after the delete: another
// device's queued upload, a page's own upload still in flight, while the server left no tombstone for a rowless id): its
// record stays and keeps blocking the id in every tab (nothing adds, shows or uploads it), and the pass deletes it again
// (`reappeared`: [{ id, at }]; App.jsx queues a delete intent at `at` = the confirm's queue time or, if later, the
// restore this browser knew of before the reads: the server voids it if any restore newer than that exists, so a row a
// restore brought back that this browser has not read yet is never deleted; the void then supersedes the confirm and the
// next pass decides it from the cloud). Before, releaseRestored released such an id as "restored", so the late row lived
// on in every tab (I1). Only confirms made before the pass began (`sinceSeq`) with no intent pending and no call in flight
// count, as before.
export function sharedDeleteState(kind, { deleting = new Set(), cloudIds = null, sinceSeq, restoreKnownAt, evidence } = {}) {
  const del = kind === "task" ? "task-delete" : "history-delete";
  const known = cloudIds instanceof Set;
  const resolved = known && restoreKnownAt > 0
    ? resolveSuperseded(del, new Set([...cloudIds, ...(evidence?.present || [])]), { restoreKnownAt, complete: evidence ? evidence.complete === true : true })
    : [];
  const pending = pendingDeleteIds(del), flying = inFlightIds(del);
  const seqs = confirmSeqs(del);
  const back = known ? releaseRestored(seqs.keys(), new Set([...pending, ...flying]), cloudIds, seqs, sinceSeq) : [];
  // Task B13a (review round 26 #3/#5): only a confirm this build MARKED final (the server named the id, or the settle
  // check confirmed it: finalMarked) is deleted again when its row comes back. Any other confirm (a previous build's, an
  // assumed one: the server left that row alone) is released, as before F1.
  const qAll = confirmQueuedAt(del), marked = finalMarked(del, qAll);
  const keepBack = back.filter(id => !marked.has(id));
  const released = [...resolved, ...(keepBack.length ? releaseConfirmed(del, keepBack, sinceSeq) : [])];
  const { final, superseded } = confirmStates(del);
  const q = confirmQueuedAt(del), rk = Number(restoreKnownAt) || 0;
  const reappeared = back.filter(id => final.has(id) && marked.has(id)).map(id => ({ id, at: Math.max(Number(q.get(id)) || 0, rk) }));
  // #3: a marked confirm whose record a previous-build tab released (no record now, nothing pending or in a call, no
  // restore known after it) while its row is back: deleted again too, and blocked meanwhile (in `deleting`).
  if (known) {
    const have = new Set(reappeared.map(r => r.id));
    for (const r of vanishedFinalMarks(del, { cloudIds, busy: new Set([...pending, ...flying]), rk: Math.max(rk, knownRestoreAt()), records: new Set(q.keys()) }))
      if (!have.has(r.id)) reappeared.push(r);
  }
  const confirmed = new Set([...final, ...superseded]);
  const all = new Set([...(deleting || []), ...pending, ...flying, ...confirmed, ...reappeared.map(r => r.id)]);
  return { released, reappeared, deleting: all, confirmed, final, superseded,
    stale: (rows) => (known ? (rows || []).filter(r => r?.id && final.has(r.id) && !cloudIds.has(r.id)).map(r => r.id) : []) };
}

// Task B12b (with F1): confirms this browser records WITHOUT the server having named the id: Clear Outputs' History-only
// generations of cloud-only entries (App.jsx, review round 10: the server tombstones the ones still without a row and
// leaves alone one whose row exists, a generation another device just made). For such an id a row in the cloud is the
// server's own decision, not a late upload: sharedDeleteState releases it, as before, and never deletes it again.
// Written BEFORE the confirm (a pass between the two then still sees it as assumed). Layout: kind -> id -> the confirm's
// queue time; an entry whose record is gone or has another queue time no longer counts (pruned by the next write).
const ASSUMED_CONFIRMS_KEY = "proximaai-assumed-confirms";
const readAssumed = () => readKinds(ASSUMED_CONFIRMS_KEY);
export function markAssumedConfirms(kind, ids, at) {
  const list = [...new Set((ids || []).filter(Boolean).map(String))], ts = Number(at);
  if (!list.length || !Number.isFinite(ts) || (kind !== "task-delete" && kind !== "history-delete")) return;
  try {
    const all = readAssumed(), live = new Set(confirmRecords(kind).map(([id]) => id));
    const m = { ...(all[kind] || {}) };
    for (const id of Object.keys(m)) if (!live.has(id)) delete m[id];
    for (const id of list) m[id] = ts;
    all[kind] = m;
    localStorage.setItem(ASSUMED_CONFIRMS_KEY, JSON.stringify(all));
  } catch {}
}
// Task B13a: this key is no longer READ by this build (a confirm without a final mark, below, is released); it is still
// WRITTEN for assumed confirms, so a tab on the previous build (bf37422), which re-deletes every final confirm whose row
// is back unless this key names it (with the record's queue time), never deletes a row the server left alone.

// ─── Task B13a (review round 26 #3/#5): THE KEY RULE for confirm records ───
// F1 (task B12b) changed what a FINAL confirm whose row shows up again means (deleted again, not released) but kept the
// confirm records' keys, so a previous build decided the same records differently: a tab on d0b3af6 released such a
// record (its row then lived on in every tab, #3), and a bf37422 tab re-deleted a confirm a previous build made without
// the server naming the id (a row the server left alone on purpose, rule (g), #5). So this build marks, in a NEW key no
// previous build reads, the final confirms it made itself because the server named the id or the clear's settle check
// confirmed it gone (confirmDeleteIntents; Clear Outputs' unnamed History-only ids only once a read showed no row for
// them). F1's re-delete applies only to a confirm with that mark (its queue time equal to the record's); a confirm
// without it (a previous build's, an assumed one, or one whose mark could not be written) is released as before. A
// marked id whose confirm record vanished while no delete of it is pending or in a call (a previous-build tab released
// it), with no restore known after its queue time, and whose row is back in the cloud is treated as reappeared and
// deleted again (at its queue time: the server voids that if any restore came after it). Layout: kind -> id -> the
// confirm's queue time (server ms). A mark goes with its record (released by a restore, forgotten by a new delete) and
// CONFIRMED_FOR_MS after its queue time; one whose record vanished with a restore known after its queue time goes too.
const FINAL_CONFIRMS_KEY = "proximaai-final-confirms";
const readFinalMarks = () => readKinds(FINAL_CONFIRMS_KEY);
// Sets (`q` finite) or removes (`q` null) the marks of `ids`; prunes marks older than CONFIRMED_FOR_MS. Says whether it was
// stored.
function writeFinalMarks(kind, ids, q) {
  if (kind !== "task-delete" && kind !== "history-delete") return true;
  const list = [...new Set((ids || []).filter(Boolean).map(String))];
  try {
    const all = readFinalMarks(), cut = serverNow() - CONFIRMED_FOR_MS, recs = readConfirmed();
    let changed = false;
    for (const k of Object.keys(all)) {
      const m = plainObject(all[k]) ? all[k] : {}, live = plainObject(recs[k]) ? recs[k] : {};
      // A mark older than CONFIRMED_FOR_MS goes once its record is gone too (a record lives 30 days from its confirm,
      // which may come long after its queue time).
      for (const [id, v] of Object.entries(m)) if (!(Number(v) > cut) && !(id in live)) { delete m[id]; changed = true; }
      all[k] = m;
    }
    if (list.length) {
      const m = plainObject(all[kind]) ? all[kind] : {};
      for (const id of list) {
        if (q != null && Number.isFinite(Number(q))) { m[id] = Number(q); changed = true; }
        else if (id in m) { delete m[id]; changed = true; }
      }
      all[kind] = m;
    }
    if (!changed) return true;
    for (const k of Object.keys(all)) if (!Object.keys(all[k]).length) delete all[k];
    if (Object.keys(all).length) localStorage.setItem(FINAL_CONFIRMS_KEY, JSON.stringify(all)); else localStorage.removeItem(FINAL_CONFIRMS_KEY);
    return true;
  } catch { return false; }
}
// The marked ids of a kind whose confirm record carries the mark's queue time (`queued`: confirmQueuedAt(kind)).
function finalMarked(kind, queued) {
  const m = readFinalMarks()[kind] || {}, out = new Set();
  for (const [id, q] of Object.entries(m)) if (queued.has(id) && Number(queued.get(id)) === Number(q)) out.add(id);
  return out;
}
// Marked ids whose confirm record vanished (#3): [{ id, at }] for those whose row is back (`cloudIds`) with no delete of
// them pending or in a call (`busy`) and no restore known after the mark (`rk`). A mark with a restore known after it
// goes (that restore may be what released the record).
function vanishedFinalMarks(kind, { cloudIds, busy, rk, records }) {
  const m = readFinalMarks()[kind] || {}, out = [], stale = [];
  for (const [id, v] of Object.entries(m)) {
    const q = Number(v);
    if (records.has(id) || busy.has(id) || !Number.isFinite(q)) continue;
    if (q < rk) { stale.push(id); continue; }
    if (cloudIds.has(id)) out.push({ id, at: q });
  }
  if (stale.length) writeFinalMarks(kind, stale, null);
  return out;
}
// Test and wiring hook: the marks of a kind (id -> queue time).
export function finalConfirmMarks(kind) {
  return new Map(Object.entries(readFinalMarks()[kind] || {}).map(([id, q]) => [id, Number(q)]));
}

// ─── Task B12b (simulator finding F3): History entries a delete trimmed here are re-taken from the cloud once it settles ───
// A delete trims this device's copies of the History entries that keep other items (purge.js planPurge rewrites; the
// server strips its own copies in the delete's transaction). If that delete is VOIDED (a restore came after it), the
// cloud's entries keep the items while this device's trimmed copies stayed: the pass takes the cloud's copy only for a
// restore this tab has not handled yet (restoredVersions under guard.fresh), so a void handled after the restore left
// the trimmed copies here forever. Now every trim is recorded under its delete's queue times (`times`: the task-delete
// and History intents' times), shared by the tabs (IndexedDB holds the trimmed copy for every tab): once nothing is
// pending or in a call at those times (confirmed, voided or dropped alike), each tab's next pass that read History takes
// the cloud's copy of those entries (less the items of generations still being deleted, App.jsx), then remembers it did
// (per tab: a reload takes it once more, harmlessly). A confirmed delete's cloud copy is already stripped, so taking it
// changes nothing. Layout: key "<times joined by ,>" -> { ids: [...], at: device ms, s: device ms first seen settled };
// dropped HISTORY_RESYNC_FOR_MS after it settled.
const HISTORY_RESYNC_KEY = "proximaai-history-resync";
const HISTORY_RESYNC_FOR_MS = 24 * 60 * 60 * 1000;
const readHistoryResync = () => {
  try { const v = JSON.parse(localStorage.getItem(HISTORY_RESYNC_KEY) || "{}"); return plainObject(v) ? v : {}; } catch { return {}; }
};
export function markHistoryResync(times, ids) {
  const list = [...new Set((ids || []).filter(Boolean).map(String))];
  const ts = [...new Set((times || []).map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
  if (!list.length || !ts.length) return true;
  try {
    const m = readHistoryResync(), key = ts.join(",");
    const cur = plainObject(m[key]) && Array.isArray(m[key].ids) ? m[key].ids : [];
    m[key] = { ids: [...new Set([...cur, ...list])], at: Date.now() };
    localStorage.setItem(HISTORY_RESYNC_KEY, JSON.stringify(m));
    return true;
  } catch { return false; }
}
// The settled records: [{ key, ids }] (each tab applies a key once, App.jsx). Records older than their lifetime go.
export function historyResyncDue(now = Date.now()) {
  const out = [];
  try {
    const m = readHistoryResync(), flights = Object.values(readFlights()).filter(f => plainObject(f) && Number(f.until) > now);
    let changed = false;
    for (const [key, r] of Object.entries(m)) {
      if (!plainObject(r) || !Array.isArray(r.ids)) { delete m[key]; changed = true; continue; }
      const times = key.split(",").map(Number).filter(Number.isFinite);
      const busy = times.some(t => intentsPendingAt(t) || flights.some(f => Number(f.at) === t));
      if (busy) continue;
      if (!(Number(r.s) > 0)) { m[key] = { ...r, s: now }; changed = true; }
      else if (now - Number(r.s) > HISTORY_RESYNC_FOR_MS) { delete m[key]; changed = true; continue; }
      out.push({ key, ids: r.ids.map(String) });
    }
    if (changed) { if (Object.keys(m).length) localStorage.setItem(HISTORY_RESYNC_KEY, JSON.stringify(m)); else localStorage.removeItem(HISTORY_RESYNC_KEY); }
  } catch {}
  return out;
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
// Says whether it was stored (a full localStorage refuses it). Task B13a (review round 26 #4): a clear writes its stash
// inside its reservation (reserveDelete `stash`), so a refused stash stops the clear with nothing changed.
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
    // Task B12a: and while a hold is kept for that time (an owner-less held item follows whether its delete was voided).
    for (const k of Object.keys(readHeldPurges())) if (Number.isFinite(Number(k))) refs.add(Number(k));
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
    // Review round 23 #2/#5: what it proves is R > at, and the server compares floor(queued_at) < last_restore_at with
    // whole-ms markers, so R >= floor(at) + 1: a confirm queued at exactly `at` (another chunk or call of the same group,
    // answered "deleted" before R) is superseded at once too, not only at the next restore read.
    if (Number.isFinite(Number(at))) noteRestoreKnown(Math.floor(Number(at)) + 1);
    landFlightIds(kind, ids, at);
  }
  releaseHeldPurges();   // review round 23 #3: what a voided id held is cancelled
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
