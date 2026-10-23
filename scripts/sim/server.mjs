// The FAKE SERVER of the delete/restore/sync simulator (scripts/sim). It models only what the client depends on, from the
// LIVE definitions in supabase/migrations (latest file that defines each function, read 2026-10-23):
//   - delete_queued_rows / clear_queued_rows / reset_queued_rows / upsert_queued_history: the restore check
//     `p_queued_at < last_restore_at` => voided, nothing done (20261023100000_mu_p1_accounts.sql:843-1089);
//   - _clear_kind: rows created by the bound OR named, History-only orphans tombstoned, History half in the same call
//     (20261022310000_clear_snapshot_and_reset.sql:18-84);
//   - tombstones: sync_tombstone_record on every tasks/history delete (by_restore = inside a restore,
//     20261021175200), _rows_not_tombstoned refuses an INSERT/UPSERT of a tombstoned id outside a restore (any tombstone of
//     that kind, user or restore: 20261020210500), sync_tombstone_clear drops the tombstone after an insert (only a
//     restore can insert one: 20261020000001);
//   - History: history_strip_deleted_items strips items with a USER task tombstone from every insert/update, and skips +
//     tombstones a brand-new entry left empty (20261022170000); history_drop_emptied deletes an entry an update emptied
//     (20261022150000);
//   - backups: snapshot_my_data_phase2 (pre-* skipped while Automatic backups is OFF, the owner's setting), the scrub
//     queue filled by the delete/update triggers and drained with the liveness filter (20261022261000), the scrub of
//     snapshots (20261021175100 _scrub_backups / _scrub_history_snapshot);
//   - restore_my_backup_phase2: drain, replace tasks/history, by_restore tombstones, user tombstones of restored items
//     flipped to by_restore, the marker set at the END, the replaced rows scrubbed (20261023100000:1157-1258);
//   - the "no tombstone for a rowless id" gap AS IT IS TODAY: delete_queued_rows tombstones a rowless task id only if a
//     live History item holds it (or a tombstone names it); a rowless History id gets nothing.
// SERVER RULE (setServerRule, run.mjs --server): "v1" (default) = the live rules above; "v2" = migration
// 20261023500000_tombstone_rowless_scoped: delete_queued_rows and _clear_kind tombstone EVERY named id without a row
// (task and History kind; "do nothing" when a tombstone exists), and _clear_kind turns a by_restore tombstone of a named
// task id into a user one, as delete_queued_rows does. Its scope rules (tombstones per account) need no model here: the
// sim has one account. "v3" = v2 + migration 20261024100000_history_strip_restore_removed (K2): a History write (not a
// restore) also strips an item whose generation a restore removed (a by_restore task tombstone) when the stored entry
// does not hold it; a new entry left empty only by such items gets a restore's History tombstone.
// Not modelled: RLS/scopes/rename, favorites/settings rows (only the marker), tasks_keep_finished (every task here is
// completed), form holds (pull_form_holds answers none), id-less legacy History items, ws_deleted_predictions.
// FILES AND WAVESPEED (task B12c): the bucket `generations` (path -> { owners, deleted }) and WaveSpeed's predictions
// (prediction id -> { tid, deleted }) are created when a generation starts (outside the network: its upload / submit is
// not what the simulator searches). The flushes reach them through the modelled calls: predictions_in_use (a tasks row
// holding the prediction id, supabase.js predictionsInUseRemote), generations_live (20261023100000:937-963: a tasks row,
// or an item of a History entry without a USER task tombstone), paths_in_use (20261023100000:969-1000: the path inside a
// tasks row's inputs / outputs or a History entry's source / items), the WaveSpeed delete (POST predictions/delete:
// answers the ids it deleted now) and the Storage remove (names what it removed) + HEAD (404 once gone). Every delete
// that runs calls `onExternalDelete` (the simulator's invariant I6).
//
// The LEDGER (used by the invariants, scripts/sim/sim.mjs) records every user delete the server performed or was asked
// to perform for an id (the rowless gap included: a delete call answered "deleted" for a named id), every id a restore
// brought back, and every id a restore removed.

let RULE = process.env.SIM_SERVER || "v2";   // v2 is live since 2026-10-23 21:30:50 UTC (20261023500000)
export const SERVER_RULES = ["v1", "v2", "v3"];
export function setServerRule(r) {
  if (!SERVER_RULES.includes(r)) throw new Error(`unknown server rule ${r} (${SERVER_RULES.join("|")})`);
  RULE = r;
}
export const serverRule = () => RULE;

const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
const itemIdsOf = (e) => (Array.isArray(e?.tasks) ? e.tasks.map(i => i?.id).filter(Boolean) : []);

export class FakeServer {
  // Task B13c: the forms' holds each browser publishes (App.jsx publish effect, syncSetting form-inputs:<browser>) and
  // every browser reads (supabase.js pullFormHolds: all of this account's, its own included).
  setFormHold(browser, value) { this.formPubs.set(browser, JSON.parse(JSON.stringify(value))); return { ok: true }; }
  pullFormHolds() { return [...this.formPubs.values()].map(v => JSON.parse(JSON.stringify(v))); }
  constructor(clock) {
    this.clock = clock;
    this.tasks = new Map();     // id -> task (+ createdAt ms)
    this.history = new Map();   // id -> entry (+ createdAt ms)
    this.tomb = new Map();      // id -> { kind: "task" | "history", byRestore, at }
    this.marker = 0;            // settings.last_restore_at
    this.backups = [];          // { id, at, tasks, history }
    this.scrubQ = [];           // { tasks: [], logs: [] }
    this.autoBackups = false;   // the owner's setting (CLAUDE.md "Delete means delete")
    this.restoring = false;     // proxima.restore
    this.nextBackup = 1;
    this.formPubs = new Map();  // task B13c: settings rows form-inputs:<browser> -> { at, paths }
    // ledger
    this.delRec = new Map();    // "task:x" / "history:L" -> { at, legit, via }
    this.restoreRemoved = new Map(); // key -> at
    this.itemDropped = new Map();    // "task:x" -> at: a user delete removed the History entry that was x's only copy (no row)
    this.restores = [];         // { at, backupId, backupAt }
    this.events = [];           // short human-readable server log (trace)
    this.counts = { voided: 0, deletes: 0, clears: 0, restores: 0, uploads: 0, backups: 0, fileDeletes: 0, wsDeletes: 0 };   // coverage of a run
    // Task B12c: the bucket and WaveSpeed (see the header). path -> { gens: [generation ids using it], entry: History
    // entry id or null, deleted: false | { at, by } }; prediction id -> { tid, deleted }.
    this.files = new Map();
    this.preds = new Map();
    this.onExternalDelete = null;   // (what: "file" | "ws", key, gens) => void, set by the simulator (I6)
  }
  // ─── files and WaveSpeed (task B12c) ───
  // A generation's batch starts: its upload (shared by the batch and its History entry), each generation's own archived
  // output (if it has one) and its WaveSpeed prediction exist from now on.
  registerGeneration(entryId, gens) {
    for (const g of gens) {
      for (const p of g.paths || []) {
        const f = this.files.get(p) || { gens: [], entry: null, deleted: false };
        if (!f.gens.includes(g.id)) f.gens.push(g.id);
        if (g.entryPath === p) f.entry = entryId;
        this.files.set(p, f);
      }
      if (g.pred) this.preds.set(g.pred, { tid: g.id, deleted: false });
    }
  }
  // supabase.js predictionsInUseRemote: prediction id -> the id of the tasks row holding it (as [[pid, rowId]]).
  predictionsInUse(ids) {
    const want = new Set(ids || []), out = [];
    for (const t of this.tasks.values()) if (t.taskId && want.has(t.taskId)) out.push([t.taskId, t.id]);
    return out;
  }
  // generations_live (20261023100000:937-963): a tasks row, or an item of a History entry with no USER task tombstone.
  generationsLive(ids) {
    return (ids || []).filter(x => x && (this.tasks.has(x) || (this.liveItem(x) && !this.userTomb(x))));
  }
  // paths_in_use (20261023100000:969-1000): the path inside a tasks row's inputs / outputs or a History entry's inputs /
  // items (position(p in ...)).
  pathsInUse(paths) {
    const rows = [...this.tasks.values()].map(t => JSON.stringify([t.sourceImageUrl ?? null, t.sourceImageUrls ?? null, t.outputs ?? null, t.endFrameUrl ?? null]));
    const logs = [...this.history.values()].map(e => JSON.stringify([e.sourceImageUrl ?? null, e.sourceImageUrls ?? null, e.tasks ?? null]));
    return (paths || []).filter(p => p && [...rows, ...logs].some(s => s.includes(p)));
  }
  // POST api/v3/predictions/delete: answers the ids it deleted now (unknown or already deleted: skipped silently).
  wsDelete(ids) {
    const out = [];
    for (const id of ids || []) {
      const e = this.preds.get(id);
      if (!e || e.deleted) continue;
      e.deleted = { at: this.now() };
      out.push(id);
      this.counts.wsDeletes++;
      this.log(`WaveSpeed deleted ${id} (generation ${e.tid})`);
      this.onExternalDelete?.("ws", id, [e.tid]);
    }
    return out;
  }
  // storage remove([path]) (names what it removed) and the HEAD of its public URL (404 once gone).
  storageRemove(path) {
    const f = this.files.get(path);
    if (!f || f.deleted) return [];
    f.deleted = { at: this.now() };
    this.counts.fileDeletes++;
    this.log(`storage removed ${path} (generations ${f.gens}${f.entry ? `, entry ${f.entry}` : ""})`);
    this.onExternalDelete?.("file", path, f.gens.slice());
    return [path];
  }
  headStatus(path) { const f = this.files.get(path); return !f || f.deleted ? 404 : 200; }
  now() { return this.clock.now; }
  log(s) { this.events.push(`[${this.now()}] ${s}`); if (this.events.length > 400) this.events.shift(); }

  // ─── ledger ───
  // `wasPresent` (task B12c): whether the cloud held the id when the call ran (false: a delete that only named an id the
  // cloud had already lost, e.g. to a restore; I7 then counts the restore as its end).
  recordDelete(kind, id, via, wasPresent = true) {
    if (!id) return;
    this.delRec.set(`${kind}:${id}`, { at: this.now(), legit: false, via, wasPresent });
  }
  // Is this id present in the cloud right now? task: a tasks row or an item of a History entry; history: an entry.
  // A client confirmed a delete of these ids for the group queued at `at` (a "deleted" answer, a clear settled by the
  // cloud's ids, or Clear Outputs' cloud-only History-only ids): recorded unless the server already recorded a delete at or
  // after that queue time. A restore that ran after `at` and restored the id makes a reappearance legitimate. An id the
  // cloud holds right now is not recorded: that confirm is already contradicted (e.g. Clear Outputs' cloud-only
  // History-only id whose row landed after the clear's bound, which the server keeps by design) and the next pass
  // releases it; only an id absent now whose row or item lands LATER is a delete that did not stick.
  recordConfirm(kind, ids, at) {
    for (const id of ids || []) {
      if (!id || this.present(kind, id)) continue;
      const key = `${kind}:${id}`, have = this.delRec.get(key);
      if (have && have.at >= at) continue;
      const legit = this.restores.some(r => r.at > at && this.backupContains(r.b, kind, id));
      this.delRec.set(key, { at, legit, via: "client confirm" });
    }
  }
  present(kind, id) {
    if (kind === "history") return this.history.has(id);
    if (this.tasks.has(id)) return true;
    for (const e of this.history.values()) if (itemIdsOf(e).includes(id)) return true;
    return false;
  }
  liveItem(id) { for (const e of this.history.values()) if (itemIdsOf(e).includes(id)) return true; return false; }
  userTomb(id, kind = "task") { const t = this.tomb.get(id); return !!t && t.kind === kind && !t.byRestore; }
  restoreTomb(id, kind = "task") { const t = this.tomb.get(id); return !!t && t.kind === kind && !!t.byRestore; }

  // ─── triggers ───
  _deleteTaskRow(id) {
    const row = this.tasks.get(id);
    if (!row) return false;
    this.tasks.delete(id);
    this.tomb.set(id, { kind: "task", byRestore: this.restoring, at: this.now() });   // sync_tombstone_record
    if (!this.restoring && !this.autoBackups) this.scrubQ.push({ tasks: [id], logs: [] });   // _tasks_queue_backup_scrub
    return true;
  }
  _deleteHistoryRow(id) {
    const e = this.history.get(id);
    if (!e) return false;
    this.history.delete(id);
    if (!this.restoring) for (const x of itemIdsOf(e)) if (!this.present("task", x)) this.itemDropped.set(`task:${x}`, this.now());
    this.tomb.set(id, { kind: "history", byRestore: this.restoring, at: this.now() });
    if (!this.restoring && !this.autoBackups) this.scrubQ.push({ tasks: itemIdsOf(e), logs: [id] });   // _history_queue_backup_scrub (20261022220000)
    return true;
  }
  // tasks upsert (PostgREST upsert on id): _rows_not_tombstoned BEFORE INSERT, then insert or update, untombstone after insert.
  _upsertTask(row) {
    const id = row?.id;
    if (!id) return "skip";
    const t = this.tomb.get(id);
    if (!this.restoring && t && t.kind === "task") return "tombstoned";
    const have = this.tasks.get(id);
    if (have) { this.tasks.set(id, { ...clone(row), createdAt: have.createdAt }); return "updated"; }
    this.tasks.set(id, { ...clone(row), createdAt: this.restoring && row.createdAt != null ? row.createdAt : this.now() });
    this.tomb.delete(id);   // sync_tombstone_clear (any kind)
    return "inserted";
  }
  // history upsert: not_tombstoned, then strip (BEFORE INSERT OR UPDATE), insert/update, drop-emptied + item scrub (AFTER UPDATE).
  _upsertHistory(entry) {
    const id = entry?.id;
    if (!id) return "skip";
    const t = this.tomb.get(id);
    if (!this.restoring && t && t.kind === "history") return "tombstoned";
    let items = Array.isArray(entry.tasks) ? clone(entry.tasks) : [];
    const have = this.history.get(id);
    const held = new Set(itemIdsOf(have));
    // v3 (20261024100000, K2): + an item a restore removed that the stored entry does not hold
    const strip = (i) => !!i?.id && (this.userTomb(i.id) || (RULE === "v3" && this.restoreTomb(i.id) && !held.has(i.id)));
    if (!this.restoring && items.some(strip)) {
      const anyUser = items.some(i => i?.id && this.userTomb(i.id));
      items = items.filter(i => !strip(i));
      if (!have && items.length === 0) {
        this.tomb.set(id, { kind: "history", byRestore: !anyUser, at: this.now() });
        if (anyUser) this.recordDelete("history", id, "strip-new-empty");
        else this.restoreRemoved.set(`history:${id}`, this.marker);   // the restore's removal, not a user delete
        return "stripped-empty";
      }
    }
    const row = { ...clone(entry), tasks: items, totalCost: items.reduce((s, i) => s + (i.status === "completed" ? i.cost || 0 : 0), 0) };
    if (have) {
      this.history.set(id, { ...row, createdAt: have.createdAt });
      this._afterHistoryUpdate(have, row);
      return "updated";
    }
    this.history.set(id, { ...row, createdAt: this.restoring && entry.createdAt != null ? entry.createdAt : this.now() });
    this.tomb.delete(id);
    return "inserted";
  }
  _afterHistoryUpdate(old, row) {
    if (this.restoring) return;
    const kept = new Set(itemIdsOf(row));
    const gone = itemIdsOf(old).filter(x => !kept.has(x));
    if (gone.length && !this.autoBackups) this.scrubQ.push({ tasks: gone, logs: [] });   // _history_queue_item_scrub
    if ((row.tasks || []).length === 0 && (old.tasks || []).length > 0) {   // _history_drop_emptied
      this._deleteHistoryRow(row.id);
      this.recordDelete("history", row.id, "emptied");
    }
  }
  // `update history set tasks = tasks` on an existing entry: the strip trigger runs on the stored items.
  _touchHistory(id) {
    const e = this.history.get(id);
    if (!e) return;
    if (!(e.tasks || []).some(i => i?.id && this.userTomb(i.id))) return;
    const items = e.tasks.filter(i => !(i?.id && this.userTomb(i.id)));
    const row = { ...e, tasks: items, totalCost: items.reduce((s, i) => s + (i.status === "completed" ? i.cost || 0 : 0), 0) };
    this.history.set(id, row);
    this._afterHistoryUpdate(e, row);
  }

  // ─── reads (supabase.js pullTasks / pullHistory / pullSettings / pullAllIds / pullAllForPurge) ───
  pullTasks() {
    return [...this.tasks.values()].sort((a, b) => (b.startTime || 0) - (a.startTime || 0)).slice(0, 500)
      .map(({ createdAt, ...t }) => clone(t));
  }
  pullHistory() {
    return [...this.history.values()].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, 1000)
      .map(({ createdAt, ...e }) => clone(e));
  }
  pullSettings() { return this.marker > 0 ? { last_restore_at: this.marker } : {}; }
  pullTaskIds() { return [...this.tasks.keys()]; }
  pullHistoryIds() { return [...this.history.keys()]; }
  pullTaskTombstones() {
    const ids = [], byRestore = [];
    for (const [id, t] of this.tomb) if (t.kind === "task") { ids.push(id); if (t.byRestore) byRestore.push(id); }
    return { ids, byRestore };
  }
  pullHistoryTombstones() { return [...this.tomb].filter(([, t]) => t.kind === "history").map(([id]) => id); }
  pullAllForPurge() {
    const iso = (ms) => new Date(ms).toISOString();
    return {
      tasks: [...this.tasks.values()].map(t => ({ ...clone(t), createdAt: iso(t.createdAt) })),
      history: [...this.history.values()].map(e => ({ ...clone(e), createdAt: iso(e.createdAt) })),
    };
  }
  serverTimeMs() { return this.now(); }

  // ─── writes ───
  syncTasks(rows) { this.counts.uploads++; const out = (rows || []).map(r => [r.id, this._upsertTask(r)]); this.log(`upsert tasks ${out.map(x => x.join("=")).join(",")}`); return { ok: true }; }
  syncHistory(entries) {
    this.counts.uploads++;
    const out = (entries || []).map(e => [`${e.id}[${itemIdsOf(e).join(" ")}]`, this._upsertHistory(e)]);
    this.log(`upsert history ${out.map(x => x.join("=")).join(",")}`);
    return { ok: true };
  }
  _voided(queuedAt) { const v = Math.floor(queuedAt || 0) < this.marker; if (v) this.counts.voided++; return v; }

  // delete_queued_rows (20261023100000:873-935)
  deleteQueuedRows(kind, ids, queuedAt) {
    const list = (ids || []).filter(Boolean);
    if (!list.length) return { ok: true, voided: false, deleted: 0 };
    if (this._voided(queuedAt)) { this.log(`delete_queued_rows ${kind} [${list}] @${queuedAt}: VOIDED (marker ${this.marker})`); return { ok: true, voided: true, deleted: 0 }; }
    let n = 0;
    this.counts.deletes++;
    const before = new Set(list.filter(id => this.present(kind, id)));
    if (kind === "task") {
      for (const id of list) if (this._deleteTaskRow(id)) n++;
      for (const id of list) {
        const t = this.tomb.get(id);
        if (t && t.kind === "task" && t.byRestore) this.tomb.set(id, { kind: "task", byRestore: false, at: this.now() });
      }
      for (const id of list) {
        if (this.tomb.has(id) || this.tasks.has(id)) continue;
        if (RULE !== "v1" || this.liveItem(id)) this.tomb.set(id, { kind: "task", byRestore: false, at: this.now() });   // v2: every named rowless id
      }
      for (const [hid, e] of [...this.history]) if (itemIdsOf(e).some(x => list.includes(x))) this._touchHistory(hid);
    } else {
      for (const id of list) if (this._deleteHistoryRow(id)) n++;
      if (RULE !== "v1") for (const id of list) if (!this.tomb.has(id) && !this.history.has(id)) this.tomb.set(id, { kind: "history", byRestore: false, at: this.now() });
    }
    for (const id of list) this.recordDelete(kind, id, "delete_queued_rows", before.has(id));
    this.log(`delete_queued_rows ${kind} [${list}] @${queuedAt}: deleted ${n}`);
    return { ok: true, voided: false, deleted: n };
  }
  // _clear_kind (20261022310000:18-84)
  _clearKind(kind, upto, ids) {
    const named = new Set((ids || []).filter(Boolean));
    const before = new Set([...named].filter(x => this.present(kind, x)));
    let n = 0;
    if (kind === "task") {
      const gone = [];
      for (const [id, t] of [...this.tasks]) if (t.createdAt <= upto || named.has(id)) { this._deleteTaskRow(id); gone.push(id); }
      n = gone.length;
      const orphans = new Set();
      for (const e of this.history.values()) {
        for (const x of itemIdsOf(e)) if ((e.createdAt <= upto || named.has(x)) && !this.tasks.has(x)) orphans.add(x);
      }
      const itemOrphans = new Set(orphans);   // items of live History entries: present
      if (RULE !== "v1") for (const x of named) if (!this.tasks.has(x)) orphans.add(x);   // v2: named rowless ids too (flip + tombstone)
      for (const o of orphans) {
        const t = this.tomb.get(o);
        if (t && t.kind === "task" && t.byRestore) this.tomb.set(o, { kind: "task", byRestore: false, at: this.now() });
        else if (!t) this.tomb.set(o, { kind: "task", byRestore: false, at: this.now() });
      }
      const set = new Set([...gone, ...orphans]);
      for (const [hid, e] of [...this.history]) {
        const its = itemIdsOf(e);
        if (!its.some(x => set.has(x))) continue;
        if (its.every(x => set.has(x)) && (e.tasks || []).every(i => i?.id)) { this._deleteHistoryRow(hid); this.recordDelete("history", hid, "clear-task-drop"); }
        else this._touchHistory(hid);
      }
      const hit = new Set([...gone, ...itemOrphans]);
      for (const id of new Set([...gone, ...orphans, ...named])) this.recordDelete("task", id, "clear_kind", hit.has(id) || before.has(id));
    } else if (kind === "history") {
      for (const [id, e] of [...this.history]) if (e.createdAt <= upto || named.has(id)) { if (this._deleteHistoryRow(id)) n++; this.recordDelete("history", id, "clear_kind"); }
      if (RULE !== "v1") for (const id of named) if (!this.tomb.has(id) && !this.history.has(id)) this.tomb.set(id, { kind: "history", byRestore: false, at: this.now() });
      for (const id of named) this.recordDelete("history", id, "clear_kind", before.has(id));
    }
    return n;
  }
  // clear_queued_rows (20261023100000:843-871)
  clearQueuedRows(kind, queuedAt, ids) {
    if (this._voided(queuedAt)) { this.log(`clear_queued_rows ${kind} @${queuedAt}: VOIDED (marker ${this.marker})`); return { ok: true, voided: true, deleted: 0 }; }
    this.counts.clears++;
    const n = this._clearKind(kind, Math.floor(queuedAt || 0), ids);
    this.log(`clear_queued_rows ${kind} @${queuedAt} named [${(ids || []).join(",")}]: deleted ${n}`);
    return { ok: true, voided: false, deleted: n };
  }
  // reset_queued_rows (20261023100000:1005-1038): tasks first, then History, one restore check.
  resetQueuedRows(queuedAt, taskIds, historyIds) {
    if (this._voided(queuedAt)) { this.log(`reset_queued_rows @${queuedAt}: VOIDED (marker ${this.marker})`); return { ok: true, voided: true }; }
    this.counts.clears++;
    const t = this._clearKind("task", Math.floor(queuedAt || 0), taskIds);
    const h = this._clearKind("history", Math.floor(queuedAt || 0), historyIds);
    this.log(`reset_queued_rows @${queuedAt}: tasks ${t} history ${h}`);
    return { ok: true, voided: false, deleted: { task: t, history: h, settings: 0, favorites: 0 } };
  }
  // upsert_queued_history (20261023100000:1040-1089)
  upsertQueuedHistory(entries, queuedAt) {
    if (this._voided(queuedAt)) { this.log(`upsert_queued_history @${queuedAt}: VOIDED`); return { ok: true, voided: true, upserted: 0 }; }
    for (const e of entries || []) this._upsertHistory(e);
    this.log(`upsert_queued_history @${queuedAt} [${(entries || []).map(e => e.id)}]`);
    return { ok: true, voided: false, upserted: (entries || []).length };
  }

  // ─── backups ───
  snapshot(type) {
    if (String(type || "").startsWith("pre-") && !this.autoBackups) return { ok: true, skipped: true };
    const id = `bk${this.nextBackup++}`;
    const tasks = [...this.tasks.values()].sort((a, b) => (b.startTime || 0) - (a.startTime || 0)).slice(0, 500).map(clone);
    const history = [...this.history.values()].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, 1000).map(clone);
    this.backups.push({ id, at: this.now(), tasks, history });
    this.counts.backups++;
    this.log(`snapshot ${id}: tasks [${tasks.map(t => t.id)}] history [${history.map(h => `${h.id}(${itemIdsOf(h).join(" ")})`)}]`);
    return { ok: true, id };
  }
  // _drain_backup_scrubs (20261022261000) + _scrub_backups (20261021175100)
  drainScrubs() {
    if (!this.scrubQ.length) return 0;
    const t = new Set(), l = new Set();
    for (const q of this.scrubQ.splice(0)) { for (const x of q.tasks || []) t.add(x); for (const x of q.logs || []) l.add(x); }
    const vt = [...t].filter(x => !this.tasks.has(x) && !(this.liveItem(x) && !this.userTomb(x)));
    const vl = [...l].filter(x => !this.history.has(x));
    const st = new Set(vt), sl = new Set(vl);
    for (const b of this.backups) {
      b.tasks = b.tasks.filter(x => !st.has(x.id));
      const hs = [];
      for (const e of b.history) {
        if (sl.has(e.id)) continue;
        const items = Array.isArray(e.tasks) ? e.tasks : [];
        const kept = items.filter(i => !(i?.id && st.has(i.id)));
        if (items.length > 0 && kept.length === 0) continue;   // emptied: dropped from the snapshot
        hs.push(kept.length === items.length ? e : { ...e, tasks: kept });
      }
      b.history = hs;
    }
    if (vt.length || vl.length) this.log(`scrub backups: tasks [${vt}] logs [${vl}]`);
    return vt.length + vl.length;
  }
  backupContains(b, kind, id) {
    if (kind === "history") return b.history.some(e => e.id === id);
    return b.tasks.some(t => t.id === id) || b.history.some(e => itemIdsOf(e).includes(id));
  }
  // restore_my_backup_phase2 (20261023100000:1157-1258)
  restore(backupId) {
    this.drainScrubs();
    if (this.scrubQ.length) return { ok: false, reason: "scrubs pending" };
    const b = this.backups.find(x => x.id === backupId);
    if (!b) return { ok: false, reason: "backup_not_found" };
    const txnNow = this.now();
    const beforeTasks = new Set(this.tasks.keys()), beforeLogs = new Set(this.history.keys());
    this.restoring = true;
    for (const id of [...this.tasks.keys()]) this._deleteTaskRow(id);
    const prevItems = new Set([...this.history.values()].flatMap(itemIdsOf));
    for (const id of [...this.history.keys()]) this._deleteHistoryRow(id);
    for (const t of b.tasks) this._upsertTask(t);
    for (const e of b.history) this._upsertHistory(e);
    const restoredItems = new Set([...this.history.values()].flatMap(itemIdsOf));
    for (const [id, t] of this.tomb) if (t.kind === "task" && !t.byRestore && restoredItems.has(id)) this.tomb.set(id, { ...t, byRestore: true });
    this.restoring = false;
    this.marker = this.now();
    if (!this.autoBackups) {
      const rt = [...this.tomb].filter(([id, t]) => t.kind === "task" && t.byRestore && t.at === txnNow && !this.tasks.has(id)).map(([id]) => id);
      for (const x of prevItems) if (!this.tasks.has(x) && !rt.includes(x)) rt.push(x);
      const rl = [...this.tomb].filter(([id, t]) => t.kind === "history" && t.byRestore && t.at === txnNow && !this.history.has(id)).map(([id]) => id);
      if (rt.length || rl.length) { this.scrubQ.push({ tasks: rt, logs: rl }); this.drainScrubs(); }
    }
    this.clock.now += 1;
    this.marker = this.now();   // "The clock at the restore's end"
    // ledger: what this restore brought back legitimises a reappearance after an earlier delete; what it removed is gone
    // by the restore's decision.
    for (const [key, rec] of this.delRec) {
      const [kind, ...rest] = key.split(":"); const id = rest.join(":");
      if (rec.at < this.marker && this.backupContains(b, kind, id)) rec.legit = true;
    }
    for (const id of beforeTasks) if (!this.present("task", id)) this.restoreRemoved.set(`task:${id}`, this.marker);
    for (const id of prevItems) if (!this.present("task", id)) this.restoreRemoved.set(`task:${id}`, this.marker);
    for (const id of beforeLogs) if (!this.history.has(id)) this.restoreRemoved.set(`history:${id}`, this.marker);
    this.restores.push({ at: this.marker, backupId, backupAt: b.at, b: JSON.parse(JSON.stringify(b)) });
    this.counts.restores++;
    this.log(`RESTORE ${backupId} (taken ${b.at}): marker ${this.marker}; tasks [${[...this.tasks.keys()]}] history [${[...this.history.values()].map(h => `${h.id}(${itemIdsOf(h).join(" ")})`)}]`);
    return { ok: true, tasks_restored: b.tasks.length, history_restored: b.history.length };
  }

  // A compact picture of the cloud for traces.
  describe() {
    const tomb = [...this.tomb].map(([id, t]) => `${id}${t.byRestore ? "(r)" : ""}`).join(",");
    return `tasks [${[...this.tasks.keys()].join(",")}] history [${[...this.history.values()].map(h => `${h.id}(${itemIdsOf(h).join(" ")})`).join(",")}] tomb [${tomb}] marker ${this.marker}`;
  }
}
export { itemIdsOf, clone };
