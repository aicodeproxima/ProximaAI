// Tests for src/lib/mediaDuration.js with a fake media element. Run: node scripts/test-media-duration.mjs
import assert from "node:assert/strict";
import { probeMediaDuration } from "../src/lib/mediaDuration.js";

// Fake <video>: behaviour per URL — a number fires loadedmetadata with that duration, "error" fires error, "hang" never answers.
const created = [];
globalThis.document = {
  createElement: () => {
    const el = { removeAttribute() { this.released = true; }, load() {} };
    let src;
    Object.defineProperty(el, "src", { get: () => src, set: url => {
      src = url;
      const behaviour = { "https://x/7s.mp4": 7.2, "https://x/live.webm": Infinity, "https://x/broken.mp4": "error" }[url];
      setTimeout(() => {
        if (behaviour === "error") el.onerror?.();
        else if (typeof behaviour === "number") { el.duration = behaviour; el.onloadedmetadata?.(); }
      }, 5);
    } });
    created.push(el);
    return el;
  },
};

let n = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", e.message); }
};

await test("reads the duration from metadata and releases the element", async () => {
  assert.equal(await probeMediaDuration("https://x/7s.mp4"), 7.2);
  assert.equal(created.at(-1).released, true);
});
await test("an unreadable file resolves null", async () => assert.equal(await probeMediaDuration("https://x/broken.mp4"), null));
await test("a stream with no finite duration resolves null", async () => assert.equal(await probeMediaDuration("https://x/live.webm"), null));
await test("a host that never answers times out to null", async () => assert.equal(await probeMediaDuration("https://x/hang.mp4", 30), null));
await test("no URL resolves null without creating an element", async () => {
  const before = created.length;
  assert.equal(await probeMediaDuration(""), null);
  assert.equal(created.length, before);
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
