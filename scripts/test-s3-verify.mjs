// S3 verification round (wf_d7e3921d-963): fixes for its 9 findings. Written first: before the changes each test fails.
// #7 mixed resolution schemes keep WaveSpeed models exactly as before (only kie.ai's exact-option models get their
//    default), and a picker label is the price of what selecting that model sends.
// #4 kie.ai video models map the app's p-sizes onto their own; the shared dropdown's note names what each model gets.
// #5 Regenerate's card shows what the rebuilt payload sends.  #1 History-only kie.ai generations keep their name.
// #2 kie.ai's maintenance codes retry a poll.  #3/#9/#6 wiring checked from App.jsx.
// Run: node scripts/test-s3-verify.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const mem = new Map();
globalThis.localStorage = { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k), get length() { return mem.size; }, key: i => [...mem.keys()][i] ?? null };
const { MODELS } = await import("../src/config/models.js");
const C = await import("../src/config/kieModels.js");
const D = await import("../src/lib/taskDraft.js");
const PB = await import("../src/lib/payloadBuilder.js");
const R = await import("../src/lib/taskResume.js");
const W = await import("../src/lib/wsDelete.js");
const B = await import("../src/lib/batchLog.js");
const S = await import("../src/lib/storage.js");
const src = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");

let n = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", String(e?.message || e).split("\n").slice(0, 4).join(" | ")); }
};
const form = (over = {}) => ({ genType: "image", prompt: "p", negPrompt: "", resolution: "", duration: 5, seed: "-1", aspectRatio: "auto",
  sourceImageUrl: "", sourceImageUrls: [], optionalParams: {}, briaPresets: {}, perModelRes: {}, ...over });
const plan = (model) => ({ model, nativeBatch: false, requestIndex: 0, requestCount: 1, imagesPerRequest: 1, totalImages: 1 });
const byScheme = (type) => {
  const m = new Map();
  for (const x of MODELS[type]) if (x.params?.resolution) { const k = x.params.resolution.paramName; if (!m.has(k)) m.set(k, x); }
  return [...m.values()];
};

await test("#7: in a mixed-scheme selection a WaveSpeed model is sent the shared value, as before (nothing filled for it)", () => {
  const [a, b] = byScheme("image");
  assert.ok(a && b, "two WaveSpeed image models of different schemes");
  const eff = D.effectivePerModelRes([a, b], {});
  assert.deepEqual(eff, {}, "WaveSpeed models are not filled");
  const k = C.kieModelById("kie/kling-3.0/text-to-video"), [v] = byScheme("t2v").filter(m => m.params.resolution.paramName !== "mode");
  assert.deepEqual(D.effectivePerModelRes([k, v], {}), { [k.id]: "std" }, "only the exact-option kie.ai model gets its default");
});

await test("#7: a picker label is the price of what selecting that model sends (mixed schemes, unselected model)", () => {
  const [a, b] = byScheme("image");
  const kie = C.kieModelById("kie/nano-banana-pro/text-to-image");
  const f = form({ resolution: "4k" });
  for (const m of [b, kie]) {
    const label = D.unitQuote(m, { ...f, perModelRes: D.labelPerModelRes([a], m, {}) }).cost;
    const sent = D.draftTask(plan(m), { ...f, perModelRes: D.effectivePerModelRes([a, m], {}) }, { id: "x" }).task.price;
    assert.equal(label, sent, m.id);
  }
});

await test("#4: kie.ai video models take the app's p-sizes to their nearest own size, never the default by surprise", () => {
  const wan = C.kieModelById("kie/wan-2.7/text-to-video"), sd = C.kieModelById("kie/seedance-2/text-to-video");
  assert.equal(PB.chosenResolution(wan, { resolution: "480p" }), "720p");
  assert.equal(PB.chosenResolution(wan, { resolution: "4k" }), "1080p");
  assert.equal(PB.chosenResolution(sd, { resolution: "540p" }), "720p");
  assert.equal(PB.chosenResolution(sd, { resolution: "2k" }), "1080p", "not 4k");
  assert.equal(PB.chosenResolution(sd, { resolution: "1080p" }), "1080p");
});

await test("#4: the shared dropdown's note names what each model without that value will get", () => {
  const wan = C.kieModelById("kie/wan-2.7/text-to-video");
  const [ws] = MODELS.t2v.filter(m => m.params?.resolution?.paramName === "resolution" && m.params.resolution.options.some(o => o.value === "480p"));
  const note = D.resolutionNotes([ws, wan], "480p");
  assert.deepEqual(note, [{ name: wan.name, label: "720p" }]);
});

await test("#5: Regenerate labels its card from the payload it rebuilds", () => {
  const [ws] = MODELS.t2v.filter(m => m.params?.duration?.options?.length && !m.params.duration.options.includes(20));
  const labels = D.runLabels(ws, { duration: 20, resolution: "" });
  assert.equal(labels.actualDur, PB.chosenDuration(ws, { duration: 20 }));
  assert.match(src, /const labels = runLabels\(regenModel, taskUserSettings\(newTask, regenType\)\);\s*newTask\.actualRes = labels\.actualRes;\s*newTask\.actualDur = labels\.actualDur;/);
});

await test("#1: a History-only kie.ai generation keeps its name, so Clear Outputs / Reset queue nothing for WaveSpeed", () => {
  const gens = B.historyOnlyGenerations([{ id: "L", tasks: [{ id: "g", model: "Nano Banana 2 · kie.ai", taskId: "task_nano-banana-2_1", status: "completed", outputs: [] },
                                                            { id: "w", model: "Nano Banana 2", taskId: "ws-1", status: "completed", outputs: [] }] }], new Set());
  assert.equal(gens.find(g => g.id === "g").model, "Nano Banana 2 · kie.ai");
  assert.deepEqual(Object.keys(W.queueDeletes({}, gens, 1)), ["ws-1"]);
});

await test("#2: kie.ai's maintenance and limit codes (455, 433) retry a poll; no such task (422) still fails", () => {
  assert.equal(R.pollErrorAction({ code: 455, kie: true, answered: true }), "retry");
  assert.equal(R.pollErrorAction({ code: 433, kie: true, answered: true }), "retry");
  assert.equal(R.pollErrorAction({ code: 422, kie: true, answered: true }), "fail");
  assert.equal(R.pollErrorAction({ code: 455 }), "fail", "WaveSpeed's codes unchanged");
});

await test("#3 wiring: a kie.ai key kie.ai rejects shows in Settings, and saving a key restarts the stopped polls", () => {
  assert.match(src, /if \(e\?\.kie && \(e\.code === 401 \|\| e\.code === 403\)\) setKieKeyStatus\("invalid"\);/);
  assert.match(src, /setKieKeyStatus\("ok"\);\s*pollUntracked\(\);/);
  assert.match(src, /if \(typed\) \{ await saveWavespeedKey\(typed\); setKeyInput\(""\); refreshProviderKeys\(\); pollUntracked\(\); \}/);
});

// Cloud publications (read by other devices, ordered by the server: 20261025900000) are stamped and judged on the
// server-aligned clock; this browser's own local publications stay on its own clock (written and read here only).
await test("#9 wiring: cloud form publications use the server-aligned clock (serverNow); local ones this browser's", () => {
  assert.match(src, /now: \(\) => formStamp\(serverNow\(\)\),/, "the :unsent publication (monotonic per browser, A; B17's publisher)");
  assert.equal((src.match(/const local = Date\.now\(\), now = formStamp\(serverNow\(\)\), mine = \[\.\.\.liveFormPaths\(readFormPublications\(\), local\)\];/g) || []).length, 2,
    "the form publication (tick and page exit): local holds on this clock, the cloud write on the server's");
  assert.match(src, /liveFormPaths\(readFormPublications\(\), Date\.now\(\)\),\s*\.\.\.liveFormPaths\(cloudHolds \|\| \[\], serverNow\(\)\)/);
  assert.match(src, /liveUnsent\(\[\.\.\.pubs, \{ at: serverNow\(\), \.\.\.unsentGenerations\(\) \}\], serverNow\(\)\)/);
});

await test("#6/#8 wiring: the per-model resolutions are memoized (the quotes' memo holds while schemes differ)", () => {
  assert.match(src, /const effectivePerModel = useMemo\(\(\) => effectivePerModelRes\(selectedModelConfigs, perModelRes\), \[selectedModels, models, perModelRes\]\);/);
  assert.match(src, /perModelRes: effectivePerModel,/);
});

// ─── Second verification round (wf_e7c2e32a-2b6) ───
await test("v4 B: with one scheme on screen, per-model picks of the selected models no longer decide (the shared dropdown does)", () => {
  const kl = C.kieModelById("kie/kling-3.0/text-to-video");
  const [v] = byScheme("t2v").filter(m => m.params.resolution.paramName !== "mode");
  const picks = { [kl.id]: "4K" };
  assert.deepEqual(D.effectivePerModelRes([kl, v], picks), { [kl.id]: "4K" }, "two schemes: Kling's own pick stands");
  const alone = D.effectivePerModelRes([kl], picks);
  assert.equal(alone[kl.id], undefined, "Kling alone: its stale pick is ignored");
  const f = { genType: "t2v", prompt: "p", negPrompt: "", resolution: "std", duration: 5, seed: "-1", aspectRatio: "16:9",
    sourceImageUrl: "", sourceImageUrls: [], optionalParams: {}, briaPresets: {}, perModelRes: alone };
  assert.equal(D.draftTask(plan(kl), f, { id: "z" }).task.price, 0.35, "sent what the shared dropdown shows (std)");
  const [w1, w2] = MODELS.t2v.filter(m => m.params?.resolution?.paramName === "resolution").slice(0, 2);
  assert.deepEqual(D.effectivePerModelRes([w1, w2], { [w1.id]: "1080p", other: "x" }), { other: "x" }, "only the selected models' picks go");
});

await test("v4 D: Nano Banana Pro · kie.ai sends kie.ai's auto aspect ratio when the form says Auto (edits keep their shape)", () => {
  for (const id of ["kie/nano-banana-pro/text-to-image", "kie/nano-banana-pro/edit"]) {
    const m = C.kieModelById(id);
    assert.equal(PB.buildPayload(m, { prompt: "p", aspectRatio: "auto", sourceImageUrl: "https://x/a.png" }, id.endsWith("edit") ? "i2i" : "image").aspect_ratio, "auto", id);
  }
});

await test("v4 C wiring: a rejected kie.ai key is shown in the header, cleared by a working poll and by sign-out", () => {
  assert.match(src, /kieKeyStatus === "invalid" && <span[^>]*>⚠ kie\.ai key rejected<\/span>/);
  assert.match(src, /if \(isKiePollUrl\(pollUrl\)\) setKieKeyStatus\(s => \(s === "invalid" \? "ok" : s\)\);/);
  assert.match(src, /if \(!isAuthed\) \{ setProviderKeys\(null\); setProviderKeyList\(\[\]\); setKieKeyStatus\("unknown"\); return; \}/);
});

// S3 second verification A (#1/#5): the form publications' stamps are ordered across this browser's tabs. Each tab's
// server-clock estimate differs by up to about a second, so a newer set could carry the smaller `at`, and the server
// (20261025900000: newest `at` wins) would skip it. formStamp is monotonic through localStorage, shared by the tabs.
await test("A: formStamp never goes backwards, whatever each tab's clock estimate says, and stays near it", () => {
  assert.equal(typeof S.formStamp, "function");
  const a = S.formStamp(10_000);           // tab A, estimate +400 ms
  const b = S.formStamp(9_200);            // tab B 300 ms later, estimate -400 ms: lower clock reading
  const c = S.formStamp(9_250);
  assert.ok(b > a && c > b, `${a} < ${b} < ${c}`);
  assert.equal(S.formStamp(50_000), 50_000, "a clock ahead of the mark is used as is");
  localStorage.setItem("proximaai-form-stamp", "not a number");
  assert.equal(S.formStamp(60_000), 60_000, "a broken mark reads as none");
  localStorage.setItem("proximaai-form-stamp", String(10 * 365 * 864e5));
  assert.equal(S.formStamp(70_000), 70_000, "a mark far ahead (a clock once set years forward) is ignored, so holds still lapse");
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
