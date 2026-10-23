// Tests for the build-stamped version (scripts/lib/build-version.mjs, src/lib/version.js), including a real build that
// fails the test if dist/index.html lacks the version tag or the version leaks into the JS bundle.
// Run: node scripts/test-version.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildVersion, versionContent, assertVersionTag } from "./lib/build-version.mjs";
import { parseVersion, versionFromHtml, runningVersion, versionStatus, isFreshAnswer, FRESH_MS } from "../src/lib/version.js";

let n = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", e.message.split("\n")[0]); }
};

const SHA = "0123456789abcdef0123456789abcdef01234567";
const at = new Date("2026-10-23T14:26:59.999Z");
const page = (content) => `<!doctype html><html><head><meta charset="UTF-8" />
<meta name="proxima-version" content="${content}">
<script type="module" crossorigin src="/assets/index-AbC123.js"></script></head><body></body></html>`;

await test("the number is the UTC build minute, fixed width, so a later build sorts higher", () => {
  const v = buildVersion({ env: { VERCEL_GIT_COMMIT_SHA: SHA }, now: at, git: () => "" });
  assert.deepEqual(v, { number: "2026.10.23-1426", commit: SHA });
  const later = buildVersion({ env: {}, now: new Date("2026-10-23T15:05:00Z"), git: () => SHA });
  assert.ok(later.number > v.number);
  assert.ok(buildVersion({ env: {}, now: new Date("2026-11-02T09:00:00Z"), git: () => "" }).number > later.number);
});

await test("the commit is VERCEL_GIT_COMMIT_SHA, else git's HEAD; anything that is not a full sha is unknown", () => {
  const noGit = () => { throw new Error("git must not run when Vercel names the commit"); };
  assert.equal(buildVersion({ env: { VERCEL_GIT_COMMIT_SHA: SHA.toUpperCase() }, now: at, git: noGit }).commit, SHA);
  assert.equal(buildVersion({ env: {}, now: at, git: () => SHA + "\n" }).commit, SHA);
  assert.equal(buildVersion({ env: { VERCEL_GIT_COMMIT_SHA: "abc123" }, now: at, git: () => SHA }).commit, SHA);
  assert.equal(buildVersion({ env: {}, now: at, git: () => "" }).commit, null);
  assert.equal(buildVersion({ env: { VERCEL_GIT_COMMIT_SHA: "abc123" }, now: at, git: () => "fatal: not a git repository" }).commit, null);
});

await test("the tag's content round-trips through the page's parser", () => {
  const v = { number: "2026.10.23-1426", commit: SHA };
  assert.equal(versionContent(v), `2026.10.23-1426 ${SHA}`);
  assert.equal(versionContent({ ...v, commit: null }), "2026.10.23-1426 unknown");
  assert.deepEqual(parseVersion(versionContent(v)), { ...v, builtAt: Date.UTC(2026, 9, 23, 14, 26) });
  assert.deepEqual(parseVersion("2026.10.23-1426 unknown"), { number: "2026.10.23-1426", commit: null, builtAt: Date.UTC(2026, 9, 23, 14, 26) });
  for (const bad of [null, undefined, "", `2026.10.23 ${SHA}`, "2026.10.23-1426", "2026.10.23-1426 xyz", `2026.10.23-1426 ${SHA} x`]) {
    assert.equal(parseVersion(bad), null, String(bad));
  }
});

await test("reads the version from a live index.html, and null when the page carries none", () => {
  assert.equal(versionFromHtml(page(`2026.10.23-1426 ${SHA}`)).commit, SHA);
  assert.equal(versionFromHtml("<html><head></head></html>"), null);
  assert.equal(versionFromHtml(undefined), null);
});

await test("reads the running version from the page's own meta tag", () => {
  const meta = { getAttribute: (a) => (a === "content" ? `2026.10.23-1426 ${SHA}` : null) };
  assert.equal(runningVersion({ querySelector: (s) => (s === 'meta[name="proxima-version"]' ? meta : null) }).number, "2026.10.23-1426");
  assert.equal(runningVersion({ querySelector: () => null }), null);
  assert.equal(runningVersion(undefined), null);
});

await test("up to date only when the live site serves this very build; unknown never claims either way", () => {
  const mine = parseVersion(`2026.10.23-1426 ${SHA}`);
  assert.equal(versionStatus(mine, parseVersion(`2026.10.23-1426 ${SHA}`)), "latest");
  assert.equal(versionStatus(mine, parseVersion(`2026.10.23-1530 ${SHA}`)), "update"); // a redeploy of the same commit
  assert.equal(versionStatus(mine, parseVersion(`2026.10.23-1426 ${"f".repeat(40)}`)), "update"); // two pushes in one minute
  assert.equal(versionStatus(mine, null), "unknown");
  assert.equal(versionStatus(null, mine), "unknown");
});

await test("a cached copy (old Date header) or a missing Date never counts as a live answer", () => {
  const now = Date.UTC(2026, 9, 23, 15, 0);
  assert.equal(isFreshAnswer(new Date(now - 30_000).toUTCString(), now), true);
  assert.equal(isFreshAnswer(new Date(now + 60_000).toUTCString(), now), true); // this device's clock a minute behind
  assert.equal(isFreshAnswer(new Date(now - FRESH_MS - 1000).toUTCString(), now), false);
  assert.equal(isFreshAnswer(null, now), false);
  assert.equal(isFreshAnswer("garbage", now), false);
});

await test("the build check refuses an index.html without the tag, or with another version", () => {
  const v = { number: "2026.10.23-1426", commit: SHA };
  assert.equal(assertVersionTag(page(versionContent(v)), v), versionContent(v));
  assert.throws(() => assertVersionTag("<html><head></head></html>", v));
  assert.throws(() => assertVersionTag(page(`2026.10.23-1427 ${SHA}`), v));
  assert.throws(() => assertVersionTag(page("someday maybe"), null));
  assert.throws(() => assertVersionTag(undefined, v));
});

await test("a real build writes the tag into dist/index.html and keeps the version out of the JS bundle", async () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const out = mkdtempSync(join(tmpdir(), "proxima-version-"));
  const fake = "fedcba9876543210fedcba9876543210fedcba98";
  const prev = process.env.VERCEL_GIT_COMMIT_SHA;
  process.env.VERCEL_GIT_COMMIT_SHA = fake;
  try {
    const { build } = await import("vite");
    await build({ root, configFile: join(root, "vite.config.js"), logLevel: "silent", build: { outDir: out, emptyOutDir: true } });
    const v = versionFromHtml(readFileSync(join(out, "index.html"), "utf8"));
    assert.ok(v, "dist/index.html has no proxima-version tag");
    assert.equal(v.commit, fake);
    const js = readdirSync(join(out, "assets")).filter((f) => f.endsWith(".js"))
      .map((f) => readFileSync(join(out, "assets", f), "utf8")).join("\n");
    assert.ok(!js.includes(fake) && !js.includes(v.number), "the version leaked into the JS bundle");
    assert.ok(!js.includes("VERCEL_"), "an environment variable name leaked into the JS bundle");
  } finally {
    if (prev === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA; else process.env.VERCEL_GIT_COMMIT_SHA = prev;
    rmSync(out, { recursive: true, force: true });
  }
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
