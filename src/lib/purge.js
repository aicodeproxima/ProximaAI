// "Delete means delete" (owner, 2026-10-21): deleting generations removes them everywhere the app can reach. This
// module decides which stored files go (pure; tested by scripts/test-purge.mjs); the durable queue in fileDelete.js
// deletes them. History entries are decided in batchLog.js purgeLogsForDeleted, WaveSpeed's copy in wsDelete.js, backup
// copies by the server (triggers queue into backup_scrub_queue, migration 20261021175100). A file still loaded in a
// Generate form is held until every form lets go of it (fileDelete.js "form").
import { purgeLogsForDeleted, clientHistoryWork } from "./batchLog.js";
import { queueDeletes } from "./wsDelete.js";
import { serverNow } from "./serverClock.js";
//
// Files live in the public bucket "generations": uploads/<scope>/<id>.<ext> (source images, end frames, audio,
// driving video WaveSpeed fetched by URL) and <scope>/... (☁ archives of outputs). A file still used by a generation
// or History entry that is kept stays, so nothing kept breaks.

const MARK = "/storage/v1/object/public/generations/";

// The bucket path of one of our storage URLs, or null for anything else (WaveSpeed CDN, other hosts, empty).
export function storagePathOf(url) {
  const s = typeof url === "string" ? url : "";
  const i = s.indexOf(MARK);
  if (i < 0) return null;
  const path = s.slice(i + MARK.length).split(/[?#]/)[0];
  try { return decodeURIComponent(path) || null; } catch { return path || null; }
}

const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);
const INPUT_FIELDS = ["sourceImageUrl", "sourceImageUrls", "endFrameUrl", "sourceAudioUrl", "sourceVideoUrl", "refVideoUrl"];

// Every bucket path a task or History entry refers to (its inputs, its outputs, its archived copies).
function pathsOf(x) {
  const urls = [...INPUT_FIELDS.flatMap(f => list(x?.[f])), ...list(x?.outputs), ...list(x?.archivedOutputs),
    ...(Array.isArray(x?.tasks) ? x.tasks.flatMap(i => list(i?.outputs)) : [])];
  const paths = urls.map(storagePathOf).filter(Boolean);
  return [...paths, ...list(x?.archivedPaths).filter(p => typeof p === "string" && p)];
}

// Paths the removed generations refer to that no kept generation or History entry still uses.
export function storagePathsToDelete(removedTasks, keptTasks, keptLogs) {
  const keep = pathsInUse([...keptTasks, ...keptLogs]);
  return [...new Set(removedTasks.flatMap(pathsOf))].filter(p => !keep.has(p));
}

// Every bucket path the given tasks / entries / form objects use.
export const pathsInUse = (items) => new Set((items || []).filter(Boolean).flatMap(pathsOf));

// Paths this device's kept generations and History entries use, ignoring what is being deleted: tasks and entries by
// id, and History items of tasks being deleted (an entry left with none of its items owns nothing).
export function ownedPaths(tasks, logs, { taskIds = new Set(), logIds = new Set() } = {}) {
  const keptTasks = (tasks || []).filter(t => t && !taskIds.has(t.id));
  const keptLogs = (logs || []).filter(l => l && !logIds.has(l.id)).flatMap(l => {
    const items = Array.isArray(l.tasks) ? l.tasks : [];
    const left = items.filter(i => !(i?.id && taskIds.has(i.id)));
    return items.length && !left.length ? [] : [{ ...l, tasks: left }];
  });
  return pathsInUse([...keptTasks, ...keptLogs]);
}

// Review round 23 #3: who each of a purge's `paths` belongs to (storage.js holdPurgeDeletes: a path goes only once every
// owner's delete is final, and stays if one is voided). A removed generation owns its own paths (by task id). An item of
// a removed History entry owns its outputs (its task id); the entry's own fields (the batch's inputs) belong to all its
// items. An entry whose removal is its own History delete (`logOwners`: the entries the delete queued intents for), or
// that holds an item without an id, owns its paths itself ("history:<id>"). Returns { path: [owners] }.
// Task B12a (review round 25 #4): an entry WITHOUT items and without a History delete of its own (its removal rides on
// the task delete: the server removes it in the clear's transaction) gets NO owner for its paths: no intent would ever
// decide "history:<id>", so it waited forever. Owner-less, the path follows the delete it is held for as a whole
// (storage.js heldPurgeRule: queued once that delete is settled, cancelled if it was voided). A path another owner
// shares keeps that owner.
export function pathOwners(removed, goneLogs, paths, { logOwners = new Set() } = {}) {
  const want = new Set(paths || []), out = new Map();
  const add = (list, owners) => {
    for (const p of list) if (want.has(p)) { if (!out.has(p)) out.set(p, new Set()); for (const o of owners) out.get(p).add(o); }
  };
  for (const t of removed || []) if (t?.id) add(pathsOf(t), [String(t.id)]);
  for (const l of goneLogs || []) {
    if (!l?.id) continue;
    const items = Array.isArray(l.tasks) ? l.tasks : [];
    if (logOwners.has(l.id) || items.some(i => !i?.id)) { add(pathsOf(l), [`history:${l.id}`]); continue; }
    if (!items.length) { add(pathsOf(l), []); continue; }
    for (const i of items) add(list(i.outputs).map(storagePathOf).filter(Boolean), [String(i.id)]);
    add(pathsOf({ ...l, tasks: [] }), items.map(i => String(i.id)));
  }
  return Object.fromEntries([...out].map(([p, s]) => [p, [...s]]));
}

// The public URL of a bucket path (the queue's gone-check HEADs it). Round-trips through storagePathOf.
export const publicUrlOf = (base, path) => (base && path ? base.replace(/\/+$/, "") + MARK + path.split("/").map(encodeURIComponent).join("/") : null);

// The whole plan of a generation delete: History entries removed / rewritten, entries kept, and the files no kept
// generation or entry uses. `history: false` + `alsoLogs`: the caller cleared History itself (Reset Everything).
export function planPurge(logs, removed, kept, { history = true, alsoLogs = [], all = false } = {}) {
  const alsoIds = new Set(alsoLogs.map(l => l.id));
  const base = (logs || []).filter(l => !alsoIds.has(l.id));
  let remove = [], rewrite = [], keptLogs = base;
  const goneLogs = [...alsoLogs];
  if (history && (removed.length || all)) {   // all: Clear Outputs removes every entry even with nothing removed (review round 8)
    ({ remove, rewrite } = purgeLogsForDeleted(base, removed, kept, { all }));
    const gone = new Set(remove), byId = new Map(rewrite.map(l => [l.id, l]));
    goneLogs.push(...base.filter(l => gone.has(l.id)));
    keptLogs = base.filter(l => !gone.has(l.id)).map(l => byId.get(l.id) || l);
  }
  return { remove, rewrite, goneLogs, keptLogs, paths: storagePathsToDelete([...removed, ...goneLogs], kept, keptLogs) };
}

// Task B12a (review round 25 #1): everything a generation delete's purge will do, computed BEFORE anything changes, so
// the delete can reserve it first (storage.js reserveDelete) and stop with nothing changed when it cannot. Pure apart
// from the server clock read for the History intents' default queue time. `base`: the History entries planned over
// (this device's, or Clear Outputs' local + cloud); `serverHistory` (a task delete through delete_queued_rows / the
// clear): the server strips the deleted items that carry an id, so only entries holding items without one are sent from
// here (review round 8); `at`: the History intents' queue time (default now); `holdAt`: the queue time of the delete this
// purge belongs to. Returns { plan, removed, doHistory, send, historyQueuedAt, history, holdAt, hold, intents }: `hold`
// is holdPurgeDeletes' input (owners per path, the WaveSpeed entries, the History intents' time), `intents` the History
// delete intents this purge queues (the caller adds its own task / History intents to the reservation).
export function planDeleteStage(base, removed, kept, { history = true, alsoLogs = [], all = false, serverHistory = false, at, holdAt, now = Date.now() } = {}) {
  const plan = planPurge(base, removed, kept, { history, alsoLogs, all });
  const doHistory = !!(history && (plan.remove.length || plan.rewrite.length));
  const send = doHistory && serverHistory ? clientHistoryWork(base, plan) : { rewrite: plan.rewrite, remove: plan.remove };
  // The History intents' queue time, taken now so the hold names it (the reservation stamps them with it).
  const historyQueuedAt = doHistory ? (at ?? serverNow()) : null;
  // Owners: each removed generation, the items of removed History entries, and an entry itself when its removal is its
  // own History delete (sent here: send.remove; Reset: every entry it passes, queued at its time).
  const logOwners = new Set(history ? send.remove : alsoLogs.map(l => l?.id));
  const hold = { files: pathOwners(removed, plan.goneLogs, plan.paths, { logOwners }), ws: queueDeletes({}, removed, now),
    historyAt: history ? historyQueuedAt : holdAt };
  const intents = doHistory && send.remove.length ? [{ kind: "history-delete", ids: send.remove, at: historyQueuedAt }] : [];
  return { plan, removed, doHistory, send, historyQueuedAt, history, holdAt, hold, intents };
}
