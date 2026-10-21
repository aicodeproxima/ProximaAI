// "Delete means delete" (owner, 2026-10-21): deleting generations removes them everywhere the app can reach. This
// module decides which stored files go (pure; tested by scripts/test-purge.mjs). History entries are decided in
// batchLog.js purgeLogsForDeleted, WaveSpeed's copy in wsDelete.js, backup copies by the server's purge_my_backups_of.
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
  const keep = new Set([...keptTasks, ...keptLogs].flatMap(pathsOf));
  return [...new Set(removedTasks.flatMap(pathsOf))].filter(p => !keep.has(p));
}
