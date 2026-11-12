// Tests for src/lib/signinText.js — sign-in / backup-code / account answers in words (P1-AUTH-DESIGN §5, §10 Q1/Q7).
// Every message is accurate (owner rulings 2026-11-12, migration 20261115100000): a wrong username, password or code
// reads as exactly that and never mentions a lock; a lock, a pause, a disabled account and a missing password or code
// each say so (a lock with how the backup code unlocks it); an answer this build doesn't know, an empty one and a call
// that threw say what is known, never "wrong password".
// Run: node scripts/test-signin-text.mjs
import assert from "node:assert/strict";
const T = await import("../src/lib/signinText.js");
const { signInError, signInSwitchesToUnlock, backupCodeError, backupLockedText, accountError, joinError, throttledText, callFailedText,
  SIGNIN_FAILED, SIGNIN_HINT, BACKUP_CODE_FAILED, SIGNIN_LOCKED, SIGNIN_LOCKED_NOW, ACCOUNT_DISABLED, SIGNIN_NO_PASSWORD,
  NO_BACKUP_CODE, NO_ANSWER, SERVER_ERROR, SERVER_PROBLEM, EMPTY_ANSWER, RENAME_RATE_LIMITED } = T;

let n = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", e.message.split("\n")[0]); }
};
// A wrong username, password or code must not claim a state it doesn't have: the static pause rule is allowed, anything
// else naming a pause, attempts left, a lock or whether an account exists is not.
const PAUSE_SENTENCE = "5 wrong codes pause unlocking for 15 minutes.";
const claimsState = s => /attempt.*left|tr(y|ies) left|\block(ed)?\b|lockout|not set up|pause|exist/i.test(String(s).replace(PAUSE_SENTENCE, ""));
const NOT_KNOWN = /answer this page doesn't know/;

test("sign-in: a wrong username or password reads exactly that, and never mentions a lock", () => {
  for (const r of [{ ok: false, reason: "invalid" }, { ok: false, reason: "invalid", attempts_left: 2 }, { ok: false, reason: "invalid", attempts_left: 0 }]) {
    assert.equal(signInError(r), SIGNIN_FAILED, JSON.stringify(r));
    assert.ok(!claimsState(signInError(r)));
    assert.equal(signInSwitchesToUnlock(r), false, JSON.stringify(r));
  }
  assert.equal(SIGNIN_FAILED, "Wrong username or password");
});
test("sign-in: a locked account says it is locked, why the right password fails, and how the backup code unlocks it (owner 2026-11-12)", () => {
  const r = { ok: false, reason: "locked" };
  assert.equal(signInSwitchesToUnlock(r), true);
  assert.equal(signInError(r), SIGNIN_LOCKED);
  for (const re of [/^Your account is locked after 3 wrong passwords/, /even the right password won't work/, /enter your backup code below and tap UNLOCK/,
    /then sign in with your password/, /Tap “Forgot password\?” to set a new one with your backup code/]) assert.match(SIGNIN_LOCKED, re);
});
test("sign-in: the wrong password that locks the account says both", () => {
  const r = { ok: false, reason: "locked", locked_now: true };
  assert.equal(signInSwitchesToUnlock(r), true);
  assert.equal(signInError(r), SIGNIN_LOCKED_NOW);
  for (const re of [/^Wrong password\. That was the 3rd wrong try, so your account is now locked\./, /enter your backup code below and tap UNLOCK/,
    /Forgot password/]) assert.match(SIGNIN_LOCKED_NOW, re);
});
test("sign-in: a disabled account and an account with no password are named", () => {
  assert.equal(signInError({ ok: false, reason: "disabled" }), ACCOUNT_DISABLED);
  assert.match(ACCOUNT_DISABLED, /turned off/);
  assert.equal(signInError({ ok: false, reason: "no_password" }), SIGNIN_NO_PASSWORD);
  assert.match(SIGNIN_NO_PASSWORD, /no password yet.*backup code/);
  for (const r of [{ reason: "disabled" }, { reason: "no_password" }, { reason: "throttled" }, { reason: "update_required" }, {}, null, undefined])
    assert.equal(signInSwitchesToUnlock(r), false, JSON.stringify(r));
  assert.equal(signInError({ reason: "update_required" }), "This page is out of date. Reload it, then sign in again.");
});
test("sign-in: an answer this build doesn't know is named, never shown as a wrong password", () => {
  for (const r of [{ ok: false }, {}, { ok: false, reason: "something_new" }, { ok: false, reason: "not_provisioned" }]) {
    assert.notEqual(signInError(r), SIGNIN_FAILED, JSON.stringify(r));
    assert.match(signInError(r), NOT_KNOWN, JSON.stringify(r));
  }
  assert.match(signInError({ reason: "something_new" }), /“something_new”/);
  assert.doesNotMatch(signInError({ reason: "<b>x</b> or a sentence" }), /<b>|sentence/);   // only a plain reason word is quoted
  for (const r of [null, undefined, { ok: false, reason: "no_answer" }]) assert.equal(signInError(r), EMPTY_ANSWER, String(r));
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
test("backup code: a wrong username or code reads exactly that, and never claims a pause beyond the static rule", () => {
  for (const r of [{ ok: false, reason: "invalid" }, { ok: false, reason: "invalid", attempts_left: 4 }, { ok: false, reason: "invalid", attempts_left: 1 }]) {
    const s = backupCodeError(r);
    assert.equal(s, BACKUP_CODE_FAILED, JSON.stringify(r));
    assert.ok(!claimsState(s));
  }
  // The server answers an unknown name and a wrong code alike, so the words name both, as the sign-in failure does
  // (2026-10-27: a member typed a name no account has and read "Wrong backup code" as their code being wrong).
  assert.equal(BACKUP_CODE_FAILED, "Wrong username or backup code. 5 wrong codes pause unlocking for 15 minutes.");
});
const { readFileSync } = await import("node:fs");
test("backup code in Settings: the signed-in account's own name is sent, so only the code can be wrong", () => {
  assert.equal(backupCodeError({ ok: false, reason: "invalid" }, { ownAccount: true }), T.BACKUP_CODE_FAILED_OWN);
  assert.equal(backupCodeError(null, { ownAccount: true }), EMPTY_ANSWER);
  assert.match(backupCodeError({}, { ownAccount: true }), NOT_KNOWN);
  assert.equal(T.BACKUP_CODE_FAILED_OWN, "Wrong backup code. 5 wrong codes pause unlocking for 15 minutes.");
  assert.ok(!claimsState(T.BACKUP_CODE_FAILED_OWN));
  assert.equal(backupCodeError({ reason: "weak_password" }, { ownAccount: true }), "New password must be at least 8 characters");
  const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.match(app, /unlockWithBackupCode\(code, newPassword, creds\.username\);\s*if \(!r\?\.ok\) \{[^}]*setError\(backupCodeError\(r, \{ ownAccount: true \}\)\)/,
    "Settings' reset passes ownAccount");
  assert.match(app, /const r = await unlockWithBackupCode\(backupCode\.trim\(\)[^\n]*\n(?:[^\n]*\n){1,8}?\s*setError\(backupCodeError\(r\)\);/,
    "the sign-in screen's unlock/reset keeps the words that name the username");
});
test("claimsState: allows exactly the static pause sentence, still catches state", () => {
  assert.ok(!claimsState(BACKUP_CODE_FAILED));
  for (const bad of ["Unlocking is paused", "pause: 12 min left", "Wrong backup code · 3 tries left", "Account locked",
    "This account does not exist", "4 attempts left", "Wrong backup code. 5 wrong codes pause unlocking for 15 minutes. Paused now."])
    assert.ok(claimsState(bad), bad);
});
test("backup code: a running pause says so with the minutes left; the 5th wrong code says both", () => {
  assert.equal(backupCodeError({ ok: false, reason: "backup_locked", retry_after: 900 }), "Too many wrong backup codes — try again in 15 min.");
  assert.equal(backupCodeError({ ok: false, reason: "backup_locked", retry_after: 61 }), "Too many wrong backup codes — try again in 2 min.");
  assert.equal(backupCodeError({ ok: false, reason: "backup_locked" }), "Too many wrong backup codes — try again in 15 min.");
  for (const bad of [0, -1, "x", null]) assert.equal(backupLockedText(bad), "Too many wrong backup codes — try again in 15 min.");
  const now = backupCodeError({ ok: false, reason: "backup_locked", retry_after: 900, paused_now: true });
  assert.equal(now, "Wrong backup code. That was the 5th wrong try, so unlocking is paused — try again in 15 min.");
  assert.equal(backupCodeError({ reason: "backup_locked", retry_after: 900, paused_now: true }, { ownAccount: true }), now);
});
test("backup code: a disabled account, no code, throttled and weak_password are named; unknown and empty answers too", () => {
  assert.equal(backupCodeError({ ok: false, reason: "disabled" }), ACCOUNT_DISABLED);
  assert.equal(backupCodeError({ ok: false, reason: "no_backup_code" }), NO_BACKUP_CODE);
  assert.match(NO_BACKUP_CODE, /no backup code/);
  assert.match(backupCodeError({ reason: "throttled", retry_after: 120 }), /this network — try again in 2 min/);
  assert.equal(backupCodeError({ reason: "weak_password" }), "New password must be at least 8 characters");
  for (const r of [{ ok: false }, {}, { reason: "something_new" }]) {
    assert.notEqual(backupCodeError(r), BACKUP_CODE_FAILED, JSON.stringify(r));
    assert.match(backupCodeError(r), NOT_KNOWN, JSON.stringify(r));
  }
  for (const r of [null, undefined, { ok: false, reason: "no_answer" }]) assert.equal(backupCodeError(r), EMPTY_ANSWER, String(r));
});
test("a call that threw: a server error didn't count, a gateway problem and no answer claim nothing", () => {
  assert.equal(callFailedText({ code: "57014", status: 500 }), SERVER_ERROR);       // a Postgres error: the call rolled back
  assert.equal(callFailedText({ code: "PGRST202", status: 404 }), SERVER_ERROR);    // PostgREST refused before running it
  assert.equal(callFailedText({ code: "", status: 502 }), SERVER_PROBLEM);          // a gateway's answer: unknown outcome
  assert.equal(callFailedText({ status: 504 }), SERVER_PROBLEM);
  for (const e of [new TypeError("Failed to fetch"), { code: "", status: 0 }, {}, null, undefined]) assert.equal(callFailedText(e), NO_ANSWER, String(e));
  assert.match(SERVER_ERROR, /this try didn't count/);
  for (const s of [SERVER_PROBLEM, NO_ANSWER, EMPTY_ANSWER]) assert.doesNotMatch(s, /count/, s);
  assert.doesNotMatch(NO_ANSWER, /can't reach/i);   // the answer may have been lost after the server got the try
});
test("rename: rate_limited -> one-hour text; throttled; taken; others unchanged", () => {
  assert.equal(accountError({ reason: "rate_limited" }, "F"), "Too many name checks — try again in an hour");
  assert.equal(RENAME_RATE_LIMITED, "Too many name checks — try again in an hour");
  assert.match(accountError({ reason: "throttled" }, "F"), /a few minutes/);
  assert.equal(accountError({ reason: "username_taken" }, "F"), "That username is taken");
  assert.match(accountError({ reason: "invalid" }, "F"), /Current password is wrong/);
  assert.match(accountError({ reason: "locked" }, "F"), /locked/);
  // Since 20261026200000 a rename takes join's allow-list: both say the same rule (RLS follow-up, 2026-10-27)
  assert.equal(accountError({ reason: "invalid_username" }, "F"), joinError({ reason: "invalid_username" }));
  assert.match(accountError({ reason: "invalid_username" }, "F"), /2 to 64 letters, digits, - or _/);
  assert.match(accountError({ reason: "too_short" }, "F"), /12 characters/);
});
test("account changes: 'forbidden' says the session isn't valid; an answer this build doesn't map is named, never 'Failed to save'", () => {
  assert.equal(accountError({ ok: false, reason: "forbidden" }), T.SESSION_INVALID);
  assert.match(T.SESSION_INVALID, /isn't valid anymore.*sign in again/);
  for (const r of [{ ok: false, reason: "nope" }, { ok: false }, {}]) {
    assert.match(accountError(r), NOT_KNOWN, JSON.stringify(r));
    assert.doesNotMatch(accountError(r), /Failed to save/);
  }
  for (const r of [null, undefined, { ok: false, reason: "no_answer" }]) assert.equal(accountError(r), EMPTY_ANSWER, String(r));
});
test("join: a dead code reads as one; an answer this build doesn't map is named; an empty one says so", () => {
  assert.equal(joinError({ ok: false, reason: "invalid" }), "That invite code doesn't work. It may be mistyped, used, expired or revoked.");
  for (const r of [{ ok: false, reason: "something_new" }, {}]) assert.match(joinError(r), NOT_KNOWN, JSON.stringify(r));
  for (const r of [null, undefined, { ok: false, reason: "no_answer" }]) assert.equal(joinError(r), EMPTY_ANSWER, String(r));
});
test("invites: making and revoking name the real refusal", () => {
  assert.equal(T.inviteError({ ok: false, reason: "forbidden" }), "Only the owner can invite people.");
  assert.match(T.inviteError({ ok: false, reason: "nope" }), NOT_KNOWN);
  assert.equal(T.revokeInviteError({ ok: false, reason: "not_found" }), "That invite was already used or revoked.");
  assert.equal(T.revokeInviteError({ ok: false, reason: "forbidden" }), "Only the owner can revoke invites.");
  assert.match(T.revokeInviteError({ ok: false, reason: "nope" }), NOT_KNOWN);
  assert.equal(T.revokeInviteError(null), EMPTY_ANSWER);
});

{
  const fs = await import("node:fs");
  // A Windows checkout (core.autocrlf) has CRLF: anchors below are written with \n.
  const app = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const sb = fs.readFileSync(new URL("../src/lib/supabase.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  test("wiring: App.jsx has no local copies of the answer texts", () => {
    assert.ok(!/function (backupCodeError|accountError|signInError|callFailedText)\b/.test(app));
    assert.ok(!/tries? left|attempts? left/.test(app.replace(/\/\/.*$/gm, "")));
  });
  test("wiring: no account answer falls back to a catch-all text; the revoke answer goes through revokeInviteError", () => {
    assert.doesNotMatch(app, /accountError\(r, /, "accountError takes the answer only");
    const inv = fs.readFileSync(new URL("../src/components/InviteSection.jsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    assert.match(inv, /revokeInviteError\(r\)/);
    assert.doesNotMatch(inv, /"That invite was already used or revoked\."/, "the words live in signinText.js");
  });
  test("wiring: each unlockWithBackupCode answer goes through backupCodeError", () => {
    const calls = [...app.matchAll(/await unlockWithBackupCode\(/g)].map(m => m.index);
    assert.equal(calls.length, 2, "sign-in unlock/reset + AccountModal reset");
    for (const i of calls) assert.match(app.slice(i, i + 900), /setError\(backupCodeError\(r(, \{ ownAccount: true \})?\)\)/);
  });
  test("wiring: a sign-in or unlock call that throws shows callFailedText(err), never a fixed 'can't reach' text", () => {
    for (const [name, call] of [["handleSignIn", "await signIn("], ["handleBackupCode", "await unlockWithBackupCode(backupCode"],
      ["submitResetWithCode", "await unlockWithBackupCode(code"]]) {
      const i = app.indexOf(call);
      assert.ok(i > 0, name);
      assert.match(app.slice(i, i + 1600), /\} catch \(err\) \{\s*setError\(callFailedText\(err\)\);/, name);
    }
  });
  test("wiring: signIn and unlockWithBackupCode keep the error's code and status, and an empty answer is 'no_answer'", () => {
    for (const fn of ["signIn", "unlockWithBackupCode"]) {
      const i = sb.indexOf(`export async function ${fn}(`);
      assert.ok(i > 0, fn);
      const body = sb.slice(i, sb.indexOf("\n}\n", i));
      assert.match(body, /const \{ data, error, status \} = await supabase\.rpc\(/, fn);
      assert.match(body, /if \(error\) throw rpcError\(error, status\);/, fn);
      assert.match(body, /return data \|\| \{ ok: false, reason: "no_answer" \};/, fn);
      assert.doesNotMatch(body, /reason: "invalid"/, fn);
    }
    assert.match(sb, /function rpcError\(error, status\) \{/);
  });
  test("every username box turns off autocorrect, autocapitalize and spellcheck (a phone must not change the name)", () => {
    for (const id of ["login-username", "login-reset-username", "join-username"]) {
      const m = app.match(new RegExp(`<input id="${id}"[\\s\\S]*?\\/>`));   // to "/>": onChange's "=>" holds a ">"
      assert.ok(m, id);
      for (const a of ['autoCapitalize="off"', 'autoCorrect="off"', "spellCheck={false}"]) assert.ok(m[0].includes(a), `${id} lacks ${a}`);
    }
  });
  test("wiring: sign-in switches to the unlock form on 'locked', then shows signInError", () => {
    assert.match(app, /if \(signInSwitchesToUnlock\(r\)\) switchMode\("unlock"\);\s*\n\s*setError\(signInError\(r\)\);/);
  });
}

console.log(`${n}/${n + failed} passed`);
process.exit(failed ? 1 : 0);
