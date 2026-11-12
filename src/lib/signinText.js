// Server answer -> words for the sign-in, backup-code and account screens (docs/P1-AUTH-DESIGN.md §5, §10 Q1/Q7).
// Every message is accurate (owner rulings 2026-11-12: "the issue should never be misleading" and "all users now and
// going forward should receive accurate errors"). Since 20261115100000 the server names why it refused ('locked',
// 'backup_locked', 'disabled', 'no_password', 'no_backup_code'), and a wrong username or password, or a wrong code, reads
// as exactly that. An answer this build doesn't know is named as such, and a call that threw says what is known (a
// server error, or no answer), never "wrong password". Per-attempt counts (the old server's attempts_left) are not shown.
// Pure: no React, no network. Tested by scripts/test-signin-text.mjs.

export const SIGNIN_FAILED = "Wrong username or password";
export const SIGNIN_HINT = "3 wrong passwords lock the account; your backup code unlocks it.";
// A wrong code or a name no account has (the server answers both 'invalid'): the words name both. The pause rule is
// static; a running pause has its own answer ('backup_locked').
export const BACKUP_CODE_FAILED = "Wrong username or backup code. 5 wrong codes pause unlocking for 15 minutes.";
// Settings → Account resets the signed-in account (its name is never typed there), so only the code can be wrong.
export const BACKUP_CODE_FAILED_OWN = "Wrong backup code. 5 wrong codes pause unlocking for 15 minutes.";
// A locked account: the sign-in screen has switched to the unlock form (Username, Backup code, UNLOCK), so the steps
// point there.
const UNLOCK_STEPS = "To unlock it, enter your backup code below and tap UNLOCK, then sign in with your password. Forgot your password? Tap “Forgot password?” to set a new one with your backup code.";
export const SIGNIN_LOCKED = `Your account is locked after 3 wrong passwords, so even the right password won't work. ${UNLOCK_STEPS}`;
export const SIGNIN_LOCKED_NOW = `Wrong password. That was the 3rd wrong try, so your account is now locked. ${UNLOCK_STEPS}`;
export const ACCOUNT_DISABLED = "This account is turned off, so it can't sign in or be unlocked. Ask the app's owner.";
export const SIGNIN_NO_PASSWORD = "This account has no password yet. Tap “Forgot password?” to set one with your backup code.";
export const NO_BACKUP_CODE = "This account has no backup code, so it can't be unlocked with one.";
export const RENAME_RATE_LIMITED = "Too many name checks — try again in an hour";
export const OFFLINE = "Can't reach the server — check your connection and try again.";
// A sign-in or unlock call that threw (callFailedText). No answer came back: a try the server never received doesn't
// count, but one whose answer was lost on the way back may have, so neither is claimed.
export const NO_ANSWER = "No answer from the server — check your connection and try again.";
// The server answered with an error code (PostgREST or Postgres): the call's transaction rolled back, so it didn't count.
export const SERVER_ERROR = "The server hit an error and couldn't check this. Try again in a moment — this try didn't count.";
// An HTTP error without a code (a gateway): whether the database finished the call is unknown, so nothing is claimed.
export const SERVER_PROBLEM = "The server had a problem and didn't answer properly. Try again in a moment.";
export const EMPTY_ANSWER = "The server's answer was empty. Try again.";

// 'throttled' (per-network limit). retry_after is seconds when the server sends it.
export function throttledText(retryAfter) {
  const s = Number(retryAfter);
  if (Number.isFinite(s) && s > 0) {
    const min = Math.max(1, Math.ceil(s / 60));
    return `Too many attempts from this network — try again in ${min} min`;
  }
  return "Too many attempts from this network — try again in a few minutes";
}

// A locked account (the lock just set, or set before): the sign-in screen switches to the unlock form.
export function signInSwitchesToUnlock(r) {
  return r?.reason === "locked";
}

// An answer this build doesn't map: said so, with the server's reason when it is a plain word (most likely a newer
// server's, which a reload's build knows). Never shown as a wrong password.
function unexpectedAnswerText(r) {
  const why = typeof r?.reason === "string" && /^[a-z_]{1,40}$/.test(r.reason) ? ` (“${r.reason}”)` : "";
  return `The server gave an answer this page doesn't know${why}. Reload the page and try again.`;
}

// verify_admin answer -> one message naming its real reason.
export function signInError(r) {
  if (r == null || r.reason === "no_answer") return EMPTY_ANSWER;
  switch (r.reason) {
    case "invalid": return SIGNIN_FAILED;
    case "locked": return r.locked_now ? SIGNIN_LOCKED_NOW : SIGNIN_LOCKED;
    case "disabled": return ACCOUNT_DISABLED;
    case "no_password": return SIGNIN_NO_PASSWORD;
    case "throttled": return throttledText(r.retry_after);   // a server that refuses a blocked network (verify_admin no longer does)
    // A member signing in from a build older than one-account-per-browser (migration 20261026600000).
    case "update_required": return "This page is out of date. Reload it, then sign in again.";
    default: return unexpectedAnswerText(r);
  }
}

const pauseMinutes = (retryAfter) => {
  const s = Number(retryAfter);
  return Math.max(1, Math.ceil((Number.isFinite(s) && s > 0 ? s : 900) / 60));
};
// A running pause ('backup_locked'), with its minutes left (15 when the server sends none).
export function backupLockedText(retryAfter) {
  return `Too many wrong backup codes — try again in ${pauseMinutes(retryAfter)} min.`;
}

// unlock (backup code) answer -> one message naming its real reason. ownAccount: the signed-in account's own reset in
// Settings, where no name was typed.
export function backupCodeError(r, { ownAccount = false } = {}) {
  if (r == null || r.reason === "no_answer") return EMPTY_ANSWER;
  switch (r.reason) {
    case "invalid": return ownAccount ? BACKUP_CODE_FAILED_OWN : BACKUP_CODE_FAILED;
    // The 5th wrong code (paused_now) found the account, so only the code was wrong.
    case "backup_locked": return r.paused_now
      ? `Wrong backup code. That was the 5th wrong try, so unlocking is paused — try again in ${pauseMinutes(r.retry_after)} min.`
      : backupLockedText(r.retry_after);
    case "disabled": return ACCOUNT_DISABLED;
    case "no_backup_code": return NO_BACKUP_CODE;
    case "weak_password": return "New password must be at least 8 characters";
    case "throttled": return throttledText(r.retry_after);
    default: return unexpectedAnswerText(r);
  }
}

// A sign-in or unlock call that threw (src/lib/supabase.js keeps the error's code and HTTP status). A code: the server
// answered with an error and the call rolled back. A status without one: a gateway answered, the outcome is unknown.
// Neither: no answer came back.
export function callFailedText(err) {
  if (err?.code) return SERVER_ERROR;
  if (Number(err?.status) > 0) return SERVER_PROBLEM;
  return NO_ANSWER;
}

// The server refused this device's session (expired, or signed out by a password change or a backup-code unlock).
export const SESSION_ENDED = "This device's session has ended (it expired or was signed out). Sign in again.";

// A change (rename, password, backup code, a provider key, Automatic backups, joining, an invite) whose call threw
// (src/lib/supabase.js keeps the HTTP status and the session refusal on it). The server's own refusal (P0001, a raised
// message) reads in its words; another server error (a code) rolled the change back. A gateway's answer (a status without
// a code) or none at all (status 0) leaves it unknown whether the change was saved: that is said, with `unsure` (how to
// tell, or what holds if it was). An error raised in the page before any call (no status) keeps its own words.
// saved: "your password changed"; nothing: "your password did not change" (owner 2026-11-12: accurate errors).
export function changeFailedText(err, { saved = "this was saved", nothing = "nothing was changed", unsure = "" } = {}) {
  if (err?.session) return SESSION_ENDED;
  if (err?.code === "P0001" && err.message) return err.message === "forbidden" ? SESSION_INVALID : err.message;
  if (err?.code) return `The server hit an error${err.message ? ` (${err.message})` : ""}, so ${nothing}. Try again in a moment.`;
  const tail = unsure ? ` ${unsure}` : "";
  if (Number(err?.status) > 0) return `The server had a problem and didn't answer properly, so it's unknown whether ${saved}.${tail}`;
  if (err?.status === 0) return `No answer from the server, so it's unknown whether ${saved}.${tail}`;
  return err?.message || "Something went wrong in this page before anything was sent. Reload the page and try again.";
}

// A name an account may take: join (20261026500000) and, since 20261026200000, rename refuse anything else.
export const USERNAME_RULE = /^[A-Za-z0-9_-]{2,64}$/;
export const USERNAME_HINT = "Choose a name of 2 to 64 letters, digits, - or _ (no spaces or other characters).";

// join_with_invite answer -> one message (supabase/migrations/20261026500000_mu_p5_invites.sql). Every code that doesn't
// work (unknown, used, expired, revoked) reads the same, as the server answers ('invalid'); an answer this build doesn't
// map is named as such (owner 2026-11-12: accurate errors).
export function joinError(r) {
  if (r == null || r.reason === "no_answer") return EMPTY_ANSWER;
  switch (r.reason) {
    case "invalid": return "That invite code doesn't work. It may be mistyped, used, expired or revoked.";
    case "closed": return "Joining isn't open yet. Ask the person who invited you when to try again.";
    case "invalid_username": return USERNAME_HINT;
    case "weak_password": return "Use a password of at least 8 characters.";
    case "username_taken": return "That name is taken. Choose another one (after 5 taken names this invite stops working).";
    case "throttled": return throttledText(r.retry_after);
    default: return unexpectedAnswerText(r);
  }
}

// The join screen after a network failure (the server may have made the account before the answer was lost), and after a
// dead-code answer that follows one.
export const JOIN_MAYBE_CREATED = "If your account was created, sign in with the name and password you chose. If you didn't see your backup code, set a new one in Settings → Account.";

export const SESSION_EXPIRED = "Your session expired — sign in again.";

// Sign-in after a join whose page was lost before CONTINUE (the account exists; review r7 #7).
export function joinedNote(name) {
  return `Your account ${name} was created. Sign in with the password you chose. If you didn't save your backup code, set a new one in Settings → Account.`;
}

// A copy to the clipboard that the browser refused or cannot do (no clipboard in this context).
export const COPY_BY_HAND = "Couldn't copy. Select it and copy it by hand.";

// The join screen on a browser that already holds an account's data (src/lib/accountGuard.js).
export const JOIN_BROWSER_TAKEN = "This browser keeps another account's generations. Open your invite in a private window or on your own device to make your account.";

// create_invite answer -> one message (the owner's Settings).
export function inviteError(r) {
  if (r?.reason === "closed") return "Member accounts are not switched on yet, so invites can't be made.";
  if (r?.reason === "too_many") return "You have 5 open invites. Revoke one before making another.";
  if (r?.reason === "forbidden") return "Only the owner can invite people.";
  return accountError(r);
}

// revoke_invite answer -> one message: 'not_found' (no such open invite of this owner's) or 'forbidden' (not the owner).
export function revokeInviteError(r) {
  if (r?.reason === "not_found") return "That invite was already used or revoked.";
  if (r?.reason === "forbidden") return "Only the owner can revoke invites.";
  return accountError(r);
}

// The session token resolved to no account (the server's 'forbidden' for the signed-in account's own calls): trying again
// on it cannot work.
export const SESSION_INVALID = "This session isn't valid anymore. Sign out, then sign in again.";

// Password-checked account RPCs (rename, change password, set backup code) for the signed-in account. Each server reason
// has its words; one this build doesn't map is named as such, never a catch-all "Failed to save" (owner 2026-11-12).
export function accountError(r) {
  if (r == null || r.reason === "no_answer") return EMPTY_ANSWER;
  switch (r.reason) {
    case "invalid": return "Current password is wrong (this counts toward the 3-attempt lockout)";
    case "locked": return "Too many wrong passwords — sign-in is now locked. Sign out and unlock it with your backup code.";
    case "rate_limited": return RENAME_RATE_LIMITED;
    case "throttled": return throttledText(r.retry_after);
    case "username_taken": return "That username is taken";
    case "weak_password": return "New password must be at least 8 characters";
    case "invalid_username": return USERNAME_HINT;   // rename: join's rule since 20261026200000
    case "too_short": return "Backup code must be at least 12 characters";
    case "forbidden": return SESSION_INVALID;
    default: return unexpectedAnswerText(r);
  }
}
