// The app's version, stamped by the build itself (vite.config.js) into index.html as
// <meta name="proxima-version" content="<YYYY.MM.DD-HHMM> <commit sha|unknown>">. Vercel builds every push, so every deploy
// carries its own version with no commit or git hook of its own, and the version can never lag the code it shipped with.
// Only VERCEL_GIT_COMMIT_SHA is read from the environment (a local build asks git). Nothing goes into the JS bundle, so a
// push that changes no app code leaves the bundle, and the "New version ready" banner, alone.
// Tested by scripts/test-version.mjs; a push is live once `sh scripts/browser/wait-deploy.sh $(git rev-parse HEAD)` hits.
import { execSync } from "node:child_process";

export const VERSION_META = "proxima-version";
const SHA = /^[0-9a-f]{40}$/;
const CONTENT = /^\d{4}\.\d{2}\.\d{2}-\d{4} (?:[0-9a-f]{40}|unknown)$/;
const TAG = new RegExp(`<meta\\s+name="${VERSION_META}"\\s+content="([^"]*)"`);

export function gitHead() {
  try { return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString(); } catch { return ""; }
}

// number = the UTC build minute, fixed width, so a later build always sorts higher; commit = the full sha, or null.
export function buildVersion({ env = process.env, now = new Date(), git = gitHead } = {}) {
  const clean = (s) => String(s || "").trim().toLowerCase();
  let sha = clean(env.VERCEL_GIT_COMMIT_SHA);
  if (!SHA.test(sha)) sha = clean(git());
  const iso = now.toISOString();
  return {
    number: `${iso.slice(0, 4)}.${iso.slice(5, 7)}.${iso.slice(8, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}`,
    commit: SHA.test(sha) ? sha : null,
  };
}

export const versionContent = (v) => `${v.number} ${v.commit || "unknown"}`;

// The build refuses to finish without the tag: a deploy must always say which version it is.
export function assertVersionTag(html, v) {
  const content = TAG.exec(typeof html === "string" ? html : "")?.[1];
  if (!content || !CONTENT.test(content) || (v && content !== versionContent(v))) {
    throw new Error(`index.html lacks <meta name="${VERSION_META}" content="${v ? versionContent(v) : "<number> <sha>"}">`);
  }
  return content;
}
