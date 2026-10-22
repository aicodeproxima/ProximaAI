// Tests for src/lib/fileDelete.js — the durable queue that deletes the files of deleted generations (review #5,
// 2026-10-22): queued before any network call, settled only on a confirmed delete (or a HEAD 400/404), a path a kept
// generation uses again leaves unsent, and nothing is acted on before the load and the first cloud sync.
// Run: node scripts/test-file-delete.mjs
import assert from "node:assert/strict";
import { queueFileDeletes, dueFileDeletes, headOutcome, settleFileDelete, fileFlushReady, pendingOf, filesNote, headStatus, FILE_DELETE_CHUNK } from "../src/lib/fileDelete.js";

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

await test("settling: deleted / gone / owned leave; present / unknown back off and are never dropped", () => {
  const q = { a: { at: 0, attempts: 0, next: 0 } };
  for (const o of ["deleted", "gone", "owned"]) assert.deepEqual(settleFileDelete(q, "a", o, 10), {});
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
  assert.equal(filesNote(0), "");
  assert.match(filesNote(1), /1 file still/);
  assert.match(filesNote(2), /2 files/);
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

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
