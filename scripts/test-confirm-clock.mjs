// A confirmed delete's stamp and a queued upload's stamp must come from the same clock (review round 19 follow-up):
// withoutConfirmedUploads drops uploads queued at or before the confirm and keeps later ones. Upload entries are
// stamped with serverNow() (storage.js addFailedSync), so the confirm stamp must be server time too, or a device whose
// clock is off by more than the gap keeps a stale upload (resurrecting a confirmed delete) or drops a real one.
// Each case runs in its own process: serverClock's offset is module state.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const HOUR = 60 * 60 * 1000;
const tick = () => new Promise(r => setTimeout(r, 5));

// Returns how many queued task uploads of id "x" survive withoutConfirmedUploads.
async function runCase(skewMs, scenario) {
  const mem = new Map();
  globalThis.localStorage = { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)),
    removeItem: k => mem.delete(k), key: i => [...mem.keys()][i] ?? null, get length() { return mem.size; } };
  const clock = await import("../src/lib/serverClock.js");
  const now = Date.now();
  // server time = local time + skew. The Date header has whole seconds, so any learned offset is off by up to 500 ms;
  // the control (skew 0) learns none, so its offset is exactly 0.
  if (skewMs) clock.noteServerDate(new Date(now + skewMs).toUTCString(), now, now);
  const S = await import("../src/lib/storage.js");
  const upload = () => S.addFailedSync({ kind: "task", id: "x", data: { id: "x" } });
  if (scenario === "stale-put-back") {
    // A clear takes x's queued upload into its stash; x's delete is confirmed; a give-back then puts the stale entry
    // (its ORIGINAL stamp, from before the confirm) back. It must never be sent again.
    upload();
    const taken = S.takeQueuedUploads("task", ["x"]);
    await tick();
    S.confirmDeleteIntents("task-delete", ["x"]);
    S.putBackQueuedUploads(taken);
  } else {
    // x was confirmed deleted, came back (a restore) and changed here: the new upload, queued after the confirm, is real.
    S.confirmDeleteIntents("task-delete", ["x"]);
    await tick();
    upload();
  }
  return S.withoutConfirmedUploads(S.getFailedSyncs().filter(e => e.kind === "task" && e.id === "x")).length;
}

if (process.env.CONFIRM_CLOCK_CASE) {
  const [skew, scenario] = process.env.CONFIRM_CLOCK_CASE.split("|");
  process.stdout.write(String(await runCase(Number(skew), scenario)));
  process.exit(0);
}

function child(skewMs, scenario) {
  const env = { ...process.env, CONFIRM_CLOCK_CASE: `${skewMs}|${scenario}` };
  delete env.NODE_TEST_CONTEXT;   // a child run must not report into this test (AGENTS.md, node 24)
  const r = spawnSync(process.execPath, [SELF], { env, encoding: "utf8", timeout: 20000 });
  assert.equal(r.status, 0, r.stderr);
  return Number(r.stdout.trim());
}

test("control (no skew): a stale put-back is dropped, a real later upload is kept", () => {
  assert.equal(child(0, "stale-put-back"), 0);
  assert.equal(child(0, "new-after-confirm"), 1);
});

test("server clock 1 h AHEAD of this device: a stale put-back is still dropped (no resurrection)", () => {
  assert.equal(child(+HOUR, "stale-put-back"), 0);
});

test("server clock 1 h BEHIND this device: an upload queued after the confirm is kept (not silently dropped)", () => {
  assert.equal(child(-HOUR, "new-after-confirm"), 1);
});

test("an ordinary learned offset (the header's whole seconds) keeps a real upload made right after the confirm", () => {
  assert.equal(child(-1, "new-after-confirm"), 1);   // learns an offset of up to -500 ms, as a real device does
  assert.equal(child(-1, "stale-put-back"), 0);
});
