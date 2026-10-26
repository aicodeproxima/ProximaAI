// Runs a database test, optionally on top of migrations that are not applied yet, in ONE transaction that always
// rolls back. Replaces the hand-built "begin; + migration + test" routine of each review round.
//
//   node scripts/tools/sql-tx.mjs --test scripts/test-public-execute-db.sql
//   node scripts/tools/sql-tx.mjs supabase/migrations/<v>_<name>.sql ... --test scripts/test-paths-in-use-db.sql
//
// The script sent is "begin;" + each migration + the test + a guard block that raises SQLTX_ROLLBACK, so nothing
// persists even when a test forgets its closing raise. It runs through sb-query.mjs --write (credentials live there).
// Output: one line per case, then a summary. Exit 0 only for a RESULT with zero FAIL; 1 otherwise; 2 for bad usage.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const GUARD = "do $sqltx$ begin raise exception 'SQLTX_ROLLBACK'; end $sqltx$;";
const SB_QUERY = path.join(path.dirname(fileURLToPath(import.meta.url)), "sb-query.mjs");

// Splits SQL into top-level code (comments dropped, string literals and identifiers blanked, dollar-quoted bodies
// replaced by " $$ ") and the dollar-quoted bodies. Same reading as sql-guard.mjs scan() (not exported there):
// nested block comments, E'..' backslash escapes, no dollar-quote opened inside an identifier.
// open: null, or "comment" / "quote" / "dollar" when the text ends inside one (round 14 T4c).
export function splitSql(sql) {
  let code = "", i = 0, open = null;
  const bodies = [];
  while (i < sql.length) {
    const c = sql[i], two = sql.slice(i, i + 2);
    if (two === "--") { const j = sql.indexOf("\n", i); i = j < 0 ? sql.length : j; continue; }
    if (two === "/*") {
      let depth = 1, j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql.startsWith("/*", j)) { depth++; j += 2; } else if (sql.startsWith("*/", j)) { depth--; j += 2; } else j++;
      }
      if (depth > 0) open = "comment";
      i = j; code += " "; continue;
    }
    if (c === "'" || c === '"') {
      const escapes = c === "'" && /[e]$/i.test(code) && !/[a-z0-9_$\u0080-￿]$/i.test(code.slice(0, -1));
      let j = i + 1;
      while (j < sql.length) {
        if (escapes && sql[j] === "\\") { j += 2; continue; }
        if (sql[j] === c) { if (sql[j + 1] === c) { j += 2; continue; } break; }
        j++;
      }
      if (j >= sql.length) open = "quote";
      i = j + 1; code += ` ${c}${c} `; continue;
    }
    const tag = c === "$" && !/[a-z0-9_$\u0080-￿]/i.test(sql[i - 1] || "")
      && /^\$([a-z_\u0080-￿][a-z0-9_\u0080-￿]*)?\$/i.exec(sql.slice(i));
    if (tag) {
      const end = sql.indexOf(tag[0], i + tag[0].length);
      if (end < 0) open = "dollar";
      bodies.push(sql.slice(i + tag[0].length, end < 0 ? sql.length : end));
      i = end < 0 ? sql.length : end + tag[0].length; code += " $$ "; continue;
    }
    code += c; i++;
  }
  return { code, bodies, open };
}

// Statements that would end sql-tx's always-abort transaction early and so commit what came before (round 11 R2).
// SAVEPOINT, RELEASE and ROLLBACK TO keep the transaction open and are allowed. PREPARE TRANSACTION ends the block too
// (round 14 T4b); COMMIT/ROLLBACK PREPARED start with commit/rollback.
const TOP_TX = /^(begin|start\s+transaction|prepare\s+transaction|commit|end|rollback(?!\s+(work\s+|transaction\s+)?to\b)|abort)\b/;

// Round 14 T4a: a SQL-standard body opens only after a CREATE [OR REPLACE] FUNCTION|PROCEDURE header; a view column
// alias or a table column named "begin atomic" does not open it. Round 15 S6b: "begin atomic" must sit at parenthesis
// depth 0 after the parameter list has closed, so a parameter or a RETURNS TABLE (...) column named begin of type
// atomic (even after a typmod such as numeric(10)) does not open it either. t is lower-cased top-level code.
const ROUTINE_HEAD = /^create (or replace )?(function|procedure)\b/;
export function opensAtomicBody(t) {
  if (!ROUTINE_HEAD.test(t)) return false;
  let depth = 0, closedParams = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === "(") depth++;
    else if (c === ")") { depth = Math.max(0, depth - 1); if (depth === 0) closedParams = true; }
    else if (depth === 0 && closedParams && t.startsWith("begin atomic", i)
      && !/[a-z0-9_$]/.test(t[i - 1] || "") && !/[a-z0-9_$]/.test(t[i + 12] || "")) return true;
  }
  return false;
}

// Returns the first top-level transaction-control statement in sql ("commit", "end", ...) or null.
// Dollar-quoted bodies are not scanned (round 12 F2/F6): PostgreSQL refuses transaction control inside DO blocks and
// procedures when they run inside a transaction block ("invalid transaction termination"), and sql-tx always opens one
// with "begin;", so a body COMMIT cannot commit. Scanning them only refused valid SQL (commit/rollback words inside
// dollar-quoted literals such as comment on ... is $c$...$c$).
// A SQL-standard function body "begin atomic ... end" is part of its CREATE statement: the top-level "end" that closes
// a preceding "begin atomic" is not transaction control. Round 13 B1: the exemption opens only for a segment that
// starts with CREATE, contains "begin atomic" and is not already closed in that segment (an empty body
// "begin atomic end"); it covers the body's statements and ends at the first segment that is just "end". Any other
// top-level "end" (it COMMITS) is refused. Round 14 T4a narrowed the CREATE to a FUNCTION/PROCEDURE header.
export function transactionControl(sql) {
  // Round 15 S6a: split the original text (dollar tags compare case-sensitively, as in PostgreSQL), then lower-case
  // only the top-level code for keyword matching.
  const code = splitSql(String(sql || "")).code.toLowerCase();
  let atomic = false;
  for (const s of code.split(";")) {
    const t = s.trim().replace(/\s+/g, " ");
    if (atomic && t === "end") { atomic = false; continue; }
    const m = t.match(TOP_TX);
    if (m) return m[0];
    if (!atomic && opensAtomicBody(t) && !/\bbegin atomic end$/.test(t)) atomic = true;
  }
  return null;
}

// files: [{ name, sql }] in run order (migrations first, test last). joinFiles is the part between "begin;" and GUARD.
export function joinFiles(files) {
  return files.map(f => `-- sql-tx: ${f.name}\n${f.sql.replace(/\s+$/, "")}`).join("\n\n");
}

export function buildScript(files) {
  return ["begin;", joinFiles(files), GUARD].join("\n\n") + "\n";
}

// Returns a refusal message or null. Round 14 T4c: the files run concatenated, so a file must not end inside a
// comment, a quote or a dollar body (it would swallow the next file's start), and the concatenated body is scanned
// exactly as buildScript joins it.
export function checkFiles(files) {
  for (const f of files) {
    const { open } = splitSql(f.sql);
    if (open) return `refused: ${f.name} ends inside a ${open}; it would run into the next file`;
  }
  for (const f of files) {
    const tc = transactionControl(f.sql);
    if (tc) return `refused: ${f.name} has transaction control "${tc}"; it would end the always-abort transaction and commit`;
  }
  const tc = transactionControl(joinFiles(files));
  if (tc) return `refused: the joined files have transaction control "${tc}"; it would end the always-abort transaction and commit`;
  return null;
}

// sb-query wraps errors as "SQL HTTP <status>: <body, cut at 2000 chars>", the body being JSON {"message": "..."}.
function errorMessage(text) {
  const m = /SQL HTTP \d+: ([\s\S]*)$/.exec(text);
  const body = (m ? m[1] : text).trim();
  try { const j = JSON.parse(body); if (typeof j?.message === "string") return { msg: j.message, truncated: false }; } catch { /* cut short */ }
  const raw = body.replace(/^\{"message":"/, "").replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  return { msg: raw, truncated: !!m && m[1].length >= 2000 };
}

// Returns { kind: "result" | "rollback" | "error", cases: [{ ok, text }], fail, pass, truncated, message }.
export function parseResult(text) {
  const { msg, truncated } = errorMessage(String(text || ""));
  const r = /RESULT: ([\s\S]*?)(?:\nCONTEXT:|\n?$)/.exec(msg);
  if (r) {
    let payload = r[1].trim(), cases;
    const rls = /^(\d+) PASS, (\d+) FAIL :: ([\s\S]*)$/.exec(payload);
    if (rls) {
      cases = rls[3].split(" | ").map(s => s.trim()).filter(Boolean).map(s => ({ ok: /^PASS\b/.test(s), text: s }));
    } else {
      cases = payload.split(";").map(s => s.trim()).filter(Boolean).map(s => ({ ok: /^ok\b/.test(s), text: s }));
    }
    let fail = cases.filter(c => !c.ok).length;
    const pass = cases.length - fail;
    if (rls && Number(rls[2]) > fail) fail = Number(rls[2]);   // a cut-off list still reports its stated FAIL count
    return { kind: "result", cases, pass, fail, truncated, message: msg };
  }
  if (/SQLTX_ROLLBACK/.test(msg)) return { kind: "rollback", cases: [], pass: 0, fail: 1, truncated, message: msg };
  return { kind: "error", cases: [], pass: 0, fail: 1, truncated, message: msg.trim() };
}

async function runSbQuery(args) {
  for (let attempt = 0; ; attempt++) {
    const r = spawnSync(process.execPath, [SB_QUERY, ...args], { encoding: "utf8" });
    const out = (r.stdout || "") + (r.stderr || "");
    if (!/fetch failed/.test(out) || attempt >= 2) return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
    console.error(`sb-query: fetch failed, retrying in 10 s (${attempt + 1}/2)`);
    await new Promise(res => setTimeout(res, 10000));
  }
}

export const USAGE = "usage: node scripts/tools/sql-tx.mjs [migration.sql ...] --test <test.sql>";

// Tokens, codes and keys are never printed (owner rule). A failing case may print an RPC's raw reply (a session token,
// an invite or backup code: fixtures of a rolled-back transaction, but still secrets); every line main() prints goes
// through this. JSON values under secret-looking keys, both token shapes, Supabase/WaveSpeed keys and JWTs are masked.
const SECRET_KEYS = /("(?:token|backup_code|code|password|new_password|secret|key|api_key)"\s*:\s*)"[^"]*"/gi;
export function maskSecrets(text) {
  return String(text)
    .replace(SECRET_KEYS, '$1"<hidden>"')
    .replace(/\b[\w:-]+\.\d{9,11}\.[0-9a-f]{16,}\b/gi, "<token>")
    .replace(/\bsb_secret_[A-Za-z0-9_-]+/g, "sb_secret_<hidden>")
    .replace(/\bwsk_[A-Za-z0-9_]+/g, "wsk_<hidden>")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "<jwt>");
}

// Throws on a flag other than --test, a missing or repeated --test, or a --test with no file after it.
export function parseArgs(argv) {
  const migrations = [];
  let test = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--test") {
      if (test !== null) throw new Error("--test given twice");
      const next = argv[i + 1];
      if (!next || next.startsWith("-")) throw new Error("--test needs a file");
      test = next; i++;
    } else if (a.startsWith("-")) throw new Error(`unknown flag ${a}`);
    else migrations.push(a);
  }
  if (!test) throw new Error("no --test file given");
  return { migrations, test };
}

async function main(argv) {
  const say = (s) => console.log(maskSecrets(String(s)));
  const sayErr = (s) => console.error(maskSecrets(String(s)));
  let args;
  try { args = parseArgs(argv); } catch (e) { sayErr(`${e.message}\n${USAGE}`); return 2; }
  const { migrations, test } = args;
  const files = [];
  for (const f of [...migrations, test]) {
    try { files.push({ name: f, sql: fs.readFileSync(f, "utf8") }); }
    catch (e) { sayErr(`cannot read ${f}: ${e.message}`); return 2; }
  }
  const refusal = checkFiles(files);
  if (refusal) { sayErr(refusal); return 2; }
  const tmp = path.join(os.tmpdir(), `sql-tx-${process.pid}-${Date.now()}.sql`);
  fs.writeFileSync(tmp, buildScript(files));
  let r;
  try { r = await runSbQuery(["--write", "-f", tmp]); } finally { try { fs.unlinkSync(tmp); } catch { /* gone */ } }
  if (r.status === 0) {
    say("FAIL - the transaction did not raise (the guard should always abort it)");
    say(r.stdout.trim());
    return 1;
  }
  const p = parseResult(r.stderr || r.stdout);
  if (p.kind === "result") {
    for (const c of p.cases) say(`${c.ok ? "ok  " : "FAIL"} - ${c.text.replace(/^(ok|PASS|FAIL)\s*/, "")}`);
    if (p.truncated) say("NOTE - sb-query cut the error text at 2000 chars; later cases are missing");
    say(`${p.pass} ok, ${p.fail} FAIL${p.truncated ? " (truncated)" : ""} -- ${test}`);
    return p.fail === 0 && !p.truncated ? 0 : 1;
  }
  if (p.kind === "rollback") { say(`FAIL - ${test} raised no RESULT (stopped at the SQLTX_ROLLBACK guard)`); return 1; }
  say(`FAIL - error before RESULT:\n${p.message}`);
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
