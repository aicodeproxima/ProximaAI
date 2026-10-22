// Tests for scripts/tools/sql-guard.mjs: sb-query's read-only mode refuses SQL that would switch its own transaction
// to read-write (review round 2). Run: node scripts/test-sql-guard.mjs
import assert from "node:assert/strict";
import { readOnlyEscape } from "./tools/sql-guard.mjs";

let n = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", e.message.split("\n").filter(Boolean).slice(0, 4).join(" | ")); }
};

test("plain reads pass, DO bodies with begin/end pass, keywords in strings and comments do not count", () => {
  for (const q of [
    "select count(*) from public.tasks",
    "with x as (select 1) select * from x",
    "do $$ begin perform 1; end $$",
    "do $t$ declare r int; begin select 1 into r; end $t$;",
    "select 'begin; set role x' as w",
    "-- begin\nselect 1",
    "/* commit */ select 1",
    "select '--'; select 2",
    "select relname from pg_class where relname like '%end%'",
    "select current_user, current_setting('transaction_read_only') ro",
  ]) assert.equal(readOnlyEscape(q), null, q);
});

test("transaction control and read-only settings are refused, top-level or inside a DO body", () => {
  for (const q of [
    "set transaction read write; select 1",
    "commit; begin read write; select 1",
    "begin; select 1",
    "BEGIN READ WRITE",
    "start transaction read write",
    "set default_transaction_read_only = off",
    "select set_config('transaction_read_only', 'off', true)",
    "set session characteristics as transaction read write",
    "do $$ begin perform 1; commit; end $$",
    "  SET  ROLE postgres",
    "set local role postgres",
    "set session authorization postgres",
    "reset all",
    "select 1; rollback",
    "savepoint a",
    "/* x */ begin",
    "select '--'; set transaction read write",
    "select 1;\nend",
    "do $$ begin set default_transaction_read_only = off; end $$",
    "alter role supabase_read_only_user set default_transaction_read_only = off",
  ]) assert.ok(readOnlyEscape(q), q);
});

// Review round 3: escape strings (E'...\'...') and nested block comments put the scanner out of step with Postgres,
// so a transaction switch after them passed as "inside a string"; and harmless session settings were refused.
test("escape strings and nested comments are scanned as Postgres does", () => {
  for (const q of [
    "select E'\\''; set transaction read write; select 'x'",
    "select e'a\\'b'; commit; begin read write; select 1",
    "/* /* */ ' */ set transaction read write; -- '",
    "/* a /* b */ c */ commit",
  ]) assert.ok(readOnlyEscape(q), q);
  for (const q of ["select E'it\\'s'", "select 'E''x'", "/* /* nested */ still a comment */ select 1", "select name from e"]) assert.equal(readOnlyEscape(q), null, q);
});

test("harmless session settings pass; anything that could change the transaction mode does not", () => {
  for (const q of [
    "set statement_timeout = '5s'; select 1",
    "set local statement_timeout to 1000; select 1",
    "SET search_path = public, pg_catalog; select 1",
    "set session timezone = 'UTC'; select now()",
    "reset statement_timeout",
  ]) assert.equal(readOnlyEscape(q), null, q);
  for (const q of ["reset all", "set session characteristics as transaction read write", "reset role", "set work_mem = '64MB'; set transaction read write"])
    assert.ok(readOnlyEscape(q), q);
});

// Review round 4: `a$x$` is one identifier in Postgres, but the scanner opened a dollar-quote at its `$` and took the
// statements after it for a body.
test("a $ inside an identifier opens no dollar-quote; real dollar-quotes still do", () => {
  for (const q of ["select 1 as a$x$; end; begin read write; select 2", "select 1 as a$x$; abort; start transaction read write; select 2"])
    assert.ok(readOnlyEscape(q), q);
  for (const q of ["select 1 as a$x$", "select $tag$ end; begin $tag$ as s", "do $b$ begin perform 1; end $b$", "select $1"])
    assert.equal(readOnlyEscape(q), null, q);
  // A dollar-quoted string and a DO body look alike, so COMMIT inside either stays refused (fails closed).
  assert.ok(readOnlyEscape("select $tag$ commit $tag$ as s"));
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
