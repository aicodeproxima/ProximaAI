// Applies migration files to the live database and records each in supabase_migrations.schema_migrations, one
// transaction per file (sb-query.mjs --write -f; credentials live there). Run --dry-run first: it writes nothing.
//
//   node scripts/tools/apply-migration.mjs supabase/migrations/<14 digits>_<name>.sql ... [--dry-run]
//
// Refuses a file whose version is already recorded, a file not named <14 digits>_<name>.sql, and a file that
// contains $mig$ (the dollar quote used to record its text). Stops at the first failure.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SB_QUERY = path.join(path.dirname(fileURLToPath(import.meta.url)), "sb-query.mjs");

export function parseName(file) {
  const m = /^(\d{14})_([A-Za-z0-9_]+)\.sql$/.exec(path.basename(String(file)));
  return m ? { version: m[1], name: m[2] } : null;
}

export function buildApplyScript(sql, { version, name }) {
  if (sql.includes("$mig$")) throw new Error("the migration contains $mig$; cannot record its text");
  if (!/^\d{14}$/.test(version) || !/^[A-Za-z0-9_]+$/.test(name)) throw new Error("bad version or name");
  return `${sql.replace(/\s+$/, "")}\n\ninsert into supabase_migrations.schema_migrations (version, name, statements) ` +
    `values ('${version}', '${name}', array[$mig$${sql}$mig$]);\n`;
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

// Read-only (sb-query without --write).
async function isRecorded(version) {
  const r = await sbQuery([`select version from supabase_migrations.schema_migrations where version = '${version}'`]);
  if (r.status !== 0) throw new Error(`lookup failed: ${(r.stderr || r.stdout).trim()}`);
  return JSON.parse(r.stdout.trim()).length > 0;
}

async function main(argv) {
  const dry = argv.includes("--dry-run");
  const files = argv.filter(a => !a.startsWith("--"));
  if (!files.length) { console.error("usage: node scripts/tools/apply-migration.mjs <migration.sql> ... [--dry-run]"); return 2; }
  const plan = [];
  for (const f of files) {
    const id = parseName(f);
    if (!id) { console.error(`refused: ${f} is not named <14 digits>_<name>.sql`); return 2; }
    let sql;
    try { sql = fs.readFileSync(f, "utf8"); } catch (e) { console.error(`cannot read ${f}: ${e.message}`); return 2; }
    if (sql.includes("$mig$")) { console.error(`refused: ${f} contains $mig$`); return 2; }
    plan.push({ f, sql, ...id });
  }
  for (const p of plan) {
    const recorded = await isRecorded(p.version);
    if (dry) {
      console.log(`${p.version} ${p.name} ${Buffer.byteLength(p.sql)} bytes -- ${recorded ? "already recorded" : "not recorded (would apply)"}`);
      continue;
    }
    if (recorded) { console.error(`refused: ${p.version} ${p.name} is already recorded`); return 1; }
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
