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

// Review round 4: an upload's Date is stamped near its end, so a slow sample biases the offset by about half its round
// trip. The sample with the smallest round trip in the last 10 minutes wins; one over 1.5 s is never used.
await test("the quickest recent sample wins; a slow one cannot replace it; a stale best is replaced", () => {
  const T = 2_000_000_000_000;
  clock.noteServerDate(new Date(T + 50_000).toUTCString(), T, T + 100);                       // offset ~ +50 s, rtt 100
  const best = clock.noteServerDate(new Date(T + 60_000 + 2_000).toUTCString(), T + 60_000, T + 61_400);   // rtt 1.4 s: worse
  assert.ok(Math.abs(best - 50_000) <= 1000, `kept the quick sample: ${best}`);
  assert.ok(Math.abs(clock.noteServerDate(new Date(T + 120_000 + 70_000).toUTCString(), T + 120_000, T + 120_050) - 70_000) <= 1000, "a quicker one wins");
  assert.ok(Math.abs(clock.noteServerDate(new Date(T + 900_000 + 40_000).toUTCString(), T + 900_000, T + 900_800) - 40_000) <= 1000,
    "after 10 minutes the best is stale and a slower sample replaces it");
  assert.equal(Math.round(clock.noteServerDate(new Date(T + 900_000).toUTCString(), T + 901_000, T + 902_600) / 1000), 40, "a 1.6 s sample is never used");
});

await test("queued uploads and delete intents are stamped in server time", () => {
  const t0 = Date.now();
  clock.noteServerDate(new Date(t0 + 120_000).toUTCString(), t0, t0);   // a 0 ms round trip beats every earlier sample
  addFailedSync({ kind: "task", id: "t", data: { id: "t" } });
  queueDeleteIntents("task-delete", ["d"]);
  for (const e of getFailedSyncs()) assert.ok(Math.abs(e.ts - (Date.now() + 120_000)) <= 1500, `${e.kind} ts ${e.ts - Date.now()}`);
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
