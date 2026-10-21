// Runs every pure test script (scripts/test-*.mjs) in turn; exits non-zero if any fails. Run: npm test
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(dir).filter(f => /^test-.*\.mjs$/.test(f)).sort();
let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, [join(dir, f)], { encoding: "utf8" });
  const last = (r.stdout || "").trim().split(/\r?\n/).pop() || "";
  const ok = r.status === 0;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${f.padEnd(28)} ${last}`);
  if (!ok) console.log((r.stdout || "") + (r.stderr || ""));
}
console.log(`\n${files.length - failed}/${files.length} test files passed`);
process.exit(failed ? 1 : 0);
