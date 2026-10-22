// Runs SQL on the ProximaAI database through the Supabase Management API: plain HTTPS from a shell, so no connector
// approval prompts (owner, 2026-10-22). Prints the result rows as JSON; the token is never printed.
//
//   node scripts/tools/sb-query.mjs "select count(*) from public.tasks"
//   node scripts/tools/sb-query.mjs -f some.sql
//   node scripts/tools/sb-query.mjs --write -f migration.sql     anything that changes data or schema needs --write
//
// Token: env SUPABASE_ACCESS_TOKEN, else the sbp_ personal access token in the owner's Claude memory
// (~/.claude/projects/C--Users-aicod--claude/memory/reference_supabase.md).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REF = "vhznmpxlcjbdzntmfvvy";
const args = process.argv.slice(2);
const write = args.includes("--write");
const fi = args.indexOf("-f");
const sql = fi >= 0 ? fs.readFileSync(args[fi + 1], "utf8") : args.filter(a => !a.startsWith("--")).join(" ");
if (!sql.trim()) { console.error('usage: node scripts/tools/sb-query.mjs "<sql>" | -f file.sql [--write]'); process.exit(2); }

// Read-only unless --write: a crude keyword check, enough to stop an accidental change from a read-only caller.
const code = sql.replace(/--[^\n]*/g, " ").replace(/'(?:[^']|'')*'/g, "''");
if (!write && /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|comment|vacuum|call|do|copy|merge|reindex|cluster|lock|set\s+role)\b/i.test(code)) {
  console.error("Refused: this SQL changes data or schema. Re-run with --write if that is intended.");
  process.exit(3);
}

function token() {
  if (process.env.SUPABASE_ACCESS_TOKEN) return process.env.SUPABASE_ACCESS_TOKEN.trim();
  const mem = path.join(os.homedir(), ".claude/projects/C--Users-aicod--claude/memory/reference_supabase.md");
  const t = fs.readFileSync(mem, "utf8").match(/sbp_[A-Za-z0-9]{20,}/)?.[0];
  if (!t) throw new Error("no sbp_ token in " + mem);
  return t;
}

const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: sql }),
});
const text = await r.text();
if (!r.ok) { console.error(`HTTP ${r.status}: ${text.slice(0, 2000)}`); process.exit(1); }
console.log(text);
