// Tests for src/lib/backupNotice.js — the line every destructive confirm ends with. Run: node scripts/test-backup-notice.mjs
// Review wf_1945b758-923 #2/#12/#14: confirms promised a safety backup that the server does not take while Automatic
// backups is off, and an unread switch (null) was worded as "off".
import assert from "node:assert/strict";
const { backupNotice } = await import("../src/lib/backupNotice.js");

let n = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", e.message.split("\n")[0]); }
};
const promisesBackup = s => /safety backup is taken first|safety backup of/i.test(s) && !/if it is on/i.test(s);

test("on: a safety backup is promised (delete and restore)", () => {
  assert.ok(promisesBackup(backupNotice(true)));
  assert.ok(promisesBackup(backupNotice(true, { restore: true })));
});
test("off: nothing is promised; it says permanent", () => {
  for (const s of [backupNotice(false), backupNotice(false, { what: "them" }), backupNotice(false, { restore: true })]) {
    assert.ok(!promisesBackup(s), s);
    assert.match(s, /permanent/i);
  }
  assert.match(backupNotice(false, { what: "them" }), /restore them/);
});
test("restore while off says the current data is replaced with no copy", () => {
  assert.match(backupNotice(false, { restore: true }), /replaced/i);
});
test("unknown (switch unread) never claims on or off", () => {
  for (const s of [backupNotice(null), backupNotice(undefined), backupNotice(null, { restore: true })]) {
    assert.ok(!promisesBackup(s), s);
    assert.doesNotMatch(s, /Automatic backups is (on|off)/);
    assert.match(s, /couldn't be checked/i);
  }
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
