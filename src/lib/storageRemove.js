// ─── Which files a Storage remove() really deleted ───
// remove() answers 200 with one object per file it deleted (`name` = the full path in the bucket, measured 2026-10-21).
// A path missing from that answer was NOT deleted: it was already gone, or the row policies refused it (no valid
// session). Both read the same, so callers report "not deleted" and decide whether to retry.
export function removedPaths(requested, data) {
  const names = new Set((Array.isArray(data) ? data : []).map(o => o?.name).filter(n => typeof n === "string"));
  return new Set((Array.isArray(requested) ? requested : []).filter(p => names.has(p)));
}
