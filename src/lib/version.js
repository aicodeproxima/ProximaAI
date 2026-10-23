// Settings → Version: the version this page runs and whether the live site serves a newer one. The build stamps it into
// index.html (scripts/lib/build-version.mjs), so the page reads its own <meta name="proxima-version"> and compares it with
// the live index.html's. Pure parts tested by scripts/test-version.mjs.
import { useEffect, useState } from "react";
import { serverNow } from "./serverClock.js";

const CONTENT = /^(\d{4})\.(\d{2})\.(\d{2})-(\d{2})(\d{2}) ([0-9a-f]{40}|unknown)$/;
const TAG = /<meta\s+name="proxima-version"\s+content="([^"]*)"/;
export const FRESH_MS = 5 * 60_000;

// {number, commit, builtAt} from a tag's content, or null.
export function parseVersion(content) {
  const m = CONTENT.exec(typeof content === "string" ? content.trim() : "");
  if (!m) return null;
  return {
    number: `${m[1]}.${m[2]}.${m[3]}-${m[4]}${m[5]}`,
    commit: m[6] === "unknown" ? null : m[6],
    builtAt: Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]),
  };
}

export const versionFromHtml = (html) => parseVersion(TAG.exec(typeof html === "string" ? html : "")?.[1]);

export function runningVersion(doc = globalThis.document) {
  return parseVersion(doc?.querySelector?.('meta[name="proxima-version"]')?.getAttribute("content"));
}

// "latest" when the live site serves this very build, "update" when it serves another one, "unknown" when it can't be told.
export function versionStatus(running, live) {
  if (!running || !live) return "unknown";
  return running.number === live.number && running.commit === live.commit ? "latest" : "update";
}

// An answer counts as live only when the server dated it within FRESH_MS of now (server time): when the network fails,
// the service worker answers /index.html from its cache, and that copy says nothing about what is live.
export function isFreshAnswer(dateHeader, now = serverNow()) {
  const t = Date.parse(dateHeader || "");
  return Number.isFinite(t) && Math.abs(now - t) <= FRESH_MS;
}

// Checks when Settings opens and whenever the tab comes back into view (at most once a minute).
export function useLiveVersion(running) {
  const [state, setState] = useState({ status: "checking", live: null });
  const number = running?.number, commit = running?.commit;
  useEffect(() => {
    let stopped = false, last = 0;
    const check = async () => {
      if (stopped || document.visibilityState !== "visible" || Date.now() - last < 60_000) return;
      last = Date.now();
      try {
        const res = await fetch("/index.html", { cache: "no-store" });
        const live = res.ok && isFreshAnswer(res.headers.get("date")) ? versionFromHtml(await res.text()) : null;
        if (!stopped) setState({ status: versionStatus(number ? { number, commit } : null, live), live });
      } catch {
        if (!stopped) setState({ status: "unknown", live: null });
      }
    };
    document.addEventListener("visibilitychange", check);
    check();
    return () => { stopped = true; document.removeEventListener("visibilitychange", check); };
  }, [number, commit]);
  return state;
}
