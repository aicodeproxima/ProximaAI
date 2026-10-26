// Static check of the guards and lock limits of 20261025800000 and 20261025820000 and their rollbacks (P4 review rounds
// 9-12). The files are read the way PostgreSQL reads them (scripts/tools/sql-tx.mjs splitSql: comments, nested comments,
// '' / E'' strings and $tag$ bodies are set aside), so a statement inside a comment or a string is not a statement.
// Checked: each file's first statement sets a lock_timeout above 0 (0 = no limit) and under a browser call's 3 s, and
// nothing else changes it but the reset (SET, RESET and set_config() all count); the reset
// comes after every statement that can wait on a lock (only a rollback's own schema_migrations delete may follow it);
// a rollback takes its lock before reading any switch; 800000's forward guard covers every function it creates or
// replaces, its rollback restores exactly those, and the rollback's md5 guard and both references-guard lists name the
// same ten; every md5 refusal joins its comparisons with OR (an AND would check only one body).
// Pure: reads the four files. Run: node scripts/test-mu-p4-ab-guards.mjs [checkout] (part of npm test).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { splitSql } from "./tools/sql-tx.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.argv[2] || path.join(here, ".."));
const read = (p) => fs.readFileSync(path.join(root, p), "utf8").replace(/\r\n/g, "\n");
const files = {
  ab: read("supabase/migrations/20261025800000_mu_p4_auto_backups_per_account.sql"),
  abRb: read("supabase/rollback/20261025800000_mu_p4_auto_backups_per_account.rollback.sql"),
  lk: read("supabase/migrations/20261025820000_backups_hold_account_row.sql"),
  lkRb: read("supabase/rollback/20261025820000_backups_hold_account_row.rollback.sql"),
};
let fail = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} - ${what}`); if (!ok) fail++; };
// Top-level statements, lower-case and whitespace-collapsed (strings are '' and $-bodies $$ after splitSql).
const statements = (text) => splitSql(text).code.split(";").map((s) => s.replace(/\s+/g, " ").trim().toLowerCase()).filter(Boolean);
const LIMIT = /^set local lock_timeout = ''$/, RESET = "set local lock_timeout to default";
const RECORD = /^delete from supabase_migrations\.schema_migrations\b/;
const waits = (st) => /^(alter|create|drop|lock|do|revoke|grant|update|insert|delete)\b/.test(st) && !RECORD.test(st);

// The original text of a file's first statement, skipping blanks, line comments and (nested) block comments: the
// limit's value is read from there, never from a commented-out copy (review round 13).
const firstStatement = (t) => {
  let i = 0;
  for (;;) {
    while (i < t.length && /\s/.test(t[i])) i++;
    if (t.startsWith("--", i)) { const j = t.indexOf("\n", i); i = j < 0 ? t.length : j + 1; continue; }
    if (t.startsWith("/*", i)) {
      let d = 1, j = i + 2;
      while (j < t.length && d > 0) { if (t.startsWith("/*", j)) { d++; j += 2; } else if (t.startsWith("*/", j)) { d--; j += 2; } else j++; }
      i = j; continue;
    }
    break;
  }
  const end = t.indexOf(";", i);
  return t.slice(i, end < 0 ? t.length : end).replace(/\s+/g, " ").trim();
};
for (const [name, text] of Object.entries(files)) {
  const st = statements(text);
  // Every way of changing it at top level (SET [LOCAL | SESSION] lock_timeout, RESET lock_timeout / ALL, set_config()):
  // the limit and its reset only.
  const sets = st.filter((s) => /^set (local |session )?lock_timeout\b/.test(s) || /^reset (lock_timeout|all)\b/.test(s) ||
                                s.includes("set_config(")).length;
  const m = /^set local lock_timeout = '(\d+)s'$/i.exec(firstStatement(text));
  check(LIMIT.test(st[0] || "") && sets === 2 && m && Number(m[1]) > 0 && Number(m[1]) < 3,
        `${name}: its first statement sets lock_timeout above 0 and under 3 s (${m ? m[1] : "?"} s), and nothing else changes it but the reset`);
  const reset = st.indexOf(RESET), lastWait = st.reduce((i, s, k) => (waits(s) ? k : i), -1);
  check(reset > lastWait && st.slice(reset + 1).every((s) => RECORD.test(s)) && st.filter((s) => s === RESET).length === 1,
        `${name}: lock_timeout is reset once, after every statement that can wait (only its record delete follows)`);
}

// The rollback locks users before it reads any switch; the migration's ALTER comes before its seed read.
const rbSt = statements(files.abRb);
const lockAt = rbSt.indexOf("lock table proxima_auth.users in access exclusive mode");
check(lockAt > 0 && lockAt < rbSt.findIndex((s) => s.startsWith("insert into public.app_secrets")),
      "800000 rollback: locks proxima_auth.users (a top-level statement) before it reads any switch");
const abSt = statements(files.ab);
const alterAt = abSt.findIndex((s) => s.startsWith("alter table proxima_auth.users add column auto_backups"));
const seedAt = abSt.findIndex((s) => s.startsWith("update proxima_auth.users set auto_backups = coalesce("));
check(alterAt > 0 && seedAt > alterAt, "800000: the ALTER (which locks users) comes before the seed reads the global row");
for (const [name, st, ver] of [["800000 rollback", rbSt, "20261025800000"], ["820000 rollback", statements(files.lkRb), "20261025820000"]]) {
  check(/^delete from supabase_migrations\.schema_migrations where version = '' and name = ''$/.test(st[st.length - 1] || "") &&
        new RegExp(`^delete from supabase_migrations\\.schema_migrations where version = '${ver}'`, "m").test(name.startsWith("800000") ? files.abRb : files.lkRb),
        `${name}: its last statement removes its own migration record`);
}

// The guards, read from their DO bodies.
const block = (text, tag) => { const a = text.indexOf(`do $${tag}$`), b = text.indexOf(`end $${tag}$`); return a >= 0 && b > a ? text.slice(a, b) : ""; };
const md5Sigs = (text) => [...text.matchAll(/md5\(pg_get_functiondef\('([^']+)'::regprocedure\)\) <> '([0-9a-f]{32})'/g)];
const replaced = (text) => new Set([...splitSql(text).code.matchAll(/create (?:or replace )?function (public\.\w+)\(/gi)].map((x) => x[1]));
const same = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
const name = (sig) => sig.slice(0, sig.indexOf("("));
const noAndJoin = (t) => !/\band md5\(pg_get_functiondef\('[^']*'::regprocedure\)\) <>/.test(t);

const fwdG = block(files.ab, "guard"), fwd = md5Sigs(fwdG), fwdSigs = new Set(fwd.map((x) => x[1]));
check(fwd.length === 9 && fwdSigs.size === 9 && noAndJoin(fwdG), `800000 forward guard: 9 distinct bodies, OR-joined (${fwd.length})`);
check(same(new Set([...fwdSigs].map(name)), replaced(files.ab)), "800000 forward guard: every function it creates or replaces is guarded by name");
check(same(replaced(files.abRb), replaced(files.ab)), "800000 rollback restores exactly the functions it creates or replaces");
const g = block(files.abRb, "rbguard"), rbm = md5Sigs(g), ten = new Set(rbm.map((x) => x[1]));
check(rbm.length === 10 && ten.size === 10 && noAndJoin(g), `800000 rollback md5 guard: 10 distinct bodies, OR-joined (${rbm.length})`);
check([...fwdSigs].every((s) => ten.has(s)) && ten.has("public._auto_backups_on(text)"), "800000 rollback md5 guard: the forward 9 plus the one-account overload");
// Each "p.oid not in (...)" list, up to its matching parenthesis (the signatures inside carry their own).
const lists = [];
for (let i = g.indexOf("p.oid not in ("); i >= 0; i = g.indexOf("p.oid not in (", i + 1)) {
  let depth = 0, j = i + "p.oid not in ".length;
  for (; j < g.length; j++) { if (g[j] === "(") depth++; else if (g[j] === ")" && --depth === 0) break; }
  lists.push(new Set([...g.slice(i, j).matchAll(/'([^']+)'::regprocedure/g)].map((x) => x[1])));
}
check(lists.length === 2 && lists.every((l) => same(l, ten)), `800000 references guard: both lists name the same 10 (${lists.map((l) => l.size).join(", ")})`);
check(/prosrc ~\* 'auto_backups'/.test(g) && !/prosrc ~ 'auto_backups'/.test(g), "800000 references guard matches any case");
check(/from pg_depend d/.test(g) && /command ~\* ''auto_backups''/.test(g), "800000 references guard also checks column dependents and cron commands (any case)");
const lkG = block(files.lk, "guard"), lkF = md5Sigs(lkG);
check(lkF.length === 2 && noAndJoin(lkG), `820000 forward guard: both bodies it replaces, OR-joined (${lkF.length})`);
check(same(replaced(files.lk), replaced(files.lkRb)) && replaced(files.lk).size === 2, "820000 rollback restores exactly the two functions it replaces");
const lkRbG = block(files.lkRb, "rbguard"), lkR = md5Sigs(lkRbG);
check(lkR.length === 2 && noAndJoin(lkRbG), `820000 rollback md5 guard: both bodies, OR-joined (${lkR.length})`);
console.log(`${fail === 0 ? "ok" : "FAIL"}: ${fail} failed`);
process.exit(fail ? 1 : 0);
