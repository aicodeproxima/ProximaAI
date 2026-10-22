// Tests for src/lib/clearOutcome.js — which cloud clears of Reset Everything did not confirm. Run: node scripts/test-clear-outcome.mjs
// Since 1bd2e68 the clears answer {ok, error}; Reset used to ignore them, so a refused settings/favorites clear still
// read "Everything cleared permanently" and the cloud copy came back on the next load.
import assert from "node:assert/strict";
const { unconfirmedClears } = await import("../src/lib/clearOutcome.js");

let n = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", e.message.split("\n")[0]); }
};
const ok = v => ({ status: "fulfilled", value: v });

test("every clear confirmed (or a local-only install): nothing unconfirmed", () => {
  assert.deepEqual(unconfirmedClears([ok({ ok: true }), ok({ ok: true, localOnly: true })], ["settings", "favorites"]), []);
});
test("a refused clear, a thrown one and a missing answer are all unconfirmed", () => {
  const settled = [ok({ ok: false, error: "42501" }), { status: "rejected", reason: new Error("net") }, ok(undefined)];
  assert.deepEqual(unconfirmedClears(settled, ["settings", "favorites", "history"]), ["settings", "favorites", "history"]);
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
