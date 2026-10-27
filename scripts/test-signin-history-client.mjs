// Sign-in history on the client (owner 2026-10-27: only the owner sees it, for every account). The exact words for each
// event, the source (network first; browser and app marker worded as claims), EDT/EST, the account filter, paging, and the
// owner-only section in Settings with its read. Review wf_22e47bf1-fa6 L10: each check here fails on a plausible wrong
// build (a failure worded as a success, a second unguarded render, HTML from a browser string, a dropped filter).
// Run: node scripts/test-signin-history-client.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertStripKeepsStrings } from "./lib/strip-comments.mjs";

let H = {};
try { H = await import("../src/lib/signinHistory.js"); } catch {}
const app = assertStripKeepsStrings(readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8"));
const sb = assertStripKeepsStrings(readFileSync(new URL("../src/lib/supabase.js", import.meta.url), "utf8"));
const sbRaw = readFileSync(new URL("../src/lib/supabase.js", import.meta.url), "utf8");
let comp = "";
try { comp = assertStripKeepsStrings(readFileSync(new URL("../src/components/SigninHistory.jsx", import.meta.url), "utf8")); } catch {}
let n = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", String(e?.message || e).split("\n").slice(0, 3).join(" | ")); }
};

// every outcome the migration can record, with its exact words
const EXPECTED = {
  signin: { ok: "Signed in", wrong_password: "Wrong password", locked_now: "Wrong password, account locked",
    locked: "Sign-in tried while locked", unknown: "Sign-in to a name no account has", disabled: "Sign-in to a disabled account",
    deleted: "Sign-in to a deleted account",
    no_password: "Sign-in to an account without a password", update_required: "Sign-in from an old app version (refused)" },
  unlock: { ok: "Unlocked with the backup code", ok_password_reset: "Password reset with the backup code", wrong_code: "Wrong backup code",
    paused_now: "Wrong backup code, unlocking paused 15 min", paused: "Unlock tried while paused",
    unknown: "Unlock for a name no account has", disabled: "Unlock of a disabled account", deleted: "Unlock of a deleted account",
    no_backup_code: "Unlock of an account without a backup code", update_required: "Unlock from an old app version (refused)",
    weak_password: "Backup-code reset with a too-short new password (refused)" },
  join: { ok: "Joined (account created)", closed: "Join tried while joining is closed", invalid_username: "Join with a name that isn't allowed",
    weak_password: "Join with a too-short password", throttled: "Join refused: too many attempts from this network",
    invalid: "Invite code didn't work", username_taken: "Join with a name already taken",
    invite_voided: "Invite code voided: too many taken names tried with it",
    invite_creator_gone: "Invite code refused: the owner who made it changed" },
  reauth: { ok: "Password confirmed for an account change", wrong_password: "Wrong password on an account change",
    locked_now: "Wrong password on an account change, account locked", locked: "Account change tried while locked" },
};

await test("every outcome the server records has its exact words, and says whether it went through", () => {
  for (const [kind, outcomes] of Object.entries(EXPECTED)) for (const [o, words] of Object.entries(outcomes)) {
    const l = H.eventLabel({ kind, outcome: o });
    assert.equal(l.text, words, `${kind}/${o}`);
    assert.equal(l.ok, o === "ok" || o === "ok_password_reset", `${kind}/${o} ok`);
    if (!l.ok) assert.ok(!/^(Signed in|Joined|Unlocked|Password reset|Password confirmed)/.test(l.text), `${kind}/${o} reads as a success`);
  }
  assert.ok(H.eventLabel({ kind: "signin", outcome: "something_new" }).text.includes("something_new"), "an unknown outcome is shown as it is");
});

await test("throttled, repeats and the hourly-limit row", () => {
  assert.equal(H.eventLabel({ kind: "signin", outcome: "wrong_password", throttled: true }).text, "Wrong password · network throttled");
  assert.equal(H.eventLabel({ kind: "join", outcome: "throttled", throttled: true }).text, EXPECTED.join.throttled, "no doubled throttled wording");
  assert.equal(H.eventLabel({ kind: "signin", outcome: "wrong_password", repeats: 3 }).text, "Wrong password ×3");
  assert.equal(H.eventLabel({ kind: "signin", outcome: "ok", repeats: 1 }).text, "Signed in");
  const s = H.eventLabel({ kind: "signin", outcome: "suppressed", repeats: 42 });
  assert.equal(s.text, "42 more failed sign-in attempts not recorded one by one (hourly limit reached)");
  assert.equal(s.ok, false);
  assert.equal(H.eventLabel({ kind: "join", outcome: "suppressed" }).text, "1 more failed join attempt not recorded one by one (hourly limit reached)");
});

await test("successes and lockouts past the hourly limit have their own counted rows", () => {
  const L = (kind, outcome, repeats) => H.eventLabel({ kind, outcome, repeats });
  assert.deepEqual(L("signin", "suppressed_ok", 5), { text: "5 more sign-ins not recorded one by one (hourly limit reached)", ok: true });
  assert.equal(L("unlock", "suppressed_ok", 2).text, "2 more unlocks not recorded one by one (hourly limit reached)");
  assert.equal(L("join", "suppressed_ok", 3).text, "3 more joins not recorded one by one (hourly limit reached)");
  assert.equal(L("reauth", "suppressed_ok", 1).text, "1 more password confirmation not recorded one by one (hourly limit reached)");
  assert.deepEqual(L("signin", "suppressed_lock", 2), { text: "2 more lockouts not recorded one by one (hourly limit reached)", ok: false });
  assert.equal(L("reauth", "suppressed_lock", 1).text, "1 more lockout not recorded one by one (hourly limit reached)");
  assert.equal(L("unlock", "suppressed_lock", 1).text, "1 more unlock pause not recorded one by one (hourly limit reached)");
  assert.equal(L("unlock", "suppressed_lock", 4).text, "4 more unlock pauses not recorded one by one (hourly limit reached)");
  // a counted row keeps its source the way a folded row does (review wf_79964fbc-e0a)
  for (const o of ["suppressed", "suppressed_ok", "suppressed_lock"])
    assert.equal(H.sourceLabel({ outcome: o, net: "ab12cd34", agent: null, client: null, mixed: true, repeats: 9 }),
      "network ab12cd34 · several browsers · several apps", o);
});

await test("failed attempts count every repeat on a line", () => {
  assert.equal(H.failedAttempts([{ kind: "signin", outcome: "ok", repeats: 3 }, { kind: "signin", outcome: "wrong_password", repeats: 5 },
    { kind: "signin", outcome: "suppressed", repeats: 40 }, { kind: "signin", outcome: "suppressed_ok", repeats: 7 },
    { kind: "signin", outcome: "locked_now" }]), 46);
  assert.equal(H.failedAttempts(undefined), 0);
});

await test("deviceLabel: browser and system; anything else only as one cleaned word", () => {
  const d = H.deviceLabel;
  assert.equal(d("Mozilla/5.0 (Linux; Android 14; SM-S928U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36"), "Chrome on Android");
  assert.equal(d("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0"), "Edge on Windows");
  assert.equal(d("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"), "Safari on iPhone");
  assert.equal(d("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15"), "Safari on Mac");
  assert.equal(d("Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0 Mobile Safari/537.36"), "Samsung Internet on Android");
  assert.equal(d("Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0"), "Firefox on Linux");
  assert.equal(d("curl/8.4.0"), "Other device (curl/8.4.0)");
  assert.equal(d("SECURITY NOTICE: call +1 555 0100 now"), "Other device (SECURITY)", "a caller's sentence never reaches the screen");
  assert.equal(d("<img src=x onerror=alert(1)>"), "Other device (img)");
  assert.equal(d("::::"), "Other device");
  assert.equal(d(""), "Unknown device");
  assert.equal(d(null), "Unknown device");
});

await test("app marker and source are worded as claims, network first; 'several' only on a row the server marked mixed", () => {
  assert.equal(H.appLabel("supabase-js-web/2.45.0 proxima-rls/1 sess/0 proxima-guard/1"), "says current app");
  assert.equal(H.appLabel("supabase-js-web/2.45.0 proxima-rls/1 sess/0"), "says older app");
  assert.equal(H.appLabel(""), "no app marker");
  assert.equal(H.appLabel("python-requests/2.31"), "no app marker");
  const ua = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";
  assert.equal(H.sourceLabel({ net: "ab12cd34", agent: ua, client: "proxima-guard/1", repeats: 1 }), "network ab12cd34 · Chrome on Android · says current app");
  assert.equal(H.sourceLabel({ net: null, agent: null, client: null, repeats: 4, mixed: true }), "several networks · several browsers · several apps");
  assert.equal(H.sourceLabel({ net: null, agent: null, client: null, repeats: 4, mixed: false }), "no network code · Unknown device · no app marker",
    "repeats that all lacked a field are not 'several'");
  assert.equal(H.sourceLabel({ net: "ab12cd34", agent: null, client: "proxima-guard/1", repeats: 3, mixed: true }),
    "network ab12cd34 · several browsers · says current app", "only the cleared field is 'several'");
  assert.equal(H.sourceLabel({ net: null, agent: null, client: null, repeats: 1 }), "no network code · Unknown device · no app marker");
});

await test("times are New York time with EDT in summer and EST in winter; a folded row shows its span with the end's zone", () => {
  assert.equal(H.formatWhen(Date.UTC(2026, 9, 27, 6, 29)), "Oct 27, 2:29 AM EDT");
  assert.equal(H.formatWhen(Date.UTC(2026, 0, 15, 17, 5)), "Jan 15, 12:05 PM EST");
  const at = Date.UTC(2026, 9, 27, 6, 29), last = Date.UTC(2026, 9, 27, 6, 37);
  assert.equal(H.whenLabel({ at, last_at: at, repeats: 1 }), "Oct 27, 2:29 AM EDT");
  assert.equal(H.whenLabel({ at, last_at: last, repeats: 3 }), "Oct 27, 2:29 AM EDT to 2:37 AM EDT");
  assert.equal(H.whenLabel({ at: Date.UTC(2026, 9, 27, 3, 50), last_at: Date.UTC(2026, 9, 27, 4, 20), repeats: 2 }),
    "Oct 26, 11:50 PM EDT to Oct 27, 12:20 AM EDT", "a span past New York midnight names both days");
  assert.equal(H.whenLabel({ at: Date.UTC(2026, 10, 1, 5, 30), last_at: Date.UTC(2026, 10, 1, 6, 20), repeats: 2 }),
    "Nov 1, 1:30 AM EDT to 1:20 AM EST", "a span across the clock change: the end reads earlier but carries EST");
});

await test("each account's last sign-in line: when, how, network first; none RECORDED (the log is new)", () => {
  const ua = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";
  const t = Date.UTC(2026, 9, 27, 6, 29);
  assert.equal(H.lastSignInLabel({ username: "x" }), "no sign-in recorded");
  assert.equal(H.lastSignInLabel({ last_ok_at: t, last_ok_kind: "signin", last_ok_net: "ab12cd34", last_ok_agent: ua, last_ok_mixed: false }),
    "Oct 27, 2:29 AM EDT · network ab12cd34 · Chrome on Android");
  assert.equal(H.lastSignInLabel({ last_ok_at: t, last_ok_kind: "unlock", last_ok_net: null, last_ok_agent: null, last_ok_mixed: true }),
    "Oct 27, 2:29 AM EDT (backup-code unlock) · several networks · several browsers");
  assert.equal(H.lastSignInLabel({ last_ok_at: t, last_ok_kind: "join", last_ok_net: null, last_ok_agent: null, last_ok_mixed: false }),
    "Oct 27, 2:29 AM EDT (joined) · no network code · Unknown device");
  assert.equal(H.lastSignInLabel({ last_ok_at: t, last_ok_kind: "signin", last_ok_net: "ab12cd34", last_ok_agent: ua, last_ok_mixed: false,
    last_ok_counted: true }), "Oct 27, 2:29 AM EDT · past the hourly limit · network ab12cd34 · Chrome on Android",
    "a sign-in past the hourly limit still shows as the latest, marked");
  assert.ok(!H.lastSignInLabel({ last_ok_at: t, last_ok_counted: false }).includes("limit"));
});

await test("an answer is shown only if it is the newest request's; a success clears an earlier error", () => {
  const s0 = { data: null, error: false, busy: true };
  const page = { ok: true, events: [{ id: 5 }], more: false, accounts: [{ account_id: "o1" }] };
  const s1 = H.applyAnswer(s0, { latest: 1, mine: 1, ok: false, page: null, beforeId: null });
  assert.deepEqual(s1, { data: null, error: true, busy: false, retryBefore: null }, "a failure shows the error");
  const s2 = H.applyAnswer({ ...s1, busy: true }, { latest: 2, mine: 2, ok: true, page, beforeId: null });
  assert.equal(s2.error, false, "fail, then succeed: the error is gone");
  assert.deepEqual(s2.data.events.map(e => e.id), [5]);
  assert.equal(s2.busy, false);
  assert.equal(H.applyAnswer(s2, { latest: 2, mine: 1, ok: false, page: null, beforeId: null }), s2, "an older failure after a newer success changes nothing");
  const s3 = { ...s2, busy: true };
  assert.equal(H.applyAnswer(s3, { latest: 3, mine: 2, ok: true, page: { ok: true, events: [{ id: 99 }] }, beforeId: null }), s3,
    "an older success while a newer request is out changes nothing (still busy)");
  const s4 = H.applyAnswer(s2, { latest: 4, mine: 4, ok: false, page: null, beforeId: 5 });
  assert.equal(s4.error, true);
  assert.equal(s4.data, s2.data, "a failed 'Load older' keeps what was loaded");
  assert.equal(s4.retryBefore, 5, "and Retry asks for that same older page again");
  const s5 = H.applyAnswer({ ...s4, busy: true }, { latest: 5, mine: 5, ok: true, page: { ok: true, events: [{ id: 4 }], more: false }, beforeId: 5 });
  assert.deepEqual([s5.error, s5.retryBefore, s5.data.events.map(e => e.id)], [false, null, [5, 4]], "the retried page joins the list, error gone");
});

await test("rows belong to the filter they were loaded for (review wf_79964fbc-e0a Lows)", () => {
  const page = a => ({ ok: true, events: [{ id: a === "m1" ? 7 : 9 }], more: true, accounts: [] });
  const sAll = H.applyAnswer({}, { latest: 1, mine: 1, ok: true, page: page("all"), beforeId: null, account: "all" });
  assert.equal(sAll.data.account, "all");
  assert.deepEqual(H.rowsFor(sAll.data, "all").map(e => e.id), [9]);
  assert.deepEqual(H.rowsFor(sAll.data, "m1"), [], "after a switch to m1, the all-accounts rows do not stand under it");
  const sFail = H.applyAnswer({ ...sAll, busy: true }, { latest: 2, mine: 2, ok: false, page: null, beforeId: null, account: "m1" });
  assert.deepEqual(H.rowsFor(sFail.data, "m1"), [], "the switch failed: still no rows of another filter");
  assert.equal(sFail.retryBefore, null, "Retry asks for m1's first page");
  const sM = H.applyAnswer(sFail, { latest: 3, mine: 3, ok: true, page: page("m1"), beforeId: 9, account: "m1" });
  assert.deepEqual(sM.data.events.map(e => e.id), [7], "an older page never joins another filter's list");
  assert.deepEqual(H.rowsFor(sM.data, "m1").map(e => e.id), [7], "m1's page shows under m1");
  assert.deepEqual(H.rowsFor(sM.data, "all"), [], "and not under all accounts");
  assert.deepEqual(H.rowsFor(null, "all"), []);
});

await test("account filter choices and paging", () => {
  const c = H.accountChoices([{ account_id: "o1", username: "Owner", role: "owner" }, { account_id: "m1", username: "DJI", role: "member", disabled: true }]);
  assert.deepEqual(c.map(x => x.value), ["all", "o1", "m1", "none"]);
  assert.deepEqual(c.map(x => x.label), ["All accounts", "Owner (owner)", "DJI (disabled)", "No account (unknown names, joins)"]);
  assert.deepEqual(H.accountChoices(undefined).map(x => x.value), ["all", "none"]);
  const p1 = H.mergePage(null, { events: [{ id: 9 }, { id: 8 }], more: true, accounts: [{ account_id: "o1" }] }, null);
  assert.deepEqual(p1.events.map(e => e.id), [9, 8]);
  assert.equal(p1.more, true);
  const p2 = H.mergePage(p1, { events: [{ id: 8 }, { id: 7 }], more: false, accounts: [] }, 8);
  assert.deepEqual(p2.events.map(e => e.id), [9, 8, 7], "older page appended, no repeats");
  assert.equal(p2.more, false);
  const p3 = H.mergePage(p2, { events: [{ id: 11 }], more: false, accounts: [] }, null);
  assert.deepEqual(p3.events.map(e => e.id), [11], "a first page (refresh, another account) replaces the list");
});

await test("supabase.js reads it through the session RPC with the cursor and the filter", () => {
  assert.match(sb, /export async function listSignins\(\{ limit = 100, beforeId = null, account = null \} = \{\}\) \{\s*const r = await sessionRpc\("list_signins", \{ p_limit: limit, p_before_id: beforeId, p_account: account \}\);/);
  const fnAt = sbRaw.indexOf("export async function listSignins"), invitesDoc = sbRaw.indexOf("// The owner's invites (state only)");
  assert.ok(fnAt > 0 && invitesDoc > fnAt && sbRaw.indexOf("export async function listMyInvites") > invitesDoc,
    "listMyInvites keeps its own comment, after listSignins");
});

await test("Settings shows it once, to the owner only, as text", () => {
  assert.match(app, /import SigninHistory from "\.\/components\/SigninHistory\.jsx";/);
  assert.equal((app.match(/<SigninHistory\b/g) || []).length, 1, "exactly one render");
  assert.match(app, /\{readBrowserAccount\(\)\?\.role === "owner" && <SigninHistory font=\{font\} \/>\}/);
  assert.ok(comp.length > 0, "component exists");
  assert.ok(!/dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML/.test(comp), "browser strings are text, never HTML");
  assert.match(comp, /listSignins\(\{ limit: PAGE, beforeId, account: account === "all" \? null : account \}\)/, "the filter and cursor go to the server");
  assert.match(comp, /<select className="setting-input" aria-label="Account" value=\{who\} onChange=\{e => setWho\(e\.target\.value\)\}/,
    "the account filter is labelled for screen readers");
  assert.match(comp, /useEffect\(\(\) => \{ load\(who, null\); \}, \[who, load\]\)/, "a new account choice reloads from the server");
  assert.match(comp, /const mine = \+\+seq\.current;/);
  assert.match(comp, /const latest = seq\.current;\s*setState\(s => applyAnswer\(s, \{ latest, mine, ok: r\?\.ok === true, page: r, beforeId, account \}\)\);/,
    "every answer, success or failure, goes through applyAnswer with the newest request's number read after it arrived, and its filter");
  assert.match(comp, /const events = rowsFor\(data, who\);/, "rows only of the selected filter");
  assert.match(comp, /onClick=\{\(\) => load\(who, retryBefore\)\}/, "Retry asks again for the page that failed");
  assert.match(comp, /<div style=\{\{ color: "var\(--text-muted\)", marginTop: 2 \}\}>\{whenLabel\(e\)\}<\/div>/,
    "the time on its own line (a span needs the width at 384 px)");
  assert.match(comp, /onClick=\{\(\) => load\(who, oldest\)\}/, "Load older asks for the page before the oldest shown");
  assert.match(comp, /\{events\.length > 0 && \(/, "the rows show whenever the selected filter has some, an error included (a failed Load older keeps them)");
  assert.match(comp, /<div role="alert"/, "a load failure is announced");
  assert.match(comp, /const btn = \{ minHeight: 44,/, "Refresh / Retry / Load older are full-size tap targets");
  assert.ok(!/ EST`/.test(comp), "no fixed 'EST' label (EDT half the year)");
  assert.match(comp, /\{a\.deleted \? " \(deleted\)" : ""\}:\{" "\}\s*\{lastSignInLabel\(a\)\}/, "the summary marks deleted accounts and uses lastSignInLabel");
  assert.ok(!/last 90 days"/.test(comp), "the summary never claims 'no sign-in in the last 90 days' (the log starts with this feature)");
  assert.match(comp, /const refused = failedAttempts\(events\);/, "the count line counts attempts, not lines");
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
