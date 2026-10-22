// Runs SQL on the ProximaAI database through the Supabase Management API: plain HTTPS from a shell, so no connector
// approval prompts (owner, 2026-10-22). Prints the result rows as JSON; the token is never printed.
//
//   node scripts/tools/sb-query.mjs "select count(*) from public.tasks"
//   node scripts/tools/sb-query.mjs -f some.sql
//   node scripts/tools/sb-query.mjs --write -f migration.sql     anything that changes data or schema needs --write
//
// Token: see accessToken() in supabase-admin.mjs.
import fs from "node:fs";
import { sql as runSql } from "./supabase-admin.mjs";

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

try { console.log(JSON.stringify(await runSql(sql))); }
catch (e) { console.error(e.message); process.exit(1); }
