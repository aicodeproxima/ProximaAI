// scripts/lib/strip-comments.mjs: the comment stripper the wiring tests read App.jsx through (a commented-out line must
// never satisfy a check). Review r8 (tests #13): the old one read the string literals "image/*" and "video/*" as block
// comment openers and silently dropped about 106 lines of App.jsx, so whole-file checks were blind there.
// Written first: before the change this file fails. Run: node scripts/test-strip-comments.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let L = {};
try { L = await import("./lib/strip-comments.mjs"); } catch {}
let n = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", String(e?.message || e).split("\n").slice(0, 3).join(" | ")); }
};

await test("block and line comments go; strings holding /* or // stay", () => {
  const src = [
    `<input accept="image/*" />`,
    `{/* a JSX comment */}`,
    `run(); /* trailing */ next();`,
    `/** doc`,
    ` * block */`,
    `const u = "https://x.test/a"; // a line comment`,
    `const v = 'video/*';`,
    `x = 1;/* glued */ y = 2;`,
  ].join("\r\n");
  const out = L.stripComments(src);
  assert.ok(out.includes(`accept="image/*"`), "image/* kept");
  assert.ok(out.includes(`'video/*'`), "video/* kept");
  assert.ok(out.includes(`"https://x.test/a"`), "URL kept");
  for (const gone of ["a JSX comment", "trailing", "doc", "block */", "a line comment", "glued"]) assert.ok(!out.includes(gone), `removed: ${gone}`);
  assert.ok(out.includes("run();") && out.includes("next();") && out.includes("y = 2;"), "code around comments kept");
  assert.ok(!out.includes("\r"), "line ends normalised");
});

await test("App.jsx: nothing between two string literals is lost, and the self-check passes", () => {
  const raw = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const out = L.assertStripKeepsStrings(raw);
  const count = (s, t) => s.split(t).length - 1;
  for (const t of [`"image/*"`, `"video/*"`]) assert.equal(count(out, t), count(raw, t), `every ${t} kept`);
  // the stripped text keeps every line that holds code outside comments: no more than the comment lines are gone
  const codeLines = raw.split("\n").filter(l => l.trim() && !/^\s*(\/\/|\/\*|\*|\{\/\*)/.test(l)).length;
  const kept = out.split("\n").filter(l => l.trim()).length;
  assert.ok(kept >= codeLines - 5, `kept ${kept} non-empty lines of ${codeLines} code lines`);
});

await test("the self-check throws when a string literal holding /* was dropped", () => {
  assert.throws(() => L.assertStripKeepsStrings(`a = "x/*"; b = 1; c = "*/y";`, `a = ; c = "*/y";`), /dropped the string/);
});

await test("the wiring tests read App.jsx through this stripper", () => {
  for (const f of ["test-join-client.mjs", "test-b18-round30-8.mjs", "test-b19-fresh-before-stale.mjs"]) {
    const s = readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
    assert.match(s, /from "\.\/lib\/strip-comments\.mjs"/, `${f} imports it`);
    assert.ok(!s.includes("/\\/\\*[\\s\\S]*?\\*\\//g"), `${f} has no own block-comment regex`);
  }
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
