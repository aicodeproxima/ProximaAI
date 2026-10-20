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

// Open logs whose tasks have all finished, rewritten with their outcomes. A task this device lacks may still arrive
// from another device, so it keeps the log open until the log is past the 48 h window.
export function finishLogs(logs, tasks, now) {
  const byId = new Map(tasks.map(t => [t.id, t]));
  const out = [];
  for (const log of logs) {
    if (!isOpenLog(log)) continue;
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

// Whether two versions of an entry carry the same outcomes (an upload that resolves late must not clear a newer
// version from the failed-sync queue).
export const sameLogContent = (a, b) => JSON.stringify(a?.tasks || []) === JSON.stringify(b?.tasks || []) && a?.totalCost === b?.totalCost;
