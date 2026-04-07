// ─── IndexedDB Storage Layer ───
// Zero dependencies. Falls back to localStorage if IndexedDB unavailable.

const DB_NAME = "prism";
const DB_VERSION = 1;

const STORES = {
  settings: { keyPath: "key" },
  history: { keyPath: "id", autoIncrement: false },
  favorites: { keyPath: "id", autoIncrement: false },
  presets: { keyPath: "modelId" },
};

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
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, config);
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
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

// ─── Public API ───

export async function getSetting(key) {
  try {
    const store = await tx("settings");
    const result = await wrapRequest(store.get(key));
    return result?.value ?? null;
  } catch {
    return localStorage.getItem(`prism-${key}`) || null;
  }
}

export async function setSetting(key, value) {
  try {
    const store = await tx("settings", "readwrite");
    await wrapRequest(store.put({ key, value }));
  } catch {
    localStorage.setItem(`prism-${key}`, typeof value === "string" ? value : JSON.stringify(value));
  }
}

export async function addHistoryEntry(entry) {
  try {
    const store = await tx("history", "readwrite");
    await wrapRequest(store.put(entry));
  } catch {
    // Fallback: append to localStorage (capped at 200)
    try {
      const logs = JSON.parse(localStorage.getItem("prism-logs") || "[]");
      logs.unshift(entry);
      if (logs.length > 200) logs.length = 200;
      localStorage.setItem("prism-logs", JSON.stringify(logs));
    } catch {}
  }
}

export async function getHistory(limit = 500) {
  try {
    const store = await tx("history");
    const all = await wrapRequest(store.getAll());
    // Sort newest first
    all.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    return limit ? all.slice(0, limit) : all;
  } catch {
    try {
      return JSON.parse(localStorage.getItem("prism-logs") || "[]");
    } catch { return []; }
  }
}

export async function clearHistory() {
  try {
    const store = await tx("history", "readwrite");
    await wrapRequest(store.clear());
  } catch {
    localStorage.removeItem("prism-logs");
  }
}

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

// ─── Migration from localStorage ───
export async function migrateFromLocalStorage() {
  try {
    // Migrate API key
    const oldKey = localStorage.getItem("prism-api-key");
    if (oldKey) {
      await setSetting("apiKey", oldKey);
      localStorage.removeItem("prism-api-key");
    }

    // Migrate logs
    const oldLogs = localStorage.getItem("prism-logs");
    if (oldLogs) {
      const logs = JSON.parse(oldLogs);
      const store = await tx("history", "readwrite");
      for (const log of logs) {
        try { await wrapRequest(store.put(log)); } catch {}
      }
      localStorage.removeItem("prism-logs");
    }
  } catch {
    // Migration failed silently — localStorage data preserved as fallback
  }
}
