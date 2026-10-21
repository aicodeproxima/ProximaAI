// Tests for src/lib/storageRemove.js — which paths a Storage remove() really deleted. Run: node scripts/test-storage-remove.mjs
// Shapes measured on the live bucket 2026-10-21: remove() answers 200 with one object per deleted file, `name` = the full
// path inside the bucket; a path that is absent (already gone, or hidden by the row policies) is simply left out.
import assert from "node:assert/strict";
const { removedPaths } = await import("../src/lib/storageRemove.js");

let n = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", e.message.split("\n")[0]); }
};

test("a deleted nested path is confirmed by its full name", () => {
  const r = removedPaths(["uploads/user_A/x.png"], [{ name: "uploads/user_A/x.png", id: "1" }]);
  assert.deepEqual([...r], ["uploads/user_A/x.png"]);
});
test("an empty answer confirms nothing (already gone, or refused)", () => {
  assert.equal(removedPaths(["user_A/t-0.png"], []).size, 0);
});
test("only the paths the answer lists count; a bare file name does not match a nested path", () => {
  const r = removedPaths(["user_A/t-0.png", "user_A/t-1.png"], [{ name: "user_A/t-1.png" }, { name: "t-0.png" }]);
  assert.deepEqual([...r], ["user_A/t-1.png"]);
});
test("malformed answers confirm nothing", () => {
  for (const data of [null, undefined, {}, "x", [null], [{}]]) assert.equal(removedPaths(["a/b.png"], data).size, 0);
  assert.equal(removedPaths(null, [{ name: "a/b.png" }]).size, 0);
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
