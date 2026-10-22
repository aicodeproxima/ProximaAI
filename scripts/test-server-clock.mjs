// Tests for src/lib/serverClock.js: queued intents are stamped in the server's time as this device estimates it, so the
// restore check (storage.js restoreGuard) never compares a phone's clock with the server's (review round 3 #7).
// Run: node scripts/test-server-clock.mjs
import assert from "node:assert/strict";

const mem = new Map();
globalThis.localStorage = { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k),
  get length() { return mem.size; }, key: i => [...mem.keys()][i] ?? null };
const clock = await import("../src/lib/serverClock.js");
const { addFailedSync, queueDeleteIntents, getFailedSyncs } = await import("../src/lib/storage.js");

let n = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", e.message.split("\n").filter(Boolean).slice(0, 4).join(" | ")); }
};

await test("one Date sample sets the offset (header midpoint vs request midpoint); bad or slow samples change nothing", () => {
  const sent = 1_000_000_000_000, server = sent + 90_000;               // device clock 90 s behind the server
  const off = clock.noteServerDate(new Date(server).toUTCString(), sent, sent + 200);
  assert.ok(Math.abs(off - 90_000) <= 1000, `offset ${off}`);
  assert.equal(clock.noteServerDate("not a date", sent, sent + 10), off);
  assert.equal(clock.noteServerDate(new Date(server + 999_000).toUTCString(), sent, sent + 6000), off, "a 6 s round trip is too vague");
  assert.ok(Math.abs(clock.serverNow() - (Date.now() + off)) < 50);
  assert.equal(Number(localStorage.getItem("proximaai-clock-offset")), off, "kept for offline stamps");
});

await test("withServerClock reads the response's Date header and returns the response unchanged", async () => {
  const res = { headers: { get: k => (k.toLowerCase() === "date" ? new Date(Date.now() - 30_000).toUTCString() : null) }, ok: true };
  const out = await clock.withServerClock(async () => res)("https://x", {});
  assert.equal(out, res);
  assert.ok(Math.abs(clock.serverNow() - (Date.now() - 30_000)) <= 1500, "offset now about -30 s");
  const bare = { ok: true };
  assert.equal(await clock.withServerClock(async () => bare)("https://x"), bare, "no headers: passes through");
});

await test("queued uploads and delete intents are stamped in server time", () => {
  clock.noteServerDate(new Date(Date.now() + 120_000).toUTCString(), Date.now(), Date.now() + 10);
  addFailedSync({ kind: "task", id: "t", data: { id: "t" } });
  queueDeleteIntents("task-delete", ["d"]);
  for (const e of getFailedSyncs()) assert.ok(Math.abs(e.ts - (Date.now() + 120_000)) <= 1500, `${e.kind} ts ${e.ts - Date.now()}`);
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
