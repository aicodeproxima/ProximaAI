// The deterministic, seeded simulator of the client's delete / restore / sync behaviour (task: replace guesswork in the
// review loop with a mechanical search). Two tabs of one browser (A1, A2: shared localStorage + IndexedDB, own pages)
// and a second device (B1, its own browser), all running the mirrored App.jsx flows (app.mjs) on the REAL src/lib
// modules, against the fake server (server.mjs) through a network whose every message the scheduler controls (net.mjs).
//
// A run is a LIST OF OPERATIONS (genOps): each op is data ({ op, tab, r, dt }), resolved against the state when it runs
// (which task to delete, which message to deliver: by its own random number `r`), so any sub-list is a valid run: the
// shrinker (shrink.mjs) delta-debugs the list. After every op the invariants that can be checked at any time are
// checked; after the last op the run QUIESCES (every tab thawed, every message delivered, several rounds of
// forceSaveAll + reconcile in every tab) and the rest are checked.
//
// INVARIANTS (precisely):
//  I1 (checked after every op and at the end): for every id the server has a USER-DELETE record of (a delete / clear /
//     reset call that was not voided removed its row, tombstoned it, or named it; or the server dropped a History entry
//     an update emptied), the id is not present in the cloud (task: a tasks row or an item of a History entry; History: an
//     entry) unless a restore that ran AFTER that delete restored a backup containing the id. (A record names the call
//     that made it; "named" covers the rowless-id gap: a delete the server answered "deleted" although it had no row.)
//     A CLIENT confirm (any confirmIntents call: an answer, a clear settled by the cloud's ids, Clear Outputs' cloud-only
//     History-only ids) records the id too, at its group's queue time, unless the server recorded a later delete.
//     Reported twice: "I1" the moment the id reappears (transient: the run goes on), "I1-end" if it is still in the
//     cloud after quiescence (the damage stayed).
//  I2 (at the end): an id that was ever created (a generation or its History entry) and that no user delete and no
//     restore removed is not lost: it is present in the cloud after quiescence. A generation whose last copy was an item
//     of a History entry the user deleted (its row gone: deleted, or removed by a restore that kept its entry) went with
//     that entry: accounted for. (Its local copies equal the cloud's by
//     I4.) A loss whose only delete attempts were bulk deletes voided by a restore is reported as I2-info (the bulk
//     delete's voided branch does not put local-only items back, by design: App.jsx 3666-3679 at a79a43c).
//  I3 (at every upload): no page uploads an id its browser holds as confirmed-final (storage.js confirmStates final):
//     not as a task row, not as a History entry, not as an item of an uploaded entry. Checked when the request is sent.
//  I4 (at the end): after quiescence every live page's tasks equal the cloud's tasks rows (by id) and its History equals
//     the cloud's History (entry ids, and each entry's item ids).
//  I5 (at the end): every delete the user asked for (bulk delete, History delete, Clear Logs, Clear Outputs' named ids,
//     Reset, and the History delete of an entry a delete emptied), recorded at its queue time once its intents are
//     queued, took effect: the id is absent from the cloud after quiescence, unless a restore ran after that queue time
//     (the restore wins: CLAUDE.md "A restore wins over every delete queued before it").
//  I6 (task B12c; at each external delete and at the end): a generation that is ALIVE never has its files or its
//     WaveSpeed result deleted. At the delete: "alive" = the cloud holds it (a tasks row or an item of a History entry)
//     and no user delete removed it (no server delete record, or one a later restore legitimised). At the end (after
//     quiescence): "alive" = the cloud, any live page's state (tasks or History items) or any browser's IndexedDB holds
//     it; every file / prediction deleted during the run whose generation is alive then is reported ("I6-end").
//  I7 (task B12c; at the end): a generation GONE FOR GOOD by a user delete (the server's delete record stands, no restore
//     legitimised it or removed it after, and nothing holds it any more: cloud, pages, IndexedDB) has its WaveSpeed
//     result and every file only gone-for-good generations use either deleted or queued (a browser's
//     proximaai-ws-deletes / proximaai-file-deletes), after quiescence (several flushes and restore-aware passes). Still
//     held (proximaai-held-purges-v3, or an older key) or nowhere is reported. "I7-info": a generation whose only delete attempts were
//     voided or dropped by a restore that then removed it (by_restore): its files stay by design (App.jsx 2382-2385: "a
//     restore never deletes files, so neither does this").
//  CRASH: a mirrored flow threw (a real code path that throws, or a mirror bug) - investigated like a violation.
//  LIVELOCK: quiescence did not finish within its bound.
import { FakeServer } from "./server.mjs";
import { Net } from "./net.mjs";
import { Browser, CURRENT, installGlobals } from "./browser.mjs";
import { Page } from "./app.mjs";

export const SLOTS = ["A1", "A2", "B1"];
const BROWSER_OF = { A1: "A", A2: "A", B1: "B" };

// ─── seeded randomness ───
export function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const OPS = [
  ["gen", 9], ["finish", 7], ["bulkDel", 5], ["logDel", 3], ["clearOutputs", 1.2], ["reset", 0.8], ["clearLogs", 1.2],
  ["reconcile", 8], ["save", 4], ["timer", 6], ["reload", 2], ["freeze", 1.2], ["thaw", 2],
  ["deliver", 22], ["netAll", 5], ["exec", 4], ["answer", 4], ["lose", 2.5], ["fail", 2.5],
  ["backup", 2], ["restore", 1.2], ["drain", 1], ["pause", 0.15],
];
const TOTAL = OPS.reduce((s, [, w]) => s + w, 0);
export function genOps(seed, steps) {
  const rand = rng(seed * 2654435761 + 12345);
  const out = [];
  for (let i = 0; i < steps; i++) {
    let x = rand() * TOTAL, op = OPS[0][0];
    for (const [name, w] of OPS) { if ((x -= w) < 0) { op = name; break; } }
    out.push({ op, tab: SLOTS[Math.floor(rand() * SLOTS.length)], r: Math.floor(rand() * 2 ** 32), dt: 50 + Math.floor(rand() * 2950) });
  }
  return out;
}
// The signature of a violation: its code and the shape of its message (ids, times and page generations removed).
export const signature = (v) => `${v.code} ${v.msg.replace(/\(created by [AB]\d#\d+\)/, "").replace(/\b[tL]\d+\b/g, "X").replace(/\d{6,}/g, "T").replace(/#\d+/g, "").replace(/\[[^\]]*\]/g, "[..]")}`;
export const fmtOp = (o) => `${o.op}${["deliver", "netAll", "exec", "answer", "lose", "fail", "backup", "drain", "pause"].includes(o.op) ? "" : " " + o.tab}${["deliver", "exec", "answer", "lose", "fail", "bulkDel", "logDel", "restore"].includes(o.op) ? ` r=${o.r % 1000}` : ""}`;

const drain = () => new Promise(r => setImmediate(r));
// Network modes (which sent requests the server may run next):
//   "fifo"   - each page's requests in the order it sent them; pages interleave freely (default);
//   "window" - the global send order, a request overtaken by at most 2 later ones (a near-ordered network: one HTTP/2
//              connection per browser, similar latencies) - violations found here are the realistic ones;
//   "any"    - any order (a request can be held arbitrarily long behind later ones of its own page).
// In every mode a frozen page's sent requests still reach the server (the browser's network service sends them); only
// its answers wait for the thaw.
export const NET_MODES = ["fifo", "window", "any"];
const READS = /^(pull|ids |tombstones|get_|server_time|snapshot)/;
const RUN_BASE = { n: 0 };
// A rejection nobody handles inside a mirrored flow (e.g. a .then callback that throws) is a CRASH of the running sim.
let ACTIVE = null;
process.on("unhandledRejection", (e) => { if (ACTIVE) ACTIVE.violate("CRASH", `unhandled rejection: ${e?.stack?.split("\n").slice(0, 3).join(" | ") || e}`); else throw e; });

export class Sim {
  constructor({ net = "fifo", traceOn = false } = {}) {
    if (!NET_MODES.includes(net)) throw new Error(`unknown network mode ${net}`);
    this.netMode = net; this.traceOn = traceOn;
    this.clock = { now: 1_800_000_000_000 + (RUN_BASE.n++) * 10_000_000_000 };   // above every earlier run (browser.mjs POOL)
    this.server = new FakeServer(this.clock);
    this.net = new Net(this);
    this.browsers = { A: new Browser("A"), B: new Browser("B") };
    this.pages = {};
    this.gens = { A1: 0, A2: 0, B1: 0 };
    this.ids = 0;
    this.violations = [];
    this.lines = [];
    this.step = -1;
    this.created = new Map();   // "task:t1" / "history:L1" -> creating page label
    this.actions = new Map();   // key -> [what...]
    this.reloads = [];
    this.seenI1 = new Set();
    this.requests = new Map();  // "task:t1" -> [{ what, at }]: deletes the user asked for (I5)
    this.extDeletes = [];       // { what: "file" | "ws", key, gens, step } (I6, I7)
    this.server.onExternalDelete = (what, key, gens) => this.onExternalDelete(what, key, gens);
  }
  // ─── I6 at the delete ───
  standingUserDelete(id) { const r = this.server.delRec.get(`task:${id}`); return !!r && !r.legit; }
  onExternalDelete(what, key, gens) {
    this.extDeletes.push({ what, key, gens, step: this.step });
    const alive = gens.filter(g => this.server.present("task", g) && !this.standingUserDelete(g));
    if (alive.length) this.violate("I6", `${what === "ws" ? "WaveSpeed result" : "file"} of [${alive}] deleted while the cloud holds ${alive.length > 1 ? "them" : "it"} and no user delete removed ${alive.length > 1 ? "them" : "it"}`);
  }
  // Where a generation is alive at the end: "cloud", "page A1#0", "IndexedDB A", or null.
  aliveWhere(id) {
    if (this.server.present("task", id)) return "cloud";
    for (const s of SLOTS) {
      const p = this.pages[s];
      if (p.st.tasks.some(t => t.id === id) || p.st.logs.some(l => (l.tasks || []).some(i => i?.id === id))) return `page ${p.label}`;
    }
    // A copy only in IndexedDB (no page shows it) of a generation the cloud lacks and holds a task tombstone of (a user's or
    // a restore's) is a leftover the next load removes (syncReconcile.js planTaskSync: tombstoned and absent), not a kept
    // generation: e.g. a voided Reset's stored-only give-back (App.jsx 5806) of a generation another device deleted for
    // good, or a restore removed, before that Reset's void.
    const tomb = this.server.tomb.get(id);
    if (this.standingUserDelete(id) || (tomb && tomb.kind === "task")) return null;
    for (const b of Object.values(this.browsers)) {
      if (b.idb.tasks.has(id) || [...b.idb.history.values()].some(l => (l.tasks || []).some(i => i?.id === id))) return `IndexedDB ${b.name}`;
    }
    return null;
  }
  // I6-end and I7 (after quiescence).
  checkFiles() {
    const srv = this.server;
    const reported = new Set();
    for (const d of this.extDeletes) {
      const where = d.gens.map(g => [g, this.aliveWhere(g)]).filter(([, w]) => w);
      const k = `${d.what}:${d.key}`;
      if (!where.length || reported.has(k)) continue;
      reported.add(k);
      this.violate("I6-end", `${d.what === "ws" ? "WaveSpeed result" : "file"} of [${where.map(([g]) => g)}] deleted but the generation is alive after quiescence (${[...new Set(where.map(([, w]) => w.replace(/#\d+/, "")))].join(", ")})`);
    }
    // Queues and holds across both browsers.
    const queued = { ws: new Set(), file: new Set() }, held = { ws: new Set(), file: new Set() };
    for (const b of Object.values(this.browsers)) {
      const js = (k) => { try { return JSON.parse(b.ls.getItem(k) || "{}") || {}; } catch { return {}; } };
      for (const p of Object.keys(js("proximaai-ws-deletes"))) queued.ws.add(p);
      for (const p of Object.keys(js("proximaai-file-deletes"))) queued.file.add(p);
      for (const key of ["proximaai-held-purges-v3", "proximaai-held-purges-v2", "proximaai-held-purges"]) for (const g of Object.values(js(key))) {
        for (const p of Object.keys(g?.files || {})) held.file.add(p);
        for (const p of Object.keys(g?.ws || {})) held.ws.add(p);
      }
    }
    const goneForGood = new Map();   // id -> "user" | "restore"
    for (const key of this.created.keys()) {
      if (!key.startsWith("task:")) continue;
      const id = key.slice(5);
      if (this.aliveWhere(id)) continue;
      const rec = srv.delRec.get(key), rr = srv.restoreRemoved.get(key);
      // A user delete that only NAMED an id a restore had already removed (the cloud lost it first: wasPresent false) leaves
      // the restore as its end.
      const restoreFirst = rr != null && rec && rec.wasPresent === false && rr <= rec.at;
      if (rec && !rec.legit && !(rr != null && rr > rec.at) && !restoreFirst) goneForGood.set(id, "user");
      else if (rr != null && (this.actions.get(key) || []).length) goneForGood.set(id, "restore");
    }
    const fate = (kind, k, deleted) => deleted ? null : queued[kind].has(k) ? null : held[kind].has(k) ? "still held" : "neither queued nor held";
    for (const [pid, e] of srv.preds) {
      const how = goneForGood.get(e.tid);
      if (!how) continue;
      const f = fate("ws", pid, !!e.deleted);
      if (!f) continue;
      if (how === "user") this.violate("I7", `the WaveSpeed result of ${e.tid}, deleted for good by the user, is ${f} after quiescence (delete attempts here: [${(this.actions.get(`task:${e.tid}`) || []).join(", ")}])`);
      else this.violate("I7-info", `the WaveSpeed result of ${e.tid} stays: a restore removed it (by_restore) while its delete was undecided, voided or not yet sent; ${f}`);
    }
    for (const [path, f0] of srv.files) {
      if (!f0.gens.length) continue;
      const hows = f0.gens.map(g => goneForGood.get(g));
      if (hows.some(h => !h)) continue;
      const f = fate("file", path, !!f0.deleted);
      if (!f) continue;
      const kind = path.startsWith("uploads/") ? "upload" : "archived output";
      if (hows.every(h => h === "user")) this.violate("I7", `the ${kind} file of [${f0.gens}], deleted for good by the user, is ${f} after quiescence`);
      else this.violate("I7-info", `the ${kind} file of [${f0.gens}] stays: a restore removed ${f0.gens.length > 1 ? "one of them" : "it"} (by_restore) while its delete was undecided, voided or not yet sent; ${f}`);
    }
  }
  newId(prefix) { return `${prefix}${++this.ids}`; }
  trace(s) { if (this.traceOn) this.lines.push(s); }
  violate(code, msg) {
    this.violations.push({ code, msg, step: this.step });
    this.trace(`  !! ${code}: ${msg}`);
  }
  flowError(page, where, e) { this.violate("CRASH", `${page.label} ${where}: ${e?.stack?.split("\n").slice(0, 3).join(" | ") || e}`); }
  noteAction(page, what, kind, list) {
    this.trace(`  ${page.label} ${what} ${kind} [${list}]`);
    for (const id of list || []) { const k = `${kind}:${id}`; if (!this.actions.has(k)) this.actions.set(k, []); this.actions.get(k).push(what); }
  }
  requestReload(page) { this.reloads.push(page.slot); }
  // A delete the user asked for, at its queue time (I5).
  noteRequest(what, kind, list, at) {
    for (const id of list || []) if (id) { const k = `${kind}:${id}`; if (!this.requests.has(k)) this.requests.set(k, []); this.requests.get(k).push({ what, at: Number(at) }); }
  }
  noteConfirm(page, kind, list, at) { if (Number.isFinite(Number(at))) this.server.recordConfirm(kind, list, Number(at)); }

  async init() {
    installGlobals();
    for (const slot of SLOTS) await this.newPage(slot);
  }
  async newPage(slot) {
    const b = this.browsers[BROWSER_OF[slot]];
    const old = this.pages[slot];
    if (old) { old.alive = false; old.macros = []; }
    const gen = this.gens[slot]++;
    const S = await b.newStorageInstance(slot, gen);
    const page = new Page(this, b, slot, S, gen);
    CURRENT.browser = b;
    page.loadLocal();
    this.pages[slot] = page;
    await this.run(page, () => page.bootstrap());
    return page;
  }
  // Runs `fn` as code of `page`, then lets the page settle: microtasks drained, renders, effects, IndexedDB continuations.
  async run(page, fn) {
    CURRENT.browser = page.b;
    let p;
    try { p = fn?.(); } catch (e) { this.flowError(page, "sync", e); }
    if (p && typeof p.then === "function") p.then(undefined, e => this.flowError(page, "async", e));
    await this.settle(page);
  }
  async settle(page) {
    for (let i = 0; i < 2000; i++) {
      CURRENT.browser = page.b;
      await drain();
      if (!page.alive) return;
      CURRENT.browser = page.b;
      const changed = page.render();
      if (changed) { page.runEffects(); continue; }
      if (page.macros.length) { page.macros.shift()(); continue; }
      return;
    }
    this.violate("LIVELOCK", `${page.label} did not settle`);
  }

  // ─── network ───
  executable() {
    const list = this.net.pending.filter(m => m.state === "sent");
    if (this.netMode === "any") return list;
    if (this.netMode === "window") return list.slice(0, 3);
    // per-page FIFO: a page's requests reach the server in the order it sent them
    const first = new Map();
    for (const m of list) if (!first.has(m.page)) first.set(m.page, m);
    return [...first.values()];
  }
  async answer(m, opts) {
    const page = this.net.answer(m, opts);
    if (page) await this.settle(page);
  }
  async deliverOne(m) {
    this.net.execute(m);
    if (!m.page.alive) { this.net.remove(m); return; }
    if (m.page.frozen) return;   // the answer waits for the thaw
    await this.answer(m);
  }
  async deliverAll(bound = 5000) {
    for (let i = 0; i < bound; i++) {
      const held = this.net.pending.find(m => m.state === "executed" && (!m.page.alive || !m.page.frozen));
      if (held) { if (!held.page.alive) this.net.remove(held); else await this.answer(held); continue; }
      const m = this.executable()[0];
      if (!m) return true;
      await this.deliverOne(m);
    }
    this.violate("LIVELOCK", "network did not drain");
    return false;
  }

  // ─── one operation ───
  async exec(o) {
    this.clock.now += o.dt;
    const R = rng(o.r);
    const page = this.pages[o.tab];
    const usable = page && page.alive && !page.frozen;
    this.trace(`#${this.step} ${fmtOp(o)}`);
    switch (o.op) {
      case "gen": if (usable) await this.run(page, () => page.generate(1 + (o.r % 2), ([batch, ...tids]) => {
        this.created.set(`history:${batch}`, { who: page.label, items: tids });
        for (const id of tids) this.created.set(`task:${id}`, { who: page.label });
      })); break;
      case "bulkDel": if (usable) {
        const c = page.st.tasks.filter(t => t.status === "completed" || t.status === "failed").map(t => t.id); if (!c.length) break;   // the toolbar selects finished ones (App.jsx 3972)
        const pick = c.filter(() => R() < 0.5); if (!pick.length) pick.push(c[Math.floor(R() * c.length)]);
        await this.run(page, () => page.deleteSelectedTasks(pick));
      } break;
      case "logDel": if (usable) {
        const c = page.st.logs.map(l => l.id); if (!c.length) break;
        const pick = c.filter(() => R() < 0.5); if (!pick.length) pick.push(c[Math.floor(R() * c.length)]);
        await this.run(page, () => page.deleteSelectedLogs(pick));
      } break;
      case "finish": if (usable) await this.run(page, () => page.finish()); break;
      case "clearOutputs": if (usable) await this.run(page, () => page.clearOutputs()); break;
      case "reset": if (usable) await this.run(page, () => page.resetEverything()); break;
      case "clearLogs": if (usable) await this.run(page, () => page.clearLogs()); break;
      case "reconcile": if (usable) await this.run(page, () => page.reconcile()); break;
      case "save": if (usable) await this.run(page, () => page.forceSaveAll()); break;
      case "timer": if (usable) await this.run(page, () => page.fireTimer()); break;
      case "reload": await this.newPage(o.tab); break;
      case "freeze": if (page) page.frozen = true; break;
      case "thaw": if (page && page.frozen) { page.frozen = false; } break;
      case "backup": { const p = this.pages[SLOTS[o.r % SLOTS.length]]; if (p.alive && !p.frozen) await this.run(p, () => p.manualBackup()); } break;
      case "restore": {
        const p = this.pages.B1, bks = this.server.backups;
        if (p.alive && !p.frozen && bks.length) await this.run(p, () => p.restoreFrom(bks[o.r % bks.length].id));
      } break;
      case "drain": this.server.drainScrubs(); break;
      case "pause": this.clock.now += 31 * 60 * 1000; break;
      case "netAll": await this.deliverAll(400); break;
      default: {   // deliver / exec / answer / lose / fail
        if (o.op === "answer") {
          const held = this.net.pending.filter(m => m.state === "executed" && (!m.page.alive || !m.page.frozen));
          if (!held.length) break;
          const m = held[o.r % held.length];
          if (!m.page.alive) this.net.remove(m); else await this.answer(m);
          break;
        }
        const all = this.executable();
        if (!all.length) break;
        // Bias (search power): exec / lose / fail pick a WRITE (upload, delete, clear, restore) 3 times in 4 when one is
        // executable; reads are most of the traffic, and a lost read rarely matters.
        const writes = all.filter(x => !READS.test(x.name));
        const list = o.op !== "deliver" && writes.length && (o.r >>> 20) % 4 !== 0 ? writes : all;
        const m = list[o.r % list.length];
        if (o.op === "deliver") await this.deliverOne(m);
        else if (o.op === "exec") this.net.execute(m);
        else if (o.op === "lose" || o.op === "fail") {
          // lose: the server ran it, the answer is lost; fail: it never reached the server. Either way the page sees a
          // network error (a frozen page when it thaws; a dead page never).
          if (o.op === "lose") { this.net.execute(m); this.trace(`  (answer lost)`); }
          else { m.state = "executed"; this.trace(`  request ${m.page.label}:${m.name} failed`); }
          m.answerError = true;
          if (!m.page.alive) this.net.remove(m); else if (!m.page.frozen) await this.answer(m);
        }
      }
    }
    while (this.reloads.length) await this.newPage(this.reloads.shift());
    this.checkI1();
  }

  // ─── invariants ───
  checkI1() {
    for (const [key, rec] of this.server.delRec) {
      if (rec.legit || this.seenI1.has(key)) continue;
      const i = key.indexOf(":"), kind = key.slice(0, i), id = key.slice(i + 1);
      if (this.server.present(kind, id)) {
        this.seenI1.add(key);
        this.violate("I1", `${kind} ${id} is back in the cloud after the server's user delete at ${rec.at} (${rec.via}); no restore since brought it back`);
      }
    }
  }
  async quiesce() {
    for (const s of SLOTS) this.pages[s].frozen = false;
    for (let round = 0; round < 4; round++) {
      this.clock.now += 61_000;
      await this.deliverAll();
      for (const s of SLOTS) { const p = this.pages[s]; await this.run(p, () => p.fireTimer()); }
      await this.deliverAll();
      for (const s of SLOTS) { const p = this.pages[s]; await this.run(p, () => p.forceSaveAll()); await this.deliverAll(); }
      for (const s of SLOTS) { const p = this.pages[s]; await this.run(p, () => p.reconcile()); await this.deliverAll(); }
      while (this.reloads.length) { await this.newPage(this.reloads.shift()); await this.deliverAll(); }
      this.checkI1();
    }
  }
  // I4: every live page's tasks and History equal the cloud's. Returns the differences.
  diffI4() {
    const srv = this.server, out = [];
    const cloudTasks = [...srv.tasks.keys()].sort();
    const cloudLogs = new Map([...srv.history.values()].map(e => [e.id, (e.tasks || []).map(i => i.id).join(" ")]));
    for (const s of SLOTS) {
      const p = this.pages[s];
      const t = p.st.tasks.map(x => x.id).sort();
      if (t.join(",") !== cloudTasks.join(",")) {
        const extra = t.filter(x => !srv.tasks.has(x)), missing = cloudTasks.filter(x => !t.includes(x));
        out.push(`${p.label} tasks differ from the cloud's: extra [${extra}] missing [${missing}]`);
      }
      const logs = new Map(p.st.logs.map(l => [l.id, (l.tasks || []).map(i => i.id).join(" ")]));
      const diffs = [];
      for (const [id, items] of logs) if (!cloudLogs.has(id)) diffs.push(`extra ${id}(${items})`); else if (cloudLogs.get(id) !== items) diffs.push(`${id}: here (${items}) cloud (${cloudLogs.get(id)})`);
      for (const [id, items] of cloudLogs) if (!logs.has(id)) diffs.push(`missing ${id}(${items})`);
      if (diffs.length) out.push(`${p.label} History differs from the cloud's: ${diffs.join("; ")}`);
    }
    return out;
  }
  checkEnd() {
    const srv = this.server;
    this.checkFiles();
    for (const d of this.diffI4()) this.violate("I4", d);
    // I1-end: a user-deleted id still in the cloud after quiescence (the damage stayed).
    for (const [key, rec] of srv.delRec) {
      if (rec.legit) continue;
      const i = key.indexOf(":"), kind = key.slice(0, i), id = key.slice(i + 1);
      if (srv.present(kind, id)) this.violate("I1-end", `${kind} ${id} is still in the cloud after quiescence although the server deleted it at ${rec.at} (${rec.via}); no restore since brought it back`);
    }
    // I5: every delete the user asked for that no restore voided took effect: absent from the cloud after quiescence.
    for (const [key, reqs] of this.requests) {
      const i = key.indexOf(":"), kind = key.slice(0, i), id = key.slice(i + 1);
      if (!srv.present(kind, id)) continue;
      const standing = reqs.filter(r => !srv.restores.some(x => x.at > r.at));
      if (standing.length) this.violate("I5", `${kind} ${id} is still in the cloud after quiescence although the user deleted it (${standing.map(r => r.what).join(", ")}) and no restore came after`);
    }
    const accounted = (key) => srv.delRec.has(key) || srv.restoreRemoved.has(key) || srv.itemDropped.has(key);
    const tried = (key) => this.actions.get(key) || [];
    // Only plain deletes (bulk delete / History delete) attempted: their voided branch puts nothing local back (App.jsx
    // 3666-3679, 3808-3813: "the next pass adopts the cloud's copies"), so a local-only item the user deleted and a
    // restore voided is gone with the user's intent: I2-info, not I2. A clear voided by a restore gives everything back.
    const plainOnly = (key) => tried(key).length > 0 && tried(key).every(w => w === "bulk delete" || w === "History delete");
    for (const [key, { who, items }] of this.created) {
      if (accounted(key)) continue;
      const i = key.indexOf(":"), kind = key.slice(0, i), id = key.slice(i + 1);
      if (srv.present(kind, id)) continue;
      // A History entry every generation of which was deleted goes with them (purgeLogsForDeleted), even if the server
      // never held it (an entry this device had not uploaded yet).
      if (items && items.every(x => accounted(`task:${x}`))) continue;
      const info = plainOnly(key) || (items && items.every(x => accounted(`task:${x}`) || plainOnly(`task:${x}`)));
      const t = tried(key);
      this.violate(info ? "I2-info" : "I2", `${kind} ${id} (created by ${who}) is lost: never deleted by the server, not removed by a restore, absent from the cloud after quiescence${t.length ? `; delete attempts: ${t.join(", ")}` : ""}${items ? `; items [${items}]` : ""}`);
    }
  }
}

// The codes that end a run at once (with stopOnViolation): the rest are found at the end or do not stop (I1 is the
// transient reappearance; whether it stays is I1-end, checked after quiescence).
const STOPS = new Set(["I3", "CRASH", "LIVELOCK"]);
// Runs one operation list. Returns { violations, lines, server, stats }.
export async function runOps(ops, { net = "fifo", traceOn = false, quiesce = true, seedRandom = 1, stopOnViolation = true } = {}) {
  const realNow = Date.now, realRandom = Math.random;
  const sim = new Sim({ net, traceOn });
  ACTIVE = sim;
  Date.now = () => sim.clock.now;
  Math.random = rng(seedRandom);
  try {
    await sim.init();
    for (let i = 0; i < ops.length; i++) {
      sim.step = i;
      await sim.exec(ops[i]);
      if (stopOnViolation && sim.violations.some(v => STOPS.has(v.code))) break;
    }
    if (quiesce && (!stopOnViolation || !sim.violations.some(v => STOPS.has(v.code)))) {
      sim.step = ops.length;
      sim.trace(`# quiesce`);
      await sim.quiesce();
      sim.checkEnd();
      // An I4 difference: does it heal once 31 more minutes pass (the 30-minute hold of a delete call in flight, storage.js
      // FLIGHT_FOR_MS, lapses) and the tabs sync again? Said in the message (and so in the signature).
      const i4 = sim.violations.filter(v => v.code === "I4");
      if (i4.length) {
        sim.trace("# 31 minutes later");
        sim.clock.now += 31 * 60 * 1000;
        await sim.quiesce();
        const healed = sim.diffI4().length === 0;
        for (const v of i4) v.msg += healed ? " {heals after 31 min: a dead page's delete call held it}" : " {persists after 31 more minutes}";
      }
    }
    if (traceOn) {
      sim.lines.push(`# cloud at the end: ${sim.server.describe()}`);
      for (const s of SLOTS) { const p = sim.pages[s]; sim.lines.push(`# ${p.label}: tasks [${p.st.tasks.map(t => t.id)}] History [${p.st.logs.map(l => `${l.id}(${(l.tasks || []).map(i => i.id).join(" ")})`)}]`); }
    }
    return { violations: sim.violations, lines: sim.lines, server: sim.server, sim, stats: { messages: sim.net.seq, ids: sim.ids, reloads: Object.values(sim.gens).reduce((a, b) => a + b, 0) - SLOTS.length, ...sim.server.counts } };
  } finally {
    Date.now = realNow; Math.random = realRandom;
    CURRENT.browser = null; ACTIVE = null;
  }
}
