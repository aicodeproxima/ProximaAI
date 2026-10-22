// Queries ProximaAI's Supabase logs (edge_logs, postgres_logs, …) through the Supabase Management API: plain HTTPS from
// a shell, so no connector approval prompts (owner, 2026-10-22). Metadata only — never select request bodies.
// SQL dialect = the logs explorer's (ClickHouse-style): `from logs where source = 'edge_logs'`, fields via
// log_attributes['request.path'], ['request.method'], ['response.status_code'], ['request.headers.user_agent'],
// ['request.headers.x_client_info'] (carries the client's "proxima-rls/1 sess/1|0" marker since the RLS rollout).
// The window is at most 24 h (the API caps it).
//
//   node scripts/tools/sb-logs.mjs 2026-10-22T14:00:00Z 2026-10-22T16:00:00Z "select count(*) as n from logs where source = 'edge_logs'"
//   node scripts/tools/sb-logs.mjs <startISO> <endISO> -f query.sql
//
// Token: env SUPABASE_ACCESS_TOKEN, else the sbp_ personal access token in the owner's Claude memory
// (~/.claude/projects/C--Users-aicod--claude/memory/reference_supabase.md).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REF = "vhznmpxlcjbdzntmfvvy";
const [start, end, ...rest] = process.argv.slice(2);
const fi = rest.indexOf("-f");
const sql = fi >= 0 ? fs.readFileSync(rest[fi + 1], "utf8") : rest.join(" ");
if (!start || !end || !sql.trim()) { console.error('usage: node scripts/tools/sb-logs.mjs <startISO> <endISO> "<sql>" | -f file.sql'); process.exit(2); }

function token() {
  if (process.env.SUPABASE_ACCESS_TOKEN) return process.env.SUPABASE_ACCESS_TOKEN.trim();
  const mem = path.join(os.homedir(), ".claude/projects/C--Users-aicod--claude/memory/reference_supabase.md");
  const t = fs.readFileSync(mem, "utf8").match(/sbp_[A-Za-z0-9]{20,}/)?.[0];
  if (!t) throw new Error("no sbp_ token in " + mem);
  return t;
}

const u = new URL(`https://api.supabase.com/v1/projects/${REF}/analytics/endpoints/logs`);
u.searchParams.set("sql", sql);
u.searchParams.set("iso_timestamp_start", start);
u.searchParams.set("iso_timestamp_end", end);
const r = await fetch(u, { headers: { Authorization: `Bearer ${token()}` } });
const text = await r.text();
if (!r.ok) { console.error(`HTTP ${r.status}: ${text.slice(0, 2000)}`); process.exitCode = 1; }
else console.log(text);
