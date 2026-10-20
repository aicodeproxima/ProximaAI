// New-deployment detection (pure parts tested by scripts/test-update-check.mjs).
// A PWA tab can stay open for hours: before this, a deploy only reached it after a full reload, so the owner kept
// running old code (2026-10-20: devices stayed on the pre-cut-over bundle for hours). The app compares the entry
// bundle named by the live index.html with the one it is running and offers a reload when they differ.
import { useEffect, useState } from "react";

const BUNDLE = /\/assets\/index-[A-Za-z0-9_-]+\.js/;

export function bundleFromHtml(html) {
  const m = BUNDLE.exec(typeof html === "string" ? html : "");
  return m ? m[0] : null;
}

export function isNewerBuild(running, liveHtml) {
  const live = bundleFromHtml(liveHtml);
  return !!(running && live && live !== running);
}

function runningBundle() {
  const s = [...document.scripts].find(el => BUNDLE.test(el.src || ""));
  return s ? new URL(s.src).pathname : null;
}

// true once a newer deployment is live. Checks when the tab becomes visible (at most once a minute) and every
// 10 minutes while visible; fetches /index.html uncached (the service worker refreshes its copy on the way).
export default function useUpdateAvailable() {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    const running = runningBundle();
    if (!running) return undefined; // dev server: no built bundle to compare
    let last = 0, stopped = false;
    const check = async () => {
      if (stopped || available || document.visibilityState !== "visible" || Date.now() - last < 60_000) return;
      last = Date.now();
      try {
        const res = await fetch("/index.html", { cache: "no-store" });
        if (res.ok && isNewerBuild(running, await res.text()) && !stopped) setAvailable(true);
        navigator.serviceWorker?.getRegistration?.().then(r => r?.update()).catch(() => {});
      } catch {}  // offline: try again on the next visibility change
    };
    const id = setInterval(check, 10 * 60_000);
    document.addEventListener("visibilitychange", check);
    check();
    return () => { stopped = true; clearInterval(id); document.removeEventListener("visibilitychange", check); };
  }, [available]);
  return available;
}
