// The kie.ai balance in the top bar (owner 2026-10-26: "Can you display the remaining balance at all times like we do
// with wavespeed?"). Refreshed at the WaveSpeed balance's moments (load, back in the app, a finished batch, Save & Test),
// asked only when the account has a kie.ai key, cleared at sign-out, hidden while kie.ai rejects the key.
// Written first: before the change these tests fail. Run: node scripts/test-kie-balance-pill.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertStripKeepsStrings } from "./lib/strip-comments.mjs";

let K = {};
try { K = await import("../src/lib/kie.js"); } catch {}
const app = assertStripKeepsStrings(readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8"));
let n = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", String(e?.message || e).split("\n").slice(0, 3).join(" | ")); }
};

await test("kieBalanceLabel: credits and their dollar value at kie.ai's rate", () => {
  assert.equal(K.kieBalanceLabel(782), "kie 782 cr · $3.91");
  assert.equal(K.kieBalanceLabel(951.5), "kie 951.5 cr · $4.76");
  assert.equal(K.kieBalanceLabel(0), "kie 0 cr · $0.00");
  assert.equal(K.kieBalanceLabel(12345.678), "kie 12,345.68 cr · $61.73");
  assert.equal(K.kieBalanceLabel(null), "");
  assert.equal(K.kieBalanceLabel("x"), "");
});

await test("refreshed with the WaveSpeed balance, only for an account with a kie.ai key", () => {
  assert.match(app, /const \[kieCredits, setKieCredits\] = useState\(null\);/);
  assert.match(app, /const hasKieKeyRef = useRef\(hasKieKey\);\s*hasKieKeyRef\.current = hasKieKey;/);
  const fn = app.slice(app.indexOf("const refreshKieCredits = useCallback("), app.indexOf("}, []);", app.indexOf("const refreshKieCredits = useCallback(")));
  assert.match(fn, /if \(!hasKieKeyRef\.current\) \{ setKieCredits\(null\); return null; \}/);
  assert.match(fn, /const r = await checkKieBalance\(\);/);
  assert.match(fn, /if \(r\.credits !== null\) setKieCredits\(r\.credits\);\s*else if \(r\.keyStatus === "missing" \|\| r\.keyStatus === "invalid"\) setKieCredits\(null\);/);
  const rb = app.slice(app.indexOf("const refreshBalance = useCallback("), app.indexOf("}, [", app.indexOf("const refreshBalance = useCallback(")));
  assert.match(rb, /refreshKieCredits\(\)\.catch\(\(\) => \{\}\);/, "every WaveSpeed balance refresh refreshes kie.ai's too");
  assert.ok(app.indexOf("const refreshKieCredits = useCallback(") < app.indexOf("const refreshBalance = useCallback("), "defined first");
  assert.match(app, /useEffect\(\(\) => \{\s*if \(isAuthed && hasKieKey\) refreshKieCredits\(\)\.catch\(\(\) => \{\}\);\s*else setKieCredits\(null\);\s*\}, \[isAuthed, hasKieKey, refreshKieCredits\]\);/);
  assert.match(app.slice(app.indexOf("function signOutLocal() {"), app.indexOf("\n  }\n", app.indexOf("function signOutLocal() {"))), /setKieCredits\(null\);/);
});

await test("the top bar shows it next to the WaveSpeed balance; hidden while the key is rejected", () => {
  assert.match(app, /\{kieCredits !== null && kieKeyStatus !== "invalid" && <div className="balance-pill" title="kie\.ai credits left">\{kieBalanceLabel\(kieCredits\)\}<\/div>\}/);
  assert.match(app, /import \{[^}]*\bkieBalanceLabel\b[^}]*\} from "\.\/lib\/kie\.js";/);
});

// Measured live at 384 px: "kie 782 cr · $3.91" wrapped onto two lines in the 46 px top bar.
await test("a balance pill stays on one line and does not shrink (384 px top bar)", () => {
  const css = (app.match(/^\.balance-pill \{[^\n]*$/m) || [""])[0];   // one line; it holds "${font}", so not up to the first "}"
  assert.match(css, /white-space: nowrap;/);
  assert.match(css, /flex-shrink: 0;/);
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
