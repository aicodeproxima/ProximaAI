// Runs SQL on the ProximaAI database through the Supabase Management API: plain HTTPS from a shell, so no connector
// approval prompts (owner, 2026-10-22). Prints the result rows as JSON; the token is never printed.
//
//   node scripts/tools/sb-query.mjs "select count(*) from public.tasks"
//   node scripts/tools/sb-query.mjs -f some.sql
//   node scripts/tools/sb-query.mjs --write -f migration.sql     anything that changes data or schema needs --write
//
// Without --write the database runs the query in a read-only transaction: any write fails, including one hidden in a
// function call (review wf_ec400a67-988 #12). That transaction could switch itself to read-write, so SQL that tries is
// refused before it is sent (sql-guard.mjs, review round 2). Token: see accessToken() in supabase-admin.mjs.
import fs from "node:fs";
import { sql as runSql } from "./supabase-admin.mjs";
import { readOnlyEscape } from "./sql-guard.mjs";

const args = process.argv.slice(2);
const write = args.includes("--write");
const fi = args.indexOf("-f");
const sql = fi >= 0 ? fs.readFileSync(args[fi + 1], "utf8") : args.filter(a => !a.startsWith("--")).join(" ");
if (!sql.trim()) { console.error('usage: node scripts/tools/sb-query.mjs "<sql>" | -f file.sql [--write]'); process.exit(2); }

// process.exitCode, not process.exit(): exiting while fetch handles close trips a libuv assertion on Windows (exit 127).
const escape = !write && readOnlyEscape(sql);
if (escape) {
  console.error(`refused: "${escape}" would leave read-only mode (re-run with --write if the change is intended)`);
  process.exitCode = 3;
} else {
  try { console.log(JSON.stringify(await runSql(sql, { readOnly: !write }))); }
  catch (e) {
    const refused = !write && /read-only transaction|25006|42501/.test(e.message);
    console.error(e.message + (refused ? "\n(read-only: re-run with --write if the change is intended)" : ""));
    process.exitCode = refused ? 3 : 1;
  }
}
