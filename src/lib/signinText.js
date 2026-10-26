// Server answer -> words for the sign-in, backup-code and account screens (docs/P1-AUTH-DESIGN.md §5 "C0", §10 Q1/Q7).
// Works with both the old and the new server: per-attempt details (attempts_left, not_provisioned) are ignored, so a
// stranger never learns whether a name exists. Until M1 is applied the OLD server still answers `locked` (sign-in) and
// `backup_locked` (unlock); design §5 keeps those (switch to unlock mode / their own pause text). The new server never
// sends them (its failures are generic), so those branches go quiet once M1 is live.
// Pure: no React, no network. Tested by scripts/test-signin-text.mjs.

export const SIGNIN_FAILED = "Wrong username or password";
export const SIGNIN_HINT = "3 wrong passwords lock the account; your backup code unlocks it.";
// Static (the same for every failure): says that waiting helps, never whether a pause is running (#7, design §5).
export const BACKUP_CODE_FAILED = "Wrong backup code. 5 wrong codes pause unlocking for 15 minutes.";
// Old server only (before M1): sign-in is locked after 3 wrong passwords; the screen switches to unlock mode.
export const SIGNIN_LOCKED_OLD = "Sign-in is locked after 3 failed attempts. Unlock it with your backup code below, or tap “Forgot password?” to set a new one.";
export const RENAME_RATE_LIMITED = "Too many name checks — try again in an hour";
export const OFFLINE_SIGNIN = "Can't reach the server — check your connection and try again. (This attempt didn't count.)";
export const OFFLINE = "Can't reach the server — check your connection and try again.";

// 'throttled' (per-network limit). retry_after is seconds when the server sends it.
export function throttledText(retryAfter) {
  const s = Number(retryAfter);
  if (Number.isFinite(s) && s > 0) {
    const min = Math.max(1, Math.ceil(s / 60));
    return `Too many attempts from this network — try again in ${min} min`;
  }
  return "Too many attempts from this network — try again in a few minutes";
}

// The old server's `locked` answer: the sign-in screen switches to unlock mode (design §5, #11).
export function signInSwitchesToUnlock(r) {
  return r?.reason === "locked";
}

// sign_in answer -> one message. Every failure except the network limit (and the old server's `locked`) reads the same.
export function signInError(r) {
  if (r?.reason === "throttled") return throttledText(r.retry_after);
  // A member signing in from a build older than one-account-per-browser (migration 20261026600000).
  if (r?.reason === "update_required") return "This page is out of date. Reload it, then sign in again.";
  if (signInSwitchesToUnlock(r)) return SIGNIN_LOCKED_OLD;
  return SIGNIN_FAILED;
}

// The old server's `backup_locked` answer (before M1), with its own minutes (default 15).
export function backupLockedText(retryAfter) {
  const s = Number(retryAfter);
  const min = Math.max(1, Math.ceil((Number.isFinite(s) && s > 0 ? s : 900) / 60));
  return `Too many wrong backup codes — try again in ${min} min.`;
}

// unlock (backup code) answer -> one message. Only input checks the user can fix are named.
export function backupCodeError(r) {
  if (r?.reason === "throttled") return throttledText(r.retry_after);
  if (r?.reason === "backup_locked") return backupLockedText(r.retry_after);
  if (r?.reason === "weak_password") return "New password must be at least 8 characters";
  return BACKUP_CODE_FAILED;
}

// join_with_invite answer -> one message (supabase/migrations/20261026500000_mu_p5_invites.sql). Every code that doesn't
// work (unknown, used, expired, revoked) reads the same, as the server answers.
export function joinError(r) {
  if (r?.reason === "closed") return "Joining isn't open yet. Ask the person who invited you when to try again.";
  if (r?.reason === "invalid_username") return "Choose a name of 2 to 64 letters, digits, - or _ (no spaces or other characters).";
  if (r?.reason === "weak_password") return "Use a password of at least 8 characters.";
  if (r?.reason === "username_taken") return "That name is taken. Choose another one (after 5 taken names this invite stops working).";
  if (r?.reason === "throttled") return throttledText(r.retry_after);
  return "That invite code doesn't work. It may be mistyped, used, expired or revoked.";
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
  return accountError(r, "Couldn't make the invite. Try again.");
}

// Password-checked account RPCs (rename, change password, set backup code) for the signed-in account.
export function accountError(r, fallback) {
  if (r?.reason === "invalid") return "Current password is wrong (this counts toward the 3-attempt lockout)";
  if (r?.reason === "locked") return "Too many wrong passwords — sign-in is now locked. Sign out and unlock it with your backup code.";
  if (r?.reason === "rate_limited") return RENAME_RATE_LIMITED;
  if (r?.reason === "throttled") return throttledText(r.retry_after);
  if (r?.reason === "username_taken") return "That username is taken";
  if (r?.reason === "weak_password") return "New password must be at least 8 characters";
  if (r?.reason === "invalid_username") return "Username: 2–64 characters, no spaces, dots, colons or slashes";
  if (r?.reason === "too_short") return "Backup code must be at least 12 characters";
  return fallback;
}
