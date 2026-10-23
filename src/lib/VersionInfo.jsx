// Settings → Version (src/lib/version.js): which build this page runs, when it was built, and whether it is the latest.
import { runningVersion, useLiveVersion } from "./version.js";

const mono = `'JetBrains Mono', 'Fira Code', monospace`;
const STATUS = {
  checking: "Checking for a newer version…",
  latest: "Up to date ✓",
  unknown: "Couldn't check for a newer version (offline?)",
};

export default function VersionInfo() {
  const running = runningVersion();
  const { status, live } = useLiveVersion(running);
  const built = running && new Date(running.builtAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return (
    <div className="setting-group">
      <div className="setting-label">Version</div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, minHeight: 44 }}>
        <span data-testid="app-version" style={{ fontFamily: mono, fontSize: 13, color: "var(--text-primary)" }}>
          {running ? `${running.number} · ${running.commit ? running.commit.slice(0, 7) : "unknown"}` : "unknown"}
        </span>
        {status === "update" && (
          <button onClick={() => window.location.reload()} style={{
            minHeight: 44, minWidth: 80, padding: "0 16px", borderRadius: 8, border: "1px solid var(--accent)",
            background: "transparent", color: "var(--accent)", fontFamily: mono, fontSize: 12, fontWeight: 700, cursor: "pointer",
          }}>Reload</button>
        )}
      </div>
      <div className="setting-hint">
        {built ? `Built ${built} · ` : ""}
        {status === "update" ? `Version ${live.number} is live — reload to switch to it` : STATUS[status]}
      </div>
    </div>
  );
}
