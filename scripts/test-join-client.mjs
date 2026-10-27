// Second account S4/S5 client: joining by invite, unlocking by name, the owner's invites in Settings, and one account per
// browser on every way in (sign-in, join, a session restored at load). The words are tested on src/lib/signinText.js; the
// wiring on App.jsx and supabase.js with comments stripped (a commented-out line cannot satisfy a check).
// Written first: before the change every test fails. Run: node scripts/test-join-client.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertStripKeepsStrings } from "./lib/strip-comments.mjs";

const strip = (s) => assertStripKeepsStrings(s);   // scripts/lib/strip-comments.mjs (review r8 #13)
const app = strip(readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8"));
const sb = strip(readFileSync(new URL("../src/lib/supabase.js", import.meta.url), "utf8"));
let T = {};
try { T = await import("../src/lib/signinText.js"); } catch {}
let n = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", String(e?.message || e).split("\n").slice(0, 3).join(" | ")); }
};
const between = (s, a, b) => { const i = s.indexOf(a); assert.ok(i >= 0, `missing: ${a}`); const j = s.indexOf(b, i + a.length); assert.ok(j > i, `missing after ${a}: ${b}`); return s.slice(i, j); };

await test("joinError: each answer in words; any dead code reads the same", () => {
  assert.match(T.joinError({ reason: "closed" }), /isn't open yet/);
  assert.match(T.joinError({ reason: "invalid_username" }), /2 to 64 letters, digits, - or _/);
  assert.match(T.joinError({ reason: "weak_password" }), /at least 8 characters/);
  assert.match(T.joinError({ reason: "username_taken" }), /taken[\s\S]*5 taken names/);   // r6 #9: the limit is said
  assert.match(T.joinError({ reason: "throttled", retry_after: 300 }), /5 min/);
  assert.equal(T.joinError({ reason: "invalid" }), T.joinError({ reason: "anything else" }));
  assert.match(T.joinError({ reason: "invalid" }), /invite code doesn't work/);
  // r6 #7: after a network failure the account may exist: say how to find out, there and on a later 'invalid'
  assert.match(T.JOIN_MAYBE_CREATED, /If your account was created, sign in with the name and password you chose/);
  assert.match(T.signInError({ reason: "update_required" }), /out of date[\s\S]*reload/i);
});

await test("inviteError: closed, too many, not the owner; password answers as in the account screens", () => {
  assert.match(T.inviteError({ reason: "closed" }), /not switched on yet/);
  assert.match(T.inviteError({ reason: "too_many" }), /5 open invites/);
  assert.match(T.inviteError({ reason: "forbidden" }), /Only the owner/);
  assert.equal(T.inviteError({ reason: "invalid" }), T.accountError({ reason: "invalid" }, ""));
  assert.equal(T.inviteError({ reason: "locked" }), T.accountError({ reason: "locked" }, ""));
  assert.match(T.JOIN_BROWSER_TAKEN, /private window/);
});

await test("supabase.js: join, create, list and revoke call the four invite functions; a missing function reads as closed", () => {
  assert.match(sb, /supabase\.rpc\("join_with_invite", \{ p_code: code, p_username: username, p_password: password \}\)/);
  assert.match(sb, /sessionRpc\("create_invite", \{ p_current_password: currentPassword \}\)/);
  assert.match(sb, /sessionRpc\("list_my_invites"\)/);
  assert.match(sb, /sessionRpc\("revoke_invite", \{ p_invite_id: id \}\)/);
  assert.match(sb, /const notOnServer = \(err\) => err\?\.code === "PGRST202"/);
  assert.match(sb, /supabase\.rpc\("unlock_with_backup_code", \{ p_username: username, p_code: code, p_new_password: newPassword \|\| null \}\)/);
});

await test("supabase.js: unlock is always by name; without one nothing is sent (r6 #22a, r7 security #3)", () => {
  const fn = between(sb, "export async function unlockWithBackupCode(", "\n}\n");
  assert.match(fn, /if \(!username\) throw new Error\("Enter your username"\);/);
  assert.match(fn, /await supabase\.rpc\("unlock_with_backup_code", \{ p_username: username, p_code: code, p_new_password: newPassword \|\| null \}\)/);
  assert.ok(!/unlock_admin_with_backup_code/.test(sb), "the legacy owner-only unlock is never called");
});

await test("the r7 pins: refusal drops the session, Sign out drops it, the early join check's polarity, the refusal cleared on sign-in", () => {
  assert.match(app, /function refuseSession\(message\) \{ clearSession\(\); setAccountCheck\(null\); setSessionRefusal\(message\); \}/);
  assert.match(app, /onClick=\{\(\) => \{ clearSession\(\); setAccountCheck\(null\); \}\}>Sign out/);
  assert.match(app, /if \(!freeForNewAccount\(\{ stored: readBrowserAccount\(\), hasLocalData: await hasLocalData\(\) \}\) && !cancelled\) setError\(JOIN_BROWSER_TAKEN\);/);
  assert.match(between(app, "function handleSignedIn(session) {", "\n  }\n"), /setSessionRefusal\(""\);/);
  assert.match(app, /browserAccountMessage\(readBrowserAccount\(\)\?\.unreadable \? \{ reason: "unreadable-record" \} : \{ reason: "other-account", other: readBrowserAccount\(\)\?\.username \}\)/);
});

await test("an invite link opened while signed in is only removed, never kept for a later sign-out (r7 #5)", () => {
  assert.match(app, /const \[joinLink, setJoinLink\] = useState\(\(\) => \{ const j = takeJoinHash\(\); return bootFit === "none" \|\| bootFit === "refuse" \? j : null; \}\);/);
  const eff = between(app, "if (!joinLink) return;", "}, [joinLink]);");
  assert.ok(!/setInfo\(/.test(eff), "the join link does not wipe a notice (session expired)");
});

// Whole effects are compared with their whitespace folded (review r8 #10: a pinned line can stay while an early return,
// an emptied dependency list or a listener removed at once undoes the fix around it).
const fold = (t) => t.replace(/\s+/g, " ").trim();
const effectOf = (anchor) => { const at = app.indexOf(anchor); assert.ok(at >= 0, `missing: ${anchor}`); const i = app.lastIndexOf("useEffect(() => {", at); const j = app.indexOf("]);", app.indexOf("}, [", at)); assert.ok(i >= 0 && j > i, `effect of ${anchor}`); return fold(app.slice(i, j + 3)); };

await test("another tab changing the session or the record: a page not on its own account's session leaves (r7 #1/#2, r8 #4/#14)", () => {
  assert.equal(effectOf("const onStorage = (e) => {"), fold(`useEffect(() => {
    const onStorage = (e) => {
      if (e.key != null && e.key !== "proximaai-session" && e.key !== BROWSER_ACCOUNT_KEY) return;
      if (pageMustLeave({ authed: isAuthedRef.current, pageAccount: pageAccountId(), token: getSession()?.token, stored: readBrowserAccount() })) leavePage();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);`));
});

await test("the page's own account: bound on every way in, cleared at sign-out; a page that must leave stops first (r8 #1/#6/#8/#14)", () => {
  // #8: every guard reads isAuthedRef; it follows isAuthed on every render
  assert.match(app, /const \[isAuthed, setIsAuthed\] = useState\(bootFit === "fit"\);\s*const isAuthedRef = useRef\(isAuthed\);\s*isAuthedRef\.current = isAuthed;/);
  // bound: a fitting session at load, the account check, sign-in and join (handleSignedIn), each before isAuthed
  assert.match(app, /const decision = bootSessionDecision\(getSession\(\), readBrowserAccount\(\)\);\s*if \(decision === "refuse"\) clearSession\(\);\s*if \(decision === "fit"\) bindPageAccount\(tokenAccountId\(getSession\(\)\?\.token\)\);/);
  const signed = between(app, "function handleSignedIn(session) {", "\n  }\n");
  assert.ok(signed.indexOf("bindPageAccount(tokenAccountId(session?.token));") > 0 && signed.indexOf("bindPageAccount(") < signed.indexOf("setIsAuthed(true)"), "sign-in binds first");
  const check = between(app, "if (accountCheck !== \"checking\") return;", "}, [accountCheck]);");
  assert.ok(check.indexOf("bindPageAccount(tokenAccountId(getSession()?.token));") > 0 && check.indexOf("bindPageAccount(") < check.indexOf("setIsAuthed(true)"), "the check binds first");
  assert.match(between(app, "function signOutLocal() {", "\n  }\n"), /^function signOutLocal\(\) \{\s*clearSession\(\);\s*bindPageAccount\(null\);/);
  assert.equal(app.split("setIsAuthed(true)").length - 1, 2, "no other way in");
  // leaving: stop sending, then reload; told by session.js when a foreign token is asked for
  assert.match(fold(app), new RegExp(fold(`const leavingRef = useRef(false);
  function leavePage() {
    if (leavingRef.current) return;
    leavingRef.current = true;
    isAuthedRef.current = false;
    window.location.reload();
  }`).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(app, /useEffect\(\(\) => \{\s*onForeignSession\(leavePage\);\s*return \(\) => onForeignSession\(null\);\s*\}, \[\]\);/);
  // the 60-second check leaves too (a storage event can be missed, a cancelled reload must not keep a foreign session)
  assert.match(app, /const check = \(\) => \{\s*if \(!getSession\(\)\) expireSessionRef\.current\?\.\(\);\s*else if \(pageMustLeave\(\{ authed: isAuthedRef\.current, pageAccount: pageAccountId\(\), token: getSession\(\)\?\.token, stored: readBrowserAccount\(\) \}\)\) leavePage\(\);\s*\};/);
  // #1/#6: a leaving page neither flushes under the other session nor asks "Reload site?"
  assert.match(app, /const flushPending = \(\) => \{\s*if \(leavingRef\.current\) return;/);
  assert.match(app, /const onBeforeUnload = \(e\) => \{\s*if \(leavingRef\.current\) return;\s*flushPending\(\);/);
});

await test("the account check acts only on the session it checked (r8 #3)", () => {
  const eff = between(app, "if (accountCheck !== \"checking\") return;", "}, [accountCheck]);");
  assert.match(eff, /const checked = getSession\(\)\?\.token;/);
  assert.match(eff, /const step = accountCheckStep\(\{ checked, now: getSession\(\)\?\.token, answer \}\);/);
  assert.match(eff, /if \(step === "restart"\) \{ window\.location\.reload\(\); return; \}/);
  assert.match(eff, /if \(step === "drop"\) \{ clearSession\(\); setAccountCheck\(null\); setSessionNotice\(SESSION_EXPIRED\); return; \}/);
  assert.match(eff, /if \(step === "expired"\) \{ setAccountCheck\(null\); setSessionNotice\(SESSION_EXPIRED\); return; \}/);
  assert.match(eff, /if \(step !== "decide"\) \{ setAccountCheck\("failed"\); return; \}/);
  const v = eff.indexOf("const verdict = browserAccountDecision("), again = eff.indexOf("if (getSession()?.token !== checked) { window.location.reload(); return; }"), refuse = eff.indexOf("refuseSession(");
  assert.ok(v > 0 && again > v && refuse > again, `re-checked after the data count, before any refusal or claim: ${v} ${again} ${refuse}`);
  assert.ok(!/clearSession\(\)/.test(eff.slice(0, eff.indexOf("const step = "))), "nothing cleared before the step");
});

await test("the account check: a time limit, Sign out while checking, a retry when back online, an expired session said so (r7 #6)", () => {
  const eff = between(app, "if (accountCheck !== \"checking\") return;", "}, [accountCheck]);");
  assert.match(eff, /try \{ answer = await Promise\.race\(\[getMyAccount\(\), new Promise\(\(_, fail\) => setTimeout\(\(\) => fail\(new Error\("timeout"\)\), 15000\)\)\]\); \} catch \{\}/);
  assert.match(app, /if \(accountCheck !== "failed"\) return;\s*const back = \(\) => setAccountCheck\("checking"\);\s*window\.addEventListener\("online", back\);/);
  const screen = between(app, "if (accountCheck) {", "<LoginScreen onSignedIn=");
  assert.equal(screen.split(">Sign out</button>").length - 1, 2, "Sign out on both the checking and the failed screen");
});

await test("load-time effects wait for the account: the backups list and the form publications (r7 #8)", () => {
  assert.match(between(app, "const list = await listBackups(20);", "}, [isAuthed]);").length > 0 ? app : "", /if \(!isAuthed \|\| !isSupabaseConfigured\(\)\) return;\s*let cancelled = false;\s*\(async \(\) => \{\s*try \{\s*if \(!getSession\(\)\) return;\s*await initSupabase\(\);/);
  const pub = between(app, "const publish = () => {", "publish();");
  assert.match(pub, /if \(!isAuthedRef\.current\) return;/);
  assert.ok(pub.indexOf("if (!isAuthedRef.current) return;") < pub.indexOf("sendFormRow("), "before any cloud write");
  const bye = between(app, "const bye = (e) => {", "const hidden = ");
  assert.match(bye, /if \(!isAuthedRef\.current\) return;/);
  assert.match(app, /const hidden = \(\) => \{ if \(document\.visibilityState === "hidden" && isAuthedRef\.current\) publishUnsent\(\); \};/);
});

await test("the joined-account note reads as one statement (r7 #7)", () => {
  assert.match(T.joinedNote("neo"), /^Your account neo was created\. Sign in with the password you chose\. If you didn't save your backup code, set a new one in Settings → Account\.$/);
  assert.match(app, /if \(note && !joinLink\) \{ setUsername\(note\); setInfo\(joinedNote\(note\)\); \}/);
});

await test("sign-in: the decision on the server's answer, the claim checked, both before the session is kept", () => {
  const h = between(app, "async function handleSignIn(e) {", "async function handleJoin(e) {");
  const decide = h.indexOf("const verdict = browserAccountDecision({ stored: readBrowserAccount(), hasLocalData: await hasLocalData(), account: { id: r.account_id, role: r.role, username: r.username } });");
  const refuse = h.indexOf("if (!verdict.ok) { clearSecrets(); setError(browserAccountMessage(verdict)); return; }");
  const claim = h.indexOf("if (verdict.claim && !claimBrowser({ id: r.account_id, role: r.role, username: r.username })) { clearSecrets(); setError(browserAccountMessage({ reason: \"claim-failed\" })); return; }");
  const signedIn = h.indexOf("onSignedIn(");
  assert.ok(decide > 0 && refuse > decide && claim > refuse && signedIn > claim, `order ${decide} ${refuse} ${claim} ${signedIn}`);
  assert.equal(h.split("onSignedIn(").length - 1, 1, "one way to keep the session");
});

await test("join: the exact free-browser guard first; the claim checked; the code shown once before any session (r6 #18, #22b, #23)", () => {
  const h = between(app, "async function handleJoin(e) {", "async function handleBackupCode(e) {");
  const free = h.indexOf("if (!freeForNewAccount({ stored: readBrowserAccount(), hasLocalData: await hasLocalData() })) { setError(JOIN_BROWSER_TAKEN); return; }");
  const call = h.indexOf("const r = await joinWithInvite(");
  const claim = h.indexOf("const claimed = claimBrowser({ id: r.account_id, role: \"member\", username: r.username });");
  assert.ok(free > 0 && call > free && claim > call, `order ${free} ${call} ${claim}`);
  assert.match(h, /setJoined\(\{ backupCode: r\.backup_code, claimed, session: \{ token: r\.token, expires_at: r\.expires_at, username: r\.username \} \}\);/);
  assert.ok(!/onSignedIn\(|setSession\(/.test(h), "no session is kept in handleJoin");
  assert.match(app, /const \[savedCode, setSavedCode\] = useState\(false\);/);
  assert.match(app, /onChange=\{e => setSavedCode\(e\.target\.checked\)\}/);
  assert.match(app, /disabled=\{!savedCode \|\| !joined\.claimed\}/);
  assert.match(app, /onClick=\{\(\) => \{ const s = joined\.session; forgetJoinedNote\(\); setJoined\(null\); clearSecrets\(\); onSignedIn\(s\); \}\}/);
  // r6 #7: a lost answer may hide a made account: say so then, and on a dead-code answer after it
  assert.match(h, /\} catch \{\s*setJoinNetFailed\(true\);\s*setError\(`\$\{OFFLINE\} \$\{JOIN_MAYBE_CREATED\}`\);/);
  assert.match(h, /setError\(joinNetFailed && r\?\.reason === "invalid" \? `\$\{joinError\(r\)\} \$\{JOIN_MAYBE_CREATED\}` : joinError\(r\)\);/);
  assert.match(h, /rememberJoinedNote\(r\.username\);/);
});

await test("a made account whose page was lost: sign-in opens with its name and says so (r6 #7)", () => {
  assert.match(app, /const note = readJoinedNote\(\);\s*if \(note && !joinLink\) \{ setUsername\(note\); setInfo\(joinedNote\(note\)\); \}/);
  const h = between(app, "async function handleSignIn(e) {", "async function handleJoin(e) {");
  assert.ok(h.indexOf("forgetJoinedNote();") > 0 && h.indexOf("forgetJoinedNote();") < h.indexOf("onSignedIn("), "forgotten once signed in");
});

await test("an invite link is taken at app level, at load and on a hash change, and always removed from the address (r6 #4, #8)", () => {
  const f = between(app, "function takeJoinHash() {", "\n}\n");
  assert.match(f, /const m = \/\^#join\(\?:=\(\[\^&\]\*\)\)\?\(\?:&\.\*\)\?\$\/i\.exec\(window\.location\.hash \|\| ""\);\s*if \(!m\) return null;\s*window\.history\.replaceState\(null, "", window\.location\.pathname \+ window\.location\.search\);/);
  assert.match(app, /const \[joinLink, setJoinLink\] = useState\(\(\) => \{ const j = takeJoinHash\(\);/);
  // r8 #7: kept only with no session (as at load): not while the account check runs or after it
  assert.match(app, /const onHash = \(\) => \{ const j = takeJoinHash\(\); if \(j && !getSession\(\)\) setJoinLink\(j\); \};\s*window\.addEventListener\("hashchange", onHash\);/);
  const ok = between(app, "if (verdict.claim && !claimBrowser(", "}, [accountCheck]);");
  assert.ok(ok.indexOf("setJoinLink(null);") > 0 && ok.indexOf("setJoinLink(null);") < ok.indexOf("setIsAuthed(true)"), "the check's success drops a kept link");
  assert.match(app, /<LoginScreen onSignedIn=\{handleSignedIn\} notice=\{sessionNotice\} refusal=\{sessionRefusal\} joinLink=\{joinLink\} \/>/);
  assert.ok(!/window\.location\.hash/.test(between(app, "function LoginScreen(", "const labelStyle = ")), "LoginScreen no longer reads the hash itself");
  assert.match(app, /onClick=\{\(\) => switchMode\("join"\)\}>Have an invite\? Join/);
});

await test("unlock and reset name the account everywhere, the Account screen's backup-code reset too (r6 #16)", () => {
  const h = between(app, "async function handleBackupCode(e) {", "const labelStyle = ");
  assert.match(h, /await unlockWithBackupCode\(backupCode\.trim\(\), resetting \? newPassword : null, username\.trim\(\)\)/);
  assert.match(app, /mode === "reset" \? \(username\.trim\(\) && backupCode\.trim\(\) && newPassword && confirmPassword\) : \(username\.trim\(\) && backupCode\.trim\(\)\)/);
  assert.match(app, /\(mode === "reset" \|\| mode === "unlock"\) && \(\s*<div>\s*<label htmlFor="login-reset-username"/);
  const reset = between(app, "async function submitResetWithCode(e) {", "async function submitNewEmail(e) {");
  assert.match(reset, /if \(!creds\?\.username\) \{ setError\("Couldn't load your account name\. Close Account and open it again\."\); return; \}/);
  assert.match(reset, /await unlockWithBackupCode\(code, newPassword, creds\.username\)/);
  for (const m of app.matchAll(/unlockWithBackupCode\(([^()]|\([^()]*\))*\)/g)) {
    if (m[0].startsWith("unlockWithBackupCode(code") || m[0].startsWith("unlockWithBackupCode(backupCode")) assert.equal(m[0].split(",").length, 3, `three arguments: ${m[0]}`);
  }
});

await test("at load: none, fit, check (before anything loads) or refuse, and the check never trusts on failure (r6 #1, #19)", () => {
  assert.match(app, /const \[bootFit\] = useState\(\(\) => \{\s*const decision = bootSessionDecision\(getSession\(\), readBrowserAccount\(\)\);\s*if \(decision === "refuse"\) clearSession\(\);\s*if \(decision === "fit"\) bindPageAccount\(tokenAccountId\(getSession\(\)\?\.token\)\);\s*return decision;\s*\}\);/);
  assert.match(app, /const \[isAuthed, setIsAuthed\] = useState\(bootFit === "fit"\);/);
  assert.match(app, /const \[accountCheck, setAccountCheck\] = useState\(bootFit === "check" \? "checking" : null\);/);
  const eff = between(app, "if (accountCheck !== \"checking\") return;", "}, [accountCheck]);");
  const stepAt = eff.indexOf("const step = accountCheckStep("), failedAt = eff.indexOf('if (step !== "decide") { setAccountCheck("failed"); return; }');
  const verdictAt = eff.indexOf("const verdict = browserAccountDecision(");
  assert.ok(stepAt > 0 && failedAt > stepAt && verdictAt > failedAt, `order ${stepAt} ${failedAt} ${verdictAt}`);
  assert.match(eff, /const verdict = browserAccountDecision\(\{ stored: readBrowserAccount\(\), hasLocalData: await hasLocalData\(\), account: \{ id: a\.id, role: a\.role, username: a\.username \} \}\);/);
  assert.match(eff, /if \(!verdict\.ok\) \{ refuseSession\(browserAccountMessage\(verdict\)\); return; \}/);
  assert.match(eff, /if \(verdict\.claim && !claimBrowser\(\{ id: a\.id, role: a\.role, username: a\.username \}\)\) \{ refuseSession\(browserAccountMessage\(\{ reason: "claim-failed" \}\)\); return; \}/);
  assert.ok(eff.indexOf("setIsAuthed(true)") > eff.indexOf("claimBrowser("), "signed in only after the claim");
  assert.match(eff, /\} catch \{ if \(!cancelled\) setAccountCheck\("failed"\); \}\s*\}\)\(\);/);
  assert.ok(!/if \(!isAuthed \|\| readBrowserAccount\(\)\) return;/.test(app), "the old after-load claim is gone (the check runs before)");
  assert.match(app, /if \(accountCheck\) \{/);
});

await test("refusals read as errors (red), not as success notices (r6 #10)", () => {
  assert.match(app, /function LoginScreen\(\{ onSignedIn, notice = "", refusal = "", joinLink = null \}\)/);
  assert.match(app, /const \[error, setError\] = useState\(refusal\);/);
});

await test("a rename keeps this browser's record in step (r6 #13)", () => {
  const h = between(app, "const r = await renameMyAccount(currentPassword, name);", "setTimeout(() => window.location.reload(), 1500);");
  assert.match(h, /const rec = readBrowserAccount\(\);\s*if \(rec\?\.id && rec\.id === tokenAccountId\(r\.token\)\) claimBrowser\(\{ \.\.\.rec, username: r\.username \}\);/);
});

await test("the sign-in screen scrolls instead of clipping a tall form; join says early when the browser is taken (r6 #11)", () => {
  assert.match(app, /<div style=\{\{ width: "100%", height: "100vh", overflowY: "auto", display: "flex", padding: 20, boxSizing: "border-box" \}\}>/);
  assert.match(app, /<form onSubmit=\{[^}]*\}[^>]*style=\{\{\s*margin: "auto",/);
  assert.match(app, /if \(mode !== "join" \|\| joined\) return;[\s\S]{0,200}freeForNewAccount\(\{ stored: readBrowserAccount\(\), hasLocalData: await hasLocalData\(\) \}\)/);
});

await test("Settings shows the owner's invite section (the server decides who may invite)", () => {
  assert.match(app, /import InviteSection from "\.\/components\/InviteSection\.jsx";/);
  assert.match(app, /\{readBrowserAccount\(\)\?\.role === "owner" && <InviteSection font=\{font\} \/>\}/);
  const comp = strip(readFileSync(new URL("../src/components/InviteSection.jsx", import.meta.url), "utf8"));
  assert.match(comp, /const r = await createInvite\(pw\);\s*setPw\(""\);/);
  assert.match(comp, /await revokeInvite\(id\)/);
  assert.match(comp, /await listMyInvites\(\)/);
  // r6 #12: a failed list is not "no invites"; no clipboard says so; Revoke is a 44 px target; the link carries no code
  assert.match(comp, /setListError\(true\)/);
  assert.match(comp, /if \(!navigator\.clipboard\?\.writeText\) \{ setMsg\(\{ ok: false, text: COPY_BY_HAND \}\); return; \}/);
  assert.match(comp, /minHeight: 44, margin: 0, padding: "0 12px" \}\}>Revoke</);
  assert.match(comp, /const link = `\$\{window\.location\.origin\}\/#join`;/);
  assert.match(comp, /void: "void \(5 taken names\)"/);
});

// Since 20261026200000 a rename takes join's allow-list: the Account screen checks the same rule before it sends (a name
// the server would refuse never costs a request), with the same words.
await test("the rename form checks join's name rule before sending", () => {
  const f = between(app, "async function submitNewUsername(e) {", "const r = await renameMyAccount(currentPassword, name);");
  assert.match(f, /if \(!USERNAME_RULE\.test\(name\)\) \{ setError\(USERNAME_HINT\); return; \}/);
  assert.ok(!/name\.length < 2/.test(f), "the old length-only check is gone");
  assert.match(app, /import \{[^}]*\bUSERNAME_RULE\b[^}]*\bUSERNAME_HINT\b[^}]*\} from "\.\/lib\/signinText\.js";/);
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
