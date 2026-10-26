// One account per browser (docs/SECOND-ACCOUNT-PLAN.md S5, its first and minimal form). This browser's IndexedDB, queues
// and logs are not split per account yet (plan §5 P2), so they belong to ONE account: the one recorded here. Another
// account cannot sign in on this browser (it would see that account's local generations, and its queued writes would go
// out under the other account's session). Before members existed, every browser's local data was the owner's: a browser
// with local data and no record yet can be claimed by the owner only. A rename keeps the record (it holds the account id).
// Sign-out keeps it too (the local data stays). A private window or another browser profile is a separate browser here.
export const BROWSER_ACCOUNT_KEY = "proximaai-browser-account";

// { id, username, role } of the account this browser's data belongs to; null when none is recorded; { id: null,
// unreadable: true } when a record exists but cannot be read (review r6: never taken for "none", which the owner could
// claim; it refuses every account until the site's data is cleared). Storage that cannot be read at all counts as unreadable.
export function readBrowserAccount() {
  let raw;
  try { raw = localStorage.getItem(BROWSER_ACCOUNT_KEY); } catch { return { id: null, unreadable: true }; }
  if (raw == null) return null;
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v.id !== "string" || !v.id) return { id: null, unreadable: true };
    const out = { id: v.id, username: typeof v.username === "string" ? v.username : null };
    if (typeof v.role === "string") out.role = v.role;
    return out;
  } catch { return { id: null, unreadable: true }; }
}

// The account a session token names (u:<uuid>.<expiry>.<signature>), or null (an older token shape, or none).
export function tokenAccountId(token) {
  const m = /^u:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\./i.exec(typeof token === "string" ? token : "");
  return m ? m[1].toLowerCase() : null;
}

// Does the session restored at page load fit this browser, before anything loads or syncs? With no record, yes: every
// session issued since this guard exists claimed the browser first, so one without a record is from before members existed
// (the owner's), and the account check after load claims it. With a record, only a token naming that account.
export function sessionFitsBrowser(token, stored) {
  if (typeof token !== "string" || !token) return false;
  if (stored?.unreadable) return false;
  if (!stored?.id) return true;
  return tokenAccountId(token) === stored.id.toLowerCase();
}

// At page load (review r6 security #1): "none" (no session), "fit" (the record names its account: use it), "check" (no
// record yet: ask the server whose session it is, and decide with browserAccountDecision BEFORE anything loads or syncs),
// "refuse" (another account's, or an unreadable record).
export function bootSessionDecision(session, stored) {
  const token = session?.token;
  if (typeof token !== "string" || !token) return "none";
  if (stored?.unreadable) return "refuse";
  if (!stored?.id) return "check";
  return sessionFitsBrowser(token, stored) ? "fit" : "refuse";
}

// A new account may be made from this browser (join) only when no account's data is here yet.
export function freeForNewAccount({ stored, hasLocalData }) {
  return !stored && !hasLocalData;
}

// May `account` ({ id, role, username }, from the server) use this browser? `stored`: readBrowserAccount(); `hasLocalData`:
// this browser holds generations, History or queued writes. Answers { ok: true, claim } (claim: record it as this
// browser's account) or { ok: false, reason: "other-account" | "unknown-account", other } (`other`: the recorded name).
export function browserAccountDecision({ stored, hasLocalData, account }) {
  if (!account || typeof account.id !== "string" || !account.id) return { ok: false, reason: "unknown-account", other: null };
  if (stored?.unreadable) return { ok: false, reason: "unreadable-record", other: null };
  if (stored?.id) {
    return stored.id === account.id ? { ok: true, claim: stored.username !== account.username }
      : { ok: false, reason: "other-account", other: stored.username || null };
  }
  if (!hasLocalData || account.role === "owner") return { ok: true, claim: true };
  return { ok: false, reason: "other-account", other: null };
}

// Records `account` as this browser's. True only when the record reads back (a full or blocked storage answers false).
// Review r7 (security #1): a compare-and-set. Only a browser with no record, or one recorded for this same account, is
// claimed: another tab may have claimed it for another account while this one waited for the server.
export function claimBrowser(account) {
  const stored = readBrowserAccount();
  if (stored && (stored.unreadable || stored.id !== account?.id)) return false;
  try {
    localStorage.setItem(BROWSER_ACCOUNT_KEY, JSON.stringify({ id: account.id, username: account.username || null, role: account.role || null }));
    return readBrowserAccount()?.id === account.id;
  } catch { return false; }
}

// A join that made the account but whose page was lost before CONTINUE (a reload, a closed tab: review r6 #7): its name, so
// sign-in opens with it and says the account exists. Not a secret; forgotten at the next sign-in or CONTINUE.
const JOINED_NOTE_KEY = "proximaai-joined-note";
export function rememberJoinedNote(username) { try { localStorage.setItem(JOINED_NOTE_KEY, String(username || "")); } catch {} }
export function readJoinedNote() { try { return localStorage.getItem(JOINED_NOTE_KEY) || ""; } catch { return ""; } }
export function forgetJoinedNote() { try { localStorage.removeItem(JOINED_NOTE_KEY); } catch {} }

// The words for a refusal (LoginScreen).
export function browserAccountMessage(decision) {
  if (decision?.reason === "unknown-account") return "Couldn't confirm your account. Check your connection and try again.";
  if (decision?.reason === "unreadable-record") return "This browser's record of which account it belongs to can't be read. To use this browser, clear this site's data in the browser's settings (anything not yet synced on it is lost), or use another browser.";
  if (decision?.reason === "claim-failed") return "This browser can't save which account it belongs to (its storage is full or blocked). Free some space or allow site storage, or use another browser.";
  const who = decision?.other ? ` (${decision.other})` : "";
  return `This browser keeps another account's generations${who}. Use your own device, another browser profile, or a private window to sign in to this account.`;
}
