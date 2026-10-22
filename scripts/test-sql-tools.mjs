// Tests for the pure parts of scripts/tools/sql-tx.mjs and scripts/tools/apply-migration.mjs (no network).
// Run: node scripts/test-sql-tools.mjs
import assert from "node:assert/strict";
const { buildScript, parseResult, GUARD } = await import("./tools/sql-tx.mjs");
const { parseName, buildApplyScript } = await import("./tools/apply-migration.mjs");

let n = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", e.message.split("\n").filter(Boolean).slice(0, 4).join(" | ")); }
};
const wrap = msg => `SQL HTTP 400: ${JSON.stringify({ message: msg })}`;

test("buildScript: begin first, files in order, guard last", () => {
  const s = buildScript([{ name: "m1.sql", sql: "create table a();\n" }, { name: "m2.sql", sql: "create table b();" }, { name: "t.sql", sql: "do $t$ begin null; end $t$;" }]);
  assert.ok(s.startsWith("begin;"));
  assert.ok(s.trimEnd().endsWith(GUARD));
  const a = s.indexOf("table a"), b = s.indexOf("table b"), t = s.indexOf("do $t$");
  assert.ok(a > 0 && a < b && b < t && t < s.indexOf(GUARD));
});

test("parseResult: semicolon format with ok and FAIL", () => {
  const p = parseResult(wrap("Failed to run sql query: ERROR:  P0001: RESULT: ok one; FAIL two 42501 nope; ok three; \nCONTEXT: PL/pgSQL function inline_code_block line 9 at RAISE\n"));
  assert.equal(p.kind, "result");
  assert.deepEqual(p.cases.map(c => c.ok), [true, false, true]);
  assert.equal(p.pass, 2); assert.equal(p.fail, 1);
  assert.equal(p.cases[1].text, "FAIL two 42501 nope");
});

test("parseResult: all ok", () => {
  const p = parseResult(wrap("ERROR:  P0001: RESULT: ok a; ok b; ok c; "));
  assert.equal(p.kind, "result"); assert.equal(p.pass, 3); assert.equal(p.fail, 0);
});

test("parseResult: RLS ' | ' format", () => {
  const p = parseResult(wrap("ERROR:  P0001: RESULT: 2 PASS, 1 FAIL :: PASS reads own rows | FAIL writes other scope | PASS anon refused\nCONTEXT: x"));
  assert.equal(p.kind, "result");
  assert.deepEqual(p.cases.map(c => c.ok), [true, false, true]);
  assert.equal(p.fail, 1); assert.equal(p.pass, 2);
});

test("parseResult: RLS stated FAIL count wins over a cut-off list", () => {
  const p = parseResult(wrap("ERROR:  P0001: RESULT: 1 PASS, 2 FAIL :: PASS a"));
  assert.equal(p.fail, 2);
});

test("parseResult: SQLTX_ROLLBACK means the test raised nothing", () => {
  const p = parseResult(wrap("ERROR:  P0001: SQLTX_ROLLBACK\nCONTEXT: PL/pgSQL function inline_code_block line 1 at RAISE\n"));
  assert.equal(p.kind, "rollback"); assert.equal(p.fail, 1);
});

test("parseResult: another error is reported as an error", () => {
  const p = parseResult(wrap('ERROR:  42883: function public.nope() does not exist'));
  assert.equal(p.kind, "error"); assert.match(p.message, /does not exist/); assert.equal(p.fail, 1);
});

test("parseResult: body cut at 2000 chars is flagged truncated and still parsed", () => {
  const msg = "ERROR:  P0001: RESULT: " + Array.from({ length: 200 }, (_, i) => `ok case-${i}`).join("; ");
  const text = ("SQL HTTP 400: " + JSON.stringify({ message: msg })).slice(0, "SQL HTTP 400: ".length + 2000);
  const p = parseResult(text);
  assert.equal(p.kind, "result"); assert.equal(p.truncated, true); assert.ok(p.pass > 10);
});

test("parseName: valid and invalid names", () => {
  assert.deepEqual(parseName("supabase/migrations/20261022302000_upsert_queued_history.sql"), { version: "20261022302000", name: "upsert_queued_history" });
  assert.equal(parseName("2026102230200_short.sql"), null);
  assert.equal(parseName("20261022302000_bad-name.sql"), null);
  assert.equal(parseName("20261022302000_x.txt"), null);
  assert.equal(parseName("upsert.sql"), null);
});

test("buildApplyScript: runs the sql then records version, name and text", () => {
  const s = buildApplyScript("create table a();\n", { version: "20261022302000", name: "x_y" });
  assert.ok(s.startsWith("create table a();"));
  assert.match(s, /insert into supabase_migrations\.schema_migrations \(version, name, statements\) values \('20261022302000', 'x_y', array\[\$mig\$create table a\(\);\n\$mig\$\]\);/);
});

test("buildApplyScript: refuses $mig$", () => {
  assert.throws(() => buildApplyScript("select $mig$x$mig$;", { version: "20261022302000", name: "x" }), /\$mig\$/);
});

// Found along the way (round 10): supabase-admin.mjs cut a failed query's text at 2000 characters, so a long RESULT
// (test-queued-deletes-db.sql has 21 cases) lost its later cases. A test's RESULT must reach the caller whole.
{
  process.env.SUPABASE_ACCESS_TOKEN = "test-token-not-real";
  const realFetch = globalThis.fetch;
  const long = "RESULT: " + Array.from({ length: 400 }, (_, i) => `ok case-${i}`).join("; ");
  globalThis.fetch = async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ message: long }) });
  try {
    const { sql } = await import("./tools/supabase-admin.mjs");
    let msg = "";
    try { await sql("select 1"); } catch (e) { msg = e.message; }
    assert.ok(msg.includes("ok case-399"), "the whole RESULT survives");
    n++; console.log("ok - supabase-admin sql(): a long error text reaches the caller whole");
  } catch (e) { failed++; console.log("FAIL - supabase-admin sql(): a long error text reaches the caller whole\n   ", e.message.split("\n")[0]); }
  finally { globalThis.fetch = realFetch; delete process.env.SUPABASE_ACCESS_TOKEN; }
}

console.log(`\n${n} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
