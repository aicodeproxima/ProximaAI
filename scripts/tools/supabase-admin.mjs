// Shared by the scripts in scripts/tools: the owner's Supabase access token, SQL through the Management API, and the
// project's server key fetched at run time. Nothing here prints a token or a key.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const REF = "vhznmpxlcjbdzntmfvvy";
export const PROJECT_URL = `https://${REF}.supabase.co`;

// env SUPABASE_ACCESS_TOKEN, else the sbp_ personal access token in the owner's Claude memory.
export function accessToken() {
  if (process.env.SUPABASE_ACCESS_TOKEN) return process.env.SUPABASE_ACCESS_TOKEN.trim();
  const mem = path.join(os.homedir(), ".claude/projects/C--Users-aicod--claude/memory/reference_supabase.md");
  const t = fs.readFileSync(mem, "utf8").match(/sbp_[A-Za-z0-9]{20,}/)?.[0];
  if (!t) throw new Error("no sbp_ token in " + mem);
  return t;
}

// A failed query's text is kept up to this length: a SQL test reports through its error (RESULT: ...), and 2000 cut off
// the later cases of a long suite (found in review round 10).
const ERROR_TEXT_MAX = 20000;

// Runs SQL as the database owner; returns the parsed rows (throws on an HTTP error). `readOnly`: the database runs it in
// a read-only transaction, so any write (a statement or a function that writes) fails with 25006.
export async function sql(query, { readOnly = false } = {}) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, read_only: readOnly }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`SQL HTTP ${r.status}: ${text.slice(0, ERROR_TEXT_MAX)}`);
  return JSON.parse(text);
}

// The project's server key (the new secret key, else the legacy service_role), read live so a rotation never breaks
// the scripts. It bypasses the row policies: use it only for owner-run maintenance, and never print it.
export async function serverKey() {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/api-keys?reveal=true`, { headers: { Authorization: `Bearer ${accessToken()}` } });
  if (!r.ok) throw new Error(`api-keys HTTP ${r.status}`);
  const keys = await r.json();
  const k = keys.find(x => x.type === "secret" && x.api_key) || keys.find(x => x.name === "service_role" && x.api_key);
  if (!k) throw new Error("no server key returned");
  return k.api_key;
}
