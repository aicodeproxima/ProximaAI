// "Delete means delete" (owner, 2026-10-21): deleting generations removes them everywhere the app can reach. This
// module decides which stored files go (pure; tested by scripts/test-purge.mjs); the durable queue in fileDelete.js
// deletes them. History entries are decided in batchLog.js purgeLogsForDeleted, WaveSpeed's copy in wsDelete.js, backup
// copies by the server (triggers queue into backup_scrub_queue, migration 20261021175100). A file still loaded in a
// Generate form is held until every form lets go of it (fileDelete.js "form").
import { purgeLogsForDeleted } from "./batchLog.js";
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

// The public URL of a bucket path (the queue's gone-check HEADs it). Round-trips through storagePathOf.
export const publicUrlOf = (base, path) => (base && path ? base.replace(/\/+$/, "") + MARK + path.split("/").map(encodeURIComponent).join("/") : null);

// The whole plan of a generation delete: History entries removed / rewritten, entries kept, and the files no kept
// generation or entry uses. `history: false` + `alsoLogs`: the caller cleared History itself (Reset Everything).
export function planPurge(logs, removed, kept, { history = true, alsoLogs = [], all = false } = {}) {
  const alsoIds = new Set(alsoLogs.map(l => l.id));
  const base = (logs || []).filter(l => !alsoIds.has(l.id));
  let remove = [], rewrite = [], keptLogs = base;
  const goneLogs = [...alsoLogs];
  if (history && removed.length) {
    ({ remove, rewrite } = purgeLogsForDeleted(base, removed, kept, { all }));
    const gone = new Set(remove), byId = new Map(rewrite.map(l => [l.id, l]));
    goneLogs.push(...base.filter(l => gone.has(l.id)));
    keptLogs = base.filter(l => !gone.has(l.id)).map(l => byId.get(l.id) || l);
  }
  return { remove, rewrite, goneLogs, keptLogs, paths: storagePathsToDelete([...removed, ...goneLogs], kept, keptLogs) };
}
