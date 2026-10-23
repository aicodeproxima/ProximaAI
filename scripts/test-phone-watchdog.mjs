// Tests for scripts/browser/phone-watchdog.sh against a fake adb and node, so no phone is ever touched: it still locks a
// phone that left Chrome, a pause flag still prevents that, and it exits by itself after WATCHDOG_MAX_S so a forgotten
// watchdog cannot keep locking the owner's phone. Skips when no POSIX sh is on PATH (a plain PowerShell).
// Run: node scripts/test-phone-watchdog.mjs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// WATCHDOG_SCRIPT points the test at another copy (e.g. an older version, to see the test fail).
const WATCHDOG = process.env.WATCHDOG_SCRIPT || join(dirname(fileURLToPath(import.meta.url)), "browser", "phone-watchdog.sh");
let n = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", e.message.split("\n")[0]); }
};

if (spawnSync("sh", ["-c", "exit 0"]).status !== 0) {
  console.log("skipped: no POSIX sh on PATH");
  process.exit(0);
}

// A fake phone in a temp folder: adb answers from the file `fg` (the foreground package) and appends every keyevent to
// `keys`; node answers the wake-lock probe with "held".
function fakePhone(foreground) {
  const dir = mkdtempSync(join(tmpdir(), "proxima-watchdog-")).replace(/\\/g, "/");
  mkdirSync(`${dir}/bin`);
  writeFileSync(`${dir}/bin/adb`, `#!/bin/sh
case "$*" in
  "get-state") echo device ;;
  "shell dumpsys activity activities") echo "  topResumedActivity=ActivityRecord{1a2b3c u0 $(cat "$FAKE_PHONE/fg")/.Main t7}" ;;
  "shell dumpsys window") echo "  isKeyguardShowing=false" ;;
  "shell dumpsys power") echo "  mWakefulness=Awake" ;;
  "forward --list") echo "R5CX13P78NW tcp:9333 localabstract:chrome_devtools_remote" ;;
  "shell input keyevent "*) echo "$4" >> "$FAKE_PHONE/keys" ;;
esac
exit 0
`);
  writeFileSync(`${dir}/bin/node`, `#!/bin/sh\necho '"held"'\n`);
  writeFileSync(`${dir}/fg`, foreground);
  const keys = () => (existsSync(`${dir}/keys`) ? readFileSync(`${dir}/keys`, "utf8") : "");
  return { dir, keys, show: (pkg) => writeFileSync(`${dir}/fg`, pkg), pause: () => writeFileSync(`${dir}/state/watchdog-pause`, "") };
}

// The watchdog under test may only ever reach the fake phone: no folder holding a real adb or node is on its PATH, so
// even after the fake folder is gone it cannot lock the owner's phone. It records its own shell PID, and kill() ends that
// shell with sh's own kill, which works the same on Windows (MSYS) and elsewhere; a run against the old v5 script (which
// never exits by itself) leaves 0 watchdogs behind.
const realTool = (d) => ["adb", "adb.exe", "node", "node.exe"].some((t) => existsSync(join(d, t)));
function run(phone, maxS) {
  const PATH = [`${phone.dir}/bin`, ...String(process.env.PATH).split(delimiter).filter((d) => d && !realTool(d))].join(delimiter);
  const pidFile = `${phone.dir}/watchdog.pid`;
  const proc = spawn("sh", ["-c", 'echo $$ > "$1"; exec sh "$2"', "sh", pidFile, WATCHDOG.replace(/\\/g, "/")], {
    env: { ...process.env, PATH, FAKE_PHONE: phone.dir, PHONE_STATE_DIR: `${phone.dir}/state`,
      WATCHDOG_MAX_S: String(maxS), WATCHDOG_TICK_S: "1" },
  });
  let out = "";
  proc.stdout.on("data", (d) => { out += d; });
  const exited = new Promise((res) => proc.on("exit", (code) => res(code)));
  const killTree = async () => {
    if (proc.exitCode === null && proc.signalCode === null && existsSync(pidFile)) {
      spawnSync("sh", ["-c", 'kill -9 "$1" 2>/dev/null', "sh", readFileSync(pidFile, "utf8").trim()]);
    }
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  };
  const until = async (re, ms) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (re.test(out)) return;
    throw new Error(`no ${re} within ${ms} ms; stdout: ${JSON.stringify(out)}`);
  };
  const exit = (ms) => Promise.race([exited, new Promise((_, rej) => setTimeout(() => rej(new Error(`still running after ${ms} ms`)), ms))]);
  return { out: () => out, until, exit, kill: killTree };
}

await test("locks a phone that leaves Chrome, then exits by itself after WATCHDOG_MAX_S", async () => {
  const phone = fakePhone("com.android.chrome"), w = run(phone, 6);
  try {
    await w.until(/ARMED/, 15_000);
    phone.show("com.sec.android.app.launcher");
    await w.until(/LOCKED foreground=com\.sec\.android\.app\.launcher/, 15_000);
    assert.match(phone.keys(), /KEYCODE_SLEEP/);
    assert.equal(await w.exit(20_000), 0);
    assert.match(w.out(), /EXPIRED/);
  } finally { await w.kill(); rmSync(phone.dir, { recursive: true, force: true }); }
});

await test("a pause flag still keeps it from locking when Chrome leaves the front", async () => {
  const phone = fakePhone("com.android.chrome"), w = run(phone, 5);
  try {
    await w.until(/ARMED/, 15_000);
    phone.pause();
    phone.show("com.android.settings");
    assert.equal(await w.exit(20_000), 0);
    assert.doesNotMatch(w.out(), /LOCKED/);
    assert.equal(phone.keys(), "");
  } finally { await w.kill(); rmSync(phone.dir, { recursive: true, force: true }); }
});

await test("expires even when it never armed (the phone stayed out of Chrome)", async () => {
  const phone = fakePhone("com.sec.android.app.launcher"), w = run(phone, 3);
  try {
    assert.equal(await w.exit(20_000), 0);
    assert.match(w.out(), /EXPIRED/);
    assert.doesNotMatch(w.out(), /ARMED|LOCKED/);
    assert.equal(phone.keys(), "");
  } finally { await w.kill(); rmSync(phone.dir, { recursive: true, force: true }); }
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
