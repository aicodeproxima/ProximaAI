// Tests for the Settings key cards' messages (WaveSpeed, kie.ai, Higgsfield): every word is accurate (owner ruling
// 2026-11-12). Only a provider's own 401/403 rejects a key; anything else the check got says it couldn't check. A
// count is the real one. "Saved." and "Removed." appear only when the server said so.
// Run: node scripts/test-key-messages.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
const H = await import("../src/lib/higgsfield.js");
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const app = read("../src/App.jsx"), api = read("../src/lib/api.js"), sb = read("../src/lib/supabase.js");

let n = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", e.message.split("\n")[0]); }
};
const fnBody = (src, head) => { const i = src.indexOf(head); assert.ok(i >= 0, head); return src.slice(i, src.indexOf("\n}\n", i)); };

test("Higgsfield check: only its own 401/403 rejects the key; an outage or the proxy's own failure says nothing about it", () => {
  for (const s of [401, 403]) assert.equal(H.hfCheckKeyStatus(s), "invalid", String(s));
  for (const s of [400, 404, 429, 500, 502, 503, 504]) assert.equal(H.hfCheckKeyStatus(s), "unknown", String(s));
  const body = fnBody(api, "export async function checkHiggsfieldConnection(");
  assert.match(body, /keyStatus: hfCheckKeyStatus\(res\.status\)/);
  assert.doesNotMatch(body, /res\.status === 400 \? "missing" : "invalid"/);
  assert.match(body, /Couldn't check the key/, "a failed check says it couldn't check");
  assert.match(body, /presetsCount: hfPresetList\(json\)\.length/, "the count is the studio's own reading of the list");
});
test("Higgsfield check: the success text gives the real preset count, or none", () => {
  assert.doesNotMatch(app, /presetsCount \|\| 20/, "no invented count");
  assert.match(app, /Connected to Higgsfield!\$\{r\.presetsCount \? ` It lists \$\{r\.presetsCount\} Genjutsu style presets\.` : ""\}/);
});
test("a key save says Saved only when the server said ok; an empty answer says the outcome is unknown", () => {
  for (const [call, setter] of [["await saveWavespeedKey(typed)", "setTestStatus"], ['await saveProviderKey("kie", typed)', "setKieTestStatus"],
    ['await saveProviderKey("higgsfield", typed)', "setHfTestStatus"]]) {
    const esc = call.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(app, new RegExp(`if \\(!\\(${esc}\\)\\) \\{ ${setter}\\(\\{ ok: false, msg: KEY_SAVE_UNCONFIRMED \\}\\); return; \\}`), call);
  }
  assert.match(app, /const KEY_SAVE_UNCONFIRMED = "The server's answer was empty, so it's unknown whether the key was saved\./);
});
test("a key removal says Removed only when a key was there; nothing saved says so; an empty answer is unknown", () => {
  assert.match(fnBody(sb, "export async function clearProviderKey("), /return r\?\.ok \? \{ removed: !!r\.removed \} : null;/);
  for (const [prov, name, setter] of [["kie", "kie.ai", "setKieTestStatus"], ["higgsfield", "Higgsfield", "setHfTestStatus"]]) {
    const i = app.indexOf(`const r = await clearProviderKey("${prov}");`);
    assert.ok(i > 0, prov);
    const seg = app.slice(i, i + 700);
    assert.match(seg, new RegExp(`${setter}\\(r \\? \\{ ok: true, msg: r\\.removed \\? "Removed\\." : "No ${name.replace(".", "\\.")} key was saved, so there was nothing to remove\\." \\} : \\{ ok: false, msg: KEY_REMOVE_UNCONFIRMED \\}\\);`), prov);
  }
});

const R = await import("../src/lib/taskResume.js");
test("a Higgsfield refusal names Higgsfield and never changes the WaveSpeed key's status", () => {
  assert.equal(R.keyStatusAfter({ code: 401, message: "bad key", higgsfield: true }), null);
  assert.equal(R.keyStatusAfter({ code: 403, higgsfield: true }), null);
  assert.equal(R.keyStatusAfter({ code: 400, message: "No Higgsfield key saved — add it in Settings", noKey: true, higgsfield: true }), null);
  assert.equal(R.keyStatusAfter({ code: 401 }), "invalid", "WaveSpeed's own refusal still counts");
  assert.equal(R.keyStatusAfter({ code: 400, noKey: true }), "missing", "WaveSpeed's own no-key still counts");
  assert.equal(R.rejectedKeyText({ code: 401, higgsfield: true }), "Higgsfield rejected the saved key — update it in Settings");
  assert.equal(R.rejectedKeyText({ code: 401, kie: true }), "kie.ai rejected the saved key — update it in Settings");
  assert.equal(R.rejectedKeyText({ code: 401 }), "WaveSpeed rejected the saved API key — update it in Settings");
  assert.equal((app.match(/if \(e\.code === 401 && !e\.session\) errMsg = rejectedKeyText\(e\);/g) || []).length, 2, "submit + regenerate");
  assert.doesNotMatch(app, /errMsg = e\.kie \?/, "no two-provider ternary left");
  assert.match(app, /if \(e\?\.higgsfield && \(e\.code === 401 \|\| e\.code === 403\)\) setHfKeyStatus\("invalid"\);/, "the Higgsfield card shows it");
});

console.log(`${n}/${n + failed} passed`);
process.exit(failed ? 1 : 0);
