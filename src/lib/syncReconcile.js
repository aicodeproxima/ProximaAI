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

import { isRecoverableFailure } from "./taskResume.js";

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

// Running tasks travel too: a device uploads a task as "processing" right after submit, so another open device can
// poll it while the first is frozen or closed. Whichever gets the result first uploads it, and the others take that
// outcome (`finish`) instead of their own poll's. A failure that only says the old app lost the connection is no
// outcome while a device is recovering the task. A finished task here whose cloud copy is still "processing" is
// sent again (the server never lets "processing" overwrite a finished row, so out-of-order uploads cannot regress it).
const IN_FLIGHT = new Set(["pending", "processing"]);
const outcomeOf = (c) => ({ status: c.status, error: c.error ?? null, endTime: c.endTime ?? null,
  wallClockMs: c.wallClockMs ?? 0, inferenceMs: c.inferenceMs ?? 0, nsfw: c.nsfw ?? null });

export function planTaskSync({ local, cloud, cloudIds, tombstones, pending, deleting, since, graceMs = SYNC_GRACE_MS }) {
  const localById = new Map(local.map(t => [t.id, t]));
  const add = cloud.filter(t => !localById.has(t.id) && !deleting.has(t.id));
  const update = [], resend = [];
  for (const c of cloud) {
    const l = localById.get(c.id);
    if (!l || pending.has(c.id)) continue;
    if (IN_FLIGHT.has(l.status) && FINISHED.has(c.status)) {
      const lostConnection = c.status === "failed" && (l.recovered || isRecoverableFailure(c, since));
      if (!lostConnection) update.push({ id: c.id, outputs: Array.isArray(c.outputs) ? c.outputs : [], finish: outcomeOf(c) });
      continue;
    }
    if (FINISHED.has(l.status) && IN_FLIGHT.has(c.status)) {
      if (!deleting.has(l.id) && (l.endTime || l.startTime || 0) < since - graceMs) resend.push(l);
      continue;
    }
    if (!Array.isArray(c.outputs) || c.outputs.length === 0) continue;
    if (JSON.stringify(c.outputs) !== JSON.stringify(l.outputs || [])) update.push({ id: c.id, outputs: c.outputs });
  }
  const finished = local.filter(t => FINISHED.has(t.status));
  const { remove, upload } = classify(finished, t => t.endTime || t.startTime, { cloudIds, tombstones, pending, deleting, since, graceMs });
  // A running task deleted on another device (finishing it here would re-insert it and clear its tombstone).
  if (cloudIds instanceof Set && tombstones instanceof Set) {
    for (const t of local) {
      if (IN_FLIGHT.has(t.status) && tombstones.has(t.id) && !cloudIds.has(t.id) && !pending.has(t.id) && !deleting.has(t.id)) remove.push(t.id);
    }
  }
  return { add, update, remove, upload: [...upload, ...resend] };
}

// Applies one `update` entry: new outputs, plus another device's outcome while the task is still running here (one
// cancelled or finished here meanwhile keeps its own state).
export function applyCloudUpdate(task, u) {
  if (!u.finish) return { ...task, outputs: u.outputs };
  return IN_FLIGHT.has(task.status) ? { ...task, outputs: u.outputs, ...u.finish } : task;
}

export function planLogSync({ local, cloud, cloudIds, tombstones, pending, deleting, since, graceMs = SYNC_GRACE_MS }) {
  const localIds = new Set(local.map(l => l.id));
  const add = cloud.filter(l => !localIds.has(l.id) && !deleting.has(l.id));
  const { remove, upload } = classify(local, l => l.timestamp, { cloudIds, tombstones, pending, deleting, since, graceMs });
  return { add, remove, upload };
}
