// The running time and the 1-minute bar of a pending or running generation (owner 2026-10-26: "I need a 1 minute
// loading bar on the generations that is missing while processing with working seconds"). Measured cause: the card drew
// both from task.wallClockMs, which only the page that polls the generation updates; another tab or device showed
// "⏱ 0ms" and an empty bar until the result arrived. Now both tick on every page from the start time.
// Written first: before the change these tests fail. Run: node scripts/test-live-elapsed.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertStripKeepsStrings } from "./lib/strip-comments.mjs";

let T = {};
try { T = await import("../src/lib/taskTime.js"); } catch {}
const app = assertStripKeepsStrings(readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8"));
let n = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", String(e?.message || e).split("\n").slice(0, 3).join(" | ")); }
};

await test("liveElapsedMs: from the start time on a page that does not poll; the polling page's own count when ahead", () => {
  const now = 1_000_000;
  assert.equal(T.liveElapsedMs({ wallClockMs: 0, startTime: now - 12_000 }, now), 12_000, "another tab or device");
  assert.equal(T.liveElapsedMs({ startTime: now - 7_500 }, now), 7_500, "no count yet");
  assert.equal(T.liveElapsedMs({ wallClockMs: 20_000, startTime: now - 15_000 }, now), 20_000, "the polling page is ahead");
  assert.equal(T.liveElapsedMs({ wallClockMs: 0, startTime: now + 5_000 }, now), 0, "a start time ahead of this clock (another device) never goes negative");
  assert.equal(T.liveElapsedMs({ wallClockMs: 3_000 }, now), 3_000, "no start time");
  assert.equal(T.liveElapsedMs({ wallClockMs: "x", startTime: "y" }, now), 0);
  assert.equal(T.liveElapsedMs(null, now), 0);
});

await test("progressPercent: a 1-minute bar that stops at 95% until the result is in", () => {
  assert.equal(T.PROGRESS_BAR_MS, 60_000);
  assert.equal(T.progressPercent(0), 0);
  assert.equal(T.progressPercent(30_000), 50);
  assert.equal(T.progressPercent(57_000), 95);
  assert.equal(T.progressPercent(10 * 60_000), 95);
  assert.equal(T.progressPercent(-1), 0);
});

await test("the cockpit card and the History 'processing' tab use the ticking clock and bar", () => {
  assert.match(app, /import \{ liveElapsedMs, progressPercent \} from "\.\/lib\/taskTime\.js";/);
  assert.ok(!/const PROGRESS_BAR_MS = 60000;/.test(app), "one definition, in taskTime.js");
  // each ticks itself once a second (the memoized card is not re-rendered), and stops when unmounted
  for (const name of ["RunningClock", "RunningBar"]) {
    const body = app.slice(app.indexOf(`function ${name}(`), app.indexOf("\n}\n", app.indexOf(`function ${name}(`)));
    assert.ok(body.length > 20, `${name} defined`);
    assert.match(body, /const id = setInterval\(tick, 1000\);\s*return \(\) => clearInterval\(id\);/, `${name} ticks and cleans up`);
    assert.match(body, /liveElapsedMs\(task\)/, `${name} reads the live elapsed time`);
  }
  const card = app.slice(app.indexOf("const CockpitTaskCard = memo("), app.indexOf("{task.status === \"completed\" && task.outputs?.map("));
  assert.match(card, /<RunningClock task=\{task\} \/>/);
  assert.match(card, /<RunningBar task=\{task\} \/>/);
  assert.ok(!/task\.wallClockMs \/ PROGRESS_BAR_MS/.test(app), "no bar drawn from the polling page's count alone");
  const gallery = app.slice(app.indexOf("{galleryProcessing.map(task => ("), app.indexOf("✕ Cancel</button>", app.indexOf("{galleryProcessing.map(task => (")));
  assert.match(gallery, /<RunningClock task=\{task\} \/>/);
  assert.match(gallery, /<RunningBar task=\{task\} \/>/);
  assert.ok(!/formatTime\(task\.wallClockMs \|\| \(Date\.now\(\) - task\.startTime\)\)/.test(app), "the gallery's frozen time is gone");
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
