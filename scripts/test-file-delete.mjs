// Tests for src/lib/fileDelete.js — the durable queue that deletes the files of deleted generations (review #5,
// 2026-10-22): queued before any network call, settled only on a confirmed delete (or a HEAD 400/404), a path a kept
// generation uses again leaves unsent, and nothing is acted on before the load and the first cloud sync.
// Run: node scripts/test-file-delete.mjs
import assert from "node:assert/strict";
import { queueFileDeletes, dueFileDeletes, headOutcome, settleFileDelete, fileFlushReady, pendingOf, purgeNote, headStatus, FILE_DELETE_CHUNK,
  classifyPath, liveFormPaths, heldOf, formPublishDue, FORM_CLOUD_HEARTBEAT_MS, FORM_HOLD_ALIVE_MS } from "../src/lib/fileDelete.js";

let n = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", String(e?.message || e).split("\n").filter(Boolean).slice(0, 4).join(" | ")); }
};

await test("queueing adds valid paths due now; re-queueing only pulls an entry earlier", () => {
  const q = queueFileDeletes({}, ["a", "b", "", null], 1000);
  assert.deepEqual(q, { a: { at: 1000, attempts: 0, next: 1000 }, b: { at: 1000, attempts: 0, next: 1000 } });
  assert.deepEqual(queueFileDeletes(q, ["a"], 500).a, { at: 1000, attempts: 0, next: 500 });
  assert.equal(queueFileDeletes(q, ["a"], 5000).a.next, 1000, "never pushed later");
});

await test("only due entries are taken, at most one chunk", () => {
  assert.deepEqual(dueFileDeletes({ a: { next: 2000 } }, 1999), []);
  assert.deepEqual(dueFileDeletes({ a: { next: 2000 } }, 2000), ["a"]);
  const many = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`p${i}`, { next: 0 }]));
  assert.equal(dueFileDeletes(many, 1).length, FILE_DELETE_CHUNK);
  assert.equal(FILE_DELETE_CHUNK, 50);
});

await test("a HEAD of the public URL: 400/404 gone, 2xx present, anything else unknown", () => {
  for (const s of [400, 404]) assert.equal(headOutcome(s), "gone");
  for (const s of [200, 204]) assert.equal(headOutcome(s), "present");
  for (const s of [0, 500]) assert.equal(headOutcome(s), "unknown");
});

await test("settling: deleted / gone leave; owned waits a minute (48 h at most); present / unknown back off and are never dropped", () => {
  const q = { a: { at: 0, attempts: 0, next: 0 } };
  for (const o of ["deleted", "gone"]) assert.deepEqual(settleFileDelete(q, "a", o, 10), {});
  // Review wf_ec400a67-988 #5: a stale view may think a deleted generation still owns the path; checked again later.
  assert.deepEqual(settleFileDelete(q, "a", "owned", 10).a, { at: 0, attempts: 0, next: 10 + 60_000 });
  assert.deepEqual(settleFileDelete(q, "a", "owned", 49 * 3600_000), {}, "owned for over 48 h: its own delete re-queues it");
  const now = 1_000_000;
  const p1 = settleFileDelete(q, "a", "present", now);
  assert.deepEqual(p1.a, { at: 0, attempts: 1, next: now + 60_000 });
  const p2 = settleFileDelete(p1, "a", "present", now);
  assert.deepEqual(p2.a, { at: 0, attempts: 2, next: now + 120_000 });
  let x = q;
  for (let i = 0; i < 100; i++) x = settleFileDelete(x, "a", i % 2 ? "unknown" : "present", now);
  assert.ok(x.a, "still queued after 100 failed tries");
  assert.equal(x.a.next, now + 30 * 60 * 1000, "backoff capped at 30 min");
  const before = structuredClone(q);
  assert.deepEqual(settleFileDelete(q, "missing", "present", now), q);
  settleFileDelete(q, "a", "present", now);
  assert.deepEqual(q, before, "the input queue is never mutated");
});

await test("nothing is acted on before this device's rows are loaded and the first cloud sync merged", () => {
  assert.equal(fileFlushReady({ loaded: false, synced: true }), false);
  assert.equal(fileFlushReady({ loaded: true, synced: false }), false);
  assert.equal(fileFlushReady({ loaded: true, synced: true }), true);
});

await test("honest status: files still queued are counted and named in the toast", () => {
  assert.equal(pendingOf({ a: {} }, ["a", "z"]), 1);
  assert.equal(purgeNote({}), "");
  assert.match(purgeNote({ files: 1 }), /1 file still/);
  assert.match(purgeNote({ files: 2 }), /2 files/);
});

await test("headStatus: a HEAD with a cache-buster; a network error or no URL gives 0", async () => {
  assert.equal(await headStatus("https://x/y.png", async () => { throw new Error("offline"); }), 0);
  let seen;
  assert.equal(await headStatus("https://x/y.png", async (url, opts) => { seen = { url, opts }; return { status: 400 }; }), 400);
  assert.match(seen.url, /\?v=/);
  assert.equal(seen.opts.method, "HEAD");
  let called = false;
  assert.equal(await headStatus(null, async () => { called = true; return { status: 200 }; }), 0);
  assert.equal(called, false);
});

// ─── Review #3 (2026-10-22): a file a Generate form still holds is kept until every form lets go of it ───
await test("#3: owned beats form; a form-held path is held, anything else is deleted", () => {
  assert.equal(classifyPath("p", { owned: new Set(["p"]), forms: new Set(["p"]) }), "owned");
  assert.equal(classifyPath("p", { owned: new Set(), forms: new Set(["p"]) }), "form");
  assert.equal(classifyPath("p", {}), null);
});

await test("#3: a form hold never expires, is re-checked every minute, and clears on any other outcome", () => {
  const now = 1_000_000;
  const q = { p: { at: 0, attempts: 2, next: 0 } };
  const h = settleFileDelete(q, "p", "form", now);
  assert.deepEqual(h.p, { at: 0, attempts: 2, next: now + 60_000, form: true });
  assert.ok(settleFileDelete(h, "p", "form", now + 30 * 24 * 3600_000).p, "still held after 30 days");
  const b = settleFileDelete(h, "p", "present", now);
  assert.equal(b.p.form, undefined);
  assert.equal(b.p.attempts, 3);
  assert.deepEqual(settleFileDelete(h, "p", "deleted", now), {});
});

// Review round 2: Chrome freezes a background page (the phone), which then sends no heartbeat, yet its form still holds
// the upload when it wakes. A hold counts FORM_HOLD_ALIVE_MS (7 days) after its last publication, not 30 minutes.
await test("#3: form publications hold until FORM_HOLD_ALIVE_MS after their last heartbeat (a frozen page too); malformed ones are ignored", () => {
  const NOW = 10_000_000_000;
  const pubs = [{ at: NOW - 60_000, paths: ["a"] }, { at: NOW - 2 * 24 * 3600_000, paths: ["b"] }, { at: "x", paths: ["c"] }, null,
    { at: NOW, paths: ["d", 7] }, { at: NOW - FORM_HOLD_ALIVE_MS - 1, paths: ["e"] }];
  assert.deepEqual([...liveFormPaths(pubs, NOW)].sort(), ["a", "b", "d"]);
  assert.equal(FORM_HOLD_ALIVE_MS, 7 * 24 * 3600_000);
  assert.equal(classifyPath("b", { owned: new Set(), forms: liveFormPaths(pubs, NOW) }), "form", "a frozen phone's form still holds it");
});

await test("#3: held files are counted apart from pending ones and named in the toast", () => {
  const q = { p: { form: true }, r: {} };
  assert.equal(pendingOf(q, ["p", "r"]), 1);
  assert.equal(heldOf(q, ["p", "r"]), 1);
  assert.match(purgeNote({ held: 1 }), /kept while the Generate form uses it/);
  assert.match(purgeNote({ files: 2 }), /2 files still/);
});

// Review wf_ec400a67-988 #7: the server's answer covers rows beyond this device's view; no answer means wait.
await test("#7: a path the server says is in use is kept; no server answer means wait; local owned/form still win", () => {
  const none = new Set();
  assert.equal(classifyPath("p", { owned: none, forms: none, remote: new Set(["p"]) }), "owned");
  assert.equal(classifyPath("p", { owned: none, forms: none, remote: null }), "unknown");
  assert.equal(classifyPath("p", { owned: none, forms: none, remote: new Set() }), null, "nobody uses it: delete");
  assert.equal(classifyPath("p", { owned: new Set(["p"]), forms: none, remote: null }), "owned");
  assert.equal(classifyPath("p", { owned: none, forms: new Set(["p"]), remote: null }), "form");
});

// Review wf_ec400a67-988 #6: a browser republishes its form holds to the cloud when they change, and at least every
// 10 minutes (well inside FORM_HOLD_ALIVE_MS, so the other device never sees a live hold as lapsed).
await test("#6: cloud form publication: on a change, on a heartbeat, never otherwise", () => {
  const T = 1_000_000;
  assert.equal(formPublishDue(null, ["a"], T), true, "first publication");
  assert.equal(formPublishDue({ at: T, paths: ["a", "b"] }, ["b", "a"], T + 60_000), false, "same set, fresh");
  assert.equal(formPublishDue({ at: T, paths: ["a"] }, ["a", "c"], T + 1), true, "changed");
  assert.equal(formPublishDue({ at: T, paths: ["a"] }, [], T + 1), true, "released");
  assert.equal(formPublishDue({ at: T, paths: ["a"] }, ["a"], T + FORM_CLOUD_HEARTBEAT_MS), true, "heartbeat");
  assert.ok(FORM_CLOUD_HEARTBEAT_MS * 2 < FORM_HOLD_ALIVE_MS);
});
await test("#6: when the other devices' form holds could not be read, an upload waits; an archive does not", () => {
  const none = new Set();
  assert.equal(classifyPath("uploads/u/a.png", { owned: none, forms: none, remote: none, formsKnown: false }), "unknown");
  assert.equal(classifyPath("u/archive.png", { owned: none, forms: none, remote: none, formsKnown: false }), null);
  assert.equal(classifyPath("uploads/u/a.png", { owned: none, forms: none, remote: none }), null, "known and free: delete");
});

// Review wf_ec400a67-988 #4: a delete reports every part still pending, not only files.
await test("purgeNote names pending WaveSpeed copies and a pending History removal too; nothing pending -> empty", () => {
  assert.match(purgeNote({ ws: 1 }), /1 WaveSpeed copy still being deleted/);
  assert.match(purgeNote({ ws: 3 }), /3 WaveSpeed copies/);
  assert.match(purgeNote({ history: true }), /History removal will finish/);
  const all = purgeNote({ files: 1, held: 1, ws: 2, history: true });
  for (const re of [/1 file still/, /kept while/, /2 WaveSpeed copies/, /History removal/]) assert.match(all, re);
  assert.equal(purgeNote({ files: 0, held: 0, ws: 0, history: false }), "");
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
