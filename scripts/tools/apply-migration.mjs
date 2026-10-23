// Applies migration files to the live database and records each in supabase_migrations.schema_migrations, one
// transaction per file (sb-query.mjs --write -f; credentials live there). Run --dry-run first: it writes nothing.
//
//   node scripts/tools/apply-migration.mjs supabase/migrations/<14 digits>_<name>.sql ... [--dry-run] [--allow-old]
//
// A file counts as already recorded when its version OR its name is in schema_migrations: the first migrations were
// recorded by an older tool under other versions with the same names (round 11 R1), so a version-only check would
// re-apply them. A file that is not recorded but older than the newest recorded version is refused unless
// --allow-old is given. Any other flag (a typo such as --dryrun) is refused before the database is touched (R2).
// Also refuses a file not named <14 digits>_<name>.sql. Its recorded text is dollar-quoted with a tag the file does not
// use (buildApplyScript). Stops at the first failure.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SB_QUERY = path.join(path.dirname(fileURLToPath(import.meta.url)), "sb-query.mjs");
const FLAGS = new Set(["--dry-run", "--allow-old"]);
export const USAGE = "usage: node scripts/tools/apply-migration.mjs <migration.sql> ... [--dry-run] [--allow-old]";

export function parseName(file) {
  const m = /^(\d{14})_([A-Za-z0-9_]+)\.sql$/.exec(path.basename(String(file)));
  return m ? { version: m[1], name: m[2] } : null;
}

// Throws on any argument starting with "-" other than the known flags, and when no file is given.
export function parseArgs(argv) {
  const files = [];
  let dryRun = false, allowOld = false;
  for (const a of argv) {
    if (a.startsWith("-")) {
      if (!FLAGS.has(a)) throw new Error(`unknown flag ${a}`);
      if (a === "--dry-run") dryRun = true; else allowOld = true;
    } else files.push(a);
  }
  if (!files.length) throw new Error("no migration file given");
  return { files, dryRun, allowOld };
}

// files: [{ version, name, ... }]; recordedRows: [{ version, name }] from schema_migrations.
// Returns the files in version order, each with action "apply" | "recorded" (by "version" | "name", as { version,
// name }) | "refused-old" (newest = the newest recorded version).
export function planApply(files, recordedRows, { allowOld = false } = {}) {
  const byVersion = new Map(), byName = new Map();
  let newest = "";
  for (const r of recordedRows) {
    const v = String(r.version), n = r.name == null ? null : String(r.name);
    byVersion.set(v, { version: v, name: n });
    if (n != null && !byName.has(n)) byName.set(n, { version: v, name: n });
    if (v > newest) newest = v;
  }
  return [...files].sort((a, b) => (a.version < b.version ? -1 : a.version > b.version ? 1 : 0)).map(f => {
    if (byVersion.has(f.version)) return { ...f, action: "recorded", by: "version", as: byVersion.get(f.version) };
    if (byName.has(f.name)) return { ...f, action: "recorded", by: "name", as: byName.get(f.name) };
    if (newest && f.version < newest && !allowOld) return { ...f, action: "refused-old", newest };
    return { ...f, action: "apply" };
  });
}

export function buildApplyScript(sql, { version, name }) {
  if (!/^\d{14}$/.test(version) || !/^[A-Za-z0-9_]+$/.test(name)) throw new Error("bad version or name");
  // The recorded text is dollar-quoted with a tag the file itself does not use ($mig$, else $mig0$, $mig1$, ...).
  let tag = "mig";
  for (let i = 0; sql.includes("$" + tag + "$"); i++) tag = "mig" + i;
  const q = "$" + tag + "$";
  return `${sql.replace(/\s+$/, "")}\n\ninsert into supabase_migrations.schema_migrations (version, name, statements) ` +
    `values ('${version}', '${name}', array[${q}${sql}${q}]);\n`;
}

async function sbQuery(args) {
  for (let attempt = 0; ; attempt++) {
    const r = spawnSync(process.execPath, [SB_QUERY, ...args], { encoding: "utf8" });
    const out = (r.stdout || "") + (r.stderr || "");
    if (!/fetch failed/.test(out) || attempt >= 2) return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
    console.error(`sb-query: fetch failed, retrying in 10 s (${attempt + 1}/2)`);
    await new Promise(res => setTimeout(res, 10000));
  }
}

// Read-only (sb-query without --write): metadata only.
async function recordedRows() {
  const r = await sbQuery(["select version, name from supabase_migrations.schema_migrations"]);
  if (r.status !== 0) throw new Error(`lookup failed: ${(r.stderr || r.stdout).trim()}`);
  return JSON.parse(r.stdout.trim());
}

async function main(argv) {
  let args;
  try { args = parseArgs(argv); } catch (e) { console.error(`${e.message}\n${USAGE}`); return 2; }
  const files = [];
  for (const f of args.files) {
    const id = parseName(f);
    if (!id) { console.error(`refused: ${f} is not named <14 digits>_<name>.sql`); return 2; }
    let sql;
    try { sql = fs.readFileSync(f, "utf8"); } catch (e) { console.error(`cannot read ${f}: ${e.message}`); return 2; }
    files.push({ f, sql, ...id });
  }
  let rows;
  try { rows = await recordedRows(); } catch (e) { console.error(e.message); return 1; }
  const plan = planApply(files, rows, { allowOld: args.allowOld });
  const refused = plan.filter(p => p.action === "refused-old");
  for (const p of plan) {
    if (p.action === "recorded") console.log(`${p.version} ${p.name} -- already recorded as ${p.as.version} ${p.as.name} (by ${p.by})`);
    else if (p.action === "refused-old") console.log(`${p.version} ${p.name} -- REFUSED: ${p.f} is older than the newest recorded version ${p.newest} (--allow-old to apply anyway)`);
    else console.log(`${p.version} ${p.name} ${Buffer.byteLength(p.sql)} bytes -- not recorded (${args.dryRun ? "would apply" : "applying"})`);
  }
  if (refused.length) { console.error(`refused: ${refused.length} file(s) older than the newest recorded version; nothing applied`); return 2; }
  if (args.dryRun) return 0;
  for (const p of plan) {
    if (p.action !== "apply") continue;
    const tmp = path.join(os.tmpdir(), `apply-migration-${process.pid}-${p.version}.sql`);
    fs.writeFileSync(tmp, buildApplyScript(p.sql, p));
    let r;
    try { r = await sbQuery(["--write", "-f", tmp]); } finally { try { fs.unlinkSync(tmp); } catch { /* gone */ } }
    if (r.status !== 0) { console.error(`FAIL ${p.version} ${p.name}: ${(r.stderr || r.stdout).trim()}`); return 1; }
    console.log(`applied + recorded ${p.version} ${p.name}`);
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
