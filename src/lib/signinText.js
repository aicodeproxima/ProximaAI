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
