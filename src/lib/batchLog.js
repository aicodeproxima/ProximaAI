// The History entry of a generation batch (pure — tested by scripts/test-batch-log.mjs).
//
// The entry is written when the batch starts, with each task still running, and finished with every task's outcome
// once all of them have finished, wherever that happens: this tab, after a reload, or on another device. It used to be
// written only by an in-memory timer at the end of the batch, so a reload or a phone leaving the app mid-batch lost it.
// Each item carries its task's id (the `tasks` column is jsonb); entries from before 2026-10-20 have none and were
// written finished.

import { RESUME_WINDOW_MS } from "./taskResume.js";

const IN_FLIGHT = new Set(["pending", "processing"]);
const REMOVED_ERROR = "Removed or expired before it finished";

const itemOf = (t) => ({ id: t.id, model: t.modelName, status: t.status, wallClockMs: t.wallClockMs || 0, cost: t.price || 0,
  outputs: t.outputs || [], error: t.error ?? null });

export const batchLogItems = (tasks) => tasks.map(itemOf);
export const isOpenLog = (log) => (log?.tasks || []).some(i => IN_FLIGHT.has(i?.status));
const totalOf = (items) => items.reduce((s, i) => s + (i.status === "completed" ? i.cost || 0 : 0), 0);

// Entries to rewrite: open ones whose tasks have all finished (with their outcomes), and closed ones with a failed item
// whose task has since completed. A task this device lacks may still arrive from another device, so it keeps an open
// entry open until the entry is past the 48 h window.
export function finishLogs(logs, tasks, now) {
  const byId = new Map(tasks.map(t => [t.id, t]));
  const out = [];
  for (const log of logs) {
    if (!isOpenLog(log)) {
      // A closed entry follows an item whose task turned out completed after all: a result another device or the
      // webhook saved while this device had already expired its copy (the cloud's completed beats a local failure).
      const items = (log.tasks || []).map(i => {
        const t = i?.id && i.status === "failed" ? byId.get(i.id) : null;
        return t?.status === "completed" && t.outputs?.length ? itemOf(t) : i;
      });
      if (items.some((i, k) => i !== log.tasks[k])) out.push({ ...log, tasks: items, totalCost: totalOf(items) });
      continue;
    }
    const stale = now - (log.timestamp || 0) > RESUME_WINDOW_MS;
    const items = log.tasks.map(i => {
      const t = i?.id ? byId.get(i.id) : null;
      if (t) return itemOf(t);
      return stale && IN_FLIGHT.has(i?.status) ? { ...i, status: "failed", error: REMOVED_ERROR } : i;
    });
    if (items.some(i => IN_FLIGHT.has(i?.status))) continue;
    out.push({ ...log, tasks: items, totalCost: totalOf(items) });
  }
  return out;
}

// "Delete means delete" (owner, 2026-10-21): deleting generations removes their History too. An entry is removed only
// when every item with a task id is deleted (entries from before items carried ids: when no kept task here has its
// batch); one that keeps some loses only the deleted items (cost recomputed). Items carry task ids since 2026-10-20;
// older entries are matched by batch (entry id = batch id) and, when partly kept, by output URL. `removeEntries: false`
// (another device's delete arriving by sync) only drops items: the deleting device removes whole entries, and that
// reaches here by tombstone. `all`: everything is being deleted (Clear Outputs). The server strips deleted items from
// any later upload (migration 20261021175300).
export function purgeLogsForDeleted(logs, removedTasks, keptTasks, { removeEntries = true, all = false } = {}) {
  const removedIds = new Set(removedTasks.map(t => t.id));
  const removedOutputs = new Set(removedTasks.flatMap(t => t.outputs || []));
  const removedBatches = new Set(removedTasks.map(t => t.batchId).filter(Boolean));
  const keptBatches = new Set(keptTasks.map(t => t.batchId).filter(Boolean));
  const remove = [], rewrite = [];
  for (const log of logs) {
    // `all` (Clear Outputs: every generation goes, and their History): every entry, hit or not, including older ones
    // whose items carry no id (review round 7).
    if (all) { remove.push(log.id); continue; }
    const items = Array.isArray(log.tasks) ? log.tasks : [];
    const hit = removedBatches.has(log.id) || items.some(i => i?.id && removedIds.has(i.id));
    if (!hit) continue;
    // An item whose task this device lacks (still pending on the other device, which pullTasks never pulls, or beyond
    // the 500 loaded) is not being deleted: its entry is rewritten, not removed (review #4). `all`: the caller deletes
    // every generation of the account (Clear Outputs), so nothing is outstanding. Entries from before items carried ids
    // are decided by batch.
    const outstanding = !all && items.some(i => i?.id && !removedIds.has(i.id));
    if (removeEntries && !outstanding && !keptBatches.has(log.id)) { remove.push(log.id); continue; }
    const left = items.filter(i => i?.id ? !removedIds.has(i.id) : !(i?.outputs || []).some(o => removedOutputs.has(o)));
    // An entry with no item left is removed even on the sync path: kept, it would show a deleted batch's prompt and
    // models for good (review wf_ec400a67-988 #8; the server deletes such a row too, migration 20261022150000).
    if (left.length === 0 && (removeEntries || items.length > 0)) { remove.push(log.id); continue; }
    if (left.length !== items.length) rewrite.push({ ...log, tasks: left, totalCost: totalOf(left) });
  }
  return { remove, rewrite };
}

// The part of a delete's History plan the client must still send (review round 8): the server strips the deleted items
// that carry an id, in the delete's own transaction (delete_queued_rows), and drops entries that leaves empty. Only an
// entry where an item WITHOUT an id is dropped (older entries, matched by batch or output) needs the client: a rewrite
// whose dropped items include one, an entry removed while holding one. `originals`: the entries before the plan.
export function clientHistoryWork(originals, plan) {
  const byId = new Map((originals || []).filter(l => l?.id).map(l => [l.id, l]));
  const idless = (items) => (items || []).some(i => !i?.id);
  const rewrite = (plan?.rewrite || []).filter(l => {
    const before = byId.get(l.id)?.tasks || [];
    const kept = new Set(l.tasks || []);
    return idless(before.filter(i => !kept.has(i) && !(l.tasks || []).some(k => k?.id && k.id === i?.id)));
  });
  const remove = (plan?.remove || []).filter(id => idless(byId.get(id)?.tasks));
  return { rewrite, remove };
}

// A History upload never carries a generation this device is deleting (review round 9 guard): an entry still holding one
// (an IndexedDB copy a crash kept, a stale queued upload) is sent without it, and one left with no item is not sent.
// Returns { upload, skip }: the entries to send (unchanged ones as given) and the ids of those not to send.
export function withoutDeleting(entries, ids) {
  const gone = ids instanceof Set ? ids : new Set(ids || []);
  const upload = [], skip = [];
  for (const l of entries || []) {
    const items = Array.isArray(l?.tasks) ? l.tasks : [];
    const left = gone.size ? items.filter(i => !(i?.id && gone.has(i.id))) : items;
    if (left.length === items.length) upload.push(l);
    else if (left.length === 0) skip.push(l.id);
    else upload.push({ ...l, tasks: left, totalCost: totalOf(left) });
  }
  return { upload, skip };
}

// Generations History holds without a task among `taskIds` (History-only: a restore keeps 500 tasks rows but up to 1000
// entries, or a task upload never landed), as generations a purge removes: id, entry, outputs, status. Clear Outputs
// removes them too, files included (review round 7).
export function historyOnlyGenerations(logs, taskIds) {
  const have = taskIds instanceof Set ? taskIds : new Set(taskIds || []);
  const out = new Map();
  for (const l of logs || []) for (const i of Array.isArray(l?.tasks) ? l.tasks : []) {
    if (i?.id && !have.has(i.id) && !out.has(i.id)) out.set(i.id, { id: i.id, batchId: l.id, outputs: i.outputs || [], status: i.status });
  }
  return [...out.values()];
}

// This device's History plus the cloud's entries it does not hold (beyond the loaded ones, or never synced here); the
// local copy wins. Clear Outputs plans its purge over all of them (review round 2).
export function mergeLogs(local, cloud) {
  const have = new Set((local || []).map(l => l?.id));
  return [...(local || []), ...(cloud || []).filter(c => c?.id && !have.has(c.id))];
}

// Entries still open here whose cloud copy another device already finished: that outcome wins (merged over the local
// entry, which keeps fields the cloud row does not store, such as the source audio and video URLs replay uses). A
// stale local copy would otherwise close or finish the entry from its own out-of-date tasks and overwrite the cloud.
// A closed entry here takes, item by item, what the cloud records as completed where this copy says failed (the server
// keeps the same rule): a device that closed it from stale copies while the cloud did not answer heals on the next pass.
export function takeFinishedFromCloud(local, cloud) {
  const byId = new Map(cloud.map(c => [c.id, c]));
  const out = [];
  for (const l of local) {
    const c = byId.get(l.id);
    if (!c || isOpenLog(c) || !(c.tasks || []).length) continue;
    if (isOpenLog(l)) { out.push({ ...l, tasks: c.tasks, totalCost: c.totalCost ?? totalOf(c.tasks) }); continue; }
    const cloudItems = new Map(c.tasks.filter(i => i?.id).map(i => [i.id, i]));
    const items = (l.tasks || []).map(i => (i?.id && i.status === "failed" && cloudItems.get(i.id)?.status === "completed") ? cloudItems.get(i.id) : i);
    if (items.some((i, k) => i !== l.tasks[k])) out.push({ ...l, tasks: items, totalCost: totalOf(items) });
  }
  return out;
}

// After a restore this device has not handled yet (storage.js restoreGuard `fresh`), the cloud's copy of an entry both
// sides hold wins: a delete queued here before the restore trimmed the local copy, and kept, it would be uploaded over
// the restored entry on the next change (review round 3). Local-only fields (source audio/video URLs) stay. An entry
// with an upload queued after the restore (`pending`) keeps its local copy. Returns the entries to replace.
export function restoredVersions(local, cloud, pending = new Set()) {
  const byId = new Map((cloud || []).filter(c => c?.id).map(c => [c.id, c]));
  return (local || []).filter(l => byId.has(l?.id) && !pending.has(l.id) && !sameLogContent(l, byId.get(l.id)))
    .map(l => { const c = byId.get(l.id); return { ...l, tasks: c.tasks, totalCost: c.totalCost }; });
}

// Tasks being deleted (here, by Clear, or because another device deleted them) close their items in open entries with
// their last known state; one deleted while still running is recorded as removed. Without this the entry waited 48 h
// for a task that was never coming back. Returns the entries that changed.
export function closeRemovedItems(logs, removedTasks) {
  const byId = new Map(removedTasks.map(t => [t.id, t]));
  const out = [];
  for (const log of logs) {
    if (!isOpenLog(log) || !log.tasks.some(i => i?.id && byId.has(i.id))) continue;
    const items = log.tasks.map(i => {
      const t = i?.id ? byId.get(i.id) : null;
      if (!t) return i;
      return IN_FLIGHT.has(t.status) ? { ...itemOf(t), status: "failed", error: REMOVED_ERROR } : itemOf(t);
    });
    out.push({ ...log, tasks: items, totalCost: totalOf(items) });
  }
  return out;
}

// Whether two versions of an entry carry the same outcomes (an upload that resolves late must not clear a newer
// version from the failed-sync queue).
export const sameLogContent = (a, b) => JSON.stringify(a?.tasks || []) === JSON.stringify(b?.tasks || []) && a?.totalCost === b?.totalCost;
