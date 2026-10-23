// One PAGE of the app (a tab between reloads): the App.jsx delete/restore/sync flows, MIRRORED line by line against
// src/App.jsx at commit a79a43c (review round 23; every block cites the lines it mirrors there; scripts/sim/drift.mjs
// fingerprints those regions and the smoke test reports drift), running on the REAL src/lib modules: storage.js
// (one instance per page, see browser.mjs), syncReconcile.js, batchLog.js, purge.js, clearOutcome.js, serverClock.js.
// Extended from the synchronous mirrors in scripts/test-b9-superseded-flight.mjs (pass, persistLog, replayHistory) and
// scripts/test-inline-void-putback.mjs (applyClearStashes, the voided branches) into the full async flows.
//
// React is modelled where the flows depend on it: state updates are QUEUED (setTasks/setLogs) and applied at a render;
// refs (tasksRef/logsRef) follow the state at a render, and the flows that assign a ref directly do so here too. A render
// happens at every IndexedDB await (an IndexedDB request completes in a later task, after React's scheduled render) and
// after every scheduler step, followed by the effects whose dependencies changed (the History save effect 2413-2419 and
// the task persistence effect 2440-2486).
//
// Left out (no bearing on which rows exist): WaveSpeed copies, files and form holds (and round 23's held purges,
// storage.js holdPurgeDeletes: stagePurge's holdAt is accepted and ignored), claimants and released predictions,
// favorites/settings, archives, toasts/save status, in-flight polling (a generation is submitted, then finished by a later op),
// finishLogs (entries are created closed), the input backfill, rename/sessions.
import { libUrl } from "./lib.mjs";
const B = await import(libUrl("batchLog.js"));
const R = await import(libUrl("syncReconcile.js"));
const P = await import(libUrl("purge.js"));
const C = await import(libUrl("serverClock.js"));
const { clearSettlement } = await import(libUrl("clearOutcome.js"));
const { isInFlight } = await import(libUrl("taskResume.js"));

const ids = (xs) => (xs || []).map(x => x.id);

export class Page {
  constructor(sim, browser, slot, S, gen) {
    this.sim = sim; this.b = browser; this.slot = slot; this.S = S; this.gen = gen;
    this.label = `${slot}#${gen}`;
    this.alive = true; this.frozen = false;
    // React state, refs, pending updaters
    this.st = { tasks: [], logs: [] };
    this.ref = { tasks: [], logs: [] };
    this.upd = { tasks: [], logs: [] };
    this.ver = { tasks: 0, logs: 0 }; this.effVer = { tasks: 0, logs: 0 };
    // App.jsx refs (1757-1783)
    this.savedLogIds = new Set(); this.savedTaskIds = new Set(); this.recoveringIds = new Set();
    this.taskSyncQueue = []; this.timerArmed = false;
    this.bootstrapInProgress = false; this.initialLoadDone = false; this.reconcileRunning = false; this.restorePending = false;
    this.historySyncReady = false; this.cloudSynced = false;
    this.deletingIds = new Set(); this.deletingLogIds = new Set();
    this.holds = { "task-delete": new Map(), "history-delete": new Map() };
    this.bulkDeleting = false; this.bulkDeletingLogs = false;
    this.macros = [];   // continuations waiting for a render (IndexedDB awaits)
  }

  // ─── React model ───
  setTasks(fn) { this.upd.tasks.push(fn); }
  setLogs(fn) { this.upd.logs.push(fn); }
  render() {
    let changed = false;
    for (const k of ["tasks", "logs"]) {
      if (!this.upd[k].length) continue;
      let v = this.st[k];
      for (const f of this.upd[k].splice(0)) v = f(v);
      if (v !== this.st[k]) { this.st[k] = v; this.ver[k]++; changed = true; }
      this.ref[k] = this.st[k];
    }
    return changed;
  }
  // An IndexedDB request: the write is applied now; the flow continues after a render (a later task).
  idb(fn) { fn?.(); return new Promise(res => this.macros.push(res)); }
  runEffects() {
    if (!this.alive) return;
    // App.jsx 2413-2419: save new History entries (every one not saved yet).
    if (this.ver.logs !== this.effVer.logs) {
      this.effVer.logs = this.ver.logs;
      for (const l of this.st.logs) if (l?.id && !this.savedLogIds.has(l.id) && !this.deletingLogIds.has(l.id)) this.persistLog(l);
    }
    // App.jsx 2440-2486: persist finished tasks + queue the debounced upload.
    if (this.ver.tasks !== this.effVer.tasks) {
      this.effVer.tasks = this.ver.tasks;
      const S = this.S, deferUpload = this.bootstrapInProgress;
      const unsaved = this.st.tasks.filter(t => (t.status === "completed" || t.status === "failed") &&
        (!this.savedTaskIds.has(t.id) || this.recoveringIds.has(t.id)) && !this.deletingIds.has(t.id));
      if (!unsaved.length) return;
      const toSave = S.uploadable("task", unsaved);
      if (!toSave.length) return;
      for (const t of toSave) {
        this.savedTaskIds.add(t.id); this.recoveringIds.delete(t.id);
        this.b.saveTask(t);
        if (!deferUpload) this.taskSyncQueue.push(t);
        S.addFailedSync({ kind: "task", id: t.id, data: t });
      }
      if (deferUpload) return;
      this.timerArmed = true;
    }
  }
  // The debounced flush (2468-2485), fired by the scheduler's "timer" op.
  fireTimer() {
    if (!this.timerArmed) return;
    this.timerArmed = false;
    const queue = this.taskSyncQueue.splice(0).filter(t => !this.deletingIds.has(t.id));
    if (!queue.length) return;
    const S = this.S;
    this.sendTasks(queue).then(sent => { for (const t of sent) S.removeFailedSync("task", t.id, S.sentVersion(t)); }).catch(() => {});
  }

  // ─── network wrappers (src/lib/supabase.js) ───
  call(name, desc, exec) { return this.sim.net.send(this, name, desc, exec); }
  get srv() { return this.sim.server; }
  // I3: nothing uploads an id this browser holds as confirmed-final (task row, History entry, or History item).
  checkI3(kind, rows) {
    const S = this.S, finalT = S.confirmStates("task-delete").final, finalH = S.confirmStates("history-delete").final;
    for (const r of rows || []) {
      if (kind === "task" && finalT.has(r.id)) this.sim.violate("I3", `${this.label} uploads task ${r.id}, a confirmed-final delete`);
      if (kind === "history") {
        if (finalH.has(r.id)) this.sim.violate("I3", `${this.label} uploads History ${r.id}, a confirmed-final delete`);
        for (const i of r.tasks || []) if (i?.id && finalT.has(i.id)) this.sim.violate("I3", `${this.label} uploads History ${r.id} with item ${i.id}, a confirmed-final delete`);
      }
    }
  }
  snapRows(rows) { return JSON.parse(JSON.stringify(rows)); }
  async rawSyncTasksBatch(rows) {   // supabase.js 162-172 (throws on failure)
    this.checkI3("task", rows);
    const body = this.snapRows(rows);
    await this.call("syncTasksBatch", `[${ids(body)}]`, () => this.srv.syncTasks(body));
  }
  async rawSyncHistoryBatch(entries) {   // supabase.js 508-519
    this.checkI3("history", entries);
    const body = this.snapRows(entries);
    await this.call("syncHistoryBatch", `[${body.map(e => `${e.id}(${ids(e.tasks).join(" ")})`)}]`, () => this.srv.syncHistory(body));
  }
  async rawSyncHistoryEntry(entry) {   // supabase.js 289-296
    this.checkI3("history", [entry]);
    const body = this.snapRows([entry]);
    await this.call("syncHistoryEntry", `${entry.id}(${ids(entry.tasks).join(" ")})`, () => this.srv.syncHistory(body));
  }
  async rawUpsertQueuedHistory(entries, queuedAt) {   // supabase.js 382-396
    this.checkI3("history", entries);
    const list = (entries || []).filter(e => e?.id), out = { ok: true, voided: [], upserted: [] };
    const body = this.snapRows(list);
    try {
      const r = await this.call("upsert_queued_history", `[${ids(body)}] @${queuedAt}`, () => this.srv.upsertQueuedHistory(body, Math.floor(queuedAt || 0)));
      (r?.voided ? out.voided : out.upserted).push(...list.map(e => e.id));
    } catch { out.ok = false; }
    return out;
  }
  async deleteQueuedRemote(kind, list0, queuedAt) {   // supabase.js 252-266
    const list = (list0 || []).filter(Boolean), out = { ok: true, voided: [], deleted: [] };
    for (let i = 0; i < list.length; i += 100) {
      const chunk = list.slice(i, i + 100);
      try {
        const r = await this.call("delete_queued_rows", `${kind} [${chunk}] @${Math.floor(queuedAt || 0)}`, () => this.srv.deleteQueuedRows(kind, chunk, Math.floor(queuedAt || 0)));
        (r?.voided ? out.voided : out.deleted).push(...chunk);
      } catch { out.ok = false; }
    }
    return out;
  }
  async deleteTasksRemote(list, queuedAt = C.serverNow()) {   // supabase.js 244-247
    const r = await this.deleteQueuedRemote("task", list, queuedAt);
    return { ok: r.ok && !r.voided.length, voided: r.voided, deleted: r.deleted };
  }
  async deleteHistoryRemote(list, queuedAt = C.serverNow()) {   // supabase.js 334-337
    const r = await this.deleteQueuedRemote("history", list, queuedAt);
    return { ok: r.ok && !r.voided.length, voided: r.voided, deleted: r.deleted };
  }
  async clearQueuedRemote(kind, queuedAt, list) {   // supabase.js 355-367
    try {
      const named = list ? [...new Set(list.filter(Boolean))] : null;
      const r = await this.call("clear_queued_rows", `${kind} @${Math.floor(queuedAt || 0)} named [${named || ""}]`, () => this.srv.clearQueuedRows(kind, Math.floor(queuedAt || 0), named));
      return { ok: !!r?.ok && !r?.voided, voided: !!r?.voided, deleted: r?.deleted ?? 0 };
    } catch { return { ok: false, voided: false, deleted: 0 }; }
  }
  async resetQueuedRemote(queuedAt, taskIds, historyIds) {   // supabase.js 369-380
    const uniq = (x) => [...new Set((x || []).filter(Boolean))];
    try {
      const t = uniq(taskIds), h = uniq(historyIds);
      const r = await this.call("reset_queued_rows", `@${Math.floor(queuedAt || 0)} tasks [${t}] history [${h}]`, () => this.srv.resetQueuedRows(Math.floor(queuedAt || 0), t, h));
      return { ok: !!r?.ok && !r?.voided, voided: !!r?.voided, deleted: r?.deleted ?? null };
    } catch { return { ok: false, voided: false, deleted: null }; }
  }
  async serverTimeRemote() {   // supabase.js 341-349
    try { const r = await this.call("server_time_ms", "", () => this.srv.serverTimeMs()); const t = Number(r); return Number.isFinite(t) ? t : null; }
    catch { return null; }
  }
  async createBackup(type) {   // supabase.js 665-670
    try { const r = await this.call("snapshot", type, () => this.srv.snapshot(type)); return r?.ok ? { ok: true, id: r.id } : { ok: false }; }
    catch { return { ok: false }; }
  }
  async readAutoBackups() {   // supabase.js 784-786 (App.jsx 1701-1706): the confirm dialog's read; its value changes nothing here
    try { return !!(await this.call("get_auto_backups", "", () => this.srv.autoBackups)); } catch { return null; }
  }
  async checkSession() { const r = await this.call("get_my_account", "", () => ({ ok: true })); return !!r?.ok; }   // supabase.js 824-828 (throws on failure)
  async pullTasks() { try { return await this.call("pullTasks", "", () => this.srv.pullTasks()); } catch { return []; } }   // 208-221
  async pullHistory() { try { return await this.call("pullHistory", "", () => this.srv.pullHistory()); } catch { return null; } }   // 318-330
  async pullSettings() { try { return await this.call("pullSettings", "", () => this.srv.pullSettings()); } catch { return null; } }   // 423-434
  async pullAllRemoteData() {   // supabase.js 558-576 (favorites left out)
    const results = await Promise.allSettled([this.pullTasks(), this.pullHistory(), this.pullSettings()]);
    return {
      tasks: results[0].status === "fulfilled" ? results[0].value : [],
      history: results[1].status === "fulfilled" && Array.isArray(results[1].value) ? results[1].value : [],
      historyOk: results[1].status === "fulfilled" && Array.isArray(results[1].value),
      settings: results[2].status === "fulfilled" ? results[2].value : null,
    };
  }
  async pullAllIds(what, byRestore) {   // supabase.js 475-488 (null on a failed read)
    try {
      if (what === "tasks") return new Set(await this.call("ids tasks", "", () => this.srv.pullTaskIds()));
      if (what === "history") return new Set(await this.call("ids history", "", () => this.srv.pullHistoryIds()));
      if (what === "tomb-task") { const r = await this.call("tombstones task", "", () => this.srv.pullTaskTombstones()); for (const id of r.byRestore) byRestore.add(id); return new Set(r.ids); }
      return new Set(await this.call("tombstones history", "", () => this.srv.pullHistoryTombstones()));
    } catch { return null; }
  }
  async pullCloudIds() {   // supabase.js 493-505: ids first, tombstones strictly after
    try {
      const [tasks, history] = await Promise.all([this.pullAllIds("tasks"), this.pullAllIds("history")]);
      const taskRestoreRemoved = new Set();
      const [taskTombstones, historyTombstones] = await Promise.all([this.pullAllIds("tomb-task", taskRestoreRemoved), this.pullAllIds("tomb-history")]);
      return { tasks, history, taskTombstones, historyTombstones, taskRestoreRemoved: taskTombstones ? taskRestoreRemoved : null };
    } catch { return null; }
  }
  async pullAllForPurge() { try { return await this.call("pullAllForPurge", "", () => this.srv.pullAllForPurge()); } catch { return null; } }   // 535-555
  async restoreBackup(id) {   // supabase.js 680-686
    try { const r = await this.call("restore_my_backup_phase2", id, () => this.srv.restore(id)); return r?.ok ? { ok: true } : { ok: false }; }
    catch { return { ok: false }; }
  }

  // ─── the only senders (App.jsx 53-86) ───
  async sendTask(task) { const send = this.S.uploadable("task", [task]); if (send.length) await this.rawSyncTasksBatch(send); return send; }   // App.jsx 58-62 (rawSyncTask: one row)
  async sendTasks(tasks) { const send = this.S.uploadable("task", tasks); if (send.length) await this.rawSyncTasksBatch(send); return send; }
  async sendHistory(entries) { const S = this.S; const send = S.uploadable("history", S.withoutBlockedItems(entries)); if (send.length) await this.rawSyncHistoryBatch(send); return send; }
  async sendHistoryEntry(entry, opts) { const S = this.S; const send = S.uploadable("history", S.withoutBlockedItems([entry], opts)); if (send.length) await this.rawSyncHistoryEntry(send[0]); return send; }
  async sendQueuedHistory(entries, queuedAt) { const S = this.S; const send = S.uploadable("history", S.withoutBlockedItems(entries)); return send.length ? this.rawUpsertQueuedHistory(send, queuedAt) : { ok: true, voided: [], upserted: [] }; }

  // App.jsx 38-46
  confirmIntents(kind, list, at) { this.sim.noteConfirm(this, kind === "task-delete" ? "task" : "history", list, at); this.S.confirmDeleteIntents(kind, list, at); }
  releaseVoided(set, kind, list) { const still = this.S.pendingDeleteIds(kind); for (const id of list || []) if (id && !still.has(id)) set.delete(id); }
  // App.jsx 1784-1797
  holdDeleting(kind, list, hold) { const m = this.holds[kind]; for (const id of list || []) { if (!id) continue; if (!m.has(id)) m.set(id, new Set()); m.get(id).add(hold); } }
  unholdDeleting(kind, list, hold) { const m = this.holds[kind]; for (const id of list || []) { const h = m.get(id); if (!h) continue; h.delete(hold); if (!h.size) m.delete(id); } }
  pruneDeleting() {
    for (const [kind, set] of [["task-delete", this.deletingIds], ["history-delete", this.deletingLogIds]]) {
      const holds = this.holds[kind];
      for (const id of this.S.settledDeletingIds(set, kind, holds)) { set.delete(id); holds.delete(id); }
    }
  }

  // ─── App.jsx 1501-1530 applyClearStashes (archives/favorites/file deletes not modelled) ───
  applyClearStashes(which, held = {}) {
    const S = this.S;
    const heldTasks = held.tasks || new Map(), heldLogs = held.logs || new Set();
    for (const s of S.readClearStashes()) {
      if (!which(s.at)) continue;
      const back = S.stashGiveBack(s);
      if (!back) continue;
      S.putBackQueuedUploads(back.uploads);
      const { tasks, logs } = back;
      const haveTasks = new Set([...ids(this.ref.tasks), ...heldTasks.keys()]), haveLogs = new Set([...ids(this.ref.logs), ...heldLogs]);
      const backTasks = tasks.filter(t => !haveTasks.has(t.id)), backLogs = logs.filter(l => !haveLogs.has(l.id));
      if (backTasks.length) {
        this.setTasks(prev => { const have = new Set(ids(prev)); const add = backTasks.filter(t => !have.has(t.id)); return add.length ? [...prev, ...add] : prev; });
        this.b.saveTasks(backTasks);
      }
      if (backLogs.length) {
        this.setLogs(prev => { const have = new Set(ids(prev)); const add = backLogs.filter(l => !have.has(l.id)); return add.length ? [...prev, ...add] : prev; });
        for (const l of backLogs) this.b.addHistoryEntry(l);
      }
      if (backTasks.length || backLogs.length) this.sim.trace(`  ${this.label} stash ${s.at} gives back tasks [${ids(backTasks)}] logs [${ids(backLogs)}] uploads [${back.uploads.map(e => e.kind[0] + ":" + e.id)}]`);
      S.dropGivenBackStash(s);
    }
  }
  // App.jsx 1539-1547
  settleClearStashes() {
    const S = this.S, voided = S.voidedTimes();
    const back = new Set(S.readClearStashes().filter(s => S.stashDecision(s, voided) === "give-back").map(s => s.at));
    if (back.size) this.applyClearStashes(at => back.has(at));
    for (const s of S.readClearStashes()) if (S.stashDecision(s, voided) === "drop") S.dropClearStash(s.at);
    S.pruneVoidedAt();
  }
  // App.jsx 1550-1553
  giveBackVoided(...times) {
    const which = times.map(Number).filter(t => Number.isFinite(t) && t > 0).map(t => this.S.voidedClearStashes(t));
    if (which.length) this.applyClearStashes(at => which.some(w => w(at)));
  }

  // ─── App.jsx 1560-1591 replayDeleteIntents ───
  async replayDeleteIntents(kind) {
    const S = this.S, isTask = kind === "task-delete";
    for (const [ts, list] of S.intentGroups(kind)) {
      const flight = S.beginDeleteFlight({ [kind]: list }, ts);
      try {
        const r = await this.deleteQueuedRemote(isTask ? "task" : "history", list, ts);
        if (r.voided.length) {
          S.voidDeleteIntents(kind, r.voided, ts);
          this.releaseVoided(isTask ? this.deletingIds : this.deletingLogIds, kind, r.voided);
        }
        if (r.deleted.length) {
          const gone = new Set(r.deleted);
          if (isTask) {
            this.setTasks(prev => prev.filter(t => !gone.has(t.id)));
            await this.idb(() => this.b.deleteTasks(r.deleted));
            for (const id of r.deleted) this.savedTaskIds.delete(id);
          } else {
            this.setLogs(prev => prev.filter(l => !gone.has(l.id)));
            await this.idb(() => this.b.deleteHistoryEntries(r.deleted));
            for (const id of r.deleted) this.savedLogIds.delete(id);
          }
          this.confirmIntents(kind, r.deleted, ts);
        }
        if (r.voided.length) this.applyClearStashes(S.voidedClearStashes(ts));
      } finally { S.endDeleteFlight(flight); }
    }
  }
  // ─── App.jsx 1596-1612 replayHistoryUploads ───
  async replayHistoryUploads(queued) {
    const S = this.S;
    const byId = new Map(S.uploadable("history", S.withoutConfirmedUploads(queued)).filter(f => f.data).map(f => [f.id, f]));
    const { upload, skip } = S.historyUploadPlan([...byId.values()].map(f => f.data));
    for (const id of skip) S.removeFailedSync("history", id, S.sentVersion(byId.get(id).data));
    for (const entry of upload) {
      const f = byId.get(entry.id);
      try {
        if (f.queuedAt) { const r = await this.sendQueuedHistory([entry], f.queuedAt); if (r.ok && (r.upserted.length || r.voided.length)) S.removeFailedSync("history", entry.id, S.sentVersion(f.data)); }
        else if ((await this.sendHistoryEntry(entry)).length) S.removeFailedSync("history", entry.id, S.sentVersion(f.data));
      } catch {}
    }
  }
  // ─── App.jsx 1614-1650 forceSaveAll (settings/favorites left out) ───
  async forceSaveAll() {
    const S = this.S;
    const guard = S.restoreGuard(await this.pullSettings());
    for (const id of guard.voided.task) this.deletingIds.delete(id);
    for (const id of guard.voided.history) this.deletingLogIds.delete(id);
    if (guard.restoreAt > 0) this.applyClearStashes(at => at < guard.restoreAt);
    await null;   // favoriteSyncChainRef
    if (guard.known) { await this.replayDeleteIntents("task-delete"); await this.replayDeleteIntents("history-delete"); this.settleClearStashes(); }
    this.pruneDeleting();
    this.timerArmed = false;
    const queue = this.taskSyncQueue.splice(0).filter(t => !this.deletingIds.has(t.id));
    if (queue.length) { try { for (const t of await this.sendTasks(queue)) S.removeFailedSync("task", t.id, S.sentVersion(t)); } catch {} }
    const failed = S.getFailedSyncs();
    const taskRetries = S.withoutConfirmedUploads(failed.filter(f => f.kind === "task" && !this.deletingIds.has(f.id))).map(f => f.data).filter(Boolean);
    if (taskRetries.length) { try { for (const t of await this.sendTasks(taskRetries)) S.removeFailedSync("task", t.id, S.sentVersion(t)); } catch {} }
    await this.replayHistoryUploads(failed.filter(f => f.kind === "history" && !this.deletingLogIds.has(f.id)));
  }

  // ─── App.jsx 1887-2082: page load (local load, cloud merge, mount replay, first reconcile) ───
  loadLocal() {
    const logData = this.b.getHistory(500);
    for (const l of logData) this.savedLogIds.add(l.id);
    // getCompletedTasks + the resumable running tasks (getPendingTasks, resumed by their poll: App.jsx resume effect).
    const savedTasks = [...this.b.getCompletedTasks(500), ...this.b.allStoredTasks().filter(isInFlight)]
      .sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
    for (const t of savedTasks) if (!isInFlight(t)) this.savedTaskIds.add(t.id);
    this.st = { tasks: savedTasks, logs: logData }; this.ref = { tasks: savedTasks, logs: logData };
    this.ver = { tasks: 1, logs: 1 }; this.effVer = { tasks: 1, logs: 1 };   // stored already (the save effect skips them)
  }
  async bootstrap() {
    const S = this.S;
    let restoreKnown = false;
    try {
      this.bootstrapInProgress = true;
      const remote = await this.pullAllRemoteData();
      if (!this.alive || !remote) { this.bootstrapInProgress = false; return; }
      const guard = S.restoreGuard(remote.settings);
      restoreKnown = guard.known;
      for (const id of guard.voided.task) this.deletingIds.delete(id);
      for (const id of guard.voided.history) this.deletingLogIds.delete(id);
      if (guard.restoreAt > 0) this.applyClearStashes(at => at < guard.restoreAt);
      for (const id of guard.pending.task) this.deletingIds.add(id);
      for (const id of guard.pending.history) this.deletingLogIds.add(id);
      if (remote.tasks?.length > 0) {
        this.setTasks(prev => {
          const existing = new Set(ids(prev));
          const newOnes = remote.tasks.filter(t => !existing.has(t.id) && !this.deletingIds.has(t.id));
          for (const t of newOnes) { if (!isInFlight(t)) this.savedTaskIds.add(t.id); this.b.saveTask(t); }
          return [...newOnes, ...prev].sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
        });
      }
      if (remote.history?.length > 0) {
        this.setLogs(prev => {
          const existing = new Set(ids(prev));
          const newOnes = remote.history.filter(l => !existing.has(l.id) && !this.deletingLogIds.has(l.id));
          for (const l of newOnes) { this.savedLogIds.add(l.id); this.b.addHistoryEntry(l); }
          return [...newOnes, ...prev].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        });
      }
      if (guard.fresh && remote.historyOk) {
        const pendingLogs = new Set(S.getFailedSyncs().filter(f => f.kind === "history").map(f => f.id));
        this.setLogs(prev => {
          const take = new Map(B.restoredVersions(prev, remote.history, pendingLogs).map(l => [l.id, l]));
          for (const l of take.values()) { this.savedLogIds.add(l.id); this.b.addHistoryEntry(l); }
          return take.size ? prev.map(l => take.get(l.id) || l) : prev;
        });
        S.markRestoreSeen(guard.restoreAt);
      }
    } catch (e) { this.sim.flowError(this, "bootstrap", e); }
    this.bootstrapInProgress = false;
    const failed = S.getFailedSyncs();
    if (failed.length > 0) {
      const delRetries = failed.filter(f => f.kind === "task-delete").map(f => f.id).filter(Boolean);
      const delSet = new Set(delRetries);
      for (const id of delRetries) this.deletingIds.add(id);
      const logDelRetries = failed.filter(f => f.kind === "history-delete").map(f => f.id).filter(Boolean);
      const logDelSet = new Set(logDelRetries);
      for (const id of logDelRetries) this.deletingLogIds.add(id);
      if (restoreKnown) { await this.replayDeleteIntents("task-delete"); await this.replayDeleteIntents("history-delete"); this.settleClearStashes(); }
      const taskRetries = S.withoutConfirmedUploads(failed.filter(f => f.kind === "task" && !delSet.has(f.id) && !this.deletingIds.has(f.id))).map(f => f.data).filter(Boolean);
      if (taskRetries.length > 0) { try { for (const t of await this.sendTasks(taskRetries)) S.removeFailedSync("task", t.id, S.sentVersion(t)); } catch {} }
      await this.replayHistoryUploads(failed.filter(f => f.kind === "history" && !logDelSet.has(f.id) && !this.deletingLogIds.has(f.id)));
    }
    this.initialLoadDone = true;
    this.reconcile();
  }

  // ─── App.jsx 2113-2316 reconcileWithCloud ───
  async reconcile() {
    if (!this.initialLoadDone || this.bootstrapInProgress || this.reconcileRunning) return;
    this.reconcileRunning = true;
    const S = this.S;
    try {
      if (!(await this.checkSession())) return;
      const since = C.serverNow();
      const sinceSeq = S.confirmSeqNow();
      const restoreKnownAt = S.knownRestoreAt();
      const [remote, cids] = await Promise.all([this.pullAllRemoteData(), this.pullCloudIds()]);
      if (!remote) return;
      const guard = S.restoreGuard(remote.settings);
      for (const id of guard.voided.task) this.deletingIds.delete(id);
      for (const id of guard.voided.history) this.deletingLogIds.delete(id);
      if (guard.restoreAt > 0) this.applyClearStashes(at => at < guard.restoreAt);
      this.restorePending = guard.fresh && (!remote.historyOk || !cids);
      if (this.restorePending) return;
      this.pruneDeleting();
      const cloudItemIds = remote.historyOk ? (remote.history || []).flatMap(l => (Array.isArray(l?.tasks) ? l.tasks : [])).map(i => i?.id).filter(Boolean) : null;
      const restoreRemoved = cids?.taskRestoreRemoved instanceof Set ? cids.taskRestoreRemoved : null;
      const taskDel = S.sharedDeleteState("task", { deleting: this.deletingIds, cloudIds: cids?.tasks ?? null, sinceSeq, restoreKnownAt,
        evidence: { present: [...(cloudItemIds || []), ...(restoreRemoved || [])], complete: !!cloudItemIds && !!restoreRemoved } });
      const logDel = S.sharedDeleteState("history", { deleting: this.deletingLogIds, cloudIds: cids?.history ?? null, sinceSeq, restoreKnownAt });
      for (const id of taskDel.released) this.deletingIds.delete(id);
      for (const id of logDel.released) this.deletingLogIds.delete(id);
      const staleTasks = new Set(taskDel.stale(this.ref.tasks)), staleLogs = new Set(logDel.stale(this.ref.logs));
      const staleTaskRows = this.ref.tasks.filter(t => staleTasks.has(t.id));
      if (staleTasks.size) {
        this.ref.tasks = this.ref.tasks.filter(t => !staleTasks.has(t.id));
        this.setTasks(prev => prev.filter(t => !staleTasks.has(t.id)));
        for (const id of staleTasks) { this.savedTaskIds.delete(id); this.recoveringIds.delete(id); }
        this.taskSyncQueue = this.taskSyncQueue.filter(t => !staleTasks.has(t.id));
        await this.idb(() => this.b.deleteTasks([...staleTasks]));
      }
      if (staleLogs.size) {
        this.ref.logs = this.ref.logs.filter(l => !staleLogs.has(l.id));
        this.setLogs(prev => prev.filter(l => !staleLogs.has(l.id)));
        for (const id of staleLogs) this.savedLogIds.delete(id);
        await this.idb(() => this.b.deleteHistoryEntries([...staleLogs]));
      }
      const staleItemIds = taskDel.stale(this.ref.logs.flatMap(l => (Array.isArray(l?.tasks) ? l.tasks : [])).filter(i => i?.id)).filter(id => !staleTasks.has(id));
      const staleGone = [...staleTaskRows, ...[...new Set(staleItemIds)].map(id => ({ id }))];
      if (staleGone.length) this.dropLogItemsFor(staleGone);
      const failed = S.getFailedSyncs();
      const pendingTasks = new Set([...failed.filter(f => f.kind === "task").map(f => f.id), ...this.taskSyncQueue.map(t => t.id)]);
      const pendingLogs = new Set(failed.filter(f => f.kind === "history").map(f => f.id));
      if (guard.fresh) {
        const take = new Map(B.restoredVersions(this.ref.logs, remote.history, pendingLogs).map(l => [l.id, l]));
        if (take.size) {
          for (const l of take.values()) { this.savedLogIds.add(l.id); this.b.addHistoryEntry(l); }
          this.ref.logs = this.ref.logs.map(l => take.get(l.id) || l);
          this.setLogs(prev => prev.map(l => take.get(l.id) || l));
        }
        S.markRestoreSeen(guard.restoreAt);
      }
      const taskPlan = R.planTaskSync({ local: this.ref.tasks, cloud: remote.tasks || [], cloudIds: cids?.tasks ?? null,
        tombstones: cids?.taskTombstones ?? null, pending: pendingTasks, deleting: taskDel.deleting, since });
      const logPlan = R.planLogSync({ local: this.ref.logs, cloud: remote.history || [], cloudIds: cids?.history ?? null,
        tombstones: cids?.historyTombstones ?? null, pending: pendingLogs, deleting: logDel.deleting, since });
      const rmTasks = new Set(taskPlan.remove), rmLogs = new Set(logPlan.remove);
      const updates = new Map(taskPlan.update.map(u => [u.id, u]));
      const logsFromCloud = B.takeFinishedFromCloud(this.ref.logs, remote.history || []).filter(l => !logDel.deleting.has(l.id));
      if (logsFromCloud.length) {
        const byId = new Map(logsFromCloud.map(l => [l.id, l]));
        this.ref.logs = this.ref.logs.map(l => byId.get(l.id) || l);
        this.setLogs(prev => prev.map(l => byId.get(l.id) || l));
        for (const l of logsFromCloud) { this.savedLogIds.add(l.id); this.b.addHistoryEntry(l); }
      }
      if (remote.historyOk) { this.cloudSynced = true; this.historySyncReady = true; }
      if (taskPlan.add.length || updates.size || rmTasks.size) {
        for (const t of taskPlan.add) if (!isInFlight(t)) this.savedTaskIds.add(t.id);
        this.setTasks(prev => {
          const have = new Set(ids(prev));
          const added = taskPlan.add.filter(t => !have.has(t.id) && !this.deletingIds.has(t.id));
          const kept = prev.filter(t => !rmTasks.has(t.id)).map(t => updates.has(t.id) ? R.applyCloudUpdate(t, updates.get(t.id)) : t);
          return [...added, ...kept].sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
        });
        for (const t of taskPlan.add) this.b.saveTask(t);
        for (const t of this.ref.tasks) {
          const u = updates.get(t.id);
          if (!u) continue;
          const next = R.applyCloudUpdate(t, u);
          if (u.finish && next !== t) { this.savedTaskIds.add(t.id); this.recoveringIds.delete(t.id); }
          if (next !== t) this.b.saveTask(next);
        }
        if (rmTasks.size) {
          const removedHere = this.ref.tasks.filter(t => rmTasks.has(t.id));
          const userRemoved = R.historyRemovals(removedHere, cids?.taskRestoreRemoved ?? null);
          this.dropLogItemsFor(userRemoved);
          for (const id of rmTasks) { this.savedTaskIds.delete(id); S.removeFailedSync("task", id); }
          await this.idb(() => this.b.deleteTasks([...rmTasks]));
        }
      }
      const goneItems = R.tombstonedItems(this.ref.logs, cids?.taskTombstones ?? null, cids?.taskRestoreRemoved ?? null, new Set(ids(this.ref.tasks)));
      if (goneItems.length) this.dropLogItemsFor(goneItems.map(id => ({ id })));
      const taskUploads = S.uploadable("task", taskPlan.upload.slice(0, 100));
      if (taskUploads.length) {
        for (const t of taskUploads) { this.savedTaskIds.add(t.id); this.b.saveTask(t); S.addFailedSync({ kind: "task", id: t.id, data: t }); }
        try { for (const t of await this.sendTasks(taskUploads)) S.removeFailedSync("task", t.id, S.sentVersion(t)); } catch {}
      }
      if (logPlan.add.length || rmLogs.size) {
        for (const l of logPlan.add) this.savedLogIds.add(l.id);
        this.setLogs(prev => {
          const have = new Set(ids(prev));
          const added = logPlan.add.filter(l => !have.has(l.id) && !this.deletingLogIds.has(l.id));
          return [...added, ...prev.filter(l => !rmLogs.has(l.id))].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        });
        for (const l of logPlan.add) this.b.addHistoryEntry(l);
        if (rmLogs.size) {
          for (const id of rmLogs) { this.savedLogIds.delete(id); S.removeFailedSync("history", id); }
          await this.idb(() => this.b.deleteHistoryEntries([...rmLogs]));
        }
      }
      const logUploads = S.historyUploadPlan(S.uploadable("history", logPlan.upload.slice(0, 100))).upload;
      if (logUploads.length) {
        for (const l of logUploads) { this.savedLogIds.add(l.id); this.b.addHistoryEntry(l); S.addFailedSync({ kind: "history", id: l.id, data: l }); }
        try { for (const l of await this.sendHistory(logUploads)) S.removeFailedSync("history", l.id, S.sentVersion(l)); } catch {}
      }
    } catch (err) {
      if (!(err instanceof Error && err.message === "network")) this.sim.flowError(this, "reconcile", err);
    } finally {
      this.reconcileRunning = false;
    }
  }

  // ─── App.jsx 2340-2363 persistLog ───
  persistLog(entry) {
    const S = this.S;
    if (S.uploadBlockedIds("history").has(entry?.id)) return Promise.resolve();
    const held = S.historyUploadPlan([entry], { strip: false }).defer.length > 0;
    const send = entry;
    this.b.addHistoryEntry(entry);
    this.savedLogIds.add(entry.id);
    S.addFailedSync({ kind: "history", id: send.id, data: send });
    if (held) return Promise.resolve();
    return this.sendHistoryEntry(send, { strip: false })
      .then((sent) => { if (sent?.length) S.removeFailedSync("history", send.id, e => B.sameLogContent(e.data, send)); })
      .catch(() => {});
  }
  // ─── App.jsx 2368-2378 sendHistoryRewrites ───
  async sendHistoryRewrites(entries, queuedAt) {
    const S = this.S;
    for (const l of entries) {
      this.savedLogIds.add(l.id); this.b.addHistoryEntry(l);
      if (!S.replaceQueuedUpload("history", l.id, l)) S.addFailedSync({ kind: "history", id: l.id, data: l, queuedAt });
    }
    const r = await this.sendQueuedHistory(entries, queuedAt);
    for (const id of r.voided) S.removeFailedSync("history", id);
    for (const l of entries) if (r.upserted.includes(l.id)) S.removeFailedSync("history", l.id, e => B.sameLogContent(e.data, l));
    return r;
  }
  // ─── App.jsx 2382-2411 dropLogItemsFor ───
  dropLogItemsFor(removed) {
    const S = this.S;
    const gone = new Set(ids(removed));
    const kept = this.ref.tasks.filter(t => !gone.has(t.id));
    const { remove, rewrite } = B.purgeLogsForDeleted(this.ref.logs, removed, kept, { removeEntries: false });
    const changed = rewrite.filter(l => !this.deletingLogIds.has(l.id));
    const emptied = remove.filter(id => !this.deletingLogIds.has(id));
    if (!changed.length && !emptied.length) return;
    if (emptied.length) {
      for (const id of emptied) { this.deletingLogIds.add(id); this.savedLogIds.delete(id); S.removeFailedSync("history", id); }
      const emptiedAt = S.queueDeleteIntents("history-delete", emptied);
      this.sim.noteRequest("emptied entry", "history", emptied, emptiedAt);
      this.b.deleteHistoryEntries(emptied);
      const flight = S.beginDeleteFlight({ "history-delete": emptied }, emptiedAt);
      this.deleteHistoryRemote(emptied, emptiedAt).then(r => {
        if (r.deleted.length) this.confirmIntents("history-delete", r.deleted, emptiedAt);
        if (r.voided.length) {
          S.voidDeleteIntents("history-delete", r.voided, emptiedAt);
          this.releaseVoided(this.deletingLogIds, "history-delete", r.voided);
          this.giveBackVoided(emptiedAt);
        }
      }).finally(() => S.endDeleteFlight(flight));
    }
    const dropped = new Set(emptied), byId = new Map(changed.map(l => [l.id, l]));
    this.ref.logs = this.ref.logs.filter(l => !dropped.has(l.id)).map(l => byId.get(l.id) || l);
    this.setLogs(prev => prev.filter(l => !dropped.has(l.id)).map(l => byId.get(l.id) || l));
    for (const l of changed) this.persistLog(l);
  }

  // ─── App.jsx 2771-2783 settleCloudClear ───
  async settleCloudClear({ tasks, history, at }) {
    const cloud = await this.pullCloudIds();
    let clean = true;
    for (const [kind, table, list] of [["task-delete", "tasks", tasks], ["history-delete", "history", history]]) {
      if (!list) continue;
      const { done, left } = clearSettlement(list, cloud?.[table] ?? null);
      this.confirmIntents(kind, done, at);
      if (left.length) clean = false;
    }
    this.settleClearStashes();
    return clean;
  }
  // ─── App.jsx 2839-2878 stagePurge (WaveSpeed / file queues left out) ───
  stagePurge(removed, kept, { history = true, alsoLogs = [], all = false, logs, serverHistory = false, at, holdAt } = {}) {   // eslint-disable-line no-unused-vars
    const S = this.S;
    const base = logs || this.ref.logs;
    const plan = P.planPurge(base, removed, kept, { history, alsoLogs, all });
    let send = { rewrite: plan.rewrite, remove: plan.remove }, historyQueuedAt = null;
    if (history && (plan.remove.length || plan.rewrite.length)) {
      const gone = new Set(plan.remove), byId = new Map(plan.rewrite.map(l => [l.id, l]));
      this.ref.logs = this.ref.logs.filter(l => !gone.has(l.id)).map(l => byId.get(l.id) || l);
      this.setLogs(prev => prev.filter(l => !gone.has(l.id)).map(l => byId.get(l.id) || l));
      if (serverHistory) send = B.clientHistoryWork(base, plan);
      historyQueuedAt = S.queueDeleteIntents("history-delete", send.remove, at);
      this.b.deleteHistoryEntries(plan.remove);
      const sent = new Set(send.rewrite.map(l => l.id));
      for (const l of plan.rewrite) {
        this.savedLogIds.add(l.id); this.b.addHistoryEntry(l);
        if (sent.has(l.id)) S.addFailedSync({ kind: "history", id: l.id, data: l, queuedAt: historyQueuedAt });
        else S.replaceQueuedUpload("history", l.id, l);
      }
      for (const id of plan.remove) { this.deletingLogIds.add(id); this.savedLogIds.delete(id); S.removeFailedSync("history", id); }
    }
    return { ...plan, rewrite: send.rewrite, remove: send.remove, localRemove: plan.remove, history, historyQueuedAt };
  }
  // ─── App.jsx 2879-2911 purgeEverywhere (its History part) ───
  async purgeEverywhere(plan) {
    if (!plan) return;
    const S = this.S;
    await null;   // flushWsDeletes
    if (plan.history) {
      const rewrites = plan.rewrite.length ? this.sendHistoryRewrites(plan.rewrite.map(l => this.ref.logs.find(x => x.id === l.id) || l), plan.historyQueuedAt) : null;
      if (plan.remove.length) {
        const flight = S.beginDeleteFlight({ "history-delete": plan.remove }, plan.historyQueuedAt);
        try {
          const hr = await this.deleteHistoryRemote(plan.remove, plan.historyQueuedAt ?? undefined);
          if (hr.deleted.length) this.confirmIntents("history-delete", hr.deleted, plan.historyQueuedAt);
          if (hr.voided.length) {
            S.voidDeleteIntents("history-delete", hr.voided, plan.historyQueuedAt);
            this.releaseVoided(this.deletingLogIds, "history-delete", hr.voided);
            this.giveBackVoided(plan.historyQueuedAt);
          }
        } finally { S.endDeleteFlight(flight); }
      }
      await rewrites;
    }
  }

  // ─── generate: one batch submitted. Its History entry is written when the batch starts (the History save effect,
  // App.jsx 2413-2419), and each task is saved and its row travels as "processing" once WaveSpeed accepts it
  // (App.jsx 3446-3448, syncInFlight 2588-2594). It finishes at a later "finish" op (finish()). The entry is created
  // with its items' final outcome (finishLogs 2421-2432 is not modelled). `note(ids)` receives the new ids at once.
  async generate(n, note) {
    const now = C.serverNow();
    const batchId = this.sim.newId("L");
    const tasks = [];
    for (let i = 0; i < n; i++) {
      const id = this.sim.newId("t");
      tasks.push({ id, batchId, modelId: "m", modelName: "M", provider: "ws", price: 0.01, status: "completed",
        startTime: now - 5000, endTime: now, wallClockMs: 5000, outputs: [`https://ws.example/${id}.png`], genType: "t2i", prompt: "p" });
    }
    note?.([batchId, ...ids(tasks)]);
    const running = tasks.map(t => ({ ...t, status: "processing", endTime: null, outputs: [], taskId: `ws-${t.id}` }));
    const entry = { id: batchId, timestamp: now - 5000, prompt: "p", genType: "t2i", models: ["M"], tasks: B.batchLogItems(tasks), totalCost: 0.01 * n };
    this.setTasks(prev => [...running, ...prev]);
    this.setLogs(prev => [entry, ...prev]);
    await this.idb();   // rendered: the entry is saved and sent
    for (const t of running) { this.b.saveTask(t); this.syncInFlight(t); }
  }
  // ─── finish: every running task this page holds gets its result (its own poll, or a poll of a running task another
  // device uploaded: "whichever gets the result first uploads it", syncReconcile.js). The persistence effect then stores,
  // queues and (debounced) uploads the finished version (App.jsx 2440-2486; applyPoll/settlePoll not modelled).
  finish() {
    const now = C.serverNow();
    this.setTasks(prev => prev.map(t => (isInFlight(t) ? { ...t, status: "completed", endTime: now, outputs: [`https://ws.example/${t.id}.png`] } : t)));
  }
  // App.jsx 2588-2594
  syncInFlight(t) {
    const S = this.S;
    S.addFailedSync({ kind: "task", id: t.id, data: t });
    this.sendTask(t).then(() => S.removeFailedSync("task", t.id, e => isInFlight(e.data))).catch(() => {});
  }

  // ─── App.jsx 3597-3705 deleteSelectedTasks ───
  async deleteSelectedTasks(selected) {
    if (this.bulkDeleting) return;
    const S = this.S;
    const idSet = new Set(selected);
    const targets = this.st.tasks.filter(t => idSet.has(t.id) && (t.status === "completed" || t.status === "failed"));
    if (!targets.length) return;
    this.sim.noteAction(this, "bulk delete", "task", ids(targets));
    await this.readAutoBackups();
    const list = ids(targets);
    this.bulkDeleting = true;
    for (const id of list) this.deletingIds.add(id);
    const callHold = {};
    this.holdDeleting("task-delete", list, callHold);
    let heldLogIds = [], taskFlight = null;
    try {
      const bk = await this.createBackup("pre-bulk-delete");
      if (!bk?.ok) { for (const id of list) this.deletingIds.delete(id); this.bulkDeleting = false; return; }
      this.timerArmed = false;
      this.taskSyncQueue = this.taskSyncQueue.filter(t => !idSet.has(t.id));
      for (const id of list) { this.savedTaskIds.delete(id); S.removeFailedSync("task", id); }
      const queuedAt = S.queueDeleteIntents("task-delete", list);
      this.sim.noteRequest("bulk delete", "task", list, queuedAt);
      S.forgetConfirmed("task-delete", list);
      const latest = targets.map(t => this.ref.tasks.find(x => x.id === t.id) || t);
      this.setTasks(prev => prev.filter(t => !idSet.has(t.id)));
      const plan = this.stagePurge(latest, this.ref.tasks.filter(t => !idSet.has(t.id)), { serverHistory: true, holdAt: queuedAt });
      heldLogIds = plan.localRemove || [];
      this.holdDeleting("history-delete", heldLogIds, callHold);
      this.holdDeleting("history-delete", heldLogIds, queuedAt);
      await this.idb(() => this.b.deleteTasks(list));
      taskFlight = S.beginDeleteFlight({ "task-delete": list }, queuedAt);
      const r = await this.deleteTasksRemote(list, queuedAt);
      if (r.ok) this.confirmIntents("task-delete", list, queuedAt);
      else if (r.deleted?.length) this.confirmIntents("task-delete", r.deleted, queuedAt);
      const voided = r.voided || [];
      if (voided.length) {
        S.voidDeleteIntents("task-delete", voided, queuedAt);
        this.releaseVoided(this.deletingIds, "task-delete", voided);
        for (const l of plan.rewrite || []) S.removeFailedSync("history", l.id);
        S.voidDeleteIntents("history-delete", plan.remove || [], plan.historyQueuedAt);
        this.releaseVoided(this.deletingLogIds, "history-delete", plan.localRemove);
        this.giveBackVoided(queuedAt, plan.historyQueuedAt);
      }
      if (r.ok) await this.purgeEverywhere(plan);
      this.bulkDeleting = false;
    } finally {
      this.unholdDeleting("task-delete", list, callHold); this.unholdDeleting("history-delete", heldLogIds, callHold);
      S.endDeleteFlight(taskFlight);
    }
  }
  // ─── App.jsx 3764-3834 deleteSelectedLogs ───
  async deleteSelectedLogs(selected) {
    if (this.bulkDeletingLogs) return;
    const S = this.S;
    const idSet = new Set(selected);
    const targets = this.st.logs.filter(l => idSet.has(l.id));
    if (!targets.length) return;
    this.sim.noteAction(this, "History delete", "history", ids(targets));
    await this.readAutoBackups();
    const list = ids(targets);
    this.bulkDeletingLogs = true;
    for (const id of list) this.deletingLogIds.add(id);
    const callHold = {};
    this.holdDeleting("history-delete", list, callHold);
    let logFlight = null;
    try {
      const bk = await this.createBackup("pre-bulk-delete-logs");
      if (!bk?.ok) { for (const id of list) this.deletingLogIds.delete(id); this.bulkDeletingLogs = false; return; }
      for (const id of list) { this.savedLogIds.delete(id); S.removeFailedSync("history", id); }
      const queuedAt = S.queueDeleteIntents("history-delete", list);
      this.sim.noteRequest("History delete", "history", list, queuedAt);
      S.forgetConfirmed("history-delete", list);
      this.setLogs(prev => prev.filter(l => !idSet.has(l.id)));
      await this.idb(() => this.b.deleteHistoryEntries(list));
      logFlight = S.beginDeleteFlight({ "history-delete": list }, queuedAt);
      const r = await this.deleteHistoryRemote(list, queuedAt);
      if (r.ok) this.confirmIntents("history-delete", list, queuedAt);
      else if (r.deleted.length) this.confirmIntents("history-delete", r.deleted, queuedAt);
      if (r.voided.length) {
        S.voidDeleteIntents("history-delete", r.voided, queuedAt);
        this.releaseVoided(this.deletingLogIds, "history-delete", r.voided);
        this.giveBackVoided(queuedAt);
      }
      this.bulkDeletingLogs = false;
    } finally {
      this.unholdDeleting("history-delete", list, callHold);
      S.endDeleteFlight(logFlight);
    }
  }

  // ─── App.jsx 5028-5129 Clear Logs ───
  async clearLogs() {
    const S = this.S;
    await this.readAutoBackups();
    const bk = await this.createBackup("pre-clear-logs");
    if (!bk?.ok) return;
    const cloudLogIds = (await this.pullCloudIds())?.history ?? null;
    const storedLogs = this.b.allStoredHistory(); await this.idb();
    const removedLogIds = [...new Set([...ids(this.ref.logs), ...ids(storedLogs)])];
    const queuedLogsAtSnap = S.peekQueuedUploads(["history"]);
    const snap = await this.serverTimeRemote();
    if (snap == null) return;
    const clearedLogIds = [...new Set([...removedLogIds, ...ids(queuedLogsAtSnap)])];
    const clearedLogSet = new Set(clearedLogIds);
    this.sim.noteAction(this, "Clear Logs", "history", clearedLogIds);
    const stashUploads = S.peekQueuedUploads(["history"]).filter(e => clearedLogSet.has(e.id));
    const logsStash = S.clearLogsStash({ loaded: this.ref.logs, stored: storedLogs, uploads: stashUploads, planned: clearedLogSet, cloudLogIds });
    if (!S.writeClearStash(snap, logsStash.full)) S.writeClearStash(snap, logsStash.loadedOnly);
    const takenLogUploads = S.takeQueuedUploads("history", clearedLogIds);
    for (const id of clearedLogIds) this.deletingLogIds.add(id);
    S.queueDeleteIntents("history-delete", clearedLogIds, snap);
    this.sim.noteRequest("Clear Logs", "history", clearedLogIds, snap);
    const logsBefore = this.ref.logs.filter(l => clearedLogSet.has(l.id));
    const loadedBefore = new Set(ids(logsBefore));
    const storedOnlyBefore = storedLogs.filter(l => !loadedBefore.has(l.id));
    const savedLogsBefore = new Set(clearedLogIds.filter(id => this.savedLogIds.has(id)));
    this.setLogs(prev => prev.filter(l => !clearedLogSet.has(l.id)));
    for (const id of clearedLogIds) this.savedLogIds.delete(id);
    await this.idb(() => this.b.deleteHistoryEntries(clearedLogIds));
    const logsFlight = S.beginDeleteFlight({ "history-delete": clearedLogIds }, snap);
    try {
      const cr = await this.clearQueuedRemote("history", snap, clearedLogIds);
      if (cr.ok) S.dropClearStash(snap);
      if (cr.voided) {
        S.voidDeleteIntents("history-delete", clearedLogIds, snap);
        this.releaseVoided(this.deletingLogIds, "history-delete", clearedLogIds);
        const back = S.inlineVoidPutBack(snap, { logs: [...logsBefore, ...storedOnlyBefore], uploads: takenLogUploads });
        const backIds = new Set(ids(back.logs));
        const logsBack = logsBefore.filter(l => backIds.has(l.id));
        this.setLogs(prev => { const have = new Set(ids(prev)); const add = logsBack.filter(l => !have.has(l.id)); return add.length ? [...prev, ...add] : prev; });
        for (const l of logsBack) { this.b.addHistoryEntry(l); if (savedLogsBefore.has(l.id)) this.savedLogIds.add(l.id); }
        const loadedNow = new Set(ids(this.ref.logs));
        for (const l of storedOnlyBefore) if (backIds.has(l.id) && !loadedNow.has(l.id)) this.b.addHistoryEntry(l);
        S.putBackQueuedUploads(back.uploads);
        this.applyClearStashes(S.voidedClearStashes(snap), { logs: backIds });
        return;
      }
      if (cr.ok) await this.settleCloudClear({ history: clearedLogIds, at: snap });
    } finally { S.endDeleteFlight(logsFlight); }
  }

  // ─── App.jsx 5130-5331 Clear Outputs ───
  async clearOutputs() {
    const S = this.S;
    await this.readAutoBackups();
    const bk = await this.createBackup("pre-clear-outputs");
    if (!bk?.ok) return;
    const localTasks = this.ref.tasks.slice();
    const localLogs = this.ref.logs.slice();
    const localLogIds = new Set(ids(localLogs));
    const queuedAtSnap = S.peekQueuedUploads(["task"]);
    const snap = await this.serverTimeRemote();
    if (snap == null) return;
    const clearAt = snap - C.SNAPSHOT_SLACK_MS;
    const remote = await this.pullAllForPurge();
    if (!remote) return;
    const copyTasks = new Map(localTasks.map(t => [t.id, t]));
    const queuedTasks = new Map(queuedAtSnap.map(e => [e.id, e.data]));
    const remoteTasks = new Map(remote.tasks.map(t => [t.id, t]));
    const heldIds = new Set([...copyTasks.keys(), ...queuedTasks.keys(),
      ...localLogs.flatMap(l => (Array.isArray(l?.tasks) ? l.tasks : []).map(i => i?.id))].filter(Boolean));
    const plannedIds = new Set([...copyTasks.keys(), ...queuedTasks.keys()]);
    for (const t of remote.tasks) if (!(Date.parse(t.createdAt) > clearAt) || heldIds.has(t.id)) plannedIds.add(t.id);
    const currentTasks = new Map(this.ref.tasks.map(t => [t.id, t]));
    const all = new Map();
    for (const id of plannedIds) all.set(id, currentTasks.get(id) || remoteTasks.get(id) || queuedTasks.get(id) || copyTasks.get(id) || { id });
    const realTasks = [...all.values()];
    const late = new Set(remote.history.filter(l => !localLogIds.has(l.id) && Date.parse(l.createdAt) > clearAt).map(l => l.id));
    const mergedLogs = B.mergeLogs(localLogs, remote.history.filter(l => !late.has(l.id)));
    const historyOnly = B.historyOnlyGenerations(mergedLogs, new Set([...all.keys(), ...remote.tasks.map(t => t.id)]));
    const removed = [...realTasks, ...historyOnly.map(g => currentTasks.has(g.id) ? { ...g, ...currentTasks.get(g.id) } : g)];
    const clearedTaskIds = ids(removed);
    const plannedTaskIds = new Set(clearedTaskIds);
    this.sim.noteAction(this, "Clear Outputs", "task", clearedTaskIds);
    this.taskSyncQueue = this.taskSyncQueue.filter(t => !plannedTaskIds.has(t.id));
    if (!this.taskSyncQueue.length) this.timerArmed = false;
    const logsBefore = new Map(this.ref.logs.map(l => [l.id, l]));
    const mergedLogIds = new Set(ids(mergedLogs));
    S.writeClearStash(clearAt, S.buildClearStash({
      uploads: S.peekQueuedUploads(["task", "history"]).filter(e => (e.kind === "task" ? plannedTaskIds : mergedLogIds).has(e.id)),
      tasks: realTasks.filter(t => currentTasks.has(t.id) || copyTasks.has(t.id)),
      logs: [...logsBefore.values()].filter(l => mergedLogIds.has(l.id)),
      cloudTaskIds: new Set(remoteTasks.keys()), cloudLogIds: new Set(ids(remote.history)) }));
    const takenUploads = S.takeQueuedUploads("task", clearedTaskIds);
    for (const id of clearedTaskIds) this.deletingIds.add(id);
    const savedLogsBefore = new Set(this.savedLogIds);
    const logUploadsBefore = S.peekQueuedUploads(["history"]);
    const queuedAt = S.queueDeleteIntents("task-delete", clearedTaskIds, clearAt);
    const plan = this.stagePurge(removed, [], { all: true, logs: mergedLogs, serverHistory: true, at: clearAt, holdAt: clearAt });
    this.holdDeleting("history-delete", plan.localRemove, clearAt);
    const rowIds = ids(realTasks);
    const namedHistoryOnly = historyOnly.filter(g => localLogIds.has(g.batchId)).map(g => g.id);
    const namedIds = [...rowIds, ...namedHistoryOnly];
    this.sim.noteRequest("Clear Outputs", "task", namedIds, queuedAt);   // the cloud-only History-only ids are the server's call (rows created after the bound stay)
    const tasksRemovedHere = this.ref.tasks.filter(t => plannedTaskIds.has(t.id));
    const savedTasksBefore = new Set(tasksRemovedHere.filter(t => this.savedTaskIds.has(t.id)).map(t => t.id));
    this.setTasks(prev => prev.filter(t => !plannedTaskIds.has(t.id)));
    this.b.deleteTasks([...plannedTaskIds]);
    for (const id of plannedTaskIds) this.savedTaskIds.delete(id);
    const outputsFlight = S.beginDeleteFlight({ "task-delete": clearedTaskIds, "history-delete": plan.remove || [] }, clearAt);
    try {
      const cr = await this.clearQueuedRemote("task", queuedAt, namedIds);
      if (cr.ok) S.dropClearStash(clearAt);
      if (cr.voided) {
        S.voidDeleteIntents("task-delete", clearedTaskIds, clearAt);
        this.releaseVoided(this.deletingIds, "task-delete", clearedTaskIds);
        for (const l of plan.rewrite || []) S.removeFailedSync("history", l.id);
        S.voidDeleteIntents("history-delete", plan.remove || [], clearAt);
        this.releaseVoided(this.deletingLogIds, "history-delete", plan.localRemove);
        const localRemoved = new Set(plan.localRemove || []);
        const back = S.inlineVoidPutBack(clearAt, { tasks: tasksRemovedHere,
          logs: [...localRemoved].map(id => logsBefore.get(id)).filter(Boolean),
          uploads: [...takenUploads, ...logUploadsBefore.filter(e => localRemoved.has(e.id) && logsBefore.has(e.id))] });
        const backTaskIds = new Set(ids(back.tasks));
        const tasksBack = tasksRemovedHere.filter(t => backTaskIds.has(t.id));
        this.setTasks(prev => { const have = new Set(ids(prev)); const add = tasksBack.filter(t => !have.has(t.id)); return add.length ? [...prev, ...add] : prev; });
        this.b.saveTasks(tasksBack);
        for (const id of savedTasksBefore) if (backTaskIds.has(id)) this.savedTaskIds.add(id);
        const logsBack = back.logs;
        const backIds = new Set(ids(logsBack));
        this.setLogs(prev => { const have = new Set(ids(prev)); const add = logsBack.filter(l => !have.has(l.id)); return add.length ? [...prev, ...add] : prev; });
        for (const l of logsBack) { this.b.addHistoryEntry(l); if (savedLogsBefore.has(l.id)) this.savedLogIds.add(l.id); }
        S.putBackQueuedUploads(back.uploads);
        this.applyClearStashes(S.voidedClearStashes(clearAt), { tasks: new Map(tasksBack.map(t => [t.id, t])), logs: backIds });
        return;
      }
      if (cr.ok) this.confirmIntents("task-delete", historyOnly.filter(g => !localLogIds.has(g.batchId)).map(g => g.id), queuedAt);
      if (cr.ok) await this.purgeEverywhere(plan);
      if (cr.ok) await this.settleCloudClear({ tasks: namedIds, at: queuedAt });
    } finally { S.endDeleteFlight(outputsFlight); }
  }

  // ─── App.jsx 5332-5556 Reset Everything (favorites / settings left out) ───
  async resetEverything() {
    const S = this.S;
    await this.readAutoBackups();
    await null;   // favoriteSyncChainRef
    const bk = await this.createBackup("pre-reset");
    if (!bk?.ok) return;
    const storedTasks = this.b.allStoredTasks(); await this.idb();
    const storedLogs = this.b.allStoredHistory(); await this.idb();
    const localTasks = this.ref.tasks.slice();
    const localLogs = this.ref.logs.slice();
    const queuedAtSnap = S.peekQueuedUploads(["task", "history"]);
    const snap = await this.serverTimeRemote();
    if (snap == null) return;
    const resetAt = snap - C.SNAPSHOT_SLACK_MS;
    const remote = await this.pullAllForPurge();
    if (!remote) return;
    await this.idb();   // getSetting(favorites)
    await this.idb();   // setSetting(favorites)
    const copyTasks = new Map([...storedTasks, ...localTasks].map(t => [t.id, t]));
    const queuedTasks = new Map(queuedAtSnap.filter(e => e.kind === "task").map(e => [e.id, e.data]));
    const queuedLogs = new Map(queuedAtSnap.filter(e => e.kind === "history").map(e => [e.id, e.data]));
    const remoteTasks = new Map(remote.tasks.map(t => [t.id, t]));
    const copyLogs = new Map([...storedLogs, ...localLogs].map(l => [l.id, l]));
    const heldIds = new Set([...copyTasks.keys(), ...queuedTasks.keys(),
      ...[...copyLogs.values(), ...queuedLogs.values()].flatMap(l => (Array.isArray(l?.tasks) ? l.tasks : []).map(i => i?.id))].filter(Boolean));
    const plannedTaskIds = new Set([...copyTasks.keys(), ...queuedTasks.keys()]);
    for (const t of remote.tasks) if (!(Date.parse(t.createdAt) > resetAt) || heldIds.has(t.id)) plannedTaskIds.add(t.id);
    const plannedLogIds = new Set([...copyLogs.keys(), ...queuedLogs.keys()]);
    for (const l of remote.history) if (!plannedLogIds.has(l.id) && !(Date.parse(l.createdAt) > resetAt)) plannedLogIds.add(l.id);
    const currentTasks = new Map(this.ref.tasks.map(t => [t.id, t]));
    const currentLogs = new Map(this.ref.logs.map(l => [l.id, l]));
    const remoteLogs = new Map(remote.history.map(l => [l.id, l]));
    S.writeClearStash(resetAt, { ...S.buildClearStash({
      uploads: S.peekQueuedUploads(["task", "history"]).filter(e => (e.kind === "task" ? plannedTaskIds : plannedLogIds).has(e.id)),
      tasks: [...plannedTaskIds].map(id => currentTasks.get(id) || copyTasks.get(id)).filter(Boolean),
      logs: [...plannedLogIds].map(id => currentLogs.get(id) || copyLogs.get(id)).filter(Boolean),
      cloudTaskIds: new Set(remoteTasks.keys()), cloudLogIds: new Set(remoteLogs.keys()) }) });
    const takenUploads = [...S.takeQueuedUploads("task", [...plannedTaskIds]), ...S.takeQueuedUploads("history", [...plannedLogIds])];
    const takenData = new Map(takenUploads.map(e => [`${e.kind}:${e.id}`, e.data]));
    const allTasks = new Map(), allLogs = new Map();
    for (const id of plannedTaskIds) allTasks.set(id, currentTasks.get(id) || remoteTasks.get(id) || takenData.get(`task:${id}`) || queuedTasks.get(id) || copyTasks.get(id) || { id });
    for (const id of plannedLogIds) allLogs.set(id, currentLogs.get(id) || remoteLogs.get(id) || takenData.get(`history:${id}`) || queuedLogs.get(id) || copyLogs.get(id) || { id });
    const removedTasks = [...allTasks.values()], removedLogs = [...allLogs.values()];
    this.sim.noteAction(this, "Reset", "task", ids(removedTasks));
    this.sim.noteAction(this, "Reset", "history", ids(removedLogs));
    const tasksRemovedHere = this.ref.tasks.filter(t => plannedTaskIds.has(t.id));
    const logsRemovedHere = this.ref.logs.filter(l => plannedLogIds.has(l.id));
    const loadedTaskIds = new Set(ids(tasksRemovedHere)), loadedLogIds = new Set(ids(logsRemovedHere));
    const storedOnlyTasks = storedTasks.filter(t => plannedTaskIds.has(t.id) && !loadedTaskIds.has(t.id));
    const storedOnlyLogs = storedLogs.filter(l => plannedLogIds.has(l.id) && !loadedLogIds.has(l.id));
    const savedTasksBefore = new Set(tasksRemovedHere.filter(t => this.savedTaskIds.has(t.id)).map(t => t.id));
    const savedLogsBefore = new Set(logsRemovedHere.filter(l => this.savedLogIds.has(l.id)).map(l => l.id));
    const keptTasks = this.ref.tasks.filter(t => !plannedTaskIds.has(t.id));
    this.setTasks(prev => prev.filter(t => !plannedTaskIds.has(t.id)));
    this.setLogs(prev => prev.filter(l => !plannedLogIds.has(l.id)));
    for (const id of plannedTaskIds) this.savedTaskIds.delete(id);
    for (const id of plannedLogIds) this.savedLogIds.delete(id);
    this.taskSyncQueue = this.taskSyncQueue.filter(t => !plannedTaskIds.has(t.id));
    if (!this.taskSyncQueue.length) this.timerArmed = false;
    for (const id of plannedTaskIds) this.deletingIds.add(id);
    for (const id of plannedLogIds) this.deletingLogIds.add(id);
    const clearedTaskIds = [...plannedTaskIds];
    const clearedLogIds = [...plannedLogIds];
    S.queueDeleteIntents("task-delete", clearedTaskIds, resetAt);
    S.queueDeleteIntents("history-delete", clearedLogIds, resetAt);
    this.sim.noteRequest("Reset", "task", clearedTaskIds, resetAt);
    this.sim.noteRequest("Reset", "history", clearedLogIds, resetAt);
    const plan = this.stagePurge(removedTasks, keptTasks, { history: false, alsoLogs: removedLogs, holdAt: resetAt });
    await this.idb(() => this.b.deleteTasks(clearedTaskIds));
    await this.idb(() => this.b.deleteHistoryEntries(clearedLogIds));
    const resetFlight = S.beginDeleteFlight({ "task-delete": clearedTaskIds, "history-delete": clearedLogIds }, resetAt);
    try {
      const rr = await this.resetQueuedRemote(resetAt, clearedTaskIds, clearedLogIds);
      if (rr.ok) S.dropClearStash(resetAt);
      if (rr.voided) {
        S.voidDeleteIntents("task-delete", clearedTaskIds, resetAt); S.voidDeleteIntents("history-delete", clearedLogIds, resetAt);
        this.releaseVoided(this.deletingIds, "task-delete", clearedTaskIds);
        this.releaseVoided(this.deletingLogIds, "history-delete", clearedLogIds);
        const back = S.inlineVoidPutBack(resetAt, { tasks: [...tasksRemovedHere, ...storedOnlyTasks], logs: [...logsRemovedHere, ...storedOnlyLogs], uploads: takenUploads });
        const backTaskIds = new Set(ids(back.tasks)), backIds = new Set(ids(back.logs));
        const tasksBack = tasksRemovedHere.filter(t => backTaskIds.has(t.id)), storedTasksBack = storedOnlyTasks.filter(t => backTaskIds.has(t.id));
        const logsBack = logsRemovedHere.filter(l => backIds.has(l.id)), storedLogsBack = storedOnlyLogs.filter(l => backIds.has(l.id));
        const nowTaskIds = new Set(ids(this.ref.tasks)), nowLogIds = new Set(ids(this.ref.logs));
        this.setTasks(prev => { const have = new Set(ids(prev)); const add = tasksBack.filter(t => !have.has(t.id)); return add.length ? [...prev, ...add] : prev; });
        this.b.saveTasks([...tasksBack, ...storedTasksBack].filter(t => !nowTaskIds.has(t.id)));
        for (const id of savedTasksBefore) if (backTaskIds.has(id)) this.savedTaskIds.add(id);
        this.setLogs(prev => { const have = new Set(ids(prev)); const add = logsBack.filter(l => !have.has(l.id)); return add.length ? [...prev, ...add] : prev; });
        for (const l of [...logsBack, ...storedLogsBack]) if (!nowLogIds.has(l.id)) this.b.addHistoryEntry(l);
        for (const id of savedLogsBefore) if (backIds.has(id)) this.savedLogIds.add(id);
        S.putBackQueuedUploads(back.uploads);
        this.applyClearStashes(S.voidedClearStashes(resetAt), { tasks: new Map([...storedTasksBack, ...tasksBack].map(t => [t.id, t])), logs: backIds });
        return;
      }
      if (rr.ok) await this.purgeEverywhere(plan);
      if (rr.ok) await this.settleCloudClear({ tasks: clearedTaskIds, history: clearedLogIds, at: resetAt });
    } finally { S.endDeleteFlight(resetFlight); }
  }

  // ─── Cloud Backups (App.jsx 1653-1669 manual backup; 5696-5712 restore, then a reload after 1.5 s) ───
  async manualBackup() { await this.forceSaveAll(); await this.createBackup("manual"); }
  async restoreFrom(backupId) {
    await this.readAutoBackups();
    const r = await this.restoreBackup(backupId);
    if (r.ok) this.sim.requestReload(this);
  }
}
