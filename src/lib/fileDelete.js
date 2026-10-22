// "Delete means delete" (owner, 2026-10-21): the files of deleted generations go too, durably (review #5). Storage
// objects can only be deleted through the Storage API (storage.protect_delete), so, like wsDelete.js, this is a client
// queue in localStorage (storage.js readFileDeletes/writeFileDeletes). It is written before the row delete fires
// (App.jsx stagePurge), replayed on load, return, reconnect and every minute, and settled only by a confirmed delete.
// remove() names a path only when it deleted it (storageRemove.js). "Already gone" and "refused (no valid session)" both
// name nothing, so after a retry the public URL is HEADed (public bucket): 400/404 = gone, 2xx = still there (back off,
// never drop). A path a kept generation or History entry on this device uses again leaves the queue unsent ("owned"):
// that generation's own delete queues it again. Pure; tested by scripts/test-file-delete.mjs.
export const FILE_DELETE_CHUNK = 50;
const MAX_BACKOFF_MS = 30 * 60 * 1000;
export const FORM_HOLD_RETRY_MS = 60 * 1000;   // a form-held path is re-checked this often (review #3)
export const TAB_ALIVE_MS = 30 * 60 * 1000;    // a tab's form publication counts this long after its last heartbeat

// Adds paths, due now. An entry already queued keeps its attempts and is only pulled earlier.
export function queueFileDeletes(queue, paths, now) {
  const out = { ...(queue || {}) };
  for (const p of paths || []) {
    if (typeof p !== "string" || !p) continue;
    out[p] = out[p] ? { ...out[p], next: Math.min(out[p].next, now) } : { at: now, attempts: 0, next: now };
  }
  return out;
}
export const dueFileDeletes = (queue, now, limit = FILE_DELETE_CHUNK) =>
  Object.entries(queue || {}).filter(([, e]) => e?.next <= now).map(([p]) => p).slice(0, limit);
// HEAD of the public URL after remove() named nothing twice.
export const headOutcome = (status) => (status === 400 || status === 404 ? "gone" : status >= 200 && status < 300 ? "present" : "unknown");
// outcome: "deleted" | "gone" | "owned" (settled: the entry leaves) | "form" (held: never dropped, re-checked every
// minute, attempts unchanged) | "present" | "unknown" (backs off, never dropped).
export function settleFileDelete(queue, path, outcome, now) {
  const out = { ...(queue || {}) }; const e = out[path];
  if (!e) return out;
  if (outcome === "deleted" || outcome === "gone" || outcome === "owned") { delete out[path]; return out; }
  if (outcome === "form") { out[path] = { ...e, form: true, next: now + FORM_HOLD_RETRY_MS }; return out; }
  const attempts = e.attempts + 1;
  const { form, ...rest } = e;
  out[path] = { ...rest, attempts, next: now + Math.min(MAX_BACKOFF_MS, 30_000 * 2 ** Math.min(attempts, 6)) };
  return out;
}

// Review #3 (2026-10-22): an upload a Generate form still holds is not deleted with the generation that used it.
// "owned": a kept generation uses it (drop, unsent). "form": a Generate form still holds it (held). null: delete it.
export const classifyPath = (path, { owned, forms } = {}) => (owned?.has(path) ? "owned" : forms?.has(path) ? "form" : null);
// Paths held by the forms of live tabs (publications refreshed within TAB_ALIVE_MS).
export function liveFormPaths(pubs, now) {
  const out = new Set();
  for (const p of pubs || []) {
    if (!p || !Number.isFinite(p.at) || now - p.at > TAB_ALIVE_MS) continue;
    for (const x of Array.isArray(p.paths) ? p.paths : []) if (typeof x === "string" && x) out.add(x);
  }
  return out;
}
// Acted on only once this device's rows are loaded and the first cloud sync merged the other device's: before that,
// nothing shows which queued paths a kept generation uses again.
export const fileFlushReady = ({ loaded, synced }) => !!loaded && !!synced;
export const pendingOf = (queue, paths) => (paths || []).filter(p => queue?.[p] && !queue[p].form).length;
export const heldOf = (queue, paths) => (paths || []).filter(p => queue?.[p]?.form).length;
export function filesNote(pending, held = 0) {
  const s = (n) => (n === 1 ? "" : "s");
  return (pending ? ` — ${pending} file${s(pending)} still being deleted (retried automatically)` : "")
    + (held ? ` — ${held} file${s(held)} kept while the Generate form uses ${held === 1 ? "it" : "them"}` : "");
}
export async function headStatus(url, fetchImpl = fetch) {
  if (!url) return 0;
  try { return (await fetchImpl(url + (url.includes("?") ? "&" : "?") + "v=" + Date.now(), { method: "HEAD", cache: "no-store" })).status; } catch { return 0; }
}
