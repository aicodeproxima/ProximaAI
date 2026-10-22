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
