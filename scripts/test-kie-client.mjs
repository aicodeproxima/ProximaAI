// kie.ai on the client (docs/SECOND-ACCOUNT-PLAN.md S3): the starter catalog (src/config/kieModels.js), the input and
// answer adapters (src/lib/kie.js) and the price (src/lib/pricing.js). Written first: before those exist every test fails.
// The catalog is checked against kie.ai's own request schemas (scripts/fixtures/kie-schemas.json, from docs.kie.ai).
// Run: node scripts/test-kie-client.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SCHEMAS = JSON.parse(readFileSync(new URL("./fixtures/kie-schemas.json", import.meta.url), "utf8"));
const load = async p => { try { return await import(p); } catch (e) { return { _err: e }; } };
const C = await load("../src/config/kieModels.js");
const K = await load("../src/lib/kie.js");
const { buildPayload } = await import("../src/lib/payloadBuilder.js");
const P = await import("../src/lib/pricing.js");

let n = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", String(e?.message || e).split("\n").slice(0, 4).join(" | ")); }
};
const all = () => Object.entries(C.KIE_MODELS || {}).flatMap(([type, list]) => list.map(m => ({ type, m })));
const IMG = "https://x.supabase.co/storage/v1/object/public/generations/uploads/u/a.png";
const IMG2 = "https://x.supabase.co/storage/v1/object/public/generations/uploads/u/b.png";
const settingsFor = type => ({ prompt: "a red fox", ...(type === "i2i" || type === "i2v" ? { sourceImageUrl: IMG, sourceImageUrls: [IMG2] } : {}) });
const inputAtDefaults = (type, m) => K.kieInput(m, buildPayload(m, settingsFor(type), type));

await test("the catalog: 14 models, ids kie/…, unique, each naming a documented kie.ai model", () => {
  const list = all();
  assert.equal(list.length, 14);
  const ids = list.map(({ m }) => m.id);
  assert.equal(new Set(ids).size, ids.length, "unique ids");
  for (const { m } of list) {
    assert.equal(m.api, "kie", m.id);
    assert.ok(m.id.startsWith("kie/"), m.id);
    assert.ok(SCHEMAS[m.kieModel], `${m.id}: ${m.kieModel} has a schema`);
    assert.equal(C.kieModelById(m.id), m);
  }
  assert.equal(C.kieModelById("google/nano-banana-2/text-to-image"), null);
});

await test("every field the app can send is in kie.ai's schema, and every option is one kie.ai accepts", () => {
  assert.ok(all().length > 0, "no catalog");
  for (const { m } of all()) {
    const props = SCHEMAS[m.kieModel].props;
    for (const f of m.kie.fields) assert.ok(props[f], `${m.id}: field ${f}`);
    for (const slot of ["resolution", "aspectRatio"]) {
      const p = m.params[slot];
      if (!p) continue;
      assert.ok(props[p.paramName], `${m.id}: ${slot} → ${p.paramName}`);
      for (const o of p.options) assert.ok(props[p.paramName].enum.includes(o.value), `${m.id}: ${p.paramName}=${o.value}`);
      assert.ok(p.options.some(o => o.value === p.default), `${m.id}: ${slot} default`);
    }
    if (m.params.duration) for (const d of m.params.duration.options) {
      const pd = props.duration;
      if (pd.enum) assert.ok(pd.enum.includes(String(d)), `${m.id}: duration ${d}`);
    }
  }
});

await test("at default settings every model's input has kie.ai's required fields, only known fields, right types", () => {
  assert.ok(all().length > 0, "no catalog");
  for (const { type, m } of all()) {
    const input = inputAtDefaults(type, m);
    const { required, props } = SCHEMAS[m.kieModel];
    for (const r of required) assert.ok(input[r] !== undefined, `${m.id}: required ${r} missing (${JSON.stringify(input)})`);
    for (const [k, v] of Object.entries(input)) {
      assert.ok(props[k], `${m.id}: unknown field ${k}`);
      const t = props[k].type;
      if (t === "string") assert.equal(typeof v, "string", `${m.id}: ${k} string`);
      if (t === "integer" || t === "number") assert.equal(typeof v, "number", `${m.id}: ${k} number`);
      if (t === "boolean") assert.equal(typeof v, "boolean", `${m.id}: ${k} boolean`);
      if (t === "array") { assert.ok(Array.isArray(v), `${m.id}: ${k} array`); if (props[k].maxItems) assert.ok(v.length <= props[k].maxItems, `${m.id}: ${k} ≤ maxItems`); }
      if (props[k].enum) assert.ok(props[k].enum.includes(String(v)), `${m.id}: ${k}=${v} allowed`);
    }
  }
});

await test("edit and image-to-video models carry the source images in kie.ai's field", () => {
  const want = { "kie/nano-banana-2/edit": ["image_input", 2], "kie/gpt-image-2/edit": ["input_urls", 2], "kie/seedream-5-lite/edit": ["image_urls", 2],
    "kie/kling-3.0/image-to-video": ["image_urls", 2] };
  for (const [id, [field, count]] of Object.entries(want)) {
    const m = C.kieModelById(id), type = id.includes("video") ? "i2v" : "i2i";
    const input = inputAtDefaults(type, m);
    assert.deepEqual(input[field], [IMG, IMG2].slice(0, count), id);
  }
  const s2 = inputAtDefaults("i2v", C.kieModelById("kie/seedance-2/image-to-video"));
  assert.equal(s2.first_frame_url, IMG);
  const w = inputAtDefaults("i2v", C.kieModelById("kie/wan-2.7/image-to-video"));
  assert.equal(w.first_frame_url, IMG);
});

await test("Kling 3.0: duration goes as a string, single-shot is explicit, sound is always sent", () => {
  const m = C.kieModelById("kie/kling-3.0/text-to-video");
  const input = K.kieInput(m, buildPayload(m, { prompt: "p", duration: 10 }, "t2v"));
  assert.equal(input.duration, "10");
  assert.equal(input.multi_shots, false);
  assert.equal(typeof input.sound, "boolean");
});

await test("kieSubmitResult: a taskId becomes the app's submit shape; kie.ai's error codes become refusals", () => {
  const ok = K.kieSubmitResult({ code: 200, msg: "success", data: { taskId: "abc123" } });
  assert.deepEqual(ok, { data: { id: "abc123", status: "created", urls: { get: "/api/kie/api/v1/jobs/recordInfo?taskId=abc123" } } });
  for (const [code, msg] of [[401, "bad key"], [402, "Insufficient credits"], [422, "bad input"], [429, "slow down"], [500, "x"]]) {
    assert.throws(() => K.kieSubmitResult({ code, msg }), e => e.code === code && e.kie === true && e.message === msg);
  }
  assert.throws(() => K.kieSubmitResult({ code: 200, data: {} }), e => e.kie === true);
  assert.throws(() => K.kieSubmitResult(null), e => e.kie === true);
});

await test("kiePollResult maps kie.ai's states onto the app's (created / processing / completed / failed)", () => {
  const st = s => K.kiePollResult({ code: 200, data: { taskId: "t", state: s } }).data.status;
  assert.equal(st("waiting"), "created");
  assert.equal(st("queuing"), "created");
  assert.equal(st("generating"), "processing");
  const done = K.kiePollResult({ code: 200, data: { taskId: "t", state: "success", resultJson: JSON.stringify({ resultUrls: ["https://tempfile.aiquickdraw.com/a.png"] }), costTime: 12, creditsConsumed: 8 } }).data;
  assert.equal(done.status, "completed");
  assert.deepEqual(done.outputs, ["https://tempfile.aiquickdraw.com/a.png"]);
  assert.equal(done.timings.inference, 12000);
  assert.equal(done.kieCredits, 8);
  const bad = K.kiePollResult({ code: 200, data: { taskId: "t", state: "fail", failCode: "500", failMsg: "content policy" } }).data;
  assert.equal(bad.status, "failed");
  assert.equal(bad.error, "content policy");
  const noUrls = K.kiePollResult({ code: 200, data: { taskId: "t", state: "success", resultJson: "{}" } }).data;
  assert.equal(noUrls.status, "failed", "a success without a file is a failure, not an empty result");
  assert.throws(() => K.kiePollResult({ code: 422, msg: "recordInfo is null" }), e => e.code === 422 && e.kie === true);
});

await test("prices: the catalog price is kie.ai's credits at default settings × $0.005, and priceRequest prices the real input", () => {
  assert.equal(K.KIE_CREDIT_USD, 0.005);
  for (const { type, m } of all()) {
    const credits = m.kie.credits(inputAtDefaults(type, m));
    assert.ok(credits > 0, m.id);
    assert.equal(m.price, Math.round(credits * K.KIE_CREDIT_USD * 1e6) / 1e6, m.id);
  }
  const nb = C.kieModelById("kie/nano-banana-2/text-to-image");
  assert.equal(P.priceRequest(nb, buildPayload(nb, { prompt: "p", perModelResolution: { [nb.id]: "4K" } }, "image")), 18 * 0.005);
  const kl = C.kieModelById("kie/kling-3.0/text-to-video");
  const kp = buildPayload(kl, { prompt: "p", duration: 10 }, "t2v");
  assert.equal(P.priceRequest(kl, kp), Math.round(10 * kl.kie.credits({ ...K.kieInput(kl, kp), duration: "1" }) * 0.005 * 1e6) / 1e6);
});

await test("kie ids are recognized without the catalog (tasks synced from another device)", () => {
  assert.equal(K.isKieModelId("kie/nano-banana-2/text-to-image"), true);
  assert.equal(K.isKieModelId("google/nano-banana-2/text-to-image"), false);
  assert.equal(K.isKieModelId(undefined), false);
  assert.equal(K.isKiePollUrl("/api/kie/api/v1/jobs/recordInfo?taskId=a"), true);
  assert.equal(K.isKiePollUrl("/api/wavespeed-v2/api/v3/predictions/a/result"), false);
});

const R = await import("../src/lib/taskResume.js");
await test("a kie.ai refusal never changes the WaveSpeed key status; its poll rules match api.js refusals", () => {
  assert.equal(R.keyStatusAfter({ code: 400, message: "No kie.ai key saved — add it in Settings", noKey: true, kie: true }), null);
  assert.equal(R.keyStatusAfter({ code: 401, message: "bad key", kie: true }), null);
  assert.equal(R.keyStatusAfter({ code: 400, noKey: true }), "missing", "WaveSpeed's own no-key still counts");
  assert.equal(R.pollErrorAction({ code: 400, noKey: true, kie: true }), "stop");
  assert.equal(R.pollErrorAction({ code: 422, kie: true }), "fail");
  assert.equal(R.pollErrorAction({ code: 429, kie: true }), "retry");
});

await test("a finished kie.ai poll records kie.ai's real charge as the task's price", () => {
  const task = { id: "t", status: "processing", startTime: 1000, price: 0.04 };
  const done = K.kiePollResult({ code: 200, data: { taskId: "k", state: "success", resultJson: '{"resultUrls":["https://tempfile.aiquickdraw.com/a.png"]}', creditsConsumed: 12, costTime: 3 } }).data;
  const t = R.applyPoll(task, done, 9000);
  assert.equal(t.status, "completed");
  assert.equal(t.price, 0.06);
  const ws = R.applyPoll(task, { status: "completed", outputs: ["https://x/a.png"] }, 9000);
  assert.equal(ws.price, 0.04, "a WaveSpeed result keeps its estimate");
});

const W = await import("../src/lib/wsDelete.js");
await test("kie.ai tasks stay out of WaveSpeed's lost-submit lookup and claimants", () => {
  const now = 10_000_000;
  const kie = { id: "k", status: "pending", modelId: "kie/nano-banana-2/text-to-image", startTime: now - 5000 };
  const ws = { id: "w", status: "pending", modelId: "google/nano-banana-2/text-to-image", startTime: now - 5000 };
  assert.equal(R.isOrphan(kie, new Set(), now), false);
  assert.equal(R.isOrphan(ws, new Set(), now), true);
  const claims = R.noteClaimants({}, [kie, ws], now);
  assert.deepEqual(Object.keys(claims), ["w"]);
});

await test("a kie.ai submit whose answer never came is failed once the grace passes (kie.ai has no task history)", () => {
  const now = 10_000_000;
  const old = { id: "a", status: "pending", modelId: "kie/kling-3.0/text-to-video", startTime: now - R.ORPHAN_GRACE_MS - 1 };
  const young = { ...old, id: "b", startTime: now - 1000 };
  const sending = { ...old, id: "c" };
  const ws = { ...old, id: "d", modelId: "kwaivgi/kling-v3.0-pro/text-to-video" };
  const withId = { ...old, id: "e", taskId: "kie-task" };
  const out = R.lostKieSubmits([old, young, sending, ws, withId, { ...old, id: "f", status: "processing" }], new Set(["c"]), now);
  assert.deepEqual(out.map(t => t.id), ["a"]);
  assert.equal(typeof R.KIE_LOST_ERROR, "string");
  assert.ok(R.KIE_LOST_ERROR.includes("kie.ai"));
});

await test("deleting a kie.ai generation queues nothing for WaveSpeed (kie.ai has no delete; its copy expires in 14 days)", () => {
  const q = W.queueDeletes({}, [{ id: "k", taskId: "kie-task", status: "completed", modelId: "kie/nano-banana-2/text-to-image" },
                                 { id: "w", taskId: "ws-pred", status: "completed", modelId: "google/nano-banana-2/text-to-image" }], 1000);
  assert.deepEqual(Object.keys(q), ["ws-pred"]);
});

const CAT = await load("../src/config/catalog.js");
const { MODELS } = await import("../src/config/models.js");
await test("the picker offers kie.ai models only with a kie.ai key; lookups by id find every model", () => {
  const ids = (type, keys) => CAT.visibleModels(type, keys).map(m => m.id);
  const ws = MODELS.image.map(m => m.id), kie = C.KIE_MODELS.image.map(m => m.id);
  assert.deepEqual(ids("image", null), ws, "unknown: WaveSpeed only, as today");
  assert.deepEqual(ids("image", new Set()), ws, "no key at all: WaveSpeed only");
  assert.deepEqual(ids("image", new Set(["wavespeed"])), ws);
  assert.deepEqual(ids("image", new Set(["kie"])), kie, "kie.ai key only: kie.ai models only");
  assert.deepEqual(ids("image", new Set(["wavespeed", "kie"])), [...ws, ...kie]);
  assert.deepEqual(ids("i23d", new Set(["kie"])), [], "a type kie.ai has nothing for");
  for (const type of Object.keys(MODELS)) assert.equal(CAT.CATALOG[type].length, MODELS[type].length + (C.KIE_MODELS[type]?.length || 0), type);
  assert.ok(CAT.CATALOG.t2v.some(m => m.id === "kie/kling-3.0/text-to-video"));
});

await test("a kie.ai task pulled from another device (no pollUrl) is polled through kie.ai, never WaveSpeed", () => {
  assert.equal(R.pollUrlFor({ taskId: "abc", modelId: "kie/kling-3.0/text-to-video" }), "/api/kie/api/v1/jobs/recordInfo?taskId=abc");
  assert.equal(R.pollUrlFor({ taskId: "abc", modelId: "google/nano-banana-2/text-to-image" }), "/api/v3/predictions/abc/result");
  assert.equal(R.pollUrlFor({ pollUrl: "/x", taskId: "abc", modelId: "kie/kling-3.0/text-to-video" }), "/x");
  assert.equal(R.pollUrlFor({ modelId: "kie/kling-3.0/text-to-video" }), null);
});

// ─── S3 review (wf_aed00e79-4a8) ───
const D = await import("../src/lib/taskDraft.js");
const PB = await import("../src/lib/payloadBuilder.js");

await test("review #1 guard: a kie.ai poll our own proxy refuses (4xx) stops the poll instead of failing a paid task", () => {
  assert.equal(R.pollErrorAction({ code: 400, message: "Bad request", kie: true, proxy: true }), "stop");
  assert.equal(R.pollErrorAction({ code: 404, kie: true, proxy: true }), "stop");
  assert.equal(R.pollErrorAction({ code: 422, kie: true }), "fail", "kie.ai's own 422 (no such task) still fails");
});

await test("review #2: with per-model dropdowns (different schemes) every model gets the value its dropdown shows", () => {
  const kl = C.kieModelById("kie/kling-3.0/text-to-video"), sd = C.kieModelById("kie/seedance-2/text-to-video");
  const eff = D.effectivePerModelRes([kl, sd], {});
  assert.deepEqual(eff, { [kl.id]: "std", [sd.id]: "720p" }, "defaults filled when the schemes differ");
  assert.deepEqual(D.effectivePerModelRes([kl, sd], { [kl.id]: "pro" }), { [kl.id]: "pro", [sd.id]: "720p" });
  assert.deepEqual(D.effectivePerModelRes([sd], {}), {}, "one scheme: the global dropdown decides, nothing filled");
  const form = { genType: "t2v", prompt: "p", resolution: "720p", duration: 5, seed: "-1", aspectRatio: "16:9", sourceImageUrl: "", sourceImageUrls: [], optionalParams: {}, briaPresets: {}, negPrompt: "", perModelRes: eff };
  const { task } = D.draftTask({ model: kl, nativeBatch: false, requestIndex: 0, requestCount: 1, imagesPerRequest: 1, totalImages: 1 }, form, { id: "x" });
  assert.equal(task.price, 0.35, "priced at std, not 4K");
  assert.equal(K.kieInput(kl, buildPayload(kl, { prompt: "p", resolution: "720p", perModelResolution: eff }, "t2v")).mode, "std");
});

await test("review #2: kie.ai's K-sized resolutions never take a WaveSpeed size by nearest number (1024*1024 is not 4K)", () => {
  const nb = C.kieModelById("kie/nano-banana-2/text-to-image");
  for (const [g, want] of [["1024*1024", "1K"], ["2048*2048", "1K"], ["720p", "1K"], ["2k", "2K"], ["4K", "4K"]]) {
    assert.equal(PB.chosenResolution(nb, { resolution: g }), want, g);
  }
});

await test("review #2: the card's resolution label is the value actually sent (one resolver for both)", () => {
  const ws = MODELS.t2v.find(m => m.params?.resolution?.options?.length > 1 && !m.params.resolution.options.some(o => o.value === "720p")
    && m.params.resolution.options.some(o => /^\d+p$/.test(o.value)));
  assert.ok(ws, "a WaveSpeed video model without a 720p option");
  const sent = PB.chosenResolution(ws, { resolution: "720p" });
  const { task } = D.draftTask({ model: ws, nativeBatch: false, requestIndex: 0, requestCount: 1, imagesPerRequest: 1, totalImages: 1 },
    { genType: "t2v", prompt: "p", resolution: "720p", duration: 5, seed: "-1", aspectRatio: "16:9", sourceImageUrl: "", sourceImageUrls: [], optionalParams: {}, briaPresets: {}, negPrompt: "", perModelRes: {} }, { id: "y" });
  assert.equal(task.actualRes, ws.params.resolution.options.find(o => o.value === sent).label);
});

await test("review #3: a kie.ai refusal with an answer is not a lost submit (its message is shown); a proxy 502 may be", () => {
  assert.throws(() => K.kieSubmitResult({ code: 505, msg: "Feature Disabled" }), e => e.answered === true && e.message === "Feature Disabled");
  assert.equal(R.submitMayHaveLanded({ code: 505, kie: true, answered: true }), false);
  assert.equal(R.submitMayHaveLanded({ code: 502, kie: true }), true);
});

await test("review #4/#8/#13: a kie.ai generation never reaches the WaveSpeed delete queue, also without a modelId", () => {
  const names = Object.values(C.KIE_MODELS).flat().map(m => m.name);
  assert.ok(names.every(nm => nm.endsWith(K.KIE_NAME_SUFFIX)), "every kie.ai model name carries the suffix");
  const q = W.queueDeletes({}, [
    { id: "a", taskId: "task_kling-3.0_1", model: "Kling 3.0 · kie.ai", status: "completed" },        // a History item
    { id: "b", taskId: "task_x_1", modelName: "Seedance 2.0 · kie.ai", status: "completed" },          // a task
    { id: "c", taskId: "ws-1", model: "Kling 3.0 Pro", status: "completed" },                           // WaveSpeed
  ], 1000);
  assert.deepEqual(Object.keys(q), ["ws-1"]);
  assert.equal(K.isKieGeneration({ modelId: "kie/wan-2.7/text-to-video" }), true);
  assert.equal(K.isKieGeneration({ id: "x", taskId: "y", status: "processing" }), false);
});

await test("review #5: Edit on a kie.ai result picks a visible kie.ai edit model of the same provider", () => {
  const vis = CAT.visibleModels("i2i", new Set(["kie"]));
  assert.equal(CAT.editModelFor({ modelId: "kie/nano-banana-2/text-to-image", provider: "Google" }, vis)?.id, "kie/nano-banana-2/edit");
  const both = CAT.visibleModels("i2i", new Set(["kie", "wavespeed"]));
  assert.equal(CAT.editModelFor({ modelId: "kie/gpt-image-2/text-to-image", provider: "OpenAI" }, both)?.api, "kie");
  assert.notEqual(CAT.editModelFor({ modelId: "google/nano-banana-2/text-to-image", provider: "Google" }, both)?.api, "kie");
  assert.equal(CAT.editModelFor({ modelId: "kie/x", provider: "Nobody" }, vis), null);
});

await test("review #6: GPT Image 2 gets a ratio kie.ai accepts at the chosen size; over-long prompts are refused before kie.ai", () => {
  const g = C.kieModelById("kie/gpt-image-2/text-to-image");
  assert.equal(K.kieInput(g, { prompt: "p", aspect_ratio: "4:5", resolution: "2K" }).aspect_ratio, "auto");
  assert.equal(K.kieInput(g, { prompt: "p", aspect_ratio: "3:1", resolution: "4K" }).aspect_ratio, "auto");
  assert.equal(K.kieInput(g, { prompt: "p", aspect_ratio: "4:5", resolution: "1K" }).aspect_ratio, "4:5");
  const kl = C.kieModelById("kie/kling-3.0/text-to-video");
  assert.match(K.kieInputProblem(kl, { prompt: "x".repeat(2501) }) || "", /2,500/);
  assert.equal(K.kieInputProblem(kl, { prompt: "x".repeat(2500) }), null);
  const w = C.kieModelById("kie/wan-2.7/text-to-video");
  assert.match(K.kieInputProblem(w, { prompt: "p", negative_prompt: "n".repeat(501) }) || "", /500/);
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
