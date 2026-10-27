// Sign-in history (owner 2026-10-27: only the owner sees it, for every account). Pure: the words for the events the server
// records (supabase/migrations/20261027100000_signin_history.sql), the source of an event (network code first: the
// browser and app marker are whatever the caller claimed), New York time with EDT/EST, the account filter's choices, each
// account's last sign-in line, and how an answer from the server joins what is shown. Tested by
// scripts/test-signin-history-client.mjs.

const WENT_THROUGH = new Set(["ok", "ok_password_reset"]);
const WORDS = {
  signin: {
    ok: "Signed in", wrong_password: "Wrong password", locked_now: "Wrong password, account locked",
    locked: "Sign-in tried while locked", unknown: "Sign-in to a name no account has", disabled: "Sign-in to a disabled account",
    deleted: "Sign-in to a deleted account",
    no_password: "Sign-in to an account without a password", update_required: "Sign-in from an old app version (refused)",
  },
  unlock: {
    ok: "Unlocked with the backup code", ok_password_reset: "Password reset with the backup code", wrong_code: "Wrong backup code",
    paused_now: "Wrong backup code, unlocking paused 15 min", paused: "Unlock tried while paused",
    unknown: "Unlock for a name no account has", disabled: "Unlock of a disabled account", deleted: "Unlock of a deleted account",
    no_backup_code: "Unlock of an account without a backup code", update_required: "Unlock from an old app version (refused)",
    weak_password: "Backup-code reset with a too-short new password (refused)",
  },
  join: {
    ok: "Joined (account created)", closed: "Join tried while joining is closed", invalid_username: "Join with a name that isn't allowed",
    weak_password: "Join with a too-short password", throttled: "Join refused: too many attempts from this network",
    invalid: "Invite code didn't work", username_taken: "Join with a name already taken",
    invite_voided: "Invite code voided: too many taken names tried with it",
    invite_creator_gone: "Invite code refused: the owner who made it changed",
  },
  reauth: {
    ok: "Password confirmed for an account change", wrong_password: "Wrong password on an account change",
    locked_now: "Wrong password on an account change, account locked", locked: "Account change tried while locked",
  },
};
const KIND_WORD = { signin: "sign-in", unlock: "unlock", join: "join", reauth: "password" };
// past the log's hourly limits (per account: failures, successes and lock moments apart), what one counted row stands for
const OK_WORDS = { signin: ["sign-in", "sign-ins"], unlock: ["unlock", "unlocks"], join: ["join", "joins"],
  reauth: ["password confirmation", "password confirmations"] };
const LOCK_WORDS = { unlock: ["unlock pause", "unlock pauses"] };
const LIMIT = "not recorded one by one (hourly limit reached)";

// { text, ok }: ok when the sign-in, unlock, join or password check went through. Repeats are counted ("×3"); a
// 'suppressed' / 'suppressed_ok' / 'suppressed_lock' row counts the failures, successes or lockouts past the log's
// hourly limit. An outcome this build has no words for is shown as sent.
export function eventLabel(e) {
  const n = Math.max(1, Number(e?.repeats) || 1);
  const pick = ([one, many]) => (n === 1 ? one : many);
  if (e?.outcome === "suppressed") {
    const what = KIND_WORD[e?.kind] || "";
    return { text: `${n} more failed ${what ? what + " " : ""}attempt${n === 1 ? "" : "s"} ${LIMIT}`, ok: false };
  }
  if (e?.outcome === "suppressed_ok") return { text: `${n} more ${pick(OK_WORDS[e?.kind] || ["success", "successes"])} ${LIMIT}`, ok: true };
  if (e?.outcome === "suppressed_lock") return { text: `${n} more ${pick(LOCK_WORDS[e?.kind] || ["lockout", "lockouts"])} ${LIMIT}`, ok: false };
  let text = WORDS[e?.kind]?.[e?.outcome] || `${e?.kind || "event"}: ${e?.outcome || "?"}`;
  if (e?.throttled && e?.outcome !== "throttled") text += " · network throttled";
  if (n > 1) text += ` ×${n}`;
  return { text, ok: WENT_THROUGH.has(e?.outcome) };
}

// "Chrome on Android" from a browser string. Anything unrecognised is caller-chosen text: only its first word, cut to
// letters, digits and . / ( ) ; _ - (at most 24), is shown, never a sentence ("Other device (curl/8.4.0)").
export function deviceLabel(ua) {
  const s = typeof ua === "string" ? ua.trim() : "";
  if (!s) return "Unknown device";
  const browser = /SamsungBrowser\//.test(s) ? "Samsung Internet" : /Edg(A|iOS)?\//.test(s) ? "Edge" : /OPR\/|Opera/.test(s) ? "Opera"
    : /Firefox\/|FxiOS\//.test(s) ? "Firefox" : /Chrome\/|CriOS\//.test(s) ? "Chrome"
    : /Safari\//.test(s) && /Version\//.test(s) ? "Safari" : null;
  const os = /Android/.test(s) ? "Android" : /iPhone/.test(s) ? "iPhone" : /iPad/.test(s) ? "iPad" : /CrOS/.test(s) ? "ChromeOS"
    : /Windows/.test(s) ? "Windows" : /Mac OS X|Macintosh/.test(s) ? "Mac" : /Linux/.test(s) ? "Linux" : null;
  if (browser && os) return `${browser} on ${os}`;
  if (browser) return browser;
  const word = (s.split(/\s+/)[0] || "").replace(/[^A-Za-z0-9./();_-]/g, "").slice(0, 24);
  return word ? `Other device (${word})` : "Other device";
}

// What the request's x-client-info marker claims (src/lib/session.js): anyone can send any marker, so it is worded as a
// claim. A script calling the server directly usually sends none.
export function appLabel(client) {
  const s = typeof client === "string" ? client : "";
  if (/(^|\s)proxima-guard\/1(\s|$)/.test(s)) return "says current app";
  if (/(^|\s)proxima-rls\/1(\s|$)/.test(s)) return "says older app";
  return "no app marker";
}

// Where an event came from, network code first (the one part the caller cannot choose). The server marks a folded row
// (or a counted row past the hourly limit) mixed when its attempts differed, and clears the field that differed:
// "several" only then; a field that is simply missing stays "no ...".
export function sourceLabel(e) {
  const mixed = e?.mixed === true;
  const net = e?.net ? `network ${e.net}` : mixed ? "several networks" : "no network code";
  const device = e?.agent ? deviceLabel(e.agent) : mixed ? "several browsers" : "Unknown device";
  const app = e?.client ? appLabel(e.client) : mixed ? "several apps" : "no app marker";
  return `${net} · ${device} · ${app}`;
}

const NY = "America/New_York";
const dayOf = ms => new Date(ms).toLocaleDateString("en-US", { timeZone: NY });

// New York time with its own zone name (EDT in summer, EST in winter): "Oct 27, 2:29 AM EDT".
export function formatWhen(ms) {
  return new Date(ms).toLocaleString("en-US", { timeZone: NY, month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short" });
}

// The time of an event; a folded row shows its first and latest attempt. The end carries its own zone (a span can cross
// the EDT/EST change) and its date when it falls on another New York day.
export function whenLabel(e) {
  const first = formatWhen(e.at);
  if (!(Number(e?.repeats) > 1) || !e?.last_at || e.last_at === e.at) return first;
  const end = dayOf(e.last_at) === dayOf(e.at)
    ? new Date(e.last_at).toLocaleString("en-US", { timeZone: NY, hour: "numeric", minute: "2-digit", timeZoneName: "short" })
    : formatWhen(e.last_at);
  return `${first} to ${end}`;
}

const LAST_KIND = { unlock: " (backup-code unlock)", join: " (joined)" };

// An account's line in "Last sign-in per account": when, how, from where (network first). The log starts with this
// feature, so an account with no line has none RECORDED, not none at all. Past the hourly limit the latest sign-in is
// only counted (last_ok_counted): its time is still the latest, its source is that counted row's.
export function lastSignInLabel(a) {
  if (!a?.last_ok_at) return "no sign-in recorded";
  const mixed = a.last_ok_mixed === true;
  const net = a.last_ok_net ? `network ${a.last_ok_net}` : mixed ? "several networks" : "no network code";
  const device = a.last_ok_agent ? deviceLabel(a.last_ok_agent) : mixed ? "several browsers" : "Unknown device";
  const counted = a.last_ok_counted === true ? " · past the hourly limit" : "";
  return `${formatWhen(a.last_ok_at)}${LAST_KIND[a.last_ok_kind] || ""}${counted} · ${net} · ${device}`;
}

// Attempts that did not go through, counting every repeat on a line (a "×5" line is five attempts).
export function failedAttempts(events) {
  return (Array.isArray(events) ? events : []).reduce((sum, e) => (eventLabel(e).ok ? sum : sum + Math.max(1, Number(e?.repeats) || 1)), 0);
}

// The account filter: all, each account the server lists (owner first), and the events of no account.
export function accountChoices(accounts) {
  const list = Array.isArray(accounts) ? accounts : [];
  return [{ value: "all", label: "All accounts" },
    ...list.map(a => ({ value: a.account_id, label: `${a.username}${a.role === "owner" ? " (owner)" : ""}${a.disabled ? " (disabled)" : ""}${a.deleted ? " (deleted)" : ""}` })),
    { value: "none", label: "No account (unknown names, joins)" }];
}

// A first page replaces the list; an older page (asked with beforeId) is added after it, without repeats.
export function mergePage(prev, page, beforeId) {
  const events = Array.isArray(page?.events) ? page.events : [];
  if (!beforeId || !prev) return { events, more: !!page?.more, accounts: page?.accounts || [] };
  const seen = new Set(prev.events.map(e => e.id));
  return { events: [...prev.events, ...events.filter(e => !seen.has(e.id))], more: !!page?.more, accounts: page?.accounts || prev.accounts };
}

// What the section shows after an answer: state { data, error, busy }. Only the newest request's answer counts (mine is
// that request's number, latest the newest one asked): an older answer, success or failure, changes nothing, so switching
// accounts quickly never shows another account's list or a stale error. A success clears an earlier error.
export function applyAnswer(state, { latest, mine, ok, page, beforeId }) {
  if (mine !== latest) return state;
  if (ok) return { data: mergePage(state?.data || null, page, beforeId), error: false, busy: false };
  return { data: state?.data || null, error: true, busy: false };
}
