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

// Entries still open here whose cloud copy another device already finished: that outcome wins (merged over the local
// entry, which keeps fields the cloud row does not store, such as the source audio and video URLs replay uses). A
// stale local copy would otherwise close or finish the entry from its own out-of-date tasks and overwrite the cloud.
export function takeFinishedFromCloud(local, cloud) {
  const byId = new Map(cloud.map(c => [c.id, c]));
  const out = [];
  for (const l of local) {
    const c = isOpenLog(l) ? byId.get(l.id) : null;
    if (c && !isOpenLog(c) && (c.tasks || []).length) out.push({ ...l, tasks: c.tasks, totalCost: c.totalCost ?? totalOf(c.tasks) });
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
