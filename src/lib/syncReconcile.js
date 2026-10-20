// Cross-device sync decisions (pure — tested by scripts/test-sync-reconcile.mjs).
//
// The cloud is the source of truth for completed tasks and history, and the server records every
// deleted id (sync_tombstones, filled by triggers on tasks/history). Each pass:
//   add    — rows another device created that this device lacks,
//   update — task outputs another device changed (e.g. ☁ archive swapped in permanent URLs),
//   remove — local rows the server says were deleted (tombstoned and not back in the cloud),
//   upload — local rows the cloud has never had (failed / dropped / pre-sync uploads): never removed,
//            because absence alone does not prove a delete.
// Nothing is removed or uploaded unless both cloud reads succeeded (`cloudIds` / `tombstones` are
// null when a read failed). Rows with a queued upload (`pending`), running tasks, rows being deleted
// here, and rows finished inside the grace window (their upload may be in flight) are left alone.

export const SYNC_GRACE_MS = 60_000;

const FINISHED = new Set(["completed", "failed"]);

function classify(rows, time, { cloudIds, tombstones, pending, deleting, since, graceMs }) {
  const remove = [], upload = [];
  if (!(cloudIds instanceof Set) || !(tombstones instanceof Set)) return { remove, upload };
  for (const row of rows) {
    if (cloudIds.has(row.id) || deleting.has(row.id)) continue;
    if (tombstones.has(row.id)) remove.push(row.id);
    else if (!pending.has(row.id) && (time(row) || 0) < since - graceMs) upload.push(row);
  }
  return { remove, upload };
}

export function planTaskSync({ local, cloud, cloudIds, tombstones, pending, deleting, since, graceMs = SYNC_GRACE_MS }) {
  const localById = new Map(local.map(t => [t.id, t]));
  const add = cloud.filter(t => !localById.has(t.id) && !deleting.has(t.id));
  const update = [];
  for (const c of cloud) {
    const l = localById.get(c.id);
    if (!l || pending.has(c.id) || !Array.isArray(c.outputs) || c.outputs.length === 0) continue;
    if (JSON.stringify(c.outputs) !== JSON.stringify(l.outputs || [])) update.push({ id: c.id, outputs: c.outputs });
  }
  const finished = local.filter(t => FINISHED.has(t.status));
  const { remove, upload } = classify(finished, t => t.endTime || t.startTime, { cloudIds, tombstones, pending, deleting, since, graceMs });
  return { add, update, remove, upload };
}

export function planLogSync({ local, cloud, cloudIds, tombstones, pending, deleting, since, graceMs = SYNC_GRACE_MS }) {
  const localIds = new Set(local.map(l => l.id));
  const add = cloud.filter(l => !localIds.has(l.id) && !deleting.has(l.id));
  const { remove, upload } = classify(local, l => l.timestamp, { cloudIds, tombstones, pending, deleting, since, graceMs });
  return { add, remove, upload };
}
