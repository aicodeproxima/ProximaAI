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
export function splitSql(sql) {
  let code = "", i = 0;
  const bodies = [];
  while (i < sql.length) {
    const c = sql[i], two = sql.slice(i, i + 2);
    if (two === "--") { const j = sql.indexOf("\n", i); i = j < 0 ? sql.length : j; continue; }
    if (two === "/*") {
      let depth = 1, j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql.startsWith("/*", j)) { depth++; j += 2; } else if (sql.startsWith("*/", j)) { depth--; j += 2; } else j++;
      }
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
      i = j + 1; code += ` ${c}${c} `; continue;
    }
    const tag = c === "$" && !/[a-z0-9_$\u0080-￿]/i.test(sql[i - 1] || "")
      && /^\$([a-z_\u0080-￿][a-z0-9_\u0080-￿]*)?\$/i.exec(sql.slice(i));
    if (tag) {
      const end = sql.indexOf(tag[0], i + tag[0].length);
      bodies.push(sql.slice(i + tag[0].length, end < 0 ? sql.length : end));
      i = end < 0 ? sql.length : end + tag[0].length; code += " $$ "; continue;
    }
    code += c; i++;
  }
  return { code, bodies };
}

// Statements that would end sql-tx's always-abort transaction early and so commit what came before (round 11 R2).
// SAVEPOINT, RELEASE and ROLLBACK TO keep the transaction open and are allowed.
const TOP_TX = /^(begin|start\s+transaction|commit|end|rollback(?!\s+(work\s+|transaction\s+)?to\b)|abort)\b/;

// Returns the first top-level transaction-control statement in sql ("commit", "end", ...) or null.
// Dollar-quoted bodies are not scanned (round 12 F2/F6): PostgreSQL refuses transaction control inside DO blocks and
// procedures when they run inside a transaction block ("invalid transaction termination"), and sql-tx always opens one
// with "begin;", so a body COMMIT cannot commit. Scanning them only refused valid SQL (commit/rollback words inside
// dollar-quoted literals such as comment on ... is $c$...$c$).
// A SQL-standard function body "begin atomic ... end" is part of its CREATE statement: the top-level "end" that closes
// a preceding "begin atomic" is not transaction control.
export function transactionControl(sql) {
  const { code } = splitSql(String(sql || "").toLowerCase());
  let atomic = false;
  for (const s of code.split(";")) {
    const t = s.trim();
    if (atomic && /^end\b/.test(t)) { atomic = false; continue; }
    const m = t.match(TOP_TX);
    if (m) return m[0].replace(/\s+/g, " ");
    if (/\bbegin\s+atomic\b/.test(t)) atomic = true;
  }
  return null;
}

// files: [{ name, sql }] in run order (migrations first, test last).
export function buildScript(files) {
  const parts = ["begin;"];
  for (const f of files) parts.push(`-- sql-tx: ${f.name}\n${f.sql.replace(/\s+$/, "")}`);
  parts.push(GUARD);
  return parts.join("\n\n") + "\n";
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
  let args;
  try { args = parseArgs(argv); } catch (e) { console.error(`${e.message}\n${USAGE}`); return 2; }
  const { migrations, test } = args;
  const files = [];
  for (const f of [...migrations, test]) {
    try { files.push({ name: f, sql: fs.readFileSync(f, "utf8") }); }
    catch (e) { console.error(`cannot read ${f}: ${e.message}`); return 2; }
  }
  for (const f of files) {
    const tc = transactionControl(f.sql);
    if (tc) { console.error(`refused: ${f.name} has transaction control "${tc}"; it would end the always-abort transaction and commit`); return 2; }
  }
  const tmp = path.join(os.tmpdir(), `sql-tx-${process.pid}-${Date.now()}.sql`);
  fs.writeFileSync(tmp, buildScript(files));
  let r;
  try { r = await runSbQuery(["--write", "-f", tmp]); } finally { try { fs.unlinkSync(tmp); } catch { /* gone */ } }
  if (r.status === 0) {
    console.log("FAIL - the transaction did not raise (the guard should always abort it)");
    console.log(r.stdout.trim());
    return 1;
  }
  const p = parseResult(r.stderr || r.stdout);
  if (p.kind === "result") {
    for (const c of p.cases) console.log(`${c.ok ? "ok  " : "FAIL"} - ${c.text.replace(/^(ok|PASS|FAIL)\s*/, "")}`);
    if (p.truncated) console.log("NOTE - sb-query cut the error text at 2000 chars; later cases are missing");
    console.log(`${p.pass} ok, ${p.fail} FAIL${p.truncated ? " (truncated)" : ""} -- ${test}`);
    return p.fail === 0 && !p.truncated ? 0 : 1;
  }
  if (p.kind === "rollback") { console.log(`FAIL - ${test} raised no RESULT (stopped at the SQLTX_ROLLBACK guard)`); return 1; }
  console.log(`FAIL - error before RESULT:\n${p.message}`);
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
