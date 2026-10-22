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
// A form publication (a tab's, or a browser's in the cloud) counts this long after its last heartbeat. Chrome freezes a
// background page (the phone) without a word, and a frozen page keeps its form's uploads for when it wakes, so silence
// cannot mean "released"; only a closing tab (pagehide) or that browser's next publication releases a hold early. A
// tab killed while frozen keeps its files at most this long (review round 2).
export const FORM_HOLD_ALIVE_MS = 7 * 24 * 60 * 60 * 1000;
const OWNED_MAX_MS = 48 * 60 * 60 * 1000;      // an "owned" path is re-checked this long before it leaves (review #5)

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
  if (outcome === "deleted" || outcome === "gone") { delete out[path]; return out; }
  // "owned": a kept generation here uses it. A view that has not caught up may still show a generation deleted
  // elsewhere, so it is checked again in a minute rather than dropped; after OWNED_MAX_MS the owner's own delete
  // re-queues it if it ever goes (review wf_ec400a67-988 #5).
  if (outcome === "owned") {
    if (now - e.at > OWNED_MAX_MS) delete out[path];
    else out[path] = { ...e, next: now + FORM_HOLD_RETRY_MS };
    return out;
  }
  if (outcome === "form") { out[path] = { ...e, form: true, next: now + FORM_HOLD_RETRY_MS }; return out; }
  const attempts = e.attempts + 1;
  const { form, ...rest } = e;
  out[path] = { ...rest, attempts, next: now + Math.min(MAX_BACKOFF_MS, 30_000 * 2 ** Math.min(attempts, 6)) };
  return out;
}

// Review #3 (2026-10-22): an upload a Generate form still holds is not deleted with the generation that used it.
// "owned": a kept generation here uses it, or the server says a row of this account does (`remote`, review #7):
// checked again later. "form": a Generate form still holds it (held). "unknown": the server did not answer (wait).
// null: nobody uses it, delete it.
// `formsKnown: false`: the other devices' form holds could not be read (review #6), so an upload waits ("unknown").
export const classifyPath = (path, { owned, forms, remote, formsKnown = true } = {}) =>
  owned?.has(path) ? "owned" : forms?.has(path) ? "form" : (!formsKnown && path.startsWith("uploads/")) ? "unknown"
    : remote === null ? "unknown" : remote?.has(path) ? "owned" : null;

// Review wf_ec400a67-988 #6: each browser also publishes its live form holds to the cloud (settings row
// form-inputs:<browser>), so a delete on the other device keeps them too. Republished when they change and at least
// every FORM_CLOUD_HEARTBEAT_MS, well inside FORM_HOLD_ALIVE_MS, so a live hold never reads as lapsed elsewhere.
export const FORM_CLOUD_HEARTBEAT_MS = 10 * 60 * 1000;
export function formPublishDue(last, paths, now) {
  if (!last) return true;
  const a = new Set(last.paths || []), b = new Set(paths || []);
  if (a.size !== b.size || [...b].some(p => !a.has(p))) return true;
  return now - last.at >= FORM_CLOUD_HEARTBEAT_MS;
}
// Paths held by the forms of live (or frozen) tabs: publications refreshed within FORM_HOLD_ALIVE_MS.
export function liveFormPaths(pubs, now) {
  const out = new Set();
  for (const p of pubs || []) {
    if (!p || !Number.isFinite(p.at) || now - p.at > FORM_HOLD_ALIVE_MS) continue;
    for (const x of Array.isArray(p.paths) ? p.paths : []) if (typeof x === "string" && x) out.add(x);
  }
  return out;
}
// Acted on only once this device's rows are loaded and the first cloud sync merged the other device's: before that,
// nothing shows which queued paths a kept generation uses again.
export const fileFlushReady = ({ loaded, synced }) => !!loaded && !!synced;
export const pendingOf = (queue, paths) => (paths || []).filter(p => queue?.[p] && !queue[p].form).length;
export const heldOf = (queue, paths) => (paths || []).filter(p => queue?.[p]?.form).length;
// The toast's note on what a delete has not finished yet (review wf_ec400a67-988 #4): files still queued or held for a
// Generate form, WaveSpeed copies still queued (a running prediction is skipped and retried), a History removal the
// cloud has not confirmed. Empty when everything is done: only then may a toast say "permanently, everywhere".
export function purgeNote({ files = 0, held = 0, ws = 0, history = false } = {}) {
  const s = (n) => (n === 1 ? "" : "s");
  return (files ? ` — ${files} file${s(files)} still being deleted (retried automatically)` : "")
    + (held ? ` — ${held} file${s(held)} kept while the Generate form uses ${held === 1 ? "it" : "them"}` : "")
    + (ws ? ` — ${ws} WaveSpeed cop${ws === 1 ? "y" : "ies"} still being deleted (retried automatically)` : "")
    + (history ? " — History removal will finish on your next save or reload" : "");
}
export async function headStatus(url, fetchImpl = fetch) {
  if (!url) return 0;
  try { return (await fetchImpl(url + (url.includes("?") ? "&" : "?") + "v=" + Date.now(), { method: "HEAD", cache: "no-store" })).status; } catch { return 0; }
}
