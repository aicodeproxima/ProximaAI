import { useState, useEffect, useRef, useCallback, useReducer } from "react";
import { MODELS, TYPE_LABELS, TYPE_ICONS, PROVIDER_COLORS } from "./config/models.js";
import { buildPayload } from "./lib/payloadBuilder.js";
import { submitTask, pollResult, checkBalance, uploadMedia, API_BASE, proxiedFetch } from "./lib/api.js";
import { getSetting, setSetting, addHistoryEntry, getHistory, clearHistory, migrateFromLocalStorage, saveTask, saveTasks, deleteTask, getCompletedTasks, getPendingTasks, clearTasks as clearTasksDB, getStorageStats, getFailedSyncs, addFailedSync, removeFailedSync, clearFailedSyncs } from "./lib/storage.js";
import { initSupabase, isSupabaseConfigured, syncHistoryEntry, syncTask, syncTasksBatch, syncSetting, pullAllRemoteData, deleteTaskRemote, clearTasksRemote, clearHistoryRemote, clearSettingsRemote, clearFavoritesRemote, resetDeviceIdCache, verifyCredentials, saveCredentials, getStoredCredentials, sendEmailOtp, verifyEmailOtp, createBackup, listBackups, restoreBackup, deleteBackup, archiveUrl, deleteArchivedPath, getArchiveStats } from "./lib/supabase.js";
import { THEMES, BACKGROUNDS } from "./lib/themes.js";
import useTheme from "./lib/useTheme.js";
import BackgroundLayer from "./lib/BackgroundLayer.jsx";

// ─── LOGIN SCREEN ───
function LoginScreen({ onLogin }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const font = `'JetBrains Mono', 'Fira Code', monospace`;
  const fontBody = `'DM Sans', 'Segoe UI', sans-serif`;

  const [loading, setLoading] = useState(false);
  async function handleSubmit(e) {
    e.preventDefault();
    if (!username.trim() || !password) return;
    setLoading(true);
    try {
      const success = await onLogin(username.trim(), password);
      if (!success) {
        setError("Invalid username or password");
        setPassword("");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ width: "100%", height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, boxSizing: "border-box" }}>
      <form onSubmit={handleSubmit} style={{
        background: "rgba(8,12,25,0.6)",
        border: "1px solid rgba(99,102,241,0.2)",
        borderRadius: 18,
        padding: "36px 32px",
        width: "100%",
        maxWidth: 400,
        boxShadow: "0 10px 60px rgba(0,0,0,0.5), 0 0 60px rgba(99,102,241,0.12)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        fontFamily: fontBody,
        color: "#e2e8f0",
      }}>
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div style={{ fontSize: 48, marginBottom: 10, color: "#a78bfa", filter: "drop-shadow(0 0 20px rgba(167,139,250,0.4))" }}>◈</div>
          <div style={{ fontFamily: font, fontSize: 20, fontWeight: 700, color: "#f1f5f9", letterSpacing: 1.5 }}>ProximaAI</div>
          <div style={{ fontSize: 12, color: "#64748b", marginTop: 6, fontFamily: font, letterSpacing: 0.5 }}>PARALLEL AI GENERATION COCKPIT</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div>
            <label style={{ display: "block", fontSize: 11, color: "#94a3b8", fontFamily: font, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>Username</label>
            <input
              type="text"
              value={username}
              onChange={e => { setUsername(e.target.value); setError(""); }}
              autoFocus
              autoComplete="username"
              style={{
                width: "100%", background: "rgba(10,20,40,0.5)", border: "1px solid rgba(99,102,241,0.15)",
                borderRadius: 10, padding: "12px 14px", color: "#f1f5f9", fontFamily: font, fontSize: 15,
                outline: "none", boxSizing: "border-box", transition: "border-color 0.3s, box-shadow 0.3s",
              }}
              onFocus={e => { e.target.style.borderColor = "#6366f1"; e.target.style.boxShadow = "0 0 0 3px rgba(99,102,241,0.1)"; }}
              onBlur={e => { e.target.style.borderColor = "rgba(99,102,241,0.15)"; e.target.style.boxShadow = "none"; }}
            />
          </div>
          <div>
            <label style={{ display: "block", fontSize: 11, color: "#94a3b8", fontFamily: font, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>Password</label>
            <input
              type="password"
              value={password}
              onChange={e => { setPassword(e.target.value); setError(""); }}
              autoComplete="current-password"
              style={{
                width: "100%", background: "rgba(10,20,40,0.5)", border: "1px solid rgba(99,102,241,0.15)",
                borderRadius: 10, padding: "12px 14px", color: "#f1f5f9", fontFamily: font, fontSize: 15,
                outline: "none", boxSizing: "border-box", transition: "border-color 0.3s, box-shadow 0.3s",
              }}
              onFocus={e => { e.target.style.borderColor = "#6366f1"; e.target.style.boxShadow = "0 0 0 3px rgba(99,102,241,0.1)"; }}
              onBlur={e => { e.target.style.borderColor = "rgba(99,102,241,0.15)"; e.target.style.boxShadow = "none"; }}
            />
          </div>
          {error && (
            <div style={{ fontSize: 12, color: "#ef4444", padding: "10px 14px", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 10, fontFamily: font }}>
              ✗ {error}
            </div>
          )}
          <button type="submit"
            disabled={!username.trim() || !password}
            style={{
              width: "100%", padding: "14px", border: "none", borderRadius: 12,
              fontFamily: font, fontSize: 14, fontWeight: 700, letterSpacing: 0.5,
              cursor: (!username.trim() || !password) ? "not-allowed" : "pointer",
              background: (!username.trim() || !password) ? "rgba(30,41,59,0.3)" : "linear-gradient(135deg, #6366f1, #8b5cf6, #a78bfa)",
              color: "white",
              boxShadow: (!username.trim() || !password) ? "none" : "0 4px 20px rgba(99,102,241,0.35)",
              transition: "all 0.3s cubic-bezier(0.4,0,0.2,1)",
              marginTop: 4,
            }}>
            SIGN IN
          </button>
        </div>

        <div style={{ textAlign: "center", marginTop: 24, fontSize: 10, color: "#64748b", fontFamily: font, letterSpacing: 0.5 }}>
          Cloud sync enabled · Works across all devices
        </div>
      </form>
    </div>
  );
}

const font = `'JetBrains Mono', 'Fira Code', monospace`;
const fontBody = `'DM Sans', 'Segoe UI', sans-serif`;

// ─── SIDEBAR SAVE-STATUS BUTTON ───
// Lives in the nav bar. Tap to force-flush pending cloud writes.
// Long-press (600ms) to create a full manual cloud backup.
function SidebarSaveButton({ saveStatus, failedCount, onForceSave, onBackup }) {
  const effective = failedCount > 0 && saveStatus !== "saving" ? "error" : saveStatus;
  const cfg = {
    idle:   { icon: "✓", color: "#22c55e", bg: "transparent",             border: "transparent",                 pulse: false, label: "Saved · Long-press to backup" },
    saving: { icon: "⟳", color: "#6366f1", bg: "rgba(99,102,241,0.12)",   border: "rgba(99,102,241,0.35)",       pulse: true,  label: "Saving…" },
    saved:  { icon: "✓", color: "#22c55e", bg: "rgba(34,197,94,0.15)",    border: "rgba(34,197,94,0.4)",         pulse: false, label: "Saved!" },
    error:  { icon: "⚠", color: "#ef4444", bg: "rgba(239,68,68,0.12)",    border: "rgba(239,68,68,0.35)",        pulse: false, label: failedCount > 0 ? `Retry (${failedCount})` : "Retry" },
    backup: { icon: "☁", color: "#f59e0b", bg: "rgba(245,158,11,0.15)",   border: "rgba(245,158,11,0.4)",        pulse: true,  label: "Creating backup…" },
  }[effective] || { icon: "·", color: "#94a3b8", bg: "transparent", border: "transparent", pulse: false, label: "Idle" };

  const pressStartRef = useRef(0);
  const longPressTimerRef = useRef(null);
  const triggeredLongPressRef = useRef(false);

  const startPress = (e) => {
    e.preventDefault();
    triggeredLongPressRef.current = false;
    pressStartRef.current = Date.now();
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = setTimeout(() => {
      triggeredLongPressRef.current = true;
      if (navigator.vibrate) navigator.vibrate(40);
      onBackup();
    }, 600);
  };
  const endPress = () => {
    if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
    if (!triggeredLongPressRef.current) {
      // Short tap — force save
      if (Date.now() - pressStartRef.current < 600) onForceSave();
    }
  };
  const cancelPress = () => {
    if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
  };

  return (
    <button
      className="sidebar-btn"
      title={cfg.label}
      onMouseDown={startPress}
      onMouseUp={endPress}
      onMouseLeave={cancelPress}
      onTouchStart={startPress}
      onTouchEnd={endPress}
      onTouchCancel={cancelPress}
      onContextMenu={e => e.preventDefault()}
      style={{
        color: cfg.color,
        background: cfg.bg,
        border: cfg.border !== "transparent" ? `1px solid ${cfg.border}` : "none",
        userSelect: "none", WebkitUserSelect: "none",
      }}>
      <span style={{ display: "inline-block", animation: cfg.pulse ? "spin 1.2s linear infinite" : "none" }}>{cfg.icon}</span>
    </button>
  );
}

// ─── FLOATING SAVE STATUS BUTTON (deprecated, replaced by SidebarSaveButton) ───
function FloatingSaveButton({ saveStatus, onForceSave, failedCount = 0 }) {
  // Honest status: if there are unreplayed failures, we're NEVER truly "saved"
  const effective = failedCount > 0 && saveStatus !== "saving" ? "error" : saveStatus;
  const cfg = {
    idle:   { icon: "✓", label: "Saved",                              bg: "rgba(34,197,94,0.12)",  border: "rgba(34,197,94,0.35)",  color: "#22c55e", pulse: false },
    saving: { icon: "⟳", label: "Saving…",                            bg: "rgba(99,102,241,0.15)", border: "rgba(99,102,241,0.4)",  color: "#6366f1", pulse: true  },
    saved:  { icon: "✓", label: "Saved!",                             bg: "rgba(34,197,94,0.2)",   border: "rgba(34,197,94,0.5)",   color: "#22c55e", pulse: false },
    error:  { icon: "⚠", label: failedCount > 0 ? `Retry (${failedCount})` : "Retry",  bg: "rgba(239,68,68,0.15)",  border: "rgba(239,68,68,0.4)",   color: "#ef4444", pulse: false },
  }[effective] || { icon: "·", label: "Idle", bg: "rgba(30,41,59,0.3)", border: "rgba(99,102,241,0.2)", color: "#94a3b8", pulse: false };

  return (
    <button onClick={onForceSave} title="Click to save immediately"
      style={{
        position: "fixed", left: "calc(14px + env(safe-area-inset-left))",
        bottom: "calc(14px + env(safe-area-inset-bottom))",
        zIndex: 1500, display: "flex", alignItems: "center", gap: 8,
        padding: "8px 14px", borderRadius: 999,
        background: cfg.bg, border: `1px solid ${cfg.border}`, color: cfg.color,
        fontFamily: font, fontSize: 11, fontWeight: 700, letterSpacing: 0.4,
        backdropFilter: "blur(16px)", WebkitBackdropFilter: "blur(16px)",
        boxShadow: "0 4px 20px rgba(0,0,0,0.35)",
        cursor: "pointer", transition: "all 0.25s cubic-bezier(0.4,0,0.2,1)",
      }}>
      <span style={{ fontSize: 14, display: "inline-block",
        animation: cfg.pulse ? "spin 1.2s linear infinite" : "none" }}>{cfg.icon}</span>
      <span>{cfg.label}</span>
    </button>
  );
}

// ─── ACCOUNT MANAGEMENT MODAL ───
function AccountModal({ onClose, onSaved }) {
  // Steps: load → menu → set-email → verify-email → change-username → change-password → change-email-verify-new → done
  const [step, setStep] = useState("load");
  const [creds, setCreds] = useState(null);
  const [email, setEmail] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState(""); // "username" | "password" | "email"
  const [pendingVerifyEmail, setPendingVerifyEmail] = useState("");

  useEffect(() => {
    (async () => {
      const stored = await getStoredCredentials();
      setCreds(stored || {});
      setEmail(stored?.email || "");
      setStep("menu");
    })();
  }, []);

  async function doSendOtp(toEmail) {
    setBusy(true); setError("");
    const r = await sendEmailOtp(toEmail);
    setBusy(false);
    if (!r.ok) { setError(r.error || "Failed to send code"); return false; }
    setPendingVerifyEmail(toEmail);
    return true;
  }

  async function startAction(kind) {
    setError("");
    setAction(kind);
    if (!creds?.email || creds?.email_verified !== "true") {
      setStep("set-email");
      return;
    }
    // Skip re-verification if user verified within the last 10 minutes
    const lastVerified = parseInt(creds?.last_verified_at || "0", 10);
    const tenMinAgo = Date.now() - 10 * 60 * 1000;
    if (lastVerified > tenMinAgo) {
      if (kind === "username") setStep("change-username");
      else if (kind === "password") setStep("change-password");
      else if (kind === "email") setStep("change-email-new");
      return;
    }
    // Send OTP to existing email
    const ok = await doSendOtp(creds.email);
    if (ok) setStep("verify-otp");
  }

  async function submitSetEmail(e) {
    e.preventDefault();
    if (!email.includes("@")) { setError("Enter a valid email"); return; }
    const ok = await doSendOtp(email);
    if (ok) setStep("verify-otp");
  }

  async function submitVerifyOtp(e) {
    e.preventDefault();
    setBusy(true); setError("");
    const r = await verifyEmailOtp(pendingVerifyEmail, otp.trim());
    setBusy(false);
    if (!r.ok) { setError(r.error || "Invalid code"); return; }
    const now = String(Date.now());
    // First-time email setup: save email as verified and finish
    if (!creds?.email || creds.email !== pendingVerifyEmail) {
      await saveCredentials({ email: pendingVerifyEmail, emailVerified: true, lastVerifiedAt: now });
      setCreds(c => ({ ...c, email: pendingVerifyEmail, email_verified: "true", last_verified_at: now }));
    } else {
      await saveCredentials({ emailVerified: true, lastVerifiedAt: now });
      setCreds(c => ({ ...c, last_verified_at: now }));
    }
    // Route to the action they wanted
    if (action === "username") setStep("change-username");
    else if (action === "password") setStep("change-password");
    else if (action === "email") setStep("change-email-new");
    else setStep("menu");
    setOtp("");
  }

  async function submitNewUsername(e) {
    e.preventDefault();
    if (!newUsername.trim() || newUsername.length < 2) { setError("Username must be at least 2 characters"); return; }
    setBusy(true);
    const ok = await saveCredentials({ username: newUsername.trim() });
    setBusy(false);
    if (!ok) { setError("Failed to save. Try again."); return; }
    try { localStorage.setItem("proximaai-user", newUsername.trim()); } catch {}
    setStep("done");
    onSaved?.("Username changed");
  }

  async function submitNewPassword(e) {
    e.preventDefault();
    if (newPassword.length < 4) { setError("Password must be at least 4 characters"); return; }
    if (newPassword !== confirmPassword) { setError("Passwords don't match"); return; }
    setBusy(true);
    const ok = await saveCredentials({ password: newPassword });
    setBusy(false);
    if (!ok) { setError("Failed to save. Try again."); return; }
    setStep("done");
    onSaved?.("Password changed");
  }

  async function submitNewEmail(e) {
    e.preventDefault();
    if (!newEmail.includes("@")) { setError("Enter a valid email"); return; }
    // Send OTP to the NEW email to verify ownership
    const ok = await doSendOtp(newEmail);
    if (ok) setStep("verify-new-email");
  }

  async function submitVerifyNewEmail(e) {
    e.preventDefault();
    setBusy(true); setError("");
    const r = await verifyEmailOtp(pendingVerifyEmail, otp.trim());
    if (!r.ok) { setBusy(false); setError(r.error || "Invalid code"); return; }
    const ok = await saveCredentials({ email: pendingVerifyEmail, emailVerified: true });
    setBusy(false);
    if (!ok) { setError("Failed to save"); return; }
    setStep("done");
    onSaved?.("Email changed");
  }

  const box = {
    background: "rgba(8,12,25,0.95)", border: "1px solid rgba(99,102,241,0.3)", borderRadius: 16,
    padding: "28px 26px", width: "100%", maxWidth: 440, color: "#e2e8f0", fontFamily: fontBody,
    boxShadow: "0 20px 80px rgba(0,0,0,0.6), 0 0 80px rgba(99,102,241,0.15)",
    backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)",
  };
  const input = {
    width: "100%", background: "rgba(10,20,40,0.5)", border: "1px solid rgba(99,102,241,0.2)",
    borderRadius: 10, padding: "12px 14px", color: "#f1f5f9", fontFamily: font, fontSize: 15,
    outline: "none", boxSizing: "border-box",
  };
  const btn = (variant) => ({
    padding: "12px 20px", borderRadius: 10, fontFamily: font, fontSize: 13, fontWeight: 700,
    cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.6 : 1, letterSpacing: 0.5,
    background: variant === "primary" ? "linear-gradient(135deg, #6366f1, #8b5cf6)" : "rgba(30,41,59,0.5)",
    color: variant === "primary" ? "white" : "#e2e8f0",
    border: variant === "primary" ? "none" : "1px solid rgba(99,102,241,0.2)",
    transition: "all 0.2s",
  });
  const label = { fontSize: 11, color: "#94a3b8", fontFamily: font, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6, display: "block" };
  const title = { fontFamily: font, fontSize: 16, fontWeight: 700, marginBottom: 6, color: "#f1f5f9" };
  const subtitle = { fontSize: 12, color: "#94a3b8", marginBottom: 20, lineHeight: 1.5 };

  return (
    <div onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: "fixed", inset: 0, background: "rgba(2,5,16,0.85)", backdropFilter: "blur(8px)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={box}>
        {step === "load" && <div style={{ textAlign: "center", padding: 40, color: "#94a3b8" }}>Loading...</div>}

        {step === "menu" && (
          <>
            <div style={title}>Account Settings</div>
            <div style={subtitle}>
              Signed in as <b style={{ color: "#e2e8f0" }}>{creds?.username || "admin"}</b>
              {creds?.email && <><br/>Email: <span style={{ color: "#e2e8f0" }}>{creds.email}</span> {creds.email_verified === "true" ? "✓" : <span style={{ color: "#f59e0b" }}>(unverified)</span>}</>}
              {!creds?.email && <><br/><span style={{ color: "#f59e0b" }}>No email set — add one for account recovery</span></>}
              {(() => {
                const lv = parseInt(creds?.last_verified_at || "0", 10);
                if (lv > Date.now() - 10 * 60 * 1000) {
                  const mins = Math.max(1, Math.ceil((lv + 10 * 60 * 1000 - Date.now()) / 60000));
                  return <><br/><span style={{ color: "#22c55e", fontSize: 11 }}>✓ Recently verified · skip re-verify for {mins} more min</span></>;
                }
                return null;
              })()}
            </div>
            {busy && <div style={{ color: "#6366f1", fontSize: 12, marginBottom: 10, textAlign: "center" }}>Sending verification code to your email...</div>}
            {error && <div style={{ color: "#ef4444", fontSize: 12, marginBottom: 10, padding: "10px 12px", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.25)", borderRadius: 8 }}>✗ {error}</div>}
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <button disabled={busy} style={btn()} onClick={() => startAction("username")}>Change Username</button>
              <button disabled={busy} style={btn()} onClick={() => startAction("password")}>Change Password</button>
              <button disabled={busy} style={btn()} onClick={() => startAction("email")}>{creds?.email ? "Change Email" : "Set Email"}</button>
              <button style={{ ...btn(), marginTop: 8, background: "transparent" }} onClick={onClose}>Close</button>
            </div>
          </>
        )}

        {step === "set-email" && (
          <form onSubmit={submitSetEmail}>
            <div style={title}>Verify Your Email</div>
            <div style={subtitle}>We'll send a 6-digit code to confirm it's really you before making account changes.</div>
            <label style={label}>Email Address</label>
            <input type="email" value={email} onChange={e => { setEmail(e.target.value); setError(""); }} style={input} placeholder="you@example.com" autoFocus />
            {error && <div style={{ color: "#ef4444", fontSize: 12, marginTop: 10 }}>✗ {error}</div>}
            <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
              <button type="button" style={btn()} onClick={() => setStep("menu")}>Back</button>
              <button type="submit" disabled={busy} style={{ ...btn("primary"), flex: 1 }}>{busy ? "Sending..." : "Send Code"}</button>
            </div>
          </form>
        )}

        {step === "verify-otp" && (
          <form onSubmit={submitVerifyOtp}>
            <div style={title}>Enter Verification Code</div>
            <div style={subtitle}>Sent to <b style={{ color: "#e2e8f0" }}>{pendingVerifyEmail}</b>. Check spam if you don't see it.</div>
            <label style={label}>Verification Code</label>
            <input type="text" inputMode="numeric" pattern="[0-9]*" autoComplete="one-time-code"
              value={otp}
              onChange={e => { setOtp(e.target.value.replace(/\D/g, "").slice(0, 10)); setError(""); }}
              onPaste={e => { e.preventDefault(); const t = (e.clipboardData.getData("text") || "").replace(/\D/g, "").slice(0, 10); setOtp(t); }}
              style={{ ...input, letterSpacing: 6, textAlign: "center", fontSize: 22 }} maxLength={10} autoFocus />
            {error && <div style={{ color: "#ef4444", fontSize: 12, marginTop: 10 }}>✗ {error}</div>}
            <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
              <button type="button" style={btn()} onClick={() => setStep("menu")}>Cancel</button>
              <button type="submit" disabled={busy || otp.length < 6} style={{ ...btn("primary"), flex: 1 }}>{busy ? "Verifying..." : "Verify"}</button>
            </div>
            <button type="button" onClick={() => doSendOtp(pendingVerifyEmail)} style={{ marginTop: 12, background: "transparent", border: "none", color: "#6366f1", fontSize: 12, cursor: "pointer", fontFamily: font }}>Resend code</button>
          </form>
        )}

        {step === "change-username" && (
          <form onSubmit={submitNewUsername}>
            <div style={title}>New Username</div>
            <div style={subtitle}>Current: <b>{creds?.username || "admin"}</b></div>
            <label style={label}>New Username</label>
            <input type="text" value={newUsername} onChange={e => { setNewUsername(e.target.value); setError(""); }} style={input} autoFocus />
            {error && <div style={{ color: "#ef4444", fontSize: 12, marginTop: 10 }}>✗ {error}</div>}
            <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
              <button type="button" style={btn()} onClick={() => setStep("menu")}>Cancel</button>
              <button type="submit" disabled={busy} style={{ ...btn("primary"), flex: 1 }}>{busy ? "Saving..." : "Save"}</button>
            </div>
          </form>
        )}

        {step === "change-password" && (
          <form onSubmit={submitNewPassword}>
            <div style={title}>New Password</div>
            <div style={subtitle}>Minimum 4 characters.</div>
            <label style={label}>New Password</label>
            <input type="password" value={newPassword} onChange={e => { setNewPassword(e.target.value); setError(""); }} style={input} autoFocus />
            <label style={{ ...label, marginTop: 12 }}>Confirm Password</label>
            <input type="password" value={confirmPassword} onChange={e => { setConfirmPassword(e.target.value); setError(""); }} style={input} />
            {error && <div style={{ color: "#ef4444", fontSize: 12, marginTop: 10 }}>✗ {error}</div>}
            <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
              <button type="button" style={btn()} onClick={() => setStep("menu")}>Cancel</button>
              <button type="submit" disabled={busy} style={{ ...btn("primary"), flex: 1 }}>{busy ? "Saving..." : "Save"}</button>
            </div>
          </form>
        )}

        {step === "change-email-new" && (
          <form onSubmit={submitNewEmail}>
            <div style={title}>New Email</div>
            <div style={subtitle}>We'll send a verification code to the new address.</div>
            <label style={label}>New Email Address</label>
            <input type="email" value={newEmail} onChange={e => { setNewEmail(e.target.value); setError(""); }} style={input} autoFocus />
            {error && <div style={{ color: "#ef4444", fontSize: 12, marginTop: 10 }}>✗ {error}</div>}
            <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
              <button type="button" style={btn()} onClick={() => setStep("menu")}>Cancel</button>
              <button type="submit" disabled={busy} style={{ ...btn("primary"), flex: 1 }}>{busy ? "Sending..." : "Send Code"}</button>
            </div>
          </form>
        )}

        {step === "verify-new-email" && (
          <form onSubmit={submitVerifyNewEmail}>
            <div style={title}>Confirm New Email</div>
            <div style={subtitle}>Code sent to <b style={{ color: "#e2e8f0" }}>{pendingVerifyEmail}</b></div>
            <label style={label}>Verification Code</label>
            <input type="text" inputMode="numeric" pattern="[0-9]*" autoComplete="one-time-code"
              value={otp}
              onChange={e => { setOtp(e.target.value.replace(/\D/g, "").slice(0, 10)); setError(""); }}
              onPaste={e => { e.preventDefault(); const t = (e.clipboardData.getData("text") || "").replace(/\D/g, "").slice(0, 10); setOtp(t); }}
              style={{ ...input, letterSpacing: 6, textAlign: "center", fontSize: 22 }} maxLength={10} autoFocus />
            {error && <div style={{ color: "#ef4444", fontSize: 12, marginTop: 10 }}>✗ {error}</div>}
            <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
              <button type="button" style={btn()} onClick={() => setStep("menu")}>Cancel</button>
              <button type="submit" disabled={busy || otp.length < 6} style={{ ...btn("primary"), flex: 1 }}>{busy ? "Verifying..." : "Verify & Save"}</button>
            </div>
          </form>
        )}

        {step === "done" && (
          <div style={{ textAlign: "center", padding: "20px 0" }}>
            <div style={{ fontSize: 48, color: "#22c55e", marginBottom: 12 }}>✓</div>
            <div style={title}>Saved!</div>
            <div style={subtitle}>Your changes are synced to the cloud and available on all your devices.</div>
            <button style={btn("primary")} onClick={onClose}>Done</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── STYLES ───

const css = `
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&family=JetBrains+Mono:wght@300;400;500;700&display=swap');

* { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg-deep: #020510; --bg-card: rgba(12,18,35,0.08); --bg-hover: rgba(30,41,59,0.08); --bg-input: rgba(10,20,40,0.1);
  --border: rgba(56,68,100,0.15); --border-focus: #6366f1;
  --text-primary: #e2e8f0; --text-secondary: #94a3b8; --text-muted: #64748b;
  --accent: #6366f1; --accent-glow: rgba(99,102,241,0.15);
  --success: #22c55e; --warning: #f59e0b; --error: #ef4444;
  --amber: #f59e0b; --amber-glow: rgba(245,158,11,0.08);
  --glass: rgba(10,15,30,0.07); --glass-border: rgba(99,102,241,0.08);
}

html { background: var(--bg-deep); }
body { background: transparent; color: var(--text-primary); font-family: ${fontBody}; }

/* App shell — MUST be transparent so the fixed BackgroundLayer (z-index:0)
   renders through. The body background acts as the base color fallback. */
.proxima-app { display: flex; height: 100vh; overflow: hidden; position: relative; background: transparent; z-index: 1; }

.proxima-app > * { position: relative; z-index: 1; }

.sidebar { width: 56px; background: var(--nav-bg); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); border-right: 1px solid var(--glass-border); display: flex; flex-direction: column; align-items: center; padding: 12px 0; gap: 4px; flex-shrink: 0; }
.sidebar-btn { width: 40px; height: 40px; border: none; background: transparent; color: var(--text-muted); border-radius: 10px; cursor: pointer; font-size: 18px; display: flex; align-items: center; justify-content: center; transition: all 0.3s cubic-bezier(0.4,0,0.2,1); }
.sidebar-btn:hover { background: rgba(99,102,241,0.1); color: var(--text-primary); transform: scale(1.1); }
.sidebar-btn:active { transform: scale(0.95); }
.sidebar-btn.active { background: rgba(99,102,241,0.15); color: var(--accent); border: 1px solid rgba(99,102,241,0.3); box-shadow: 0 0 12px rgba(99,102,241,0.2); }
.sidebar-logo { font-size: 22px; margin-bottom: 16px; cursor: default; }
/* Push save button to bottom of vertical sidebar on desktop */
.sidebar-save-wrap { margin-top: auto; padding-top: 8px; border-top: 1px solid var(--glass-border); width: 100%; display: flex; justify-content: center; }
@media (max-width: 768px) {
  /* On mobile (horizontal sidebar) don't push to an "end" — just sit inline */
  .sidebar-save-wrap { margin-top: 0; margin-left: auto; padding-top: 0; border-top: none; border-left: 1px solid var(--glass-border); padding-left: 6px; margin-left: 6px; width: auto; }
}

.main { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-width: 0; position: relative; z-index: 1; }
.topbar { height: 48px; border-bottom: 1px solid var(--glass-border); display: flex; align-items: center; justify-content: space-between; padding: 0 20px; flex-shrink: 0; background: var(--nav-bg); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); position: relative; z-index: 10; }
.topbar-title { font-family: ${font}; font-size: 13px; font-weight: 600; letter-spacing: 0.5px; color: var(--text-secondary); }
.balance-pill { font-family: ${font}; font-size: 12px; color: var(--success); background: rgba(34,197,94,0.1); border: 1px solid rgba(34,197,94,0.2); padding: 4px 10px; border-radius: 20px; }

.content { flex: 1; overflow-y: auto; padding: 20px; min-width: 0; max-width: 100%; }

/* Cockpit */
.cockpit { display: grid; grid-template-columns: 360px 1fr; gap: 24px; height: 100%; min-height: 0; }
.cockpit-left { display: flex; flex-direction: column; gap: 16px; overflow-y: auto; overflow-x: hidden; padding-right: 8px; padding-bottom: 60px; flex-shrink: 0; min-height: 0; scrollbar-gutter: stable; }
.cockpit-left::-webkit-scrollbar { width: 8px; }
.cockpit-left::-webkit-scrollbar-track { background: rgba(10,20,40,0.2); border-radius: 4px; }
.cockpit-left::-webkit-scrollbar-thumb { background: rgba(99,102,241,0.3); border-radius: 4px; }
.cockpit-left::-webkit-scrollbar-thumb:hover { background: rgba(99,102,241,0.5); }
.cockpit-right { overflow-y: auto; min-width: 0; min-height: 0; padding-bottom: 40px; }
@media (min-width: 1600px) {
  .cockpit { grid-template-columns: 400px 1fr; gap: 28px; }
}
@media (max-width: 1200px) {
  .cockpit { grid-template-columns: 340px 1fr; gap: 20px; }
}

.card { background: var(--bg-card); border: 1px solid var(--glass-border); border-radius: 14px; padding: 16px; transition: border-color 0.3s, box-shadow 0.3s; backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); }
.card:hover { border-color: rgba(99,102,241,0.25); box-shadow: 0 4px 24px rgba(99,102,241,0.06); }
.card-title { font-family: ${font}; font-size: 11px; font-weight: 600; color: var(--text-muted); letter-spacing: 1px; text-transform: uppercase; margin-bottom: 10px; }

.type-tabs-wrap { position: relative; flex-shrink: 0; }
.type-tabs-wrap::after { content: ""; position: absolute; top: 0; right: 0; bottom: 0; width: 28px; pointer-events: none; background: linear-gradient(to right, transparent, rgba(5,8,22,0.6)); border-radius: 0 12px 12px 0; opacity: 0; transition: opacity 0.2s; }
.type-tabs-wrap.has-overflow::after { opacity: 1; }
.type-tabs { display: flex; gap: 4px; background: var(--bg-input); border: 1px solid var(--glass-border); border-radius: 12px; padding: 3px; overflow-x: auto; overflow-y: hidden; flex-wrap: nowrap; scroll-behavior: smooth; -webkit-overflow-scrolling: touch; scroll-snap-type: x proximity; backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); }
.type-tabs::-webkit-scrollbar { height: 4px; }
.type-tabs::-webkit-scrollbar-track { background: transparent; }
.type-tabs::-webkit-scrollbar-thumb { background: rgba(99,102,241,0.25); border-radius: 2px; }
.type-tabs::-webkit-scrollbar-thumb:hover { background: rgba(99,102,241,0.4); }
.type-tab { flex: 0 0 auto; padding: 9px 14px; min-width: 110px; border: none; background: transparent; color: var(--text-muted); font-size: 12px; font-family: ${fontBody}; font-weight: 500; border-radius: 9px; cursor: pointer; transition: all 0.3s cubic-bezier(0.4,0,0.2,1); white-space: nowrap; text-align: center; scroll-snap-align: start; }
.tab-label-full { display: inline; }
.tab-label-short { display: none; }
.tab-icon { display: none; }
.type-tab:hover { color: var(--text-secondary); background: rgba(99,102,241,0.08); }
.type-tab:active { transform: scale(0.97); }
.type-tab.active { background: linear-gradient(135deg, #6366f1, #8b5cf6); color: white; box-shadow: 0 2px 12px rgba(99,102,241,0.3); }

.prompt-area { width: 100%; min-height: 90px; background: var(--bg-input); border: 1px solid var(--glass-border); border-radius: 10px; padding: 12px; color: var(--text-primary); font-family: ${fontBody}; font-size: 14px; resize: vertical; outline: none; transition: border-color 0.3s, box-shadow 0.3s; backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); }
.prompt-area:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(99,102,241,0.1), 0 0 20px rgba(99,102,241,0.08); }
.prompt-area::placeholder { color: var(--text-muted); }

.model-grid { display: flex; flex-direction: column; gap: 4px; max-height: 280px; overflow-y: auto; overflow-x: hidden; }
.model-item { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-radius: 8px; cursor: pointer; transition: all 0.25s cubic-bezier(0.4,0,0.2,1); border: 1px solid transparent; }
.model-item:hover { background: rgba(99,102,241,0.06); border-color: rgba(99,102,241,0.1); }
.model-item:active { transform: scale(0.98); }
.model-item.selected { background: rgba(99,102,241,0.1); border-color: rgba(99,102,241,0.25); box-shadow: 0 0 12px rgba(99,102,241,0.08); }
.model-check { width: 16px; height: 16px; border-radius: 4px; border: 2px solid var(--text-muted); display: flex; align-items: center; justify-content: center; flex-shrink: 0; transition: all 0.25s cubic-bezier(0.4,0,0.2,1); font-size: 10px; }
.model-item.selected .model-check { background: linear-gradient(135deg, #6366f1, #8b5cf6); border-color: #6366f1; color: white; box-shadow: 0 0 8px rgba(99,102,241,0.4); }
.model-name { font-size: 13px; font-weight: 500; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-provider { font-size: 10px; font-family: ${font}; padding: 2px 6px; border-radius: 4px; font-weight: 500; }
.hot-badge { font-size: 9px; background: var(--error); color: white; padding: 1px 5px; border-radius: 3px; font-weight: 700; font-family: ${font}; }
.model-price { font-size: 11px; font-family: ${font}; color: var(--text-muted); }
.model-meta { display: contents; }

.settings-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.settings-row label { font-size: 11px; color: var(--text-muted); font-weight: 500; }
.settings-select, .settings-input { background: var(--bg-input); border: 1px solid var(--glass-border); border-radius: 6px; padding: 6px 8px; color: var(--text-primary); font-size: 12px; font-family: ${font}; outline: none; min-width: 70px; transition: border-color 0.3s, box-shadow 0.3s; backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); }
.settings-select:focus, .settings-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(99,102,241,0.1); }

.action-panel { display: flex; flex-direction: column; gap: 10px; }
.gen-btn { width: 100%; padding: 12px; border: none; border-radius: 12px; font-family: ${font}; font-size: 14px; font-weight: 700; cursor: pointer; transition: all 0.35s cubic-bezier(0.4,0,0.2,1); letter-spacing: 0.5px; position: relative; overflow: hidden; }
.gen-btn.ready { background: linear-gradient(135deg, #6366f1, #8b5cf6, #a78bfa); color: white; box-shadow: 0 2px 12px rgba(99,102,241,0.25); }
.gen-btn.ready:hover { transform: translateY(-2px); box-shadow: 0 8px 30px rgba(99,102,241,0.4); }
.gen-btn.ready:active { transform: translateY(0) scale(0.98); }
.gen-btn.running { background: rgba(30,41,59,0.3); color: var(--warning); cursor: not-allowed; }
.gen-btn:disabled { opacity: 0.4; cursor: not-allowed; transform: none; box-shadow: none; }

.cost-bar { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: var(--amber-glow); border: 1px solid rgba(245,158,11,0.2); border-radius: 8px; font-size: 12px; }
.cost-bar .cost-amount { font-family: ${font}; color: var(--amber); font-weight: 600; }

/* Progress + Results */
.task-card { background: var(--bg-card); border: 1px solid var(--glass-border); border-radius: 14px; padding: 14px; margin-bottom: 12px; transition: border-color 0.3s; animation: fadeSlideIn 0.4s ease; backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); }
.task-card:hover { border-color: rgba(99,102,241,0.2); }
@keyframes fadeSlideIn { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
.task-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.task-model { font-size: 13px; font-weight: 600; }
.task-status { font-size: 11px; font-family: ${font}; padding: 3px 8px; border-radius: 12px; font-weight: 600; }
.task-status.pending { background: rgba(148,163,184,0.1); color: var(--text-muted); }
.task-status.processing { background: rgba(99,102,241,0.1); color: var(--accent); }
.task-status.completed { background: rgba(34,197,94,0.1); color: var(--success); }
.task-status.failed { background: rgba(239,68,68,0.1); color: var(--error); }
.task-timer { font-family: ${font}; font-size: 12px; color: var(--text-muted); margin-top: 4px; }
.task-progress { height: 3px; background: var(--bg-input); border-radius: 2px; margin-top: 8px; overflow: hidden; }
.task-progress-fill { height: 100%; background: linear-gradient(90deg, #6366f1, #a78bfa); border-radius: 2px; transition: width 0.5s ease; box-shadow: 0 0 8px rgba(99,102,241,0.4); }

.result-img { width: 100%; border-radius: 8px; margin-top: 10px; cursor: pointer; transition: transform 0.2s; max-height: 300px; object-fit: cover; }
.result-img:hover { transform: scale(1.01); }
.result-video { width: 100%; border-radius: 8px; margin-top: 10px; max-height: 300px; }
.result-actions { display: flex; gap: 6px; margin-top: 8px; }
.result-action-btn { padding: 5px 10px; font-size: 11px; border-radius: 6px; border: 1px solid var(--glass-border); background: var(--bg-input); color: var(--text-secondary); cursor: pointer; font-family: ${font}; transition: all 0.25s cubic-bezier(0.4,0,0.2,1); }
.result-action-btn:hover { background: rgba(99,102,241,0.12); color: var(--text-primary); border-color: rgba(99,102,241,0.4); box-shadow: 0 2px 10px rgba(99,102,241,0.15); }
.result-action-btn:active { transform: scale(0.96); }

.results-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px; }
@media (min-width: 1600px) {
  .results-grid { grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 18px; }
}

/* Logs */
.log-row { display: grid; grid-template-columns: 140px 1fr 120px 80px 80px 60px; gap: 8px; padding: 10px 12px; border-bottom: 1px solid rgba(56,68,100,0.2); font-size: 12px; align-items: center; cursor: pointer; transition: all 0.25s; }
.log-row:hover { background: rgba(99,102,241,0.05); }
.log-header { font-weight: 700; color: var(--text-muted); font-family: ${font}; font-size: 10px; letter-spacing: 0.5px; text-transform: uppercase; cursor: default; }
.log-header:hover { background: transparent; }
.log-prompt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-secondary); }
.log-models { font-family: ${font}; color: var(--text-muted); font-size: 11px; }
.log-cost { font-family: ${font}; color: var(--amber); }
.log-replay { padding: 3px 8px; font-size: 10px; border-radius: 4px; border: 1px solid var(--glass-border); background: transparent; color: var(--accent); cursor: pointer; font-family: ${font}; transition: all 0.25s; }
.log-replay:hover { background: rgba(99,102,241,0.12); border-color: rgba(99,102,241,0.3); }

/* Settings */
.setting-group { margin-bottom: 24px; }
.setting-label { font-size: 12px; font-weight: 600; color: var(--text-secondary); margin-bottom: 6px; }
.setting-input { width: 100%; background: var(--bg-input); border: 1px solid var(--glass-border); border-radius: 8px; padding: 10px 12px; color: var(--text-primary); font-family: ${font}; font-size: 13px; outline: none; transition: border-color 0.3s, box-shadow 0.3s; backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); }
.setting-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(99,102,241,0.1), 0 0 20px rgba(99,102,241,0.06); }
.setting-hint { font-size: 11px; color: var(--text-muted); margin-top: 4px; }

.api-test-btn { padding: 8px 16px; background: linear-gradient(135deg, #6366f1, #8b5cf6); color: white; border: none; border-radius: 6px; font-family: ${font}; font-size: 12px; cursor: pointer; margin-top: 8px; transition: all 0.3s cubic-bezier(0.4,0,0.2,1); }
.api-test-btn:hover:not(:disabled) { box-shadow: 0 4px 16px rgba(99,102,241,0.35); transform: translateY(-1px); }
.api-test-btn:active:not(:disabled) { transform: scale(0.97); }
.api-test-btn:disabled { opacity: 0.5; cursor: not-allowed; }

/* Empty State */
.empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 300px; color: var(--text-muted); text-align: center; gap: 12px; }
.empty-state .emoji { font-size: 48px; }
.empty-state .msg { font-size: 14px; max-width: 300px; line-height: 1.5; }

/* Lightbox */
.lightbox { position: fixed; inset: 0; background: rgba(5,8,22,0.95); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); z-index: 1000; display: flex; align-items: center; justify-content: center; cursor: pointer; animation: fadeIn 0.25s ease; }
.lightbox img, .lightbox video { max-width: 92vw; max-height: 92vh; border-radius: 10px; box-shadow: 0 8px 40px rgba(0,0,0,0.5); }

/* Scrollbar */
::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: var(--text-muted); }

/* Animations */
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
@keyframes glowPulse { 0%,100% { box-shadow: 0 0 12px rgba(99,102,241,0.15); } 50% { box-shadow: 0 0 24px rgba(99,102,241,0.3); } }
.fade-in { animation: fadeIn 0.35s cubic-bezier(0.4,0,0.2,1); }
.pulse { animation: pulse 1.5s ease-in-out infinite; }
.content { animation: fadeIn 0.3s ease; }
.task-status.processing { animation: glowPulse 2s ease-in-out infinite; }

@media (max-width: 768px) {
  /* Lock horizontal scroll — no page panning at all */
  html, body, #root, .proxima-app, .main, .content { overflow-x: hidden; max-width: 100vw; }
  .proxima-app { flex-direction: column; }
  .sidebar { width: 100%; flex-direction: row; padding: 0 8px 0 max(8px, env(safe-area-inset-left)); gap: 2px; border-right: none; border-bottom: 1px solid var(--glass-border); overflow-x: auto; flex-shrink: 0; height: 56px; padding-top: env(safe-area-inset-top); justify-content: center; background: rgba(5,8,22,0.3); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); }
  .sidebar-logo { margin-bottom: 0; margin-right: 10px; font-size: 20px; }
  .sidebar-btn { width: 46px; height: 46px; font-size: 22px; }

  .topbar { height: 46px; padding: 0 16px; background: rgba(5,8,22,0.3); }
  .topbar-title { font-size: 11px; letter-spacing: 0.4px; }

  /* Page-scroll container: large bottom pad so the sticky gen bar never covers content */
  .content { padding: 14px 14px calc(160px + env(safe-area-inset-bottom)) 14px; -webkit-overflow-scrolling: touch; }

  .cockpit { grid-template-columns: 1fr; gap: 12px; height: auto; min-height: auto; position: relative; }
  .cockpit-left { padding-right: 0; padding-bottom: 0; gap: 12px; overflow: visible; min-height: auto; }
  .cockpit-left::-webkit-scrollbar { display: none; }
  .cockpit-right { overflow: visible; padding-bottom: 0; }

  /* All 5 tabs fit on one row: icon stacked above short label, equal flex distribution */
  .type-tabs-wrap { margin: 0; }
  .type-tabs-wrap::after { display: none; }
  .type-tabs { gap: 3px; padding: 3px; border-radius: 11px; overflow: hidden; flex-wrap: nowrap; width: 100%; }
  .type-tab { padding: 7px 2px; font-size: 9.5px; border-radius: 9px; flex: 1 1 0; min-width: 0; max-width: none; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; line-height: 1.2; letter-spacing: 0.2px; font-weight: 600; white-space: nowrap; }
  .type-tab .tab-icon { display: block; font-size: 16px; line-height: 1; }
  .type-tab .tab-label-full { display: none; }
  .type-tab .tab-label-short { display: block; font-size: 10px; text-transform: uppercase; letter-spacing: 0.3px; }

  .card { padding: 14px; border-radius: 14px; }
  .card-title { font-size: 11px; margin-bottom: 10px; letter-spacing: 0.8px; }

  .prompt-area { min-height: 96px; padding: 13px; font-size: 16px; border-radius: 11px; }

  /* On taller screens, expand the model list so users see more without scrolling the inner panel */
  .model-grid { max-height: 320px; gap: 6px; }

  .model-item { padding: 12px 14px; border-radius: 11px; gap: 0; flex-wrap: wrap; align-items: flex-start; min-height: 56px; }
  .model-check { width: 22px; height: 22px; border-radius: 6px; font-size: 13px; margin-right: 12px; margin-top: 1px; }
  .model-name { font-size: 14.5px; white-space: normal; overflow: visible; text-overflow: unset; flex: 1; min-width: calc(100% - 36px); line-height: 1.3; }
  .model-meta { display: flex; align-items: center; gap: 8px; width: 100%; padding-left: 34px; margin-top: 6px; }
  .model-provider { font-size: 11px; padding: 3px 8px; border-radius: 5px; }
  .hot-badge { font-size: 10px; padding: 2px 6px; border-radius: 4px; }
  .model-price { font-size: 13px; margin-left: auto; }

  .settings-row { gap: 10px; }
  .settings-row label { font-size: 13px; }
  .settings-select, .settings-input { padding: 10px 12px; font-size: 14px; border-radius: 8px; min-width: 80px; min-height: 40px; }

  /* Sticky bottom action panel — contains cost + generate button, always reachable by thumb on 6.7" phones */
  .action-panel { position: fixed; left: 0; right: 0; bottom: 0; z-index: 50; padding: 10px 14px calc(10px + env(safe-area-inset-bottom)) 14px; background: linear-gradient(to top, rgba(2,5,16,0.97) 60%, rgba(2,5,16,0.8) 90%, rgba(2,5,16,0)); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); border-top: 1px solid rgba(99,102,241,0.15); display: flex; flex-direction: column; gap: 8px; }
  .action-panel .cost-bar { margin: 0; padding: 9px 14px; font-size: 13px; border-radius: 10px; }
  .action-panel .gen-btn { margin: 0; }
  .action-panel .gen-hint { display: none; }
  .gen-btn { padding: 15px; font-size: 15px; border-radius: 12px; min-height: 52px; letter-spacing: 0.8px; }

  .cost-bar { padding: 12px 16px; font-size: 14px; border-radius: 10px; }

  .task-card { padding: 16px; border-radius: 14px; margin-bottom: 14px; }
  .task-model { font-size: 15px; }
  .task-status { font-size: 12px; padding: 4px 10px; }
  .task-timer { font-size: 13px; }

  .result-img { border-radius: 10px; max-height: 400px; }
  .result-video { border-radius: 10px; max-height: 400px; }
  .result-actions { gap: 8px; margin-top: 12px; flex-wrap: wrap; }
  .result-action-btn { padding: 10px 14px; font-size: 13px; border-radius: 8px; }

  .results-grid { grid-template-columns: 1fr; gap: 14px; }

  .log-row { grid-template-columns: 1fr 60px 50px; gap: 6px; padding: 12px 14px; font-size: 13px; }
  .log-row > :nth-child(1) { display: none; }
  .log-row > :nth-child(5), .log-row > :nth-child(6) { display: none; }
  .log-header > :nth-child(1) { display: none; }

  .setting-group { margin-bottom: 28px; }
  .setting-label { font-size: 14px; margin-bottom: 8px; }
  .setting-input { padding: 14px 16px; font-size: 15px; border-radius: 10px; }
  .setting-hint { font-size: 13px; margin-top: 6px; }
  .api-test-btn { padding: 12px 20px; font-size: 14px; border-radius: 8px; }

  .empty-state { height: 200px; }
  .empty-state .emoji { font-size: 40px; }
  .empty-state .msg { font-size: 15px; }
}
`;

// ─── HELPERS ───
// Empirical avg generation time (ms) per model — from actual Supabase history
const MODEL_AVG_MS = {
  "alibaba/wan-2.6/text-to-image": 7000, "alibaba/wan-2.7/image-edit-pro": 19600,
  "bytedance/seedream-v4.5": 25900, "bytedance/seedream-v5.0-lite": 34700,
  "bytedance/seedream-v5.0-lite/edit": 35000, "bytedance/seedream-v5.0-lite/edit-sequential": 51100,
  "bytedance/seedream-v5.0-lite/sequential": 36500, "bytedance/seedream-v4.5/edit": 26000,
  "bytedance/seededit-v3": 20000, "google/imagen4": 22200,
  "google/nano-banana-2/text-to-image": 30800, "google/nano-banana-2/edit": 31000,
  "google/nano-banana-pro/text-to-image": 52000, "google/nano-banana-pro/edit": 52000,
  "google/gemini-2.5-flash-image/edit": 15000,
  "luma/photon": 6900, "openai/dall-e-3": 15000,
  "wavespeed-ai/flux-2-klein-4b/text-to-image-lora": 23600,
  "wavespeed-ai/flux-2-klein-9b/text-to-image": 5500,
  "wavespeed-ai/flux-dev": 7000, "wavespeed-ai/flux-schnell": 5500,
  "wavespeed-ai/flux-2-pro/edit": 12000, "wavespeed-ai/flux-kontext-pro": 12000,
  "wavespeed-ai/phota/text-to-image": 33000, "wavespeed-ai/phota/edit": 33000,
  "wavespeed-ai/qwen-image-2.0-pro/text-to-image": 10200,
  "wavespeed-ai/qwen-image-2.0-pro/edit": 10200,
  "wavespeed-ai/qwen-image-edit": 10000, "wavespeed-ai/qwen-image-text-to-image": 10000,
  "wavespeed-ai/firered-image-v1.1-edit": 8000, "wavespeed-ai/step1x-edit": 8000,
  "alibaba/wan-2.7/image-edit": 18000,
};
const FALLBACK_MS = { image: 15000, i2i: 20000, t2v: 120000, i2v: 90000, avatar: 60000 };
function getExpectedMs(modelId, genType) {
  return MODEL_AVG_MS[modelId] || FALLBACK_MS[genType] || 30000;
}

function genId() { return typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }
function formatTime(ms) {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  return s >= 60 ? `${(s / 60).toFixed(1)}m` : `${s.toFixed(1)}s`;
}
function formatCost(c) { return `$${c.toFixed(4)}`; }
function timeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return formatTimestamp(ts);
}
function formatTimestamp(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", hour12: true, month: "short", day: "numeric" });
}

// ─── API SERVICE ───
// ─── MAIN APP ───
export default function ProximaApp() {
  const [isAuthed, setIsAuthed] = useState(() => {
    try { return !!localStorage.getItem("proximaai-user"); } catch { return false; }
  });
  const [page, setPage] = useState("cockpit");
  const [apiKey, setApiKey] = useState("");
  const [balance, setBalance] = useState(null);
  const [genType, setGenType] = useState("image");
  const [selectedModels, setSelectedModels] = useState([]);
  const [prompt, setPrompt] = useState("");
  const [negPrompt, setNegPrompt] = useState("");
  const [resolution, setResolution] = useState("1k");
  const [duration, setDuration] = useState(5);
  const [seed, setSeed] = useState("-1");
  const [aspectRatio, setAspectRatio] = useState("auto");
  const [perModelRes, setPerModelRes] = useState({});
  const [sourceImageUrl, setSourceImageUrl] = useState("");
  const [sourceImageUrls, setSourceImageUrls] = useState([]); // multi-image support
  const [sourcePreview, setSourcePreview] = useState("");
  const [uploadStatus, setUploadStatus] = useState(""); // "" | "uploading" | "done" | "error"
  const [testStatus, setTestStatus] = useState(null); // null | "testing" | {ok, msg}
  const fileInputRef = useRef(null);
  const multiImageInputRef = useRef(null);
  const [tasks, setTasks] = useState([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [logs, setLogs] = useState([]);
  const [lightbox, setLightbox] = useState(null);
  const [defaultImageRes, setDefaultImageRes] = useState("1k");
  const [defaultVideoDur, setDefaultVideoDur] = useState(5);
  const [galleryTabState, setGalleryTabState] = useState("completed");
  const [galleryView, setGalleryView] = useState("masonry");
  const [numImages, setNumImages] = useState(1);
  const [storageStats, setStorageStats] = useState(null);
  const [showAccountModal, setShowAccountModal] = useState(false);
  const [accountToast, setAccountToast] = useState("");
  // ── Theme + animated background settings ──
  const [theme, setThemeState] = useState(() => { try { return localStorage.getItem("proximaai-theme") || "default"; } catch { return "default"; } });
  const [background, setBackgroundState] = useState(() => {
    try {
      const v = localStorage.getItem("proximaai-background");
      // Migrate legacy "void" preference to "orbs" since we removed the image bg
      return (!v || v === "void") ? "orbs" : v;
    } catch { return "orbs"; }
  });
  const [lightMode, setLightModeState] = useState(() => { try { return localStorage.getItem("proximaai-lightMode") === "1"; } catch { return false; } });
  const [archiveStats, setArchiveStats] = useState({ bytes: 0, count: 0 });
  useTheme({ theme, lightMode });

  // Force-flush all pending cloud writes + replay any failed entries
  const forceSaveAll = async () => {
    setSaveStatus("saving");
    if (taskSyncTimerRef.current) { clearTimeout(taskSyncTimerRef.current); taskSyncTimerRef.current = null; }
    const queue = taskSyncQueueRef.current.splice(0);
    if (queue.length > 0) {
      try { await syncTasksBatch(queue); for (const t of queue) removeFailedSync("task", t.id); } catch {}
    }
    if (apiKeyDebounceRef.current) { clearTimeout(apiKeyDebounceRef.current); apiKeyDebounceRef.current = null; }
    if (apiKey) { try { await syncSetting("apiKey", apiKey); removeFailedSync("setting", "apiKey"); } catch {} }
    const failed = getFailedSyncs();
    const taskRetries = failed.filter(f => f.kind === "task").map(f => f.data).filter(Boolean);
    if (taskRetries.length > 0) { try { await syncTasksBatch(taskRetries); for (const t of taskRetries) removeFailedSync("task", t.id); } catch {} }
    for (const f of failed.filter(f => f.kind === "history")) { try { await syncHistoryEntry(f.data); removeFailedSync("history", f.id); } catch {} }
    for (const f of failed.filter(f => f.kind === "setting")) { try { await syncSetting(f.id, f.data); removeFailedSync("setting", f.id); } catch {} }
    const remaining = getFailedSyncs().length;
    setFailedSyncCount(remaining);
    if (remaining === 0) { setSaveStatus("saved"); setTimeout(() => setSaveStatus(s => s === "saved" ? "idle" : s), 2000); }
    else setSaveStatus("error");
  };

  // Long-press handler: full manual cloud backup (settings + tasks + history + favorites)
  const triggerManualBackup = async () => {
    setSaveStatus("saving");
    // Flush everything first so the backup includes the very latest state
    await forceSaveAll();
    setSaveStatus("saving");
    const r = await createBackup("manual", "Long-press save from nav");
    if (r.ok) {
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus(s => s === "saved" ? "idle" : s), 2500);
      setAccountToast("☁ Full backup saved to cloud");
      setTimeout(() => setAccountToast(""), 4000);
    } else {
      setSaveStatus("error");
      setAccountToast("Backup failed: " + (r.error || "unknown"));
      setTimeout(() => setAccountToast(""), 5000);
    }
  };

  const setTheme = (v) => {
    setThemeState(v);
    try { localStorage.setItem("proximaai-theme", v); } catch {}
    setSetting("theme", v);
    syncSetting("theme", v).catch(() => {});
  };
  const setBackground = (v) => {
    setBackgroundState(v);
    try { localStorage.setItem("proximaai-background", v); } catch {}
    setSetting("background", v);
    syncSetting("background", v).catch(() => {});
  };
  const setLightMode = (v) => {
    setLightModeState(v);
    try { localStorage.setItem("proximaai-lightMode", v ? "1" : "0"); } catch {}
    setSetting("lightMode", v ? "1" : "0");
    syncSetting("lightMode", v ? "1" : "0").catch(() => {});
  };

  const [saveStatus, setSaveStatus] = useState("idle"); // "idle" | "saving" | "saved" | "error"
  const pendingWritesRef = useRef(new Set());
  const saveStatusTimerRef = useRef(null);
  const [backups, setBackups] = useState([]);
  const [showBackupsPanel, setShowBackupsPanel] = useState(false);

  // Track any in-flight cloud write (lets the floating save button show live status)
  const markWriteStart = useCallback((key) => {
    pendingWritesRef.current.add(key);
    setSaveStatus("saving");
  }, []);
  const markWriteEnd = useCallback((key, ok) => {
    pendingWritesRef.current.delete(key);
    if (!ok) { setSaveStatus("error"); return; }
    if (pendingWritesRef.current.size === 0) {
      setSaveStatus("saved");
      if (saveStatusTimerRef.current) clearTimeout(saveStatusTimerRef.current);
      saveStatusTimerRef.current = setTimeout(() => setSaveStatus(s => s === "saved" ? "idle" : s), 2000);
    }
  }, []);
  const trackedSync = useCallback(async (key, fn) => {
    markWriteStart(key);
    try { const r = await fn(); markWriteEnd(key, true); return r; }
    catch (e) { markWriteEnd(key, false); throw e; }
  }, [markWriteStart, markWriteEnd]);
  const multiImageFileRef = useRef(null);
  const [activeCount, setActiveCount] = useState(0);
  const pollRefs = useRef({});
  const savedLogIds = useRef(new Set());
  const savedTaskIds = useRef(new Set());
  const isGeneratingRef = useRef(false);
  const timerRefs = useRef({});
  const initialLoadDone = useRef(false);
  const apiKeyDebounceRef = useRef(null);
  const taskSyncQueueRef = useRef([]);
  const taskSyncTimerRef = useRef(null);
  const bootstrapInProgress = useRef(false);
  const [failedSyncCount, setFailedSyncCount] = useState(0);

  // ─── AUTH HANDLERS ───
  // Initialize Supabase early so verifyCredentials can run before login
  useEffect(() => { if (isSupabaseConfigured()) initSupabase(); }, []);

  async function handleLogin(username, password) {
    // Check Supabase-stored credentials first, falls back to admin/admin if none set
    const valid = await verifyCredentials(username, password);
    if (valid) {
      try { localStorage.setItem("proximaai-user", "admin"); } catch {}
      resetDeviceIdCache();
      setIsAuthed(true);
      return true;
    }
    return false;
  }

  function handleLogout() {
    if (!confirm("Sign out? Your data will remain safely in the cloud — sign back in any time.")) return;
    try { localStorage.removeItem("proximaai-user"); } catch {}
    resetDeviceIdCache();
    // Clear in-memory state so next login re-fetches fresh
    setIsAuthed(false);
    setTasks([]);
    setLogs([]);
    setApiKey("");
    setBalance(null);
    setPage("cockpit");
    savedLogIds.current.clear();
    savedTaskIds.current.clear();
    initialLoadDone.current = false;
    taskSyncQueueRef.current = [];
  }

  // Load state from IndexedDB + Supabase (gated on authentication)
  useEffect(() => {
    if (!isAuthed) return;
    let cancelled = false;
    (async () => {
      await migrateFromLocalStorage();
      if (cancelled) return;

      // Load local data first (fast)
      const key = await getSetting("apiKey");
      if (key && !cancelled) {
        setApiKey(key);
        // Trigger balance check directly on initial load (bypasses debounced effect)
        checkBalance(key).then(r => { if (r.balance !== null && !cancelled) setBalance(r.balance); }).catch(() => {});
      }
      const logData = await getHistory(500);
      if (logData?.length && !cancelled) setLogs(logData);
      const savedTasks = await getCompletedTasks(500);
      if (savedTasks?.length && !cancelled) {
        for (const t of savedTasks) savedTaskIds.current.add(t.id);
        setTasks(savedTasks);
      }
      const savedImgRes = await getSetting("defaultImageRes");
      if (savedImgRes && !cancelled) setDefaultImageRes(savedImgRes);
      const savedVidDur = await getSetting("defaultVideoDur");
      if (savedVidDur && !cancelled) setDefaultVideoDur(Number(savedVidDur));
      // Theme + background settings (also synced to Supabase so they follow you across devices)
      const savedTheme = await getSetting("theme");
      if (savedTheme && !cancelled) setThemeState(savedTheme);
      const savedBg = await getSetting("background");
      if (savedBg && !cancelled) setBackgroundState(savedBg === "void" ? "orbs" : savedBg);
      const savedLight = await getSetting("lightMode");
      if (savedLight != null && !cancelled) setLightModeState(savedLight === "1" || savedLight === "true");


      // Then pull cloud data and merge (fills any gaps from other devices / recovery)
      await initSupabase();
      if (cancelled || !isSupabaseConfigured()) return;
      try {
        // Guard: flush any pending debounced writes BEFORE pulling cloud to avoid
        // a stale pre-bootstrap write landing after we've loaded fresh cloud data.
        bootstrapInProgress.current = true;
        if (taskSyncTimerRef.current) {
          clearTimeout(taskSyncTimerRef.current);
          taskSyncTimerRef.current = null;
          const queue = taskSyncQueueRef.current.splice(0);
          if (queue.length > 0) { try { await syncTasksBatch(queue); } catch { for (const t of queue) addFailedSync({ kind: "task", id: t.id, data: t }); } }
        }
        const remote = await pullAllRemoteData();
        if (cancelled || !remote) { bootstrapInProgress.current = false; return; }

        // Merge tasks: add any cloud tasks not already in local
        if (remote.tasks?.length > 0) {
          setTasks(prev => {
            const existingIds = new Set(prev.map(t => t.id));
            const newOnes = remote.tasks.filter(t => !existingIds.has(t.id));
            // Save new cloud tasks to local IndexedDB
            for (const t of newOnes) {
              savedTaskIds.current.add(t.id);
              saveTask(t);
            }
            return [...newOnes, ...prev].sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
          });
        }

        // Merge history: add any cloud logs not already in local
        if (remote.history?.length > 0) {
          setLogs(prev => {
            const existingIds = new Set(prev.map(l => l.id));
            const newOnes = remote.history.filter(l => !existingIds.has(l.id));
            for (const l of newOnes) {
              savedLogIds.current.add(l.id);
              addHistoryEntry(l);
            }
            return [...newOnes, ...prev].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
          });
        }

        // Merge settings: cloud wins for keys not set locally
        if (remote.settings) {
          if (!key && remote.settings.apiKey) {
            setApiKey(remote.settings.apiKey);
            setSetting("apiKey", remote.settings.apiKey);
            checkBalance(remote.settings.apiKey).then(r => { if (r.balance !== null && !cancelled) setBalance(r.balance); }).catch(() => {});
          }
          if (!savedImgRes && remote.settings.defaultImageRes) { setDefaultImageRes(remote.settings.defaultImageRes); setSetting("defaultImageRes", remote.settings.defaultImageRes); }
          if (!savedVidDur && remote.settings.defaultVideoDur) { setDefaultVideoDur(Number(remote.settings.defaultVideoDur)); setSetting("defaultVideoDur", remote.settings.defaultVideoDur); }
        }
      } catch {}
      // Bootstrap complete — allow persistence effect to schedule writes again
      bootstrapInProgress.current = false;
      // Replay any failed syncs from previous sessions
      if (!cancelled) {
        const failed = getFailedSyncs();
        setFailedSyncCount(failed.length);
        if (failed.length > 0) {
          const taskRetries = failed.filter(f => f.kind === "task").map(f => f.data).filter(Boolean);
          if (taskRetries.length > 0) {
            try {
              await syncTasksBatch(taskRetries);
              for (const t of taskRetries) removeFailedSync("task", t.id);
            } catch {}
          }
          const historyRetries = failed.filter(f => f.kind === "history").map(f => f.data).filter(Boolean);
          for (const entry of historyRetries) {
            try { await syncHistoryEntry(entry); removeFailedSync("history", entry.id); } catch {}
          }
          const settingRetries = failed.filter(f => f.kind === "setting");
          for (const s of settingRetries) {
            try { await syncSetting(s.id, s.data); removeFailedSync("setting", s.id); } catch {}
          }
          setFailedSyncCount(getFailedSyncs().length);
        }
      }
      // Mark initial load complete so future apiKey changes debounce-sync to cloud
      if (!cancelled) initialLoadDone.current = true;
    })();
    return () => { cancelled = true; };
  }, [isAuthed]);

  // Save API key — debounced to avoid keystroke-level syncs
  useEffect(() => {
    if (!apiKey) return;
    // Skip sync if this update came from the initial cloud load (avoids echo)
    if (!initialLoadDone.current) return;
    if (apiKeyDebounceRef.current) clearTimeout(apiKeyDebounceRef.current);
    apiKeyDebounceRef.current = setTimeout(() => {
      setSetting("apiKey", apiKey);
      // Preemptively queue as failed; remove on success. Guarantees no silent loss.
      addFailedSync({ kind: "setting", id: "apiKey", data: apiKey });
      setFailedSyncCount(getFailedSyncs().length);
      trackedSync("apiKey", () => syncSetting("apiKey", apiKey))
        .then(() => { removeFailedSync("setting", "apiKey"); setFailedSyncCount(getFailedSyncs().length); })
        .catch(() => { setFailedSyncCount(getFailedSyncs().length); });
      checkBalance(apiKey).then(r => { if (r.balance !== null) setBalance(r.balance); });
    }, 800);
    return () => { if (apiKeyDebounceRef.current) clearTimeout(apiKeyDebounceRef.current); };
  }, [apiKey]);

  // Save NEW logs to IndexedDB (and sync to Supabase) — skip already-saved entries
  useEffect(() => {
    if (logs.length > 0) {
      const latest = logs[0];
      if (latest?.id && !savedLogIds.current.has(latest.id)) {
        savedLogIds.current.add(latest.id);
        addHistoryEntry(latest);
        addFailedSync({ kind: "history", id: latest.id, data: latest });
        setFailedSyncCount(getFailedSyncs().length);
        trackedSync(`history-${latest.id}`, () => syncHistoryEntry(latest))
          .then(() => { removeFailedSync("history", latest.id); setFailedSyncCount(getFailedSyncs().length); })
          .catch(() => { setFailedSyncCount(getFailedSyncs().length); });
      }
    }
  }, [logs]);

  // Track active count
  useEffect(() => {
    const active = tasks.filter(t => t.status === "pending" || t.status === "processing").length;
    setActiveCount(active);
  }, [tasks]);

  // Persist completed/failed tasks to IndexedDB + batch sync to Supabase
  useEffect(() => {
    // Skip scheduling new writes during cloud bootstrap — prevents races with the pull
    if (bootstrapInProgress.current) return;
    const toSave = tasks.filter(t =>
      (t.status === "completed" || t.status === "failed") && !savedTaskIds.current.has(t.id)
    );
    if (toSave.length === 0) return;
    for (const t of toSave) {
      savedTaskIds.current.add(t.id);
      saveTask(t); // Local IndexedDB always succeeds first — cloud sync is separate
      taskSyncQueueRef.current.push(t);
      // Also record in failed-queue preemptively so if the tab closes mid-debounce,
      // the next session will replay it. Removed on successful cloud sync below.
      addFailedSync({ kind: "task", id: t.id, data: t });
    }
    setFailedSyncCount(getFailedSyncs().length);
    // Debounced batch upload to Supabase (flushes 300ms after last task)
    if (taskSyncTimerRef.current) clearTimeout(taskSyncTimerRef.current);
    taskSyncTimerRef.current = setTimeout(() => {
      const queue = taskSyncQueueRef.current.splice(0);
      taskSyncTimerRef.current = null;
      if (queue.length === 0) return;
      trackedSync(`tasks-batch-${Date.now()}`, () => syncTasksBatch(queue))
        .then(() => {
          // Successful sync — clear the preemptive failure entries
          for (const t of queue) removeFailedSync("task", t.id);
          setFailedSyncCount(getFailedSyncs().length);
        })
        .catch(() => {
          // Sync failed: entries already in failed-queue, nothing else to do.
          // Next mount will replay them automatically.
          setFailedSyncCount(getFailedSyncs().length);
        });
    }, 300);
  }, [tasks]);

  // Flush pending writes aggressively on page-hide / before-unload.
  // This is the main defense against the race: tab-close mid-debounce used to drop
  // the queued writes silently. Now we either (a) flush them immediately, or
  // (b) warn the user and rely on the failed-sync queue to replay on next mount.
  useEffect(() => {
    const flushPending = () => {
      // 1. Fire any pending task batch immediately
      if (taskSyncTimerRef.current) {
        clearTimeout(taskSyncTimerRef.current);
        taskSyncTimerRef.current = null;
        const queue = taskSyncQueueRef.current.splice(0);
        if (queue.length > 0) {
          // Fire-and-forget: we're mid-unload, can't await. The writes are already
          // in addFailedSync() so if this doesn't complete, replay handles it.
          syncTasksBatch(queue).then(() => {
            for (const t of queue) removeFailedSync("task", t.id);
          }).catch(() => {});
        }
      }
      // 2. Fire any pending apiKey debounce
      if (apiKeyDebounceRef.current) {
        clearTimeout(apiKeyDebounceRef.current);
        apiKeyDebounceRef.current = null;
        if (apiKey) {
          syncSetting("apiKey", apiKey).then(() => removeFailedSync("setting", "apiKey")).catch(() => {});
        }
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === "hidden") flushPending();
    };
    const onBeforeUnload = (e) => {
      flushPending();
      // If there are still unsaved writes in the failed queue, warn the user
      const failed = getFailedSyncs();
      if (failed.length > 0 || taskSyncQueueRef.current.length > 0) {
        e.preventDefault();
        e.returnValue = "";
        return "";
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("pagehide", flushPending);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("pagehide", flushPending);
    };
  }, [apiKey]);

  // Cleanup polling timeouts on unmount
  useEffect(() => {
    return () => { Object.values(pollRefs.current).forEach(id => clearTimeout(id)); };
  }, []);

  // ─── RESUME POLLING for in-flight tasks after refresh/close/OS-kill ───
  // On mount (after auth), load any pending/processing tasks from IndexedDB
  // with their saved pollUrl, inject them into state, and restart their polls.
  // Without this, hitting refresh or being backgrounded kills the poll timer
  // and the task stays "processing" forever.
  useEffect(() => {
    if (!isAuthed || !apiKey) return;
    let cancelled = false;
    (async () => {
      const pending = await getPendingTasks();
      if (cancelled || !pending?.length) return;
      // Merge into state (de-duped by id)
      setTasks(prev => {
        const ids = new Set(prev.map(t => t.id));
        const fresh = pending.filter(t => !ids.has(t.id));
        return [...fresh, ...prev].sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
      });
      // Restart polling for each
      for (const task of pending) {
        if (!task.pollUrl || pollRefs.current[task.id]) continue;
        const pollInterval = (task.genType === "image" || task.genType === "i2i") ? 3000 : 15000;
        const maxTimeout = (task.genType === "image" || task.genType === "i2i") ? 300000 : Infinity;
        const pollUrl = task.pollUrl;
        const poll = async () => {
          if (maxTimeout !== Infinity && Date.now() - task.startTime > maxTimeout) {
            setTasks(prev => prev.map(t => t.id === task.id ? { ...t, status: "failed", error: "Timeout (resumed)", endTime: Date.now() } : t));
            return;
          }
          try {
            const result = await pollResult(apiKey, pollUrl);
            const data = result?.data || result;
            if (data.status === "completed" && data.outputs?.length > 0) {
              const wallClock = Date.now() - task.startTime;
              setTasks(prev => prev.map(t => t.id === task.id ? {
                ...t, status: "completed", outputs: data.outputs,
                endTime: Date.now(), wallClockMs: wallClock,
                inferenceMs: data?.timings?.inference || wallClock,
                nsfw: data?.has_nsfw_contents
              } : t));
            } else if (data.status === "failed") {
              setTasks(prev => prev.map(t => t.id === task.id ? {
                ...t, status: "failed", error: data.error || "Generation failed", endTime: Date.now()
              } : t));
            } else {
              pollRefs.current[task.id] = setTimeout(poll, pollInterval);
            }
          } catch (e) {
            if (e.code === 429) pollRefs.current[task.id] = setTimeout(poll, pollInterval * 2 + Math.random() * 2000);
            else setTasks(prev => prev.map(t => t.id === task.id ? { ...t, status: "failed", error: e.message || "Poll error (resumed)", endTime: Date.now() } : t));
          }
        };
        // Start polling immediately (the task's been waiting)
        pollRefs.current[task.id] = setTimeout(poll, 500);
      }
    })();
    return () => { cancelled = true; };
  }, [isAuthed, apiKey]);

  // Clean up pollUrl from IndexedDB once a task reaches terminal state.
  // Reuses the saveTask call that already runs in the persistence effect —
  // at that point status is completed/failed so pollUrl is simply overwritten.
  // Nothing extra to do; the field just becomes harmless metadata.

  // ─── BACK-BUTTON TRAP (PWA / mobile browsers) ───
  // Without this, Android back gesture or browser back button exits the PWA,
  // killing in-flight polls. Trap popstate, require a second press within 2s
  // to actually exit.
  useEffect(() => {
    if (!isAuthed) return;
    // Seed two history entries so we have something to catch
    try { window.history.pushState({ proximaTrap: 1 }, ""); } catch {}
    let lastBackAt = 0;
    let toastTimer = null;

    const onPopState = () => {
      const now = Date.now();
      if (now - lastBackAt < 2000) {
        // Second press within 2s — actually allow exit
        window.removeEventListener("popstate", onPopState);
        window.history.back();
        return;
      }
      // First press — show toast, push state back
      lastBackAt = now;
      setAccountToast("Press back again to exit");
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => setAccountToast(""), 2000);
      try { window.history.pushState({ proximaTrap: 1 }, ""); } catch {}
    };

    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
      if (toastTimer) clearTimeout(toastTimer);
    };
  }, [isAuthed]);

  const models = MODELS[genType] || [];
  const estCost = selectedModels.reduce((sum, id) => {
    const m = models.find(x => x.id === id);
    return sum + (m?.price || 0) * (numImages || 1);
  }, 0);

  function toggleModel(id) {
    setSelectedModels(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }

  // ─── FILE UPLOAD ───
  async function uploadSingleFile(file) {
    const formData = new FormData();
    formData.append("file", file);
    const { res } = await proxiedFetch(`${API_BASE}/media/upload/binary`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}` },
      body: formData
    });
    if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
    const data = await res.json();
    return data?.data?.download_url || data?.data?.url || null;
  }

  async function handleFileSelect(e) {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    // Preview first image
    const reader = new FileReader();
    reader.onload = (ev) => setSourcePreview(ev.target.result);
    reader.readAsDataURL(files[0]);

    if (!apiKey) { setUploadStatus("error"); return; }
    setUploadStatus("uploading");

    try {
      // Upload all files in parallel
      const uploadPromises = files.map(f => uploadSingleFile(f));
      const urls = (await Promise.all(uploadPromises)).filter(Boolean);

      if (urls.length === 0) throw new Error("No URLs returned");

      // First image goes to primary sourceImageUrl
      setSourceImageUrl(urls[0]);

      // Additional images go to sourceImageUrls (for multi-image models)
      if (urls.length > 1) {
        setSourceImageUrls(prev => [...prev, ...urls.slice(1)]);
      }

      setUploadStatus("done");
    } catch (err) {
      console.error("Upload error:", err);
      setUploadStatus("error");
    }
    // Reset input so same files can be re-selected
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  // Upload additional reference images from gallery picker
  async function handleAdditionalFileSelect(e) {
    const files = Array.from(e.target.files || []);
    if (files.length === 0 || !apiKey) return;
    try {
      const uploadPromises = files.map(f => uploadSingleFile(f));
      const urls = (await Promise.all(uploadPromises)).filter(Boolean);
      if (urls.length > 0) {
        setSourceImageUrls(prev => [...prev, ...urls]);
      }
    } catch (err) {
      console.error("Additional image upload error:", err);
    }
    if (multiImageFileRef.current) multiImageFileRef.current.value = "";
  }

  function clearSourceImage() {
    setSourceImageUrl("");
    setSourceImageUrls([]);
    setSourcePreview("");
    setUploadStatus("");
  }

  // Compute max images allowed — use min across selected models (most restrictive)
  const maxImagesAllowed = (() => {
    if (genType !== "i2i" || selectedModels.length === 0) return 1;
    const caps = selectedModels.map(id => {
      const m = models.find(x => x.id === id);
      return m?.params?.maxImages || 1;
    }).filter(v => v > 1);
    return caps.length > 0 ? Math.min(...caps) : 1;
  })();

  // ─── GENERATION ENGINE ───
  async function handleGenerate() {
    if (!apiKey || (!prompt.trim() && genType !== "avatar") || selectedModels.length === 0) return;
    if ((genType === "i2i" || genType === "i2v") && !sourceImageUrl.trim()) {
      alert("Please provide a source image URL for " + (genType === "i2i" ? "image editing" : "image-to-video"));
      return;
    }
    isGeneratingRef.current = true;
    setIsGenerating(true);
    setPage("cockpit");

    const batchId = genId();
    const newTasks = selectedModels.map(modelId => {
      const model = models.find(m => m.id === modelId);
      return {
        id: genId(), batchId, modelId, modelName: model?.name || modelId,
        provider: model?.provider || "Unknown", price: model?.price || 0,
        status: "pending", startTime: Date.now(), endTime: null,
        wallClockMs: 0, inferenceMs: 0, outputs: [], error: null,
        genType, prompt, negPrompt, resolution, duration, seed, aspectRatio, sourceImageUrl,
        sourceImageUrls: sourceImageUrls.length > 0 ? sourceImageUrls : (sourceImageUrl ? [sourceImageUrl] : []),
        perModelResolution: perModelRes, numImages
      };
    });

    setTasks(prev => [...newTasks, ...prev]);

    // Fire all in parallel
    for (const task of newTasks) {
      (async () => {
        try {
          // Build per-model payload using model's params config
          const modelConfig = models.find(m => m.id === task.modelId);
          const userSettings = {
            prompt: task.prompt, negPrompt: task.negPrompt,
            resolution: task.resolution, duration: task.duration,
            seed: task.seed, aspectRatio: task.aspectRatio,
            sourceImageUrl: task.sourceImageUrl,
            sourceImageUrls: task.sourceImageUrls || [],
            perModelResolution: task.perModelResolution || {},
            numImages: task.numImages || 1,
          };
          const payload = modelConfig?.params
            ? buildPayload(modelConfig, userSettings, task.genType || genType)
            : { prompt: task.prompt, resolution: task.resolution };

          const submitRes = await submitTask(apiKey, task.modelId, payload);
          const taskId = submitRes?.data?.id;
          const pollUrl = submitRes?.data?.urls?.get || `${API_BASE}/predictions/${taskId}/result`;

          // Check if sync mode returned outputs directly
          if (submitRes?.data?.outputs?.length > 0) {
            const wallClock = Date.now() - task.startTime;
            setTasks(prev => prev.map(t => t.id === task.id ? {
              ...t, status: "completed", outputs: submitRes.data.outputs,
              endTime: Date.now(), wallClockMs: wallClock,
              inferenceMs: submitRes.data?.timings?.inference || wallClock
            } : t));
            return;
          }

          // Persist pollUrl immediately so we can resume polling after tab close / refresh / OS kill
          setTasks(prev => prev.map(t => t.id === task.id ? { ...t, status: "processing", taskId, pollUrl } : t));
          saveTask({ ...task, status: "processing", taskId, pollUrl });

          // Polling loop
          const pollInterval = (genType === "image" || genType === "i2i") ? 3000 : 15000;
          const maxTimeout = (genType === "image" || genType === "i2i") ? 300000 : Infinity;
          const startPoll = Date.now();

          const poll = async () => {
            if (maxTimeout !== Infinity && Date.now() - startPoll > maxTimeout) {
              setTasks(prev => prev.map(t => t.id === task.id ? { ...t, status: "failed", error: "Timeout", endTime: Date.now() } : t));
              return;
            }
            try {
              const result = await pollResult(apiKey, pollUrl);
              const data = result?.data || result;
              if (data.status === "completed" && data.outputs?.length > 0) {
                const wallClock = Date.now() - task.startTime;
                setTasks(prev => prev.map(t => t.id === task.id ? {
                  ...t, status: "completed", outputs: data.outputs,
                  endTime: Date.now(), wallClockMs: wallClock,
                  inferenceMs: data?.timings?.inference || wallClock,
                  nsfw: data?.has_nsfw_contents
                } : t));
              } else if (data.status === "failed") {
                setTasks(prev => prev.map(t => t.id === task.id ? {
                  ...t, status: "failed", error: data.error || "Generation failed", endTime: Date.now()
                } : t));
              } else {
                pollRefs.current[task.id] = setTimeout(poll, pollInterval);
              }
            } catch (e) {
              if (e.code === 429) {
                // Rate limited — backoff
                pollRefs.current[task.id] = setTimeout(poll, pollInterval * 2 + Math.random() * 2000);
              } else {
                setTasks(prev => prev.map(t => t.id === task.id ? {
                  ...t, status: "failed", error: e.message || "Poll error", endTime: Date.now()
                } : t));
              }
            }
          };

          pollRefs.current[task.id] = setTimeout(poll, pollInterval);

        } catch (e) {
          let errMsg = e.message || "Submit failed";
          if (e.code === 401) errMsg = "Invalid API key";
          if (e.code === 402) errMsg = "Insufficient balance";
          if (e.code === 429) errMsg = "Rate limited — try fewer models";
          setTasks(prev => prev.map(t => t.id === task.id ? {
            ...t, status: "failed", error: errMsg, endTime: Date.now()
          } : t));
        }
      })();
    }

    // Update timers
    const timerId = setInterval(() => {
      setTasks(prev => {
        const anyActive = prev.some(t => t.batchId === batchId && (t.status === "pending" || t.status === "processing"));
        if (!anyActive) {
          clearInterval(timerId);
          // Check if ANY tasks across ALL batches are still active
          const anyGlobalActive = prev.some(t => t.status === "pending" || t.status === "processing");
          if (!anyGlobalActive) {
            isGeneratingRef.current = false;
            setIsGenerating(false);
          }
          // Log the batch
          const batch = prev.filter(t => t.batchId === batchId);
          if (batch.length > 0) {
            const logEntry = {
              id: batchId, timestamp: Date.now(), prompt, negPrompt, genType,
              models: batch.map(t => t.modelName), resolution, duration, seed, aspectRatio, sourceImageUrl, sourceImageUrls: sourceImageUrls.length > 0 ? [...sourceImageUrls] : [], numImages,
              tasks: batch.map(t => ({ model: t.modelName, status: t.status, wallClockMs: t.wallClockMs, cost: t.price, outputs: t.outputs, error: t.error })),
              totalCost: batch.reduce((s, t) => s + (t.status === "completed" ? t.price : 0), 0)
            };
            setLogs(prev => [logEntry, ...prev]);
          }
          // Refresh balance
          checkBalance(apiKey).then(r => { if (r.balance !== null) setBalance(r.balance); });
        }
        return prev.map(t => {
          if ((t.status === "pending" || t.status === "processing") && t.batchId === batchId) {
            return { ...t, wallClockMs: Date.now() - t.startTime };
          }
          return t;
        });
      });
    }, 500);
  }

  function cancelTask(taskId) {
    if (pollRefs.current[taskId]) clearTimeout(pollRefs.current[taskId]);
    setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: "failed", error: "Cancelled", endTime: Date.now() } : t));
  }

  // Regenerate — re-submit the same task with a new ID, without disrupting existing results
  function regenerateTask(originalTask) {
    if (!apiKey) return;
    const newTask = {
      ...originalTask,
      id: genId(),
      status: "pending",
      startTime: Date.now(),
      endTime: null,
      wallClockMs: 0,
      inferenceMs: 0,
      outputs: [],
      error: null,
      seed: Math.floor(Math.random() * 999999).toString(),
    };
    setTasks(prev => [newTask, ...prev]);

    // Timer for live wallClock display on regenerated task
    const regenTimer = setInterval(() => {
      setTasks(prev => {
        const t = prev.find(x => x.id === newTask.id);
        if (!t || t.status === "completed" || t.status === "failed") { clearInterval(regenTimer); return prev; }
        return prev.map(x => x.id === newTask.id ? { ...x, wallClockMs: Date.now() - x.startTime } : x);
      });
    }, 500);

    // Fire the regenerated task — use task's own genType, not current UI tab
    (async () => {
      try {
        const taskGenType = newTask.genType || genType;
        const taskModels = MODELS[taskGenType] || [];
        const modelConfig = taskModels.find(m => m.id === newTask.modelId);
        const userSettings = {
          prompt: newTask.prompt, negPrompt: newTask.negPrompt,
          resolution: newTask.resolution, duration: newTask.duration,
          seed: newTask.seed, aspectRatio: newTask.aspectRatio,
          sourceImageUrl: newTask.sourceImageUrl,
          sourceImageUrls: newTask.sourceImageUrls || [],
          perModelResolution: newTask.perModelResolution || {},
          numImages: newTask.numImages || 1,
        };
        const payload = modelConfig?.params
          ? buildPayload(modelConfig, userSettings, taskGenType)
          : { prompt: newTask.prompt };

        const submitRes = await submitTask(apiKey, newTask.modelId, payload);
        const taskId = submitRes?.data?.id;
        const pollUrl = submitRes?.data?.urls?.get || `${API_BASE}/predictions/${taskId}/result`;

        if (submitRes?.data?.outputs?.length > 0) {
          const wallClock = Date.now() - newTask.startTime;
          setTasks(prev => prev.map(t => t.id === newTask.id ? {
            ...t, status: "completed", outputs: submitRes.data.outputs,
            endTime: Date.now(), wallClockMs: wallClock,
            inferenceMs: submitRes.data?.timings?.inference || wallClock
          } : t));
          return;
        }

        setTasks(prev => prev.map(t => t.id === newTask.id ? { ...t, status: "processing", taskId } : t));

        const isImageType = taskGenType === "image" || taskGenType === "i2i";
        const pollInterval = isImageType ? 3000 : 15000;
        const maxTimeout = isImageType ? 300000 : Infinity;
        const startPoll = Date.now();

        const poll = async () => {
          if (maxTimeout !== Infinity && Date.now() - startPoll > maxTimeout) {
            setTasks(prev => prev.map(t => t.id === newTask.id ? { ...t, status: "failed", error: "Timeout", endTime: Date.now() } : t));
            return;
          }
          try {
            const result = await pollResult(apiKey, pollUrl);
            const data = result?.data || result;
            if (data.status === "completed" && data.outputs?.length > 0) {
              const wallClock = Date.now() - newTask.startTime;
              setTasks(prev => prev.map(t => t.id === newTask.id ? {
                ...t, status: "completed", outputs: data.outputs,
                endTime: Date.now(), wallClockMs: wallClock,
                inferenceMs: data?.timings?.inference || wallClock,
              } : t));
            } else if (data.status === "failed") {
              setTasks(prev => prev.map(t => t.id === newTask.id ? {
                ...t, status: "failed", error: data.error || "Generation failed", endTime: Date.now()
              } : t));
            } else {
              pollRefs.current[newTask.id] = setTimeout(poll, pollInterval);
            }
          } catch (e) {
            if (e.code === 429) {
              pollRefs.current[newTask.id] = setTimeout(poll, pollInterval * 2 + Math.random() * 2000);
            } else {
              setTasks(prev => prev.map(t => t.id === newTask.id ? {
                ...t, status: "failed", error: e.message || "Poll error", endTime: Date.now()
              } : t));
            }
          }
        };
        pollRefs.current[newTask.id] = setTimeout(poll, pollInterval);
      } catch (e) {
        let errMsg = e.message || "Regenerate failed";
        if (e.code === 401) errMsg = "Invalid API key";
        if (e.code === 402) errMsg = "Insufficient balance";
        setTasks(prev => prev.map(t => t.id === newTask.id ? {
          ...t, status: "failed", error: errMsg, endTime: Date.now()
        } : t));
      }
    })();
  }

  function replayLog(log) {
    setPrompt(log.prompt);
    setNegPrompt(log.negPrompt || "");
    setGenType(log.genType);
    setResolution(log.resolution);
    setDuration(log.duration);
    setSeed(log.seed);
    setAspectRatio(log.aspectRatio || "auto");
    setSourceImageUrls(log.sourceImageUrls?.length > 0 ? [...log.sourceImageUrls] : []);
    if (log.sourceImageUrl) { setSourceImageUrl(log.sourceImageUrl); setSourcePreview(log.sourceImageUrl); setUploadStatus("done"); }
    if (log.numImages) setNumImages(log.numImages);
    // Try to reselect models
    const modelIds = (MODELS[log.genType] || []).filter(m => log.models.includes(m.name)).map(m => m.id);
    setSelectedModels(modelIds);
    setPerModelRes({});
    setPage("cockpit");
  }

  // ─── RENDER ───
  const completedTasks = tasks.filter(t => t.status === "completed");
  const activeTasks = tasks.filter(t => t.status === "pending" || t.status === "processing");
  // resOptions and arOptions are now computed dynamically in the settings panel based on selected models
  const needsImage = genType === "i2i" || genType === "i2v" || genType === "avatar";

  // Show login screen if not authenticated
  if (!isAuthed) {
    return (
      <>
        <style>{css}</style>
        <BackgroundLayer type={background} accent={(THEMES[theme] || THEMES.default).accent} />
        <div className="proxima-app">
          <LoginScreen onLogin={handleLogin} />
        </div>
      </>
    );
  }

  const activeAccent = (THEMES[theme] || THEMES.default).accent;

  return (
    <>
      <style>{css}</style>
      <BackgroundLayer type={background} accent={activeAccent} />
      <div className="proxima-app">
        {/* Sidebar */}
        <div className="sidebar">
          <div className="sidebar-logo" title="ProximaAI">◈</div>
          <button className={`sidebar-btn ${page==="cockpit"?"active":""}`} onClick={() => setPage("cockpit")} title="Cockpit">⚡</button>
          <button className={`sidebar-btn ${page==="gallery"?"active":""}`} onClick={() => setPage("gallery")} title="Gallery">🖼</button>
          <button className={`sidebar-btn ${page==="logs"?"active":""}`} onClick={() => setPage("logs")} title="Logs">📋</button>
          <button className={`sidebar-btn ${page==="settings"?"active":""}`} onClick={() => { setPage("settings"); getStorageStats().then(s => setStorageStats(s)); getArchiveStats().then(s => setArchiveStats(s)); }} title="Settings">⚙</button>
          {/* Save status (tap=force-save, long-press=full backup) — pushed to bottom on desktop */}
          <div className="sidebar-save-wrap">
            <SidebarSaveButton saveStatus={saveStatus} failedCount={failedSyncCount} onForceSave={forceSaveAll} onBackup={triggerManualBackup} />
          </div>
          {activeCount > 0 && (
            <div style={{ position: "absolute", top: 68, left: 36, background: "var(--accent)", color: "white", fontSize: 9, fontWeight: 700, width: 16, height: 16, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: font }} className="pulse">{activeCount}</div>
          )}
        </div>

        {/* Main */}
        <div className="main">
          <div className="topbar">
            <div className="topbar-title">ProximaAI — {page === "cockpit" ? "GENERATION COCKPIT" : page === "gallery" ? "SAVED OUTPUTS" : page === "logs" ? "GENERATION LOG" : "SETTINGS"}</div>
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              {balance !== null && <div className="balance-pill">${Number(balance).toFixed(2)}</div>}
              {!apiKey && <span style={{ fontSize: 11, color: "var(--error)" }}>⚠ No API Key</span>}
            </div>
          </div>

          <div className="content">
            {/* ═══ COCKPIT ═══ */}
            {page === "cockpit" && (
              <div className="cockpit">
                <div className="cockpit-left">
                  {/* Type Tabs */}
                  <div className="type-tabs-wrap" ref={el => {
                    if (!el) return;
                    const tabs = el.querySelector('.type-tabs');
                    if (!tabs) return;
                    const updateFade = () => {
                      const maxScroll = tabs.scrollWidth - tabs.clientWidth;
                      if (maxScroll > 2 && tabs.scrollLeft < maxScroll - 2) {
                        el.classList.add('has-overflow');
                      } else {
                        el.classList.remove('has-overflow');
                      }
                    };
                    updateFade();
                    tabs.onscroll = updateFade;
                    if (!el._resizeObs) {
                      el._resizeObs = new ResizeObserver(updateFade);
                      el._resizeObs.observe(tabs);
                    }
                  }}>
                    <div className="type-tabs">
                      {Object.entries(TYPE_LABELS).map(([key, label]) => (
                        <button key={key} className={`type-tab ${genType===key?"active":""}`}
                          onClick={e => {
                            setGenType(key); setSelectedModels([]); setPerModelRes({}); setResolution(""); setDuration(5); setAspectRatio("auto"); setSourceImageUrls([]);
                            if (key !== "i2i" && key !== "i2v" && key !== "avatar") { clearSourceImage(); }
                            // Scroll selected tab into view (desktop only — mobile shows all 5 in one row)
                            if (window.innerWidth > 768) e.currentTarget.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
                          }}>
                          <span className="tab-icon">{TYPE_ICONS[key]}</span>
                          <span className="tab-label tab-label-full">{label}</span>
                          <span className="tab-label tab-label-short">{({ image: "Image", i2i: "Edit", t2v: "T→V", i2v: "I→V", avatar: "Avatar" }[key] || label)}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Prompt */}
                  <div className="card">
                    <div className="card-title">{genType === "i2i" ? "Edit Instructions" : "Prompt"}</div>
                    <textarea className="prompt-area" placeholder={
                      genType === "i2i" ? "Describe the edit you want... (e.g., 'Change the background to a sunset beach')" :
                      genType === "i2v" ? "Describe the motion... (e.g., 'Slow camera push-in, subtle movement')" :
                      "Describe what you want to generate..."}
                      value={prompt} onChange={e => setPrompt(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) handleGenerate(); }} />
                    {(genType === "image" || genType === "i2i" || genType === "t2v" || genType === "i2v") && (
                      <input type="text" className="prompt-area" style={{ minHeight: "auto", marginTop: 8, fontSize: 12, padding: 8 }}
                        placeholder="Negative prompt (optional)..." value={negPrompt} onChange={e => setNegPrompt(e.target.value)} />
                    )}
                  </div>

                  {/* Source Image — for i2i and i2v */}
                  {needsImage && (
                    <div className="card">
                      <div className="card-title" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span>Source Image *</span>
                        {uploadStatus === "done" && <span style={{ color: "var(--success)", fontSize: 10, fontWeight: 400 }}>✓ Uploaded to WaveSpeed</span>}
                        {uploadStatus === "uploading" && <span className="pulse" style={{ color: "var(--accent)", fontSize: 10, fontWeight: 400 }}>⏳ Uploading...</span>}
                        {uploadStatus === "error" && <span style={{ color: "var(--error)", fontSize: 10, fontWeight: 400 }}>✗ Upload failed — try URL</span>}
                      </div>

                      {/* Hidden file input — triggers native picker, multiple when multi-image models selected */}
                      <input type="file" ref={fileInputRef} accept="image/*"
                        multiple={genType === "i2i" && maxImagesAllowed > 1}
                        style={{ display: "none" }} onChange={handleFileSelect} />

                      {/* Upload + URL buttons */}
                      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                        <button onClick={() => fileInputRef.current?.click()}
                          style={{
                            flex: 1, padding: "12px 8px", background: "var(--bg-input)", border: "2px dashed var(--border)",
                            borderRadius: 10, color: "var(--text-secondary)", cursor: "pointer", fontSize: 13,
                            fontFamily: fontBody, fontWeight: 500, transition: "all 0.2s", display: "flex",
                            flexDirection: "column", alignItems: "center", gap: 4
                          }}
                          onMouseOver={e => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.background = "var(--accent-glow)"; }}
                          onMouseOut={e => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.background = "var(--bg-input)"; }}>
                          <span style={{ fontSize: 24 }}>📁</span>
                          <span>{genType === "i2i" && maxImagesAllowed > 1 ? "Upload Images" : "Upload from Device"}</span>
                          <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{genType === "i2i" && maxImagesAllowed > 1 ? `Select up to ${maxImagesAllowed} images` : "Gallery · Photos · Files"}</span>
                        </button>
                      </div>

                      {/* OR divider */}
                      <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "4px 0 10px" }}>
                        <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
                        <span style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: font }}>OR PASTE URL</span>
                        <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
                      </div>

                      {/* URL input */}
                      <input type="text" className="prompt-area" style={{ minHeight: "auto", fontSize: 12, padding: 10 }}
                        placeholder="https://example.com/image.png"
                        value={sourceImageUrl}
                        onChange={e => { setSourceImageUrl(e.target.value); setSourcePreview(e.target.value); setUploadStatus(e.target.value ? "done" : ""); }} />

                      {/* Preview */}
                      {(sourcePreview || sourceImageUrl) && (
                        <div style={{ marginTop: 10, position: "relative" }}>
                          <img src={sourcePreview || sourceImageUrl} alt="Source"
                            style={{ width: "100%", maxHeight: 180, objectFit: "contain", borderRadius: 8, border: "1px solid var(--border)", background: "#000" }}
                            onError={e => { e.target.style.display = "none"; setUploadStatus("error"); }} />
                          {genType === "i2i" && maxImagesAllowed > 1 && (
                            <div style={{ position: "absolute", bottom: 6, left: 6, background: "rgba(0,0,0,0.7)", color: "#a78bfa", fontSize: 10, padding: "2px 6px", borderRadius: 4, fontFamily: font, fontWeight: 600 }}>Ref 1</div>
                          )}
                          <button onClick={clearSourceImage}
                            style={{ position: "absolute", top: 6, right: 6, background: "rgba(0,0,0,0.8)", color: "white", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 6, width: 26, height: 26, cursor: "pointer", fontSize: 13, display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
                          {uploadStatus === "uploading" && (
                            <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.6)", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center" }}>
                              <div className="pulse" style={{ color: "white", fontFamily: font, fontSize: 13 }}>Uploading to WaveSpeed...</div>
                            </div>
                          )}
                        </div>
                      )}

                      <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 6, lineHeight: 1.4 }}>
                        {genType === "i2i" ? "Upload the image you want to edit. Your prompt describes what to change." :
                         "Upload the image to animate into video. Your prompt describes the motion."}
                        {uploadStatus === "done" && sourceImageUrl && (
                          <span style={{ display: "block", marginTop: 2, color: "var(--text-secondary)", fontFamily: font, fontSize: 9, wordBreak: "break-all" }}>
                            {sourceImageUrl.length > 60 ? sourceImageUrl.slice(0, 60) + "..." : sourceImageUrl}
                          </span>
                        )}
                      </div>

                      {/* Multi-image — only shown for i2i models that support maxImages > 1 */}
                      {genType === "i2i" && maxImagesAllowed > 1 && uploadStatus === "done" && (
                        <div style={{ marginTop: 10, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
                          <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 6, fontFamily: font }}>
                            Additional Reference Images ({sourceImageUrls.length}/{maxImagesAllowed} max)
                          </div>
                          {/* Thumbnails of additional images */}
                          {sourceImageUrls.length > 0 && (
                            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
                              {sourceImageUrls.map((url, i) => (
                                <div key={i} style={{ position: "relative", width: 60, height: 60 }}>
                                  <img src={url} alt={`Ref ${i+2}`} style={{ width: 60, height: 60, objectFit: "cover", borderRadius: 6, border: "1px solid var(--border)" }} />
                                  <div style={{ position: "absolute", bottom: 2, left: 2, background: "rgba(0,0,0,0.7)", color: "#a78bfa", fontSize: 8, padding: "1px 4px", borderRadius: 3, fontFamily: font }}>Ref {i+2}</div>
                                  <button onClick={() => setSourceImageUrls(prev => prev.filter((_, j) => j !== i))}
                                    style={{ position: "absolute", top: -4, right: -4, background: "var(--error)", color: "white", border: "none", borderRadius: "50%", width: 18, height: 18, cursor: "pointer", fontSize: 10, display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
                                </div>
                              ))}
                            </div>
                          )}
                          {sourceImageUrls.length < maxImagesAllowed - 1 && (
                            <>
                              {/* Hidden file input for gallery picker */}
                              <input type="file" ref={multiImageFileRef} accept="image/*" multiple style={{ display: "none" }}
                                onChange={handleAdditionalFileSelect} />
                              <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
                                <button onClick={() => multiImageFileRef.current?.click()}
                                  style={{ flex: 1, padding: "10px 8px", background: "var(--bg-input)", border: "2px dashed var(--border)", borderRadius: 8, color: "var(--text-secondary)", cursor: "pointer", fontSize: 12, fontFamily: fontBody, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, transition: "all 0.2s" }}
                                  onMouseOver={e => { e.currentTarget.style.borderColor = "var(--accent)"; }}
                                  onMouseOut={e => { e.currentTarget.style.borderColor = "var(--border)"; }}>
                                  📁 Upload More from Gallery
                                </button>
                              </div>
                              <div style={{ display: "flex", gap: 6 }}>
                                <input ref={multiImageInputRef} type="text" className="prompt-area" style={{ minHeight: "auto", fontSize: 11, padding: 8, flex: 1 }}
                                  placeholder="Or paste image URL..."
                                  onKeyDown={e => {
                                    if (e.key === "Enter" && e.target.value.trim()) {
                                      e.preventDefault();
                                      setSourceImageUrls(prev => [...prev, e.target.value.trim()]);
                                      e.target.value = "";
                                    }
                                  }} />
                                <button onClick={() => {
                                  const input = multiImageInputRef.current;
                                  if (input?.value?.trim()) { setSourceImageUrls(prev => [...prev, input.value.trim()]); input.value = ""; }
                                }} style={{ padding: "8px 12px", background: "var(--accent)", color: "white", border: "none", borderRadius: 8, cursor: "pointer", fontSize: 11, fontFamily: font, whiteSpace: "nowrap" }}>+ Add</button>
                              </div>
                            </>
                          )}
                          <div style={{ fontSize: 9, color: "var(--text-muted)", marginTop: 4 }}>
                            Reference images as "Figure 1", "Figure 2" etc. in your prompt
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Model Selector */}
                  <div className="card">
                    <div className="card-title" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span>Models — {selectedModels.length} selected</span>
                      <div style={{ display: "flex", gap: 6 }}>
                        {(genType === "image" || genType === "i2i") && (
                          <button title="Select favorites (Nano Banana Pro, Seedream 5.0 Lite, Qwen 2.0 Pro)" onClick={() => {
                            const favIds = genType === "image"
                              ? ["google/nano-banana-pro/text-to-image", "bytedance/seedream-v5.0-lite", "wavespeed-ai/qwen-image-2.0-pro/text-to-image"]
                              : ["google/nano-banana-2/edit", "google/nano-banana-pro/edit", "bytedance/seedream-v5.0-lite/edit", "wavespeed-ai/qwen-image-2.0-pro/edit"];
                            const available = favIds.filter(id => models.some(m => m.id === id));
                            setSelectedModels(available);
                          }} style={{ background: "transparent", border: "1px solid rgba(245,158,11,0.3)", borderRadius: 6, padding: "2px 7px", cursor: "pointer", fontSize: 13, color: "var(--warning)", transition: "all 0.2s", lineHeight: 1 }}
                            onMouseOver={e => { e.currentTarget.style.background = "rgba(245,158,11,0.1)"; }}
                            onMouseOut={e => { e.currentTarget.style.background = "transparent"; }}>⭐</button>
                        )}
                        <button title="Select all" onClick={() => setSelectedModels(models.map(m => m.id))}
                          style={{ background: selectedModels.length === models.length ? "rgba(99,102,241,0.15)" : "transparent", border: "1px solid rgba(99,102,241,0.3)", borderRadius: 6, padding: "2px 7px", cursor: "pointer", fontSize: 10, color: "var(--accent)", fontFamily: font, fontWeight: 600, transition: "all 0.2s", lineHeight: 1.4 }}
                          onMouseOver={e => { e.currentTarget.style.background = "rgba(99,102,241,0.15)"; }}
                          onMouseOut={e => { e.currentTarget.style.background = selectedModels.length === models.length ? "rgba(99,102,241,0.15)" : "transparent"; }}>ALL</button>
                        <button title="Deselect all" onClick={() => setSelectedModels([])}
                          disabled={selectedModels.length === 0}
                          style={{ background: "transparent", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 6, padding: "2px 7px", cursor: selectedModels.length === 0 ? "default" : "pointer", fontSize: 10, color: selectedModels.length === 0 ? "var(--text-muted)" : "var(--error)", fontFamily: font, fontWeight: 600, transition: "all 0.2s", lineHeight: 1.4, opacity: selectedModels.length === 0 ? 0.4 : 1 }}
                          onMouseOver={e => { if (selectedModels.length > 0) e.currentTarget.style.background = "rgba(239,68,68,0.1)"; }}
                          onMouseOut={e => { e.currentTarget.style.background = "transparent"; }}>✕</button>
                      </div>
                    </div>
                    <div className="model-grid">
                      {models.map(m => (
                        <div key={m.id} className={`model-item ${selectedModels.includes(m.id)?"selected":""}`} onClick={() => toggleModel(m.id)}>
                          <div className="model-check">{selectedModels.includes(m.id) ? "✓" : ""}</div>
                          <span className="model-name">{m.name}</span>
                          <div className="model-meta">
                            {m.hot && <span className="hot-badge">HOT</span>}
                            {m.flagship && <span className="hot-badge" style={{ background: "var(--accent)" }}>★</span>}
                            <span className="model-provider" style={{ background: (PROVIDER_COLORS[m.provider]||"#666")+"22", color: PROVIDER_COLORS[m.provider]||"#aaa" }}>{m.provider}</span>
                            <span className="model-price">{formatCost(m.price)}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Dynamic Settings — adapts to selected models (UNION-based) */}
                  <div className="card">
                    <div className="card-title">Settings {selectedModels.length > 0 ? `(${selectedModels.length} model${selectedModels.length > 1 ? "s" : ""})` : ""}</div>
                    {selectedModels.length === 0 ? (
                      <div style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>Select models to see parameters</div>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                        {/* Resolution — UNION of all selected models' options */}
                        {(() => {
                          const selectedWithRes = selectedModels.map(id => models.find(m => m.id === id)).filter(m => m?.params?.resolution);
                          if (selectedWithRes.length === 0) return null;
                          // Group by param scheme (paramName)
                          const schemes = {};
                          selectedWithRes.forEach(m => {
                            const key = m.params.resolution.paramName;
                            if (!schemes[key]) schemes[key] = [];
                            schemes[key].push(m);
                          });
                          const schemeKeys = Object.keys(schemes);
                          // If all share same scheme, show one dropdown with UNION of options
                          if (schemeKeys.length === 1) {
                            const modelsInScheme = schemes[schemeKeys[0]];
                            // Build UNION: deduplicate by value, track which models support each
                            const optMap = new Map();
                            modelsInScheme.forEach(m => {
                              m.params.resolution.options.forEach(o => {
                                if (!optMap.has(o.value)) optMap.set(o.value, { label: o.label, value: o.value, models: [] });
                                optMap.get(o.value).models.push(m.name);
                              });
                            });
                            const unionOptions = [...optMap.values()];
                            const totalModels = modelsInScheme.length;
                            // Auto-set resolution if current value is not in union
                            const validVals = unionOptions.map(o => o.value);
                            if (!validVals.includes(resolution)) {
                              setTimeout(() => setResolution(modelsInScheme[0].params.resolution.default), 0);
                            }
                            return (
                              <div className="settings-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                  <label>Resolution</label>
                                  <select className="settings-select" value={resolution} onChange={e => setResolution(e.target.value)}>
                                    {unionOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                                  </select>
                                </div>
                                {totalModels > 1 && (() => {
                                  const current = optMap.get(resolution);
                                  if (current && current.models.length < totalModels) {
                                    const unsupported = modelsInScheme.filter(m => !current.models.includes(m.name));
                                    return (
                                      <div style={{ fontSize: 9, color: "var(--text-muted)", lineHeight: 1.3 }}>
                                        {current.models.length === totalModels ? "All models" : current.models.join(", ")}
                                        {unsupported.length > 0 && <span style={{ color: "var(--amber)" }}> — {unsupported.map(m => m.name).join(", ")} will use nearest valid</span>}
                                      </div>
                                    );
                                  }
                                  return null;
                                })()}
                              </div>
                            );
                          }
                          // Different schemes — show per-model dropdowns
                          return selectedWithRes.map(m => (
                            <div className="settings-row" key={m.id}>
                              <label style={{ fontSize: 10, minWidth: 80 }}>{m.name}</label>
                              <select className="settings-select" value={perModelRes[m.id] || m.params.resolution.default}
                                onChange={e => setPerModelRes(prev => ({ ...prev, [m.id]: e.target.value }))}>
                                {m.params.resolution.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                              </select>
                            </div>
                          ));
                        })()}

                        {/* Aspect ratio — UNION with support indicators */}
                        {(() => {
                          const withAR = selectedModels.map(id => models.find(m => m.id === id)).filter(m => m?.params?.aspectRatio);
                          if (withAR.length === 0) return null;
                          // Build UNION of all aspect ratio options, track supporters
                          const arMap = new Map();
                          withAR.forEach(m => {
                            m.params.aspectRatio.options.forEach(o => {
                              if (!arMap.has(o.value)) arMap.set(o.value, { label: o.label, value: o.value, models: [] });
                              arMap.get(o.value).models.push(m.name);
                            });
                          });
                          const unionAR = [...arMap.values()];
                          const totalAR = withAR.length;
                          return (
                            <div className="settings-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                <label>Aspect</label>
                                <select className="settings-select" value={aspectRatio} onChange={e => setAspectRatio(e.target.value)}>
                                  <option value="auto">Auto</option>
                                  {unionAR.map(o => <option key={o.value} value={o.value}>{o.label}{totalAR > 1 && o.models.length < totalAR ? ` (${o.models.length}/${totalAR})` : ""}</option>)}
                                </select>
                              </div>
                              {totalAR > 1 && aspectRatio !== "auto" && (() => {
                                const current = arMap.get(aspectRatio);
                                if (current && current.models.length < totalAR) {
                                  const unsupported = withAR.filter(m => !current.models.includes(m.name));
                                  return (
                                    <div style={{ fontSize: 9, color: "var(--text-muted)", lineHeight: 1.3 }}>
                                      {current.models.join(", ")}
                                      {unsupported.length > 0 && <span style={{ color: "var(--amber)" }}> — {unsupported.map(m => m.name).join(", ")} will use their default</span>}
                                    </div>
                                  );
                                }
                                return null;
                              })()}
                            </div>
                          );
                        })()}

                        {/* Duration — UNION for video models with per-model fallback */}
                        {(genType === "t2v" || genType === "i2v") && (() => {
                          const withDur = selectedModels.map(id => models.find(m => m.id === id)).filter(m => m?.params?.duration);
                          if (withDur.length === 0) return null;
                          // Build UNION of all duration options, track which models support each
                          const durMap = new Map();
                          withDur.forEach(m => {
                            m.params.duration.options.forEach(d => {
                              if (!durMap.has(d)) durMap.set(d, []);
                              durMap.get(d).push(m.name);
                            });
                          });
                          const unionDurs = [...durMap.keys()].sort((a, b) => a - b);
                          const totalDur = withDur.length;
                          // Auto-correct if current duration is not in union at all
                          if (!unionDurs.includes(Number(duration))) {
                            setTimeout(() => setDuration(unionDurs[0]), 0);
                          }
                          return (
                            <div className="settings-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                <label>Duration</label>
                                <select className="settings-select" value={duration} onChange={e => setDuration(Number(e.target.value))}>
                                  {unionDurs.map(d => {
                                    const supporters = durMap.get(d);
                                    const suffix = totalDur > 1 && supporters.length < totalDur ? ` (${supporters.length}/${totalDur})` : "";
                                    return <option key={d} value={d}>{d}s{suffix}</option>;
                                  })}
                                </select>
                              </div>
                              {totalDur > 1 && (() => {
                                const currentDur = Number(duration);
                                const supporters = durMap.get(currentDur) || [];
                                if (supporters.length < totalDur) {
                                  const unsupported = withDur.filter(m => !m.params.duration.options.includes(currentDur));
                                  // Show what fallback each unsupported model gets
                                  const fallbackInfo = unsupported.map(m => {
                                    const opts = m.params.duration.options;
                                    const closest = opts.reduce((prev, curr) => Math.abs(curr - currentDur) < Math.abs(prev - currentDur) ? curr : prev);
                                    return `${m.name} -> ${closest}s`;
                                  });
                                  return (
                                    <div style={{ fontSize: 9, color: "var(--text-muted)", lineHeight: 1.3 }}>
                                      <span>{supporters.length === totalDur ? "All models" : supporters.join(", ")}</span>
                                      {fallbackInfo.length > 0 && <span style={{ color: "var(--amber)" }}> — {fallbackInfo.join(", ")}</span>}
                                    </div>
                                  );
                                }
                                return null;
                              })()}
                            </div>
                          );
                        })()}

                        {(genType === "image" || genType === "i2i") && (
                          <div className="settings-row">
                            <label>Batch</label>
                            <select className="settings-select" value={numImages} onChange={e => setNumImages(Number(e.target.value))}>
                              {[1,2,3,4,8,12,16].map(n => <option key={n} value={n}>{n} image{n > 1 ? "s" : ""}</option>)}
                            </select>
                          </div>
                        )}

                        <div className="settings-row">
                          <label>Seed</label>
                          <input type="text" className="settings-input" style={{ width: 72 }} value={seed} onChange={e => setSeed(e.target.value)} />
                          <button onClick={() => setSeed(Math.floor(Math.random() * 999999).toString())} style={{ background: "transparent", border: "1px solid var(--border)", borderRadius: 6, padding: "5px 8px", cursor: "pointer", fontSize: 14 }} title="Random seed">🎲</button>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Cost + Generate — sticky on mobile, inline on desktop */}
                  <div className="action-panel">
                    {selectedModels.length > 0 && (
                      <div className="cost-bar">
                        <span style={{ color: "var(--text-secondary)", fontSize: 11 }}>Est. cost ({selectedModels.length} model{selectedModels.length > 1 ? "s" : ""})</span>
                        <span className="cost-amount">{formatCost(estCost)}</span>
                      </div>
                    )}

                    <button className={`gen-btn ${isGenerating ? "running" : "ready"}`}
                      disabled={!apiKey || (!prompt.trim() && genType !== "avatar") || selectedModels.length === 0 || (needsImage && !sourceImageUrl.trim())}
                      onClick={handleGenerate}>
                      {isGenerating ? `⏳ GENERATING (${activeCount} active)...` :
                       !apiKey ? "⚠ SET API KEY IN SETTINGS" :
                       needsImage && !sourceImageUrl.trim() ? "⚠ ADD SOURCE IMAGE ABOVE" :
                       `⚡ ${genType === "i2i" ? "EDIT" : "GENERATE"}${selectedModels.length > 0 ? ` ACROSS ${selectedModels.length} MODELS` : ""}`}
                    </button>
                    <div className="gen-hint" style={{ fontSize: 10, color: "var(--text-muted)", textAlign: "center" }}>Ctrl+Enter to generate</div>
                  </div>
                </div>

                {/* Results */}
                <div className="cockpit-right">
                  {tasks.length === 0 ? (
                    <div className="empty-state">
                      <div className="emoji">◈</div>
                      <div className="msg">Select models, write a prompt, and hit Generate to fire parallel requests across all selected models simultaneously.</div>
                    </div>
                  ) : (
                    <div className="results-grid">
                      {tasks.map(task => (
                        <div key={task.id} className="task-card fade-in">
                          <div className="task-header">
                            <div>
                              <span className="task-model">{task.modelName}</span>
                              <span style={{ fontSize: 10, color: PROVIDER_COLORS[task.provider] || "#aaa", marginLeft: 6 }}>{task.provider}</span>
                            </div>
                            <span className={`task-status ${task.status}`}>
                              {task.status === "pending" ? "PENDING" : task.status === "processing" ? "PROCESSING" : task.status === "completed" ? "DONE" : "FAILED"}
                            </span>
                          </div>

                          <div className="task-timer">
                            {task.status === "completed" ? `✓ ${formatTime(task.wallClockMs)}` :
                             task.status === "failed" ? `✗ ${task.error}` :
                             <span className="pulse">⏱ {formatTime(task.wallClockMs)}</span>}
                            {task.status === "completed" && <span style={{ marginLeft: 8, color: "var(--amber)" }}>{formatCost(task.price)}</span>}
                          </div>

                          {(task.status === "pending" || task.status === "processing") && (
                            <>
                              <div className="task-progress">
                                <div className="task-progress-fill" style={{
                                  width: `${Math.min(95, (task.wallClockMs / getExpectedMs(task.modelId, task.genType || genType)) * 100)}%`
                                }} />
                              </div>
                              <button className="result-action-btn" style={{ marginTop: 6, fontSize: 10 }} onClick={() => cancelTask(task.id)}>✕ Cancel</button>
                            </>
                          )}

                          {task.status === "completed" && task.outputs?.map((url, i) => {
                            const tType = task.genType || genType;
                            const isVideo = url.includes(".mp4") || url.includes("video") || tType === "t2v" || tType === "i2v" || tType === "avatar";
                            return isVideo ? (
                              <video key={i} className="result-video" src={url} controls autoPlay muted loop playsInline />
                            ) : (
                              <img key={i} className="result-img" src={url} alt={task.modelName}
                                onClick={() => setLightbox(url)} loading="lazy" />
                            );
                          })}

                          {(task.status === "completed" || task.status === "failed") && (
                            <div className="result-actions">
                              <button className="result-action-btn" style={{ color: "var(--accent)", borderColor: "rgba(99,102,241,0.3)" }}
                                onClick={() => regenerateTask(task)}>🔄 Regenerate</button>
                              {task.status === "completed" && <>
                                <button className="result-action-btn" title="Download to device" onClick={async () => {
                                  try {
                                    const url = task.outputs?.[0];
                                    if (!url) return;
                                    const resp = await fetch(url);
                                    const blob = await resp.blob();
                                    const tgt = task.genType || genType;
                                    const ext = (tgt === "t2v" || tgt === "i2v" || tgt === "avatar" || blob.type.startsWith("video")) ? "mp4" : "png";
                                    const fname = `${task.modelName.replace(/\s+/g, "_")}_${Date.now()}.${ext}`;
                                    const a = document.createElement("a");
                                    a.href = URL.createObjectURL(blob);
                                    a.download = fname;
                                    a.style.display = "none";
                                    document.body.appendChild(a);
                                    a.click();
                                    setTimeout(() => { a.remove(); URL.revokeObjectURL(a.href); }, 100);
                                  } catch (e) { console.log("Direct download blocked, opening in new tab"); window.open(task.outputs?.[0], "_blank"); }
                                }}>↓ Download</button>
                                <button className="result-action-btn" title="Back up to cloud storage (permanent)"
                                  disabled={task.isArchived}
                                  style={task.isArchived ? { color: "var(--success)", borderColor: "rgba(34,197,94,0.3)" } : { color: "var(--amber)", borderColor: "rgba(245,158,11,0.3)" }}
                                  onClick={async () => {
                                    if (task.isArchived) return;
                                    setTasks(prev => prev.map(x => x.id === task.id ? { ...x, archiving: true } : x));
                                    const newUrls = [];
                                    const paths = [];
                                    let anyOk = false;
                                    for (let i = 0; i < (task.outputs || []).length; i++) {
                                      const r = await archiveUrl(task.outputs[i], { taskId: task.id, index: i });
                                      if (r.ok) { newUrls.push(r.url); paths.push(r.path); anyOk = true; }
                                      else { newUrls.push(task.outputs[i]); }
                                    }
                                    if (anyOk) {
                                      setTasks(prev => prev.map(x => x.id === task.id
                                        ? { ...x, outputs: newUrls, archivedOutputs: newUrls, archivedPaths: paths, isArchived: true, archiving: false }
                                        : x));
                                      const updated = { ...task, outputs: newUrls, archivedOutputs: newUrls, archivedPaths: paths, isArchived: true };
                                      saveTask(updated);
                                      syncTask(updated).catch(() => {});
                                      setAccountToast("☁ Backed up to cloud");
                                    } else {
                                      setTasks(prev => prev.map(x => x.id === task.id ? { ...x, archiving: false } : x));
                                      setAccountToast("Cloud backup failed");
                                    }
                                    setTimeout(() => setAccountToast(""), 4000);
                                    getArchiveStats().then(s => setArchiveStats(s));
                                  }}>
                                  {task.archiving ? "☁ …" : task.isArchived ? "☁ Saved" : "☁ Cloud"}
                                </button>
                                <button className="result-action-btn" onClick={() => { navigator.clipboard?.writeText(task.outputs?.[0] || ""); }}>📋 URL</button>
                                {((task.genType || genType) === "image" || (task.genType || genType) === "i2i") && (
                                  <button className="result-action-btn" style={{ color: "#a78bfa", borderColor: "rgba(167,139,250,0.3)" }}
                                    onClick={() => {
                                      setSourceImageUrl(task.outputs?.[0] || ""); setSourcePreview(task.outputs?.[0] || ""); setUploadStatus("done");
                                      setGenType("i2i"); setPrompt(task.prompt || "");
                                      // Auto-select the edit variant of the same model if available
                                      const editModels = MODELS["i2i"] || [];
                                      const sameProviderEdit = editModels.find(m => m.provider === task.provider);
                                      setSelectedModels(sameProviderEdit ? [sameProviderEdit.id] : []);
                                      setPage("cockpit");
                                    }}>
                                    ✏️ Edit
                                  </button>
                                )}
                                {((task.genType || genType) === "image" || (task.genType || genType) === "i2i") && (
                                  <button className="result-action-btn" style={{ color: "var(--warning)", borderColor: "rgba(245,158,11,0.3)" }}
                                    onClick={() => { setSourceImageUrl(task.outputs?.[0] || ""); setSourcePreview(task.outputs?.[0] || ""); setUploadStatus("done"); setGenType("i2v"); setSelectedModels([]); setPrompt(""); }}>
                                    🎬 Animate
                                  </button>
                                )}
                              </>}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ═══ GALLERY ═══ */}
            {page === "gallery" && (() => {
              const galleryCompleted = tasks.filter(t => t.status === "completed");
              const galleryProcessing = tasks.filter(t => t.status === "pending" || t.status === "processing");
              const galleryFailed = tasks.filter(t => t.status === "failed");
              const [galleryTab, setGalleryTab] = [galleryTabState, setGalleryTabState];
              const tabCounts = { completed: galleryCompleted.length, processing: galleryProcessing.length, failed: galleryFailed.length };
              return (
              <div>
                {/* Gallery Tabs */}
                <div style={{ display: "flex", gap: 4, marginBottom: 16, background: "rgba(10,20,40,0.3)", borderRadius: 10, padding: 3 }}>
                  {[["completed","Completed"],["processing","Processing"],["failed","Failed"]].map(([key,label]) => (
                    <button key={key} onClick={() => setGalleryTabState(key)}
                      style={{ flex: 1, padding: "8px 6px", border: "none", borderRadius: 8, cursor: "pointer", fontSize: 12, fontFamily: fontBody, fontWeight: 500, transition: "all 0.2s",
                        background: galleryTab === key ? "linear-gradient(135deg, #6366f1, #8b5cf6)" : "transparent",
                        color: galleryTab === key ? "white" : "var(--text-muted)",
                        boxShadow: galleryTab === key ? "0 2px 8px rgba(99,102,241,0.3)" : "none" }}>
                      {label} ({tabCounts[key]})
                    </button>
                  ))}
                </div>

                {/* View Toggle — only for completed tab */}
                {galleryTab === "completed" && galleryCompleted.length > 0 && (
                  <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10, gap: 4 }}>
                    <button onClick={() => setGalleryView("masonry")}
                      style={{ padding: "6px 10px", border: "1px solid var(--glass-border)", borderRadius: 6, cursor: "pointer", fontSize: 14, background: galleryView === "masonry" ? "rgba(99,102,241,0.15)" : "transparent", color: galleryView === "masonry" ? "var(--accent)" : "var(--text-muted)" }}
                      title="Masonry grid view">⊞</button>
                    <button onClick={() => setGalleryView("vertical")}
                      style={{ padding: "6px 10px", border: "1px solid var(--glass-border)", borderRadius: 6, cursor: "pointer", fontSize: 14, background: galleryView === "vertical" ? "rgba(99,102,241,0.15)" : "transparent", color: galleryView === "vertical" ? "var(--accent)" : "var(--text-muted)" }}
                      title="Vertical list view">☰</button>
                  </div>
                )}

                {/* Completed outputs */}
                {galleryTab === "completed" && (
                  galleryCompleted.length === 0 ? (
                    <div className="empty-state"><div className="emoji">🖼️</div><div className="msg">Completed outputs will appear here.</div></div>
                  ) : galleryView === "masonry" ? (
                    /* 3-column thumbnail grid — tap to lightbox, long-press for info */
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 4 }}>
                      {galleryCompleted.flatMap(task =>
                        (task.outputs || []).map((url, i) => {
                          const gType = task.genType || "";
                          const isVideo = url.includes(".mp4") || url.includes("video") || gType === "t2v" || gType === "i2v" || gType === "avatar";
                          return (
                            <div key={`${task.id}-${i}`} style={{ position: "relative", aspectRatio: "1", overflow: "hidden", borderRadius: 6, cursor: "pointer", background: "#111" }}
                              onClick={() => setLightbox(url)}
                              onContextMenu={e => { e.preventDefault(); setLightbox({ url, task }); }}>
                              {isVideo
                                ? <video src={url} muted playsInline style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                                : <img src={url} alt="" loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />}
                              {isVideo && <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", fontSize: 24, color: "white", textShadow: "0 1px 4px rgba(0,0,0,0.6)", pointerEvents: "none" }}>▶</div>}
                              <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, padding: "16px 4px 3px", background: "linear-gradient(transparent, rgba(0,0,0,0.7))", fontSize: 8, color: "rgba(255,255,255,0.8)", fontFamily: font, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {task.modelName}
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  ) : (
                    /* Vertical list — full-width previews with detailed info */
                    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                      {galleryCompleted.map(task => (
                        <div key={task.id} className="task-card">
                          <div className="task-header">
                            <span className="task-model">{task.modelName}</span>
                            <span className="task-status completed">COMPLETED</span>
                          </div>
                          <div style={{ fontSize: 12, color: "var(--text-secondary)", margin: "4px 0" }}>{task.prompt}</div>
                          {task.outputs?.map((url, i) => {
                            const gType = task.genType || "";
                            const isVideo = url.includes(".mp4") || url.includes("video") || gType === "t2v" || gType === "i2v" || gType === "avatar";
                            return isVideo
                              ? <video key={i} className="result-video" src={url} controls muted playsInline onClick={() => setLightbox(url)} />
                              : <img key={i} className="result-img" src={url} alt="" onClick={() => setLightbox(url)} />;
                          })}
                          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: 11, color: "var(--text-muted)", fontFamily: font }}>
                            <span>{task.provider}</span>
                            <span>{formatTime(task.wallClockMs)}</span>
                            <span>{formatCost(task.price)}</span>
                            <span>{task.endTime ? formatTimestamp(task.endTime) : timeAgo(task.endTime)}</span>
                          </div>
                          {task.sourceImageUrl && (
                            <div style={{ marginTop: 6, fontSize: 10, color: "var(--text-muted)" }}>
                              Source: <a href={task.sourceImageUrl} target="_blank" rel="noopener" style={{ color: "var(--accent)" }}>{task.sourceImageUrl.slice(0, 50)}...</a>
                              {task.sourceImageUrls?.length > 0 && ` + ${task.sourceImageUrls.length} ref(s)`}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )
                )}

                {/* Processing — Live status cards */}
                {galleryTab === "processing" && (
                  galleryProcessing.length === 0 ? (
                    <div className="empty-state"><div className="emoji">⏳</div><div className="msg">No generations currently processing.</div></div>
                  ) : (
                    <div className="results-grid">
                      {galleryProcessing.map(task => (
                        <div key={task.id} className="task-card">
                          <div className="task-header">
                            <span className="task-model">{task.modelName}</span>
                            <span className={`task-status ${task.status}`}>{task.status.toUpperCase()}</span>
                          </div>
                          <div style={{ fontSize: 11, color: "var(--text-muted)", margin: "4px 0" }}>{task.prompt?.slice(0, 80)}</div>
                          <div className="task-timer">{formatTime(task.wallClockMs || (Date.now() - task.startTime))}</div>
                          <div className="task-progress"><div className="task-progress-fill" style={{ width: `${Math.min(95, ((Date.now() - task.startTime) / getExpectedMs(task.modelId, task.genType)) * 100)}%` }} /></div>
                          <div style={{ marginTop: 8 }}>
                            <button className="result-action-btn" onClick={() => cancelTask(task.id)}>✕ Cancel</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )
                )}

                {/* Failed — Full debug info */}
                {galleryTab === "failed" && (
                  galleryFailed.length === 0 ? (
                    <div className="empty-state"><div className="emoji">✓</div><div className="msg">No failed generations. Looking good!</div></div>
                  ) : (
                    <div className="results-grid">
                      {galleryFailed.map(task => (
                        <div key={task.id} className="task-card" style={{ borderColor: "rgba(239,68,68,0.2)" }}>
                          <div className="task-header">
                            <span className="task-model">{task.modelName}</span>
                            <span className="task-status failed">FAILED</span>
                          </div>
                          <div style={{ fontSize: 12, color: "var(--error)", margin: "6px 0", fontFamily: font, background: "rgba(239,68,68,0.08)", padding: "8px 10px", borderRadius: 6, wordBreak: "break-word" }}>
                            {task.error || "Unknown error"}
                          </div>
                          <div style={{ fontSize: 10, color: "var(--text-muted)", lineHeight: 1.6, fontFamily: font }}>
                            <div><strong>Model ID:</strong> {task.modelId}</div>
                            <div><strong>Provider:</strong> {task.provider}</div>
                            <div><strong>Gen Type:</strong> {task.genType || "unknown"}</div>
                            <div><strong>Resolution:</strong> {task.resolution || "default"}</div>
                            <div><strong>Duration:</strong> {task.duration || "N/A"}</div>
                            <div><strong>Seed:</strong> {task.seed || "-1"}</div>
                            <div><strong>Aspect:</strong> {task.aspectRatio || "auto"}</div>
                            <div><strong>Prompt:</strong> <span style={{ color: "var(--text-secondary)" }}>{task.prompt?.slice(0, 120)}</span></div>
                            <div><strong>Time:</strong> {task.startTime ? formatTimestamp(task.startTime) : "unknown"}</div>
                          </div>
                          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                            <button className="result-action-btn" style={{ color: "var(--accent)" }} onClick={() => regenerateTask(task)}>🔄 Retry</button>
                            <button className="result-action-btn" onClick={() => { navigator.clipboard?.writeText(JSON.stringify({ modelId: task.modelId, error: task.error, prompt: task.prompt, resolution: task.resolution, duration: task.duration, seed: task.seed, genType: task.genType }, null, 2)); }}>📋 Copy Debug</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )
                )}
              </div>
              );
            })()}

            {/* ═══ LOGS ═══ */}
            {page === "logs" && (
              <div>
                <h2 style={{ fontFamily: font, fontSize: 16, marginBottom: 16, color: "var(--text-secondary)" }}>Generation Log ({logs.length} entries)</h2>
                {logs.length === 0 ? (
                  <div className="empty-state"><div className="emoji">📋</div><div className="msg">Your generation history will appear here. Each entry can be replayed with one click.</div></div>
                ) : (
                  <div style={{ border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
                    <div className="log-row log-header">
                      <span>Time</span><span>Prompt</span><span>Models</span><span>Type</span><span>Cost</span><span></span>
                    </div>
                    {logs.map(log => (
                      <div key={log.id} className="log-row" onClick={() => replayLog(log)}>
                        <span style={{ fontFamily: font, fontSize: 11, color: "var(--text-muted)" }}>{timeAgo(log.timestamp)}</span>
                        <span className="log-prompt">{log.prompt}</span>
                        <span className="log-models">{log.models.length} model{log.models.length > 1 ? "s" : ""}</span>
                        <span style={{ fontSize: 11 }}>{TYPE_ICONS[log.genType]}</span>
                        <span className="log-cost">{formatCost(log.totalCost)}</span>
                        <button className="log-replay" onClick={e => { e.stopPropagation(); replayLog(log); }}>▶</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ═══ SETTINGS ═══ */}
            {page === "settings" && (
              <div style={{ maxWidth: 500 }}>
                <h2 style={{ fontFamily: font, fontSize: 16, marginBottom: 24, color: "var(--text-secondary)" }}>Settings</h2>

                {/* Appearance */}
                <div className="setting-group">
                  <div className="setting-label">Appearance</div>
                  <div className="setting-hint" style={{ marginBottom: 12 }}>Theme and animated backdrop are synced to the cloud — they follow you to every device.</div>

                  {/* Theme picker — color swatches */}
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: font, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>Color Theme</div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 8 }}>
                      {Object.entries(THEMES).map(([key, t]) => (
                        <button key={key} onClick={() => setTheme(key)}
                          style={{
                            display: "flex", alignItems: "center", gap: 10, padding: "10px 12px",
                            background: theme === key ? "rgba(99,102,241,0.15)" : "rgba(8,12,25,0.4)",
                            border: `1px solid ${theme === key ? t.accent : "var(--glass-border)"}`,
                            borderRadius: 10, cursor: "pointer", transition: "all 0.2s",
                            boxShadow: theme === key ? `0 0 16px ${t.accent}40` : "none",
                          }}>
                          <div style={{ width: 18, height: 18, borderRadius: "50%", background: t.accent, boxShadow: `0 0 8px ${t.accent}80`, flexShrink: 0 }} />
                          <div style={{ fontSize: 12, color: "var(--text-primary)", fontFamily: fontBody, fontWeight: theme === key ? 600 : 500, textAlign: "left" }}>{t.name}</div>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Background picker */}
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: font, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>Animated Background</div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(90px, 1fr))", gap: 6 }}>
                      {BACKGROUNDS.map(bg => {
                        const labels = { orbs: "◉ Orbs", stars: "✦ Stars", matrix: "⎔ Matrix", grid: "▦ Grid", none: "— None" };
                        return (
                          <button key={bg} onClick={() => setBackground(bg)}
                            style={{
                              padding: "10px 8px",
                              background: background === bg ? "rgba(99,102,241,0.15)" : "rgba(8,12,25,0.4)",
                              border: `1px solid ${background === bg ? "var(--accent)" : "var(--glass-border)"}`,
                              borderRadius: 8, cursor: "pointer", fontSize: 12, fontFamily: font,
                              color: background === bg ? "var(--accent)" : "var(--text-secondary)",
                              fontWeight: background === bg ? 700 : 500, textAlign: "center",
                              transition: "all 0.2s", textTransform: "capitalize",
                            }}>{labels[bg] || bg}</button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Light mode toggle */}
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px", background: "rgba(8,12,25,0.4)", border: "1px solid var(--glass-border)", borderRadius: 10 }}>
                    <div>
                      <div style={{ fontSize: 13, color: "var(--text-primary)", fontWeight: 600 }}>Light Mode</div>
                      <div style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: font, marginTop: 2 }}>Flip to a bright palette. Accent color stays.</div>
                    </div>
                    <button onClick={() => setLightMode(!lightMode)}
                      style={{
                        width: 48, height: 26, borderRadius: 14,
                        background: lightMode ? "var(--accent)" : "rgba(30,41,59,0.5)",
                        border: "1px solid var(--glass-border)", cursor: "pointer", position: "relative",
                        transition: "background 0.25s",
                      }}>
                      <div style={{ position: "absolute", top: 2, left: lightMode ? 24 : 2, width: 20, height: 20, borderRadius: "50%", background: "white", transition: "left 0.25s", boxShadow: "0 1px 4px rgba(0,0,0,0.3)" }} />
                    </button>
                  </div>
                </div>

                {/* Cloud storage usage (per-generation manual backup via buttons on each result) */}
                <div className="setting-group">
                  <div className="setting-label">Cloud Storage</div>
                  <div className="setting-hint" style={{ marginBottom: 10 }}>
                    WaveSpeed output URLs expire after ~24h. To make a generation permanent, tap the <b>☁</b> button on that result card to back it up to cloud storage.
                  </div>
                  <div style={{ padding: "10px 14px", background: "rgba(8,12,25,0.3)", border: "1px solid var(--glass-border)", borderRadius: 10, fontSize: 11, color: "var(--text-secondary)", fontFamily: font, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span>☁ {archiveStats.count} file{archiveStats.count === 1 ? "" : "s"} · {(archiveStats.bytes / 1024 / 1024).toFixed(1)} MB backed up</span>
                    <button onClick={async () => { const s = await getArchiveStats(); setArchiveStats(s); }}
                      style={{ padding: "4px 10px", fontSize: 10, background: "rgba(99,102,241,0.1)", color: "var(--accent)", border: "1px solid rgba(99,102,241,0.3)", borderRadius: 6, cursor: "pointer", fontFamily: font, fontWeight: 600 }}>Refresh</button>
                  </div>
                </div>

                {/* Account */}
                <div className="setting-group">
                  <div className="setting-label">Account</div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "12px 14px", background: "rgba(8,12,25,0.4)", border: "1px solid var(--glass-border)", borderRadius: 10 }}>
                    <div>
                      <div style={{ fontSize: 13, color: "var(--text-primary)", fontWeight: 600 }}>
                        {(() => { try { return localStorage.getItem("proximaai-user") || "anonymous"; } catch { return "anonymous"; } })()}
                      </div>
                      <div style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: font, marginTop: 2 }}>Signed in · Cloud sync active</div>
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button onClick={() => setShowAccountModal(true)}
                        style={{ padding: "8px 14px", background: "rgba(99,102,241,0.1)", color: "var(--accent)", border: "1px solid rgba(99,102,241,0.3)", borderRadius: 8, fontFamily: font, fontSize: 12, cursor: "pointer", fontWeight: 600, whiteSpace: "nowrap" }}>
                        Manage
                      </button>
                      <button onClick={handleLogout}
                        style={{ padding: "8px 14px", background: "rgba(239,68,68,0.1)", color: "var(--error)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 8, fontFamily: font, fontSize: 12, cursor: "pointer", fontWeight: 600, whiteSpace: "nowrap" }}>
                        Sign Out
                      </button>
                    </div>
                  </div>
                  {accountToast && (
                    <div style={{ marginTop: 10, padding: "10px 14px", background: "rgba(34,197,94,0.1)", border: "1px solid rgba(34,197,94,0.3)", borderRadius: 8, fontSize: 12, color: "var(--success)", fontFamily: font }}>
                      ✓ {accountToast}
                    </div>
                  )}
                </div>

                <div className="setting-group">
                  <div className="setting-label">WaveSpeed API Key</div>
                  <input type="password" className="setting-input" placeholder="Enter your WaveSpeed API key..."
                    value={apiKey} onChange={e => { setApiKey(e.target.value); setTestStatus(null); }} />
                  <div className="setting-hint">Get your key at <span style={{ color: "var(--accent)" }}>wavespeed.ai/settings</span>. Stored locally in your browser. Requests are forwarded to WaveSpeed through Vite's dev server proxy on your machine — no third-party services involved, your API key never leaves your computer.</div>
                  {apiKey && (
                    <button className="api-test-btn"
                      disabled={testStatus === "testing"}
                      onClick={async () => {
                        setTestStatus("testing");
                        const r = await checkBalance(apiKey);
                        if (r.balance !== null) {
                          setBalance(r.balance);
                          setTestStatus({ ok: true, msg: `Connected! Balance: $${Number(r.balance).toFixed(4)}` });
                        } else {
                          setTestStatus({ ok: false, msg: r.error ? r.error : "Could not verify key. Check if it's correct." });
                        }
                      }}>
                      {testStatus === "testing" ? "Testing..." : "Test Connection"}
                    </button>
                  )}
                  {testStatus && testStatus !== "testing" && (
                    <div style={{
                      marginTop: 10, padding: "10px 12px", borderRadius: 8, fontSize: 12,
                      fontFamily: font, fontWeight: 500,
                      background: testStatus.ok ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
                      border: `1px solid ${testStatus.ok ? "rgba(34,197,94,0.3)" : "rgba(239,68,68,0.3)"}`,
                      color: testStatus.ok ? "var(--success)" : "var(--error)"
                    }}>
                      {testStatus.ok ? "✓ " : "✗ "}{testStatus.msg}
                    </div>
                  )}
                  {testStatus === "testing" && (
                    <div className="pulse" style={{ marginTop: 10, fontSize: 12, color: "var(--accent)", fontFamily: font }}>
                      ⏳ Contacting WaveSpeed API...
                    </div>
                  )}
                  {balance !== null && testStatus !== "testing" && !testStatus && <div style={{ marginTop: 8, fontFamily: font, fontSize: 13, color: "var(--success)" }}>Balance: ${Number(balance).toFixed(4)}</div>}
                </div>

                <div className="setting-group">
                  <div className="setting-label">Default Settings</div>
                  <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
                    <div>
                      <label style={{ fontSize: 11, color: "var(--text-muted)" }}>Image Resolution</label>
                      <select className="settings-select" style={{ display: "block", marginTop: 4 }}
                        value={defaultImageRes} onChange={e => { setDefaultImageRes(e.target.value); setSetting("defaultImageRes", e.target.value); trackedSync("defaultImageRes", () => syncSetting("defaultImageRes", e.target.value)).catch(() => {}); }}>
                        <option value="1k">1K</option><option value="2k">2K</option><option value="4k">4K</option>
                      </select>
                    </div>
                    <div>
                      <label style={{ fontSize: 11, color: "var(--text-muted)" }}>Video Duration</label>
                      <select className="settings-select" style={{ display: "block", marginTop: 4 }}
                        value={defaultVideoDur} onChange={e => { setDefaultVideoDur(Number(e.target.value)); setSetting("defaultVideoDur", e.target.value); trackedSync("defaultVideoDur", () => syncSetting("defaultVideoDur", e.target.value)).catch(() => {}); }}>
                        <option value={5}>5s</option><option value={10}>10s</option><option value={15}>15s</option>
                      </select>
                    </div>
                  </div>
                </div>

                <div className="setting-group">
                  <div className="setting-label">About</div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>
                    <strong style={{ color: "var(--text-primary)" }}>ProximaAI v1.0</strong> — Parallel AI Generation Cockpit<br />
                    {Object.values(MODELS).flat().length} models registered across {Object.keys(MODELS).length} categories<br />
                    Powered by WaveSpeed.ai unified API
                  </div>
                </div>

                <div className="setting-group">
                  <div className="setting-label">Storage</div>
                  {storageStats && (
                    <div style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: font, lineHeight: 1.8, marginBottom: 10 }}>
                      <div>Saved Outputs: <strong style={{ color: "var(--text-primary)" }}>{storageStats.tasks}</strong></div>
                      <div>Generation Logs: <strong style={{ color: "var(--text-primary)" }}>{storageStats.history}</strong></div>
                      <div>Favorites: <strong style={{ color: "var(--text-primary)" }}>{storageStats.favorites}</strong></div>
                      {storageStats.usedMB && <div>Disk Usage: <strong style={{ color: "var(--text-primary)" }}>{storageStats.usedMB} MB</strong></div>}
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button className="api-test-btn" style={{ background: "var(--error)" }} onClick={async () => {
                      if (!confirm("Clear all generation logs? (local + cloud)\n\nA safety backup will be created first so you can restore it from the Backups panel.")) return;
                      setSaveStatus("saving");
                      await createBackup("pre-clear-logs", "Before Clear Logs");
                      setLogs([]); savedLogIds.current.clear();
                      await clearHistory();
                      await clearHistoryRemote();
                      getStorageStats().then(s => setStorageStats(s));
                      setSaveStatus("saved"); setTimeout(() => setSaveStatus(s => s === "saved" ? "idle" : s), 2000);
                      setAccountToast("Logs cleared — safety backup saved");
                      setTimeout(() => setAccountToast(""), 5000);
                    }}>Clear Logs</button>
                    <button className="api-test-btn" style={{ background: "var(--error)" }} onClick={async () => {
                      if (!confirm("Clear all saved outputs? (local + cloud)\n\nA safety backup will be created first so you can restore it from the Backups panel.")) return;
                      setSaveStatus("saving");
                      await createBackup("pre-clear-outputs", "Before Clear Outputs");
                      setTasks([]); clearTasksDB(); await clearTasksRemote(); savedTaskIds.current.clear();
                      getStorageStats().then(s => setStorageStats(s));
                      setSaveStatus("saved"); setTimeout(() => setSaveStatus(s => s === "saved" ? "idle" : s), 2000);
                      setAccountToast("Outputs cleared — safety backup saved");
                      setTimeout(() => setAccountToast(""), 5000);
                    }}>Clear Outputs</button>
                    <button className="api-test-btn" style={{ background: "var(--error)" }} onClick={async () => {
                      if (!confirm("Clear ALL data? This removes everything locally AND from the cloud.\n\nA full safety backup will be created first so you can restore it from the Backups panel.")) return;
                      setSaveStatus("saving");
                      // Full pre-destructive snapshot
                      await createBackup("pre-reset", "Before Reset Everything");
                      // Clear local state
                      setLogs([]); setTasks([]);
                      savedLogIds.current.clear();
                      savedTaskIds.current.clear();
                      taskSyncQueueRef.current = [];
                      if (taskSyncTimerRef.current) clearTimeout(taskSyncTimerRef.current);
                      // Clear local IndexedDB
                      await clearHistory();
                      await clearTasksDB();
                      // Clear cloud (all tables)
                      await Promise.allSettled([
                        clearHistoryRemote(),
                        clearTasksRemote(),
                        clearSettingsRemote(),
                        clearFavoritesRemote(),
                      ]);
                      // Clear local settings
                      setSetting("apiKey", "");
                      setApiKey("");
                      setBalance(null);
                      getStorageStats().then(s => setStorageStats(s));
                      setSaveStatus("saved"); setTimeout(() => setSaveStatus(s => s === "saved" ? "idle" : s), 2000);
                      setAccountToast("Everything cleared — safety backup saved");
                      setTimeout(() => setAccountToast(""), 5000);
                    }}>Reset Everything</button>
                  </div>
                </div>

                {/* Cloud Backups */}
                <div className="setting-group">
                  <div className="setting-label" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <span>Cloud Backups</span>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button className="api-test-btn" style={{ padding: "6px 12px", fontSize: 11 }} onClick={async () => {
                        setSaveStatus("saving");
                        const r = await createBackup("manual", "Manual snapshot");
                        if (r.ok) { setSaveStatus("saved"); setTimeout(() => setSaveStatus("idle"), 2000); setAccountToast("Backup created"); setTimeout(() => setAccountToast(""), 4000); }
                        else { setSaveStatus("error"); setAccountToast("Backup failed: " + (r.error || "unknown")); setTimeout(() => setAccountToast(""), 5000); }
                        const list = await listBackups(20);
                        setBackups(list);
                      }}>+ Create Backup</button>
                      <button className="api-test-btn" style={{ padding: "6px 12px", fontSize: 11, background: "rgba(30,41,59,0.5)", color: "var(--text-secondary)" }} onClick={async () => {
                        if (!showBackupsPanel) { const list = await listBackups(20); setBackups(list); }
                        setShowBackupsPanel(v => !v);
                      }}>{showBackupsPanel ? "Hide" : "View"} ({backups.length || "·"})</button>
                    </div>
                  </div>
                  <div className="setting-hint">Auto-backup runs every 2 days. Manual backups are saved immediately. Destructive actions (Clear / Reset) auto-create a backup first. Rolling retention: 30 auto + all manual.</div>
                  {showBackupsPanel && (
                    <div style={{ marginTop: 12, maxHeight: 360, overflowY: "auto", background: "rgba(8,12,25,0.4)", border: "1px solid var(--glass-border)", borderRadius: 10, padding: 6 }}>
                      {backups.length === 0 ? (
                        <div style={{ padding: 20, textAlign: "center", color: "var(--text-muted)", fontSize: 12 }}>No backups yet. Click "+ Create Backup" above to make one.</div>
                      ) : backups.map(b => (
                        <div key={b.id} style={{ padding: "10px 12px", borderBottom: "1px solid rgba(56,68,100,0.15)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 12, color: "var(--text-primary)", fontWeight: 600 }}>
                              {b.backup_type === "manual" ? "📌 Manual" : b.backup_type === "auto-2day" ? "🔁 Auto (2-day)" : b.backup_type.startsWith("pre-") ? "🛡️ " + b.backup_type.replace("pre-", "Pre-") : b.backup_type}
                              <span style={{ fontSize: 10, color: "var(--text-muted)", fontWeight: 400, marginLeft: 8, fontFamily: font }}>
                                {b.task_count} tasks · {b.history_count} logs
                              </span>
                            </div>
                            <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 2, fontFamily: font }}>{formatTimestamp(b.created_at)}</div>
                            {b.note && <div style={{ fontSize: 10, color: "var(--text-secondary)", marginTop: 2, fontStyle: "italic" }}>{b.note}</div>}
                          </div>
                          <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                            <button onClick={async () => {
                              if (!confirm(`Restore this backup from ${formatTimestamp(b.created_at)}?\n\nThis replaces current data with the snapshot. A safety backup of your CURRENT state is taken first.`)) return;
                              setSaveStatus("saving");
                              const r = await restoreBackup(b.id);
                              if (r.ok) {
                                setAccountToast(`Restored ${r.tasks} tasks, ${r.history} logs. Refresh to see changes.`);
                                setTimeout(() => setAccountToast(""), 6000);
                                setSaveStatus("saved"); setTimeout(() => setSaveStatus("idle"), 2000);
                                const list = await listBackups(20); setBackups(list);
                                setTimeout(() => window.location.reload(), 1500);
                              } else {
                                setSaveStatus("error");
                                setAccountToast("Restore failed: " + (r.error || "unknown"));
                                setTimeout(() => setAccountToast(""), 5000);
                              }
                            }} style={{ padding: "5px 10px", fontSize: 10, background: "rgba(99,102,241,0.12)", color: "var(--accent)", border: "1px solid rgba(99,102,241,0.3)", borderRadius: 6, cursor: "pointer", fontFamily: font, fontWeight: 600 }}>Restore</button>
                            <button onClick={async () => {
                              if (!confirm("Delete this backup permanently?")) return;
                              await deleteBackup(b.id);
                              const list = await listBackups(20); setBackups(list);
                            }} style={{ padding: "5px 9px", fontSize: 10, background: "transparent", color: "var(--error)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 6, cursor: "pointer", fontFamily: font }}>✕</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Floating Save Status Button — always visible, bottom-left */}
        {/* Account Modal */}
        {showAccountModal && (
          <AccountModal
            onClose={() => setShowAccountModal(false)}
            onSaved={(msg) => {
              setAccountToast(msg);
              setTimeout(() => setAccountToast(""), 5000);
            }}
          />
        )}

        {/* Lightbox */}
        {lightbox && (() => {
          const lbUrl = typeof lightbox === "string" ? lightbox : lightbox.url;
          const lbTask = typeof lightbox === "object" ? lightbox.task : null;
          const isVid = lbUrl?.includes(".mp4") || lbUrl?.includes("video");
          return (
            <div className="lightbox" onClick={() => setLightbox(null)}>
              <div onClick={e => e.stopPropagation()} style={{ display: "flex", flexDirection: "column", alignItems: "center", maxWidth: "94vw", maxHeight: "94vh" }}>
                {isVid
                  ? <video src={lbUrl} controls autoPlay muted style={{ maxWidth: "92vw", maxHeight: lbTask ? "70vh" : "92vh", borderRadius: 10 }} />
                  : <img src={lbUrl} alt="Full resolution" style={{ maxWidth: "92vw", maxHeight: lbTask ? "70vh" : "92vh", borderRadius: 10, objectFit: "contain" }} />}
                {lbTask && (
                  <div style={{ marginTop: 10, padding: "12px 16px", background: "rgba(8,12,25,0.85)", borderRadius: 10, width: "92vw", maxHeight: "22vh", overflowY: "auto", border: "1px solid var(--glass-border)" }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>{lbTask.modelName}</div>
                    <div style={{ fontSize: 12, color: "var(--text-secondary)", margin: "4px 0" }}>{lbTask.prompt}</div>
                    <div style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: font, display: "flex", flexWrap: "wrap", gap: "6px 16px", marginTop: 6 }}>
                      <span>Provider: {lbTask.provider}</span>
                      <span>Time: {formatTime(lbTask.wallClockMs)}</span>
                      <span>Cost: {formatCost(lbTask.price)}</span>
                      <span>Seed: {lbTask.seed || "-1"}</span>
                      <span>{lbTask.endTime ? formatTimestamp(lbTask.endTime) : ""}</span>
                    </div>
                    <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                      <button className="result-action-btn" onClick={async () => {
                        try { const r = await fetch(lbUrl); const b = await r.blob(); const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = `${lbTask.modelName.replace(/\s+/g,"_")}_${Date.now()}.${isVid?"mp4":"png"}`; a.click(); URL.revokeObjectURL(a.href); } catch { window.open(lbUrl,"_blank"); }
                      }}>↓ Save</button>
                      <button className="result-action-btn" onClick={() => { navigator.clipboard?.writeText(lbUrl); }}>📋 URL</button>
                      <button className="result-action-btn" onClick={() => setLightbox(null)}>✕ Close</button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })()}
      </div>
    </>
  );
}
