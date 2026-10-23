// Tests for src/lib/signinText.js — sign-in / backup-code / account answers in words (P1-AUTH-DESIGN §5 C0, §10 Q1/Q7).
// Must read the same for the old server (attempts_left, not_provisioned) and the new one (invalid, throttled,
// rate_limited). Only the old server's `locked` / `backup_locked` keep their own texts until M1 (design §5, #11).
// Run: node scripts/test-signin-text.mjs
import assert from "node:assert/strict";
const T = await import("../src/lib/signinText.js");
const { signInError, signInSwitchesToUnlock, backupCodeError, backupLockedText, accountError, throttledText, SIGNIN_FAILED, SIGNIN_HINT, BACKUP_CODE_FAILED, SIGNIN_LOCKED_OLD, RENAME_RATE_LIMITED } = T;

let n = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", e.message.split("\n")[0]); }
};
// The one static pause sentence (#7) is allowed; anything else naming a pause, attempts left, a lock or whether an
// account exists reveals state.
const PAUSE_SENTENCE = "5 wrong codes pause unlocking for 15 minutes.";
const leaks = s => /attempt.*left|tr(y|ies) left|\block(ed)?\b|lockout|not set up|pause|exist/i.test(String(s).replace(PAUSE_SENTENCE, ""));

test("sign-in: every failure (old and new server) reads 'Wrong username or password'", () => {
  const answers = [
    { ok: false, reason: "invalid" },
    { ok: false, reason: "invalid", attempts_left: 2 },
    { ok: false, reason: "invalid", attempts_left: 1 },
    { ok: false, reason: "invalid", attempts_left: 0 },
    { ok: false, reason: "not_provisioned" },
    { ok: false }, {}, null, undefined, { ok: false, reason: "something_new" },
  ];
  for (const r of answers) assert.equal(signInError(r), SIGNIN_FAILED, JSON.stringify(r));
  assert.equal(SIGNIN_FAILED, "Wrong username or password");
});
test("sign-in: never shows attempts left (new-server answers never say locked)", () => {
  for (const r of [{ reason: "invalid", attempts_left: 1 }, { reason: "invalid" }, { reason: "not_provisioned" }]) {
    assert.ok(!leaks(signInError(r)));
    assert.equal(signInSwitchesToUnlock(r), false, JSON.stringify(r));
  }
  for (const r of [{ reason: "throttled" }, {}, null, undefined]) assert.equal(signInSwitchesToUnlock(r), false);
});
test("sign-in: the OLD server's 'locked' switches to unlock mode with its own message (#11)", () => {
  for (const r of [{ ok: false, reason: "locked" }, { ok: false, reason: "locked", attempts_left: 0 }]) {
    assert.equal(signInSwitchesToUnlock(r), true);
    assert.equal(signInError(r), SIGNIN_LOCKED_OLD);
  }
  assert.match(SIGNIN_LOCKED_OLD, /locked after 3 failed attempts/);
  assert.match(SIGNIN_LOCKED_OLD, /backup code/);
});
test("sign-in hint names the lockout and the backup code", () => {
  assert.match(SIGNIN_HINT, /3 wrong passwords lock/);
  assert.match(SIGNIN_HINT, /backup code unlocks/);
});
test("throttled: minutes from retry_after, or 'a few minutes'", () => {
  assert.equal(signInError({ reason: "throttled" }), "Too many attempts from this network — try again in a few minutes");
  assert.equal(signInError({ reason: "throttled", retry_after: 600 }), "Too many attempts from this network — try again in 10 min");
  assert.equal(signInError({ reason: "throttled", retry_after: 61 }), "Too many attempts from this network — try again in 2 min");
  assert.equal(signInError({ reason: "throttled", retry_after: 5 }), "Too many attempts from this network — try again in 1 min");
  for (const bad of [0, -3, "x", null, NaN]) assert.equal(throttledText(bad), "Too many attempts from this network — try again in a few minutes");
});
test("backup code: one generic failure (old and new server)", () => {
  for (const r of [
    { ok: false, reason: "invalid" }, { ok: false, reason: "invalid", attempts_left: 4 }, { ok: false, reason: "invalid", attempts_left: 1 },
    { ok: false, reason: "no_backup_code" }, {}, null, undefined, { ok: false, reason: "something_new" },
  ]) {
    const s = backupCodeError(r);
    assert.equal(s, BACKUP_CODE_FAILED, JSON.stringify(r));
    assert.ok(!leaks(s));
  }
  assert.equal(BACKUP_CODE_FAILED, "Wrong backup code. 5 wrong codes pause unlocking for 15 minutes.");
});
test("leaks: allows exactly the static pause sentence, still forbids state", () => {
  assert.ok(!leaks(BACKUP_CODE_FAILED));
  for (const bad of ["Unlocking is paused", "pause: 12 min left", "Wrong backup code · 3 tries left", "Account locked",
    "This account does not exist", "4 attempts left", "Wrong backup code. 5 wrong codes pause unlocking for 15 minutes. Paused now."])
    assert.ok(leaks(bad), bad);
});
test("backup code: the OLD server's 'backup_locked' keeps its own text (#11)", () => {
  assert.equal(backupCodeError({ ok: false, reason: "backup_locked", retry_after: 900 }), "Too many wrong backup codes — try again in 15 min.");
  assert.equal(backupCodeError({ ok: false, reason: "backup_locked", retry_after: 61 }), "Too many wrong backup codes — try again in 2 min.");
  assert.equal(backupCodeError({ ok: false, reason: "backup_locked" }), "Too many wrong backup codes — try again in 15 min.");
  for (const bad of [0, -1, "x", null]) assert.equal(backupLockedText(bad), "Too many wrong backup codes — try again in 15 min.");
});
test("backup code: throttled and weak_password are named", () => {
  assert.match(backupCodeError({ reason: "throttled", retry_after: 120 }), /this network — try again in 2 min/);
  assert.equal(backupCodeError({ reason: "weak_password" }), "New password must be at least 8 characters");
});
test("rename: rate_limited -> one-hour text; throttled; taken; others unchanged", () => {
  assert.equal(accountError({ reason: "rate_limited" }, "F"), "Too many name checks — try again in an hour");
  assert.equal(RENAME_RATE_LIMITED, "Too many name checks — try again in an hour");
  assert.match(accountError({ reason: "throttled" }, "F"), /a few minutes/);
  assert.equal(accountError({ reason: "username_taken" }, "F"), "That username is taken");
  assert.match(accountError({ reason: "invalid" }, "F"), /Current password is wrong/);
  assert.match(accountError({ reason: "locked" }, "F"), /locked/);
  assert.match(accountError({ reason: "invalid_username" }, "F"), /2–64 characters/);
  assert.match(accountError({ reason: "too_short" }, "F"), /12 characters/);
  assert.equal(accountError({ reason: "nope" }, "F"), "F");
  assert.equal(accountError(null, "F"), "F");
});

{
  const fs = await import("node:fs");
  const app = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  test("wiring: App.jsx has no local copies of the answer texts", () => {
    assert.ok(!/function (backupCodeError|accountError|signInError)\b/.test(app));
    assert.ok(!/tries? left|attempts? left/.test(app.replace(/\/\/.*$/gm, "")));
  });
  test("wiring: each unlockWithBackupCode answer goes through backupCodeError", () => {
    const calls = [...app.matchAll(/await unlockWithBackupCode\(/g)].map(m => m.index);
    assert.equal(calls.length, 2, "sign-in unlock/reset + AccountModal reset");
    for (const i of calls) assert.match(app.slice(i, i + 900), /setError\(backupCodeError\(r\)\)/);
  });
  test("wiring: sign-in switches to unlock mode on the old server's locked, then shows signInError", () => {
    assert.match(app, /if \(signInSwitchesToUnlock\(r\)\) switchMode\("unlock"\);\s*\n\s*setError\(signInError\(r\)\);/);
  });
}

console.log(`${n}/${n + failed} passed`);
process.exit(failed ? 1 : 0);
