// One BROWSER of the simulator: its localStorage (shared by its tabs, exactly as Chrome shares it), its IndexedDB (a
// shared in-memory mirror of the storage.js IndexedDB layer), and one sessionStorage per tab.
//
// How the tabs share state (and why): the REAL src/lib/storage.js keeps per-page module state (TAB_ID from
// sessionStorage, handledRestore = the restore this PAGE has handled) next to the shared localStorage keys (the
// failed-sync queue, confirm records, flights, stashes, seen-restore). So every PAGE (a tab's life between reloads) gets
// its OWN instance of the real module, imported with a cache-busting query (storage.js?slot=A1&gen=N): its module-level
// state is its own, while every instance reads and writes the ONE localStorage of its browser. storage.js reads the
// global `localStorage` at call time, so the global is a proxy to the localStorage of the browser whose code is running
// (sim.mjs sets `CURRENT` before resuming any tab's code and drains every microtask before switching; no tab's code
// ever runs while another browser is current). The pure modules storage.js imports (syncReconcile, batchLog,
// serverClock, taskResume, fileDelete) are shared by every instance: they hold no per-tab state.
// IndexedDB: storage.js's IndexedDB functions cannot run in Node (no `window.indexedDB`), so the few the App flows use
// (saveTask(s), deleteTasks, addHistoryEntry, deleteHistoryEntries, allStoredTasks, allStoredHistory, getHistory,
// getCompletedTasks) are mirrored here over a per-browser Map, applied synchronously (blind spot: IndexedDB write order
// against the awaits around it).
import { libUrl } from "./lib.mjs";

const STORAGE_URL = libUrl("storage.js");

export const CURRENT = { browser: null };
class MemStorage {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(String(k), String(v)); }
  removeItem(k) { this.m.delete(k); }
  key(i) { return [...this.m.keys()][i] ?? null; }
  get length() { return this.m.size; }
  clear() { this.m.clear(); }
}
const proxyStore = (pick) => ({
  getItem: (k) => pick().getItem(k), setItem: (k, v) => pick().setItem(k, v), removeItem: (k) => pick().removeItem(k),
  key: (i) => pick().key(i), get length() { return pick().length; }, clear: () => pick().clear(),
});
let installed = false;
export function installGlobals() {
  if (installed) return;
  installed = true;
  const cur = () => { if (!CURRENT.browser) throw new Error("sim: no current browser"); return CURRENT.browser.ls; };
  globalThis.localStorage = proxyStore(cur);
  globalThis.sessionStorage = proxyStore(() => { const s = CURRENT.browser?.session; if (!s) throw new Error("sim: no current session"); return s; });
}

// Instances are POOLED per tab slot and page generation (memory: each instance of storage.js costs ~0.26 MB and an ESM
// module is never unloaded, while one run reloads pages several times and the shrinker makes hundreds of runs). Every
// instance of a slot is imported with that slot's sessionStorage holding "proximaai-tab-id" = the slot name, so its
// TAB_ID is the slot (as a reloaded tab keeps its id: storage.js pickTabId, no form key). The other per-page module
// state, handledRestore, is re-seeded at each page start with markRestoreSeen(<this browser's seen-restore>): a run's
// clock starts above every earlier run's (sim.mjs RUN_BASE), so a value left over from an earlier run is below every
// time of this run and acts exactly like 0 (a fresh page's value when nothing was seen).
const POOL = new Map();   // slot -> [instance by page generation]
export class Browser {
  constructor(name) {
    this.name = name;
    this.ls = new MemStorage();
    this.session = null;
    this.idb = { tasks: new Map(), history: new Map() };
  }
  // The storage.js instance of page generation `gen` of tab `slot`, ready for a page start in this browser.
  async newStorageInstance(slot, gen) {
    if (!POOL.has(slot)) POOL.set(slot, []);
    const pool = POOL.get(slot);
    const prev = CURRENT.browser;
    CURRENT.browser = this;
    try {
      while (pool.length <= gen) {
        this.session = new MemStorage();
        this.session.setItem("proximaai-tab-id", slot);
        this.session.setItem("proximaai-flight-tab", `f-${slot}`);   // round 23: the tab's flight id, kept across reloads
        pool.push(await import(`${STORAGE_URL}?slot=${slot}&gen=${pool.length}`));
      }
      const S = pool[gen];
      S.markRestoreSeen(Number(this.ls.getItem("proximaai-seen-restore")) || 0);
      // Round 23 (storage.js, at load): no live page answers for this tab's flight id (its previous page is dead), so the
      // entries it left before this load go (flightPresence onFree / the no-BroadcastChannel branch: dropFlightsOfTab).
      if (typeof S.dropFlightsOfTab === "function" && typeof S.flightTabId === "function") S.dropFlightsOfTab(S.flightTabId(), Date.now());
      return S;
    } finally { CURRENT.browser = prev; }
  }
  // ─── IndexedDB mirror (storage.js:245-338, 132-201) ───
  saveTask(t) { if (t?.id) this.idb.tasks.set(t.id, JSON.parse(JSON.stringify(t))); }
  saveTasks(list) { for (const t of list || []) this.saveTask(t); }
  deleteTasks(ids) { for (const id of ids || []) this.idb.tasks.delete(id); }
  addHistoryEntry(e) { if (e?.id) this.idb.history.set(e.id, JSON.parse(JSON.stringify(e))); }
  deleteHistoryEntries(ids) { for (const id of ids || []) this.idb.history.delete(id); }
  allStoredTasks() { return [...this.idb.tasks.values()].map(t => JSON.parse(JSON.stringify(t))); }
  allStoredHistory() { return [...this.idb.history.values()].map(e => JSON.parse(JSON.stringify(e))).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)); }
  getHistory(limit = 500) { return this.allStoredHistory().slice(0, limit); }
  getCompletedTasks(limit = 500) {
    return this.allStoredTasks().filter(t => t.status === "completed" || t.status === "failed")
      .sort((a, b) => (b.startTime || 0) - (a.startTime || 0)).slice(0, limit);
  }
}
