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

// Found along the way (round 11): a file using $mig$ itself (20261022120000_rls_session_header.sql) was refused, so the
// tool could neither apply nor classify it. The recorded text is quoted with a tag the file does not contain.
test("buildApplyScript: quotes the recorded text with a tag the file does not use", () => {
  const sql = "do $mig$ begin null; end $mig$; select $mig0$x$mig0$;\n";
  const s = buildApplyScript(sql, { version: "20261022302000", name: "x" });
  assert.ok(s.includes("array[$mig1$" + sql + "$mig1$]"), "first free tag");
  assert.ok(s.startsWith("do $mig$ begin null; end $mig$;"));
});

// Round 11 R1: a file counts as recorded by version OR name; older unrecorded files are refused unless --allow-old.
const { planApply, isRefusal, parseArgs: parseApplyArgs } = await import("./tools/apply-migration.mjs");
const { transactionControl, parseArgs: parseTxArgs } = await import("./tools/sql-tx.mjs");
const rows = [
  { version: "20261020145422", name: "sync_tombstones" },
  { version: "20261022300000", name: "newest_one" },
];
const f = (version, name) => ({ version, name });

test("planApply: recorded by name under another version (old tool's versions)", () => {
  const [p] = planApply([f("20261020000001", "sync_tombstones")], rows);
  assert.equal(p.action, "recorded"); assert.equal(p.by, "name");
  assert.deepEqual(p.as, { version: "20261020145422", name: "sync_tombstones" });
});

test("planApply: recorded by version (same version, same name)", () => {
  const [p] = planApply([f("20261022300000", "newest_one")], rows);
  assert.equal(p.action, "recorded"); assert.equal(p.by, "version");
});

// Round 12 F3: a NEW file reusing a recorded version or a recorded name was counted as recorded and skipped (exit 0).
test("planApply: a recorded version with a different name is a version-clash", () => {
  const [p] = planApply([f("20261022300000", "renamed_file")], rows);
  assert.equal(p.action, "version-clash");
  assert.equal(p.reason, "version-clash: 20261022300000 is already recorded as newest_one; renumber the file");
});

test("planApply: a recorded name under a newer unrecorded version is a name-clash", () => {
  const [p] = planApply([f("20261023000000", "sync_tombstones")], rows);
  assert.equal(p.action, "name-clash");
  assert.equal(p.reason, "name-clash: sync_tombstones is already recorded as 20261020145422; rename the file");
  assert.equal(planApply([f("20261022300000", "sync_tombstones")], rows)[0].action, "version-clash");
});

test("planApply: isRefusal marks every refusal; recorded and apply are not refusals", () => {
  const plan = planApply([f("20261022300000", "x"), f("20261023000000", "sync_tombstones"), f("20261021000000", "y"),
    f("20261022300000", "newest_one"), f("20261023100000", "z")], rows);
  assert.deepEqual(plan.map(x => x.action), ["refused-old", "version-clash", "recorded", "name-clash", "apply"]);
  assert.deepEqual(plan.map(x => isRefusal(x)), [true, true, false, true, false]);
});

test("planApply: an unrecorded file older than the newest recorded version is refused", () => {
  const [p] = planApply([f("20261021000000", "never_applied")], rows);
  assert.equal(p.action, "refused-old"); assert.equal(p.newest, "20261022300000");
});

test("planApply: --allow-old lets an old unrecorded file apply; newer files apply", () => {
  assert.equal(planApply([f("20261021000000", "never_applied")], rows, { allowOld: true })[0].action, "apply");
  assert.equal(planApply([f("20261022400000", "next")], rows)[0].action, "apply");
  assert.equal(planApply([f("20261021000000", "x")], [])[0].action, "apply");
});

test("planApply: files come back in version order", () => {
  const p = planApply([f("20261022500000", "b"), f("20261022400000", "a")], rows);
  assert.deepEqual(p.map(x => x.name), ["a", "b"]);
});

test("apply-migration parseArgs: known flags, unknown flags and no file", () => {
  assert.deepEqual(parseApplyArgs(["a.sql", "--dry-run"]), { files: ["a.sql"], dryRun: true, allowOld: false });
  assert.deepEqual(parseApplyArgs(["--allow-old", "a.sql", "b.sql"]), { files: ["a.sql", "b.sql"], dryRun: false, allowOld: true });
  assert.throws(() => parseApplyArgs(["a.sql", "--dryrun"]), /unknown flag --dryrun/);
  assert.throws(() => parseApplyArgs(["a.sql", "-n"]), /unknown flag -n/);
  assert.throws(() => parseApplyArgs(["--dry-run"]), /no migration file/);
  assert.throws(() => parseApplyArgs([]), /no migration file/);
});

// Round 11 R2: a file that ends sql-tx's always-abort transaction early would commit.
test("transactionControl: top-level commit/end/rollback/abort/begin refused", () => {
  assert.equal(transactionControl("create table a();\ncommit;\n"), "commit");
  assert.equal(transactionControl("select 1; END;"), "end");
  assert.equal(transactionControl("select 1; rollback;"), "rollback");
  assert.equal(transactionControl("abort"), "abort");
  assert.equal(transactionControl("begin; select 1;"), "begin");
  assert.equal(transactionControl("start  transaction; select 1;"), "start transaction");
});

test("transactionControl: commit inside a string, identifier or comment is allowed", () => {
  assert.equal(transactionControl("select 'commit'; -- commit\n/* rollback; /* nested */ end; */ select \"commit\";"), null);
  assert.equal(transactionControl("select E'it\\'s; commit;'; select 1;"), null);
});

test("transactionControl: savepoint, release and rollback to savepoint are allowed", () => {
  assert.equal(transactionControl("savepoint s; select 1; rollback to savepoint s; release s;"), null);
  assert.equal(transactionControl("do $$ begin null; end $$;"), null);
});

// Round 12 F2/F6: dollar-quoted bodies are not scanned. Inside sql-tx's "begin;" a body COMMIT fails with "invalid
// transaction termination", so it cannot commit; scanning bodies only refused valid SQL.
test("transactionControl: dollar-quoted bodies and literals are not transaction control", () => {
  assert.equal(transactionControl("do $$ begin update t set x = 1; commit; end $$;"), null);
  assert.equal(transactionControl("create procedure p() language plpgsql as $f$ begin rollback; end $f$;"), null);
  assert.equal(transactionControl("comment on table t is $c$Never rollback here$c$;"), null);
  assert.equal(transactionControl("do $d$ begin raise notice $m$ commit pending $m$; end $d$;"), null);
  assert.equal(transactionControl("do $$ begin raise notice 'commit'; end $$;"), null);
});

test("transactionControl: a SQL-standard begin atomic ... end body is part of its CREATE", () => {
  const sql = "create function public.add(a int, b int) returns int language sql\nbegin atomic\n  select a + b;\nend;\nselect 1;";
  assert.equal(transactionControl(sql), null);
  assert.equal(transactionControl("create procedure p() language sql begin atomic insert into t values (1); insert into t values (2); end; end;"), "end");
  assert.equal(transactionControl(sql + "\ncommit;"), "commit");
});

test("transactionControl: top-level commit, end and begin..commit stay refused", () => {
  assert.equal(transactionControl("select 1;\ncommit;"), "commit");
  assert.equal(transactionControl("select 1;\nend;"), "end");
  assert.equal(transactionControl("begin; select 1; commit;"), "begin");
});

test("transactionControl: a normal migration with $$ bodies and case..end is allowed", () => {
  const sql = `create or replace function public.f(p int) returns int language plpgsql security definer set search_path = '' as $$
begin
  if p > 0 then return case when p = 1 then 1 else 2 end; end if;
  return 0;
end;
$$;
revoke all on function public.f(int) from public;
select case when true then 1 end;
comment on function public.f(int) is 'never commits';`;
  assert.equal(transactionControl(sql), null);
});

test("sql-tx parseArgs: --test required, unknown flags refused", () => {
  assert.deepEqual(parseTxArgs(["m.sql", "--test", "t.sql"]), { migrations: ["m.sql"], test: "t.sql" });
  assert.throws(() => parseTxArgs(["--test", "t.sql", "--dry-run"]), /unknown flag --dry-run/);
  assert.throws(() => parseTxArgs(["m.sql"]), /no --test/);
  assert.throws(() => parseTxArgs(["--test"]), /needs a file/);
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
