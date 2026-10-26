// The owner's invites in Settings (docs/SECOND-ACCOUNT-PLAN.md K7; supabase/migrations/20261026500000_mu_p5_invites.sql):
// make one (the current password is re-checked by the server), see each invite's state, revoke an open one. A new code is
// shown once. The link opens the join form; it carries no code (review r6 #4: a code in a link stays in the browser's
// history), so the person invited types the code you send with it.
import { useState, useEffect, useCallback } from "react";
import { createInvite, listMyInvites, revokeInvite } from "../lib/supabase.js";
import { inviteError, OFFLINE, COPY_BY_HAND } from "../lib/signinText.js";

const when = (s) => (s ? new Date(s * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "");
const STATE_COLOR = { open: "var(--success)", used: "var(--accent)", revoked: "var(--text-muted)", expired: "var(--text-muted)", void: "var(--text-muted)" };
const STATE_LABEL = { open: "open", used: "used", revoked: "revoked", expired: "expired", void: "void (5 taken names)" };

export default function InviteSection({ font }) {
  const [invites, setInvites] = useState(null);
  const [listError, setListError] = useState(false);
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState(null);   // { code, expires_at }: shown once, until this panel closes
  const [msg, setMsg] = useState(null);     // { ok, text }

  const refresh = useCallback(async () => {
    try {
      const r = await listMyInvites();
      if (r?.ok) { setInvites(r.invites || []); setListError(false); } else setListError(true);
    } catch { setListError(true); }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  async function make() {
    if (!pw || busy) return;
    setBusy(true); setMsg(null); setMade(null);
    try {
      const r = await createInvite(pw);
      setPw("");
      if (r?.ok) { setMade({ code: r.code, expires_at: r.expires_at }); await refresh(); }
      else setMsg({ ok: false, text: inviteError(r) });
    } catch {
      setPw("");
      setMsg({ ok: false, text: OFFLINE });
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id) {
    if (!window.confirm("Revoke this invite? Its code stops working.")) return;
    setBusy(true); setMsg(null);
    try {
      const r = await revokeInvite(id);
      setMsg(r?.ok ? { ok: true, text: "Revoked." } : { ok: false, text: "That invite was already used or revoked." });
      await refresh();
    } catch {
      setMsg({ ok: false, text: OFFLINE });
    } finally {
      setBusy(false);
    }
  }

  function copy(text, what) {
    if (!navigator.clipboard?.writeText) { setMsg({ ok: false, text: COPY_BY_HAND }); return; }
    navigator.clipboard.writeText(text).then(() => setMsg({ ok: true, text: `${what} copied.` }), () => setMsg({ ok: false, text: COPY_BY_HAND }));
  }
  const link = `${window.location.origin}/#join`;

  return (
    <div className="setting-group">
      <div className="setting-label">Invite a person</div>
      <div className="setting-hint">
        An invite makes one member account with its own generations, keys and History; members never see yours and you never
        see theirs. A code works once, for 7 days, on a browser that holds no other account's data (their own device, or a
        private window). Send the link and the code. Enter your password to make one.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8 }}>
        <input type="password" className="setting-input" aria-label="Your password" autoComplete="current-password"
          placeholder="Your password" value={pw} onChange={e => { setPw(e.target.value); setMsg(null); }}
          onKeyDown={e => { if (e.key === "Enter") make(); }} style={{ margin: 0 }} />
        <button className="api-test-btn" disabled={!pw || busy} onClick={make} style={{ minHeight: 44, margin: 0 }}>
          {busy ? "Working..." : "Make invite"}
        </button>
      </div>
      {made && (
        <div role="status" style={{ marginTop: 10, padding: "12px 14px", borderRadius: 10, border: "1px solid rgba(34,197,94,0.35)", background: "rgba(34,197,94,0.08)" }}>
          <div style={{ fontSize: 12, color: "var(--success)", fontFamily: font, marginBottom: 6 }}>✓ Invite made. Shown once: send it privately.</div>
          <div style={{ fontFamily: font, fontSize: 18, letterSpacing: 1, userSelect: "all", wordBreak: "break-all", color: "var(--text-primary)" }}>{made.code}</div>
          <div style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: font, marginTop: 4 }}>Works once, until {when(made.expires_at)}. Join page: {link}</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 10 }}>
            <button className="api-test-btn" style={{ minHeight: 44, margin: 0 }} onClick={() => copy(made.code, "Code")}>Copy code</button>
            <button className="api-test-btn" style={{ minHeight: 44, margin: 0 }} onClick={() => copy(link, "Link")}>Copy link</button>
          </div>
        </div>
      )}
      {msg && (
        <div role={msg.ok ? "status" : "alert"} style={{
          marginTop: 10, padding: "10px 12px", borderRadius: 8, fontSize: 12, fontFamily: font,
          background: msg.ok ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
          border: `1px solid ${msg.ok ? "rgba(34,197,94,0.3)" : "rgba(239,68,68,0.3)"}`,
          color: msg.ok ? "var(--success)" : "var(--error)",
        }}>{msg.ok ? "✓ " : "✗ "}{msg.text}</div>
      )}
      {listError && (
        <div role="alert" style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr auto", gap: 8, alignItems: "center", fontSize: 12, fontFamily: font, color: "var(--error)" }}>
          <span>✗ Couldn't load your invites.</span>
          <button className="api-test-btn" onClick={refresh} style={{ minHeight: 44, margin: 0, padding: "0 12px" }}>Retry</button>
        </div>
      )}
      {!listError && invites && invites.length === 0 && (
        <div style={{ marginTop: 10, fontSize: 12, color: "var(--text-muted)", fontFamily: font }}>No invites yet.</div>
      )}
      {!listError && invites && invites.length > 0 && (
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
          {invites.map(i => (
            <div key={i.id} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, alignItems: "center", padding: "8px 10px", borderRadius: 8, border: "1px solid var(--glass-border)", fontFamily: font, fontSize: 12 }}>
              <div style={{ minWidth: 0 }}>
                <span style={{ color: STATE_COLOR[i.state] || "var(--text-muted)", fontWeight: 700, textTransform: "uppercase", marginRight: 8 }}>{STATE_LABEL[i.state] || i.state}</span>
                <span style={{ color: "var(--text-muted)" }}>
                  {i.state === "used" ? `by ${i.used_by_username || "a member"}, ${when(i.used_at)}` : i.state === "open" ? `until ${when(i.expires_at)}` : `made ${when(i.created_at)}`}
                </span>
              </div>
              {i.state === "open" && (
                <button className="api-test-btn" disabled={busy} onClick={() => revoke(i.id)} style={{ minHeight: 44, margin: 0, padding: "0 12px" }}>Revoke</button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
