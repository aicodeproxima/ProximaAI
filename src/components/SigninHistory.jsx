// The owner's sign-in history in Settings (owner 2026-10-27: "I will be able to see sign-in history for all accounts. And
// no one else can see them."): every sign-in, backup-code unlock, join and password confirmation of every account, newest
// first, a page at a time; each account's last successful sign-in on top (a flood of failures cannot push it out of view).
// The server keeps 90 days, folds repeats into counted rows, caps floods per hour and answers only the owner
// (supabase/migrations/20261027100000_signin_history.sql). Browser strings are shown as text (React escapes them).
import { useState, useEffect, useCallback, useRef } from "react";
import { listSignins } from "../lib/supabase.js";
import { eventLabel, sourceLabel, whenLabel, lastSignInLabel, failedAttempts, accountChoices, applyAnswer, rowsFor } from "../lib/signinHistory.js";

const PAGE = 100;

export default function SigninHistory({ font }) {
  const [state, setState] = useState({ data: null, error: false, busy: false, retryBefore: null });
  const [who, setWho] = useState("all");
  const seq = useRef(0);

  // Only the newest request's answer is shown (applyAnswer): switching accounts quickly cannot show an older answer.
  const load = useCallback(async (account, beforeId) => {
    const mine = ++seq.current;
    setState(s => ({ ...s, busy: true }));
    let r = null;
    try { r = await listSignins({ limit: PAGE, beforeId, account: account === "all" ? null : account }); } catch { r = null; }
    const latest = seq.current;
    setState(s => applyAnswer(s, { latest, mine, ok: r?.ok === true, page: r, beforeId, account }));
  }, []);
  useEffect(() => { load(who, null); }, [who, load]);

  const { data, error, busy, retryBefore } = state;
  // rows only of the selected filter: after a switch, the previous filter's rows never stand under the new choice
  const events = rowsFor(data, who);
  const accounts = data?.accounts || [];
  const refused = failedAttempts(events);
  const oldest = events.length ? events[events.length - 1].id : null;
  const btn = { minHeight: 44, margin: 0, padding: "0 12px" };

  return (
    <div className="setting-group">
      <div className="setting-label">Sign-in history</div>
      <div className="setting-hint">
        Every sign-in, backup-code unlock, join and password confirmation, for every account, kept 90 days (recording
        started with this version). Only you
        (the owner) can see this. "Network" is a short code for where it came from (the same code means the same network; the
        address itself is never stored). The browser and app parts are what the request said about itself, so trust the
        network code first. The same result from one network within 10 minutes is counted on one line (×N); a refusal
        anyone can send without an account (a name that isn't allowed, a too-short password, joining while it is closed)
        is counted on one line an hour from any network. Past 30 lines
        an hour of an account's failures, successes or lockouts (60 a kind for names no account has), the rest are only
        counted, on one "not recorded one by one" line.
      </div>
      {accounts.length > 0 && (
        <div style={{ marginTop: 8, fontSize: 12, fontFamily: font }}>
          <div style={{ color: "var(--text-muted)", marginBottom: 4 }}>Last sign-in per account</div>
          {accounts.map(a => (
            <div key={a.account_id} style={{ overflowWrap: "anywhere", marginTop: 2 }}>
              <strong>{a.username}</strong>{a.role === "owner" ? " (owner)" : ""}{a.disabled ? " (disabled)" : ""}{a.deleted ? " (deleted)" : ""}:{" "}
              {lastSignInLabel(a)}
            </div>
          ))}
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, marginTop: 10 }}>
        <select className="setting-input" aria-label="Account" value={who} onChange={e => setWho(e.target.value)} style={{ margin: 0, minHeight: 44 }}>
          {accountChoices(accounts).map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
        <button className="api-test-btn" disabled={busy} onClick={() => load(who, null)} style={btn}>
          {busy ? "Loading..." : "Refresh"}
        </button>
      </div>
      {error && (
        <div role="alert" style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr auto", gap: 8, alignItems: "center", fontSize: 12, fontFamily: font, color: "var(--error)" }}>
          <span>{retryBefore ? "✗ Couldn't load older sign-ins." : "✗ Couldn't load the sign-in history."}</span>
          {/* Retry asks again for the page that failed (an older page keeps what is already on screen) */}
          <button className="api-test-btn" disabled={busy} onClick={() => load(who, retryBefore)} style={btn}>Retry</button>
        </div>
      )}
      {!error && data?.account === who && events.length === 0 && (
        <div style={{ marginTop: 10, fontSize: 12, color: "var(--text-muted)", fontFamily: font }}>No sign-ins recorded yet.</div>
      )}
      {events.length > 0 && (
        <>
          <div style={{ marginTop: 10, fontSize: 11, color: "var(--text-muted)", fontFamily: font }}>
            {events.length} line{events.length === 1 ? "" : "s"}{refused ? ` · ${refused} attempt${refused === 1 ? "" : "s"} did not go through` : ""}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
            {events.map(e => {
              const l = eventLabel(e);
              return (
                <div key={e.id} style={{ padding: "8px 10px", borderRadius: 8, fontFamily: font, fontSize: 12,
                  border: `1px solid ${l.ok ? "var(--glass-border)" : "rgba(239,68,68,0.35)"}` }}>
                  <div style={{ color: l.ok ? "var(--success)" : "var(--error)", fontWeight: 700, overflowWrap: "anywhere" }}>
                    {l.ok ? "✓ " : "✗ "}{l.text}
                  </div>
                  {/* the time on its own line: a span ("Oct 26, 11:50 PM EDT to Oct 27, 12:20 AM EDT") needs the width at 384 px */}
                  <div style={{ color: "var(--text-muted)", marginTop: 2 }}>{whenLabel(e)}</div>
                  <div style={{ color: "var(--text-muted)", marginTop: 2, overflowWrap: "anywhere" }}>
                    {e.username || "(no account)"} · {sourceLabel(e)}
                  </div>
                </div>
              );
            })}
          </div>
          {data.more && (
            <button className="api-test-btn" disabled={busy} onClick={() => load(who, oldest)} style={{ ...btn, marginTop: 8, width: "100%" }}>
              {busy ? "Loading..." : "Load older"}
            </button>
          )}
        </>
      )}
    </div>
  );
}
