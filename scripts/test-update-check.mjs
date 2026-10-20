// Tests for src/lib/updateCheck.js — telling a newer deployment from the running one. Run: node scripts/test-update-check.mjs
import assert from "node:assert/strict";
import { bundleFromHtml, isNewerBuild } from "../src/lib/updateCheck.js";

let n = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", e.message.split("\n")[0]); }
};

const html = (hash) => `<!doctype html><head><script>addEventListener('error', () => {})</script>
<script type="module" crossorigin src="/assets/index-${hash}.js"></script></head><body><div id="root"></div></body>`;

test("reads the entry bundle path from the deployed index.html", () => {
  assert.equal(bundleFromHtml(html("DGpp8PHm")), "/assets/index-DGpp8PHm.js");
});

test("returns null when the page has no built bundle (dev server, error page)", () => {
  assert.equal(bundleFromHtml('<script type="module" src="/src/main.jsx"></script>'), null);
  assert.equal(bundleFromHtml(""), null);
  assert.equal(bundleFromHtml(undefined), null);
});

test("a different live bundle is a newer build; the same one is not", () => {
  assert.equal(isNewerBuild("/assets/index-OLD11111.js", html("NEW22222")), true);
  assert.equal(isNewerBuild("/assets/index-SAME1234.js", html("SAME1234")), false);
});

test("never reports an update when either side is unknown (offline, dev, odd HTML)", () => {
  assert.equal(isNewerBuild(null, html("NEW22222")), false);
  assert.equal(isNewerBuild("/assets/index-OLD11111.js", "<html>offline</html>"), false);
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
