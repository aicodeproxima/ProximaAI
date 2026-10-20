// Tests for WaveSpeed price formulas (src/lib/priceFormula.js) and per-request pricing (src/lib/pricing.js).
// Formulas are copied verbatim from WaveSpeed model pages. Run: node scripts/test-pricing.mjs
import assert from "node:assert/strict";
import { evaluateFormula, compileFormula } from "../src/lib/priceFormula.js";
import { priceRequest, requestCost } from "../src/lib/pricing.js";
import { MODEL_PRICING, PRICING_FORMULAS } from "../src/config/modelPricing.js";
import { MODELS } from "../src/config/models.js";
import { buildPayload } from "../src/lib/payloadBuilder.js";

let n = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", e.message.split("\n").filter(Boolean).slice(0, 6).join(" | ")); }
};
const near = (actual, expected, msg) => assert.ok(actual !== null && Math.abs(actual - expected) < 1e-9, `${msg || ""} expected ${expected}, got ${actual}`);
const model = id => Object.values(MODELS).flat().find(m => m.id === id) || assert.fail(`no registry model ${id}`);
const categoryOf = id => Object.entries(MODELS).find(([, list]) => list.some(m => m.id === id))[0];
const SETTINGS = { prompt: "a red fox in snow", negPrompt: "", aspectRatio: "auto", seed: "-1", perModelResolution: {}, numImages: 1, briaPresets: {} };
const payloadFor = (id, extra = {}) => buildPayload(model(id), { ...SETTINGS, ...extra }, categoryOf(id));

// ── Formula engine: real formulas, prices in WaveSpeed's millionths of a dollar ──
const GPT_IMAGE_2 = `{"total_price": ((quality = "low") ? (resolution = "4k" ? 30000 : (resolution = "2k" ? 20000 : 10000)) : ((quality = "high") ? (resolution = "4k" ? 720000 : (resolution = "2k" ? 400000 : 220000)) : (resolution = "4k" ? 180000 : (resolution = "2k" ? 100000 : 60000))))}`;
test("GPT Image 2: nested quality x resolution ternaries", () => {
  assert.equal(evaluateFormula(GPT_IMAGE_2, { quality: "high", resolution: "4k" }), 720000);
  assert.equal(evaluateFormula(GPT_IMAGE_2, { quality: "low", resolution: "2k" }), 20000);
  assert.equal(evaluateFormula(GPT_IMAGE_2, { quality: "medium", resolution: "1k" }), 60000);
});

const VEO_31 = `{"total_price": base_price * $min([duration, 8]) / 8 * (resolution = "4k" ? (generate_audio ? 1.5 : 1) : (generate_audio ? 1 : 0.5))}`;
test("Veo 3.1: per-second price, $min, boolean audio multiplier", () => {
  assert.equal(evaluateFormula(VEO_31, { base_price: 3200000, duration: 4, resolution: "4k", generate_audio: false }), 1600000);
  assert.equal(evaluateFormula(VEO_31, { base_price: 3200000, duration: 8, resolution: "4k", generate_audio: true }), 4800000);
  assert.equal(evaluateFormula(VEO_31, { base_price: 3200000, duration: 8, resolution: "720p", generate_audio: false }), 1600000);
});

test("array literals drop undefined values, as in JSONata", () => {
  assert.equal(evaluateFormula(VEO_31, { base_price: 3200000, resolution: "1080p", generate_audio: true }), 3200000);
});

test("WAN 2.5: `or` inside a size multiplier", () => {
  const f = `{"total_price": base_price * duration / 5 * ((size = "1280*720" or size = "720*1280") ? 2 : (size = "1920*1080" or size = "1080*1920") ?  3 : 1)}`;
  assert.equal(evaluateFormula(f, { base_price: 250000, duration: 10, size: "1920*1080" }), 1500000);
  assert.equal(evaluateFormula(f, { base_price: 250000, duration: 5, size: "832*480" }), 250000);
});

test("Sora 2 Pro: `in` array membership and fractional multipliers", () => {
  const f = `{"total_price": duration / 4 * base_price * (size in ["720*1280","1280*720"] ? 1 : size in ["1024*1792","1792*1024"] ? 5/3 : size in ["1080*1920","1920*1080"] ? 7/3 : 1)}`;
  near(evaluateFormula(f, { base_price: 1200000, duration: 8, size: "1792*1024" }), 4000000);
});

test("Krea 3: block bindings, $exists default, $split + index, $number, $ceil", () => {
  const f = `{"total_price": ($s := $exists(size) ? size : "1024*1024"; $w := $ceil($number($split($s, "*")[0]) / 16) * 16; $h := $ceil($number($split($s, "*")[1]) / 16) * 16; $ceil(base_price * $w * $h / 1048576))}`;
  assert.equal(evaluateFormula(f, { base_price: 30000, size: "2048*2048" }), 120000);
  assert.equal(evaluateFormula(f, { base_price: 30000 }), 30000);
});

test("P-Video 2 Pro reference: many bindings, $count + $exists on media inputs", () => {
  const f = `{"total_price": ($d := $exists(duration) ? duration : 5; $cost := mode = "cost"; $r := resolution = "480p"; $img := $count(images) + ($exists(image) ? 1 : 0) + ($exists(last_image) ? 1 : 0); $v := $count(videos) > 0 ? $min([$ceil($min([get_duration(videos, max=15, total=15), $count(videos) * ($d + 0.5)])), 15]) : 0; $a := $count(audios) > 0 ? $min([$ceil(get_duration(audios, total=15)), 15]) : 0; $d * ($cost ? ($r ? 15000 : 25000) : ($r ? 20000 : 35000)) + $img * ($cost ? 5000 : 10000) + $v * ($cost ? ($r ? 30000 : 60000) : ($r ? 40000 : 60000)) + $a * ($cost ? 1500 : 2500))}`;
  assert.equal(evaluateFormula(f, { resolution: "720p", images: ["a.png", "b.png"] }), 195000);
  assert.equal(evaluateFormula(f, { resolution: "480p", mode: "cost", duration: 10, image: "a.png" }), 155000);
});

const KLING_O3_REF = `{"total_price": duration / 5 * base_price * (video != "" ? 1.5 : (sound ? 1.25 : 1))}`;
test("Kling O3 reference: `!=` against a missing field is false (JSONata)", () => {
  assert.equal(evaluateFormula(KLING_O3_REF, { base_price: 560000, duration: 10, sound: true }), 1400000);
  assert.equal(evaluateFormula(KLING_O3_REF, { base_price: 560000, duration: 10, sound: true, video: "v.mp4" }), 1680000);
});

const SEEDANCE_EDIT = `{"total_price": ($scale := (resolution = "4k" ? 10 : resolution = "1080p" ? 5 : resolution = "720p" ? 2 : 1); $source := $min([$ceil(get_duration(video, min=2, max=15, total=15)), 15]); 75000 * $scale * ($max([2, $source]) + (duration ? duration : $max([4, $source]))))}`;
test("Seedance 2.0 video edit: get_duration with named args uses the measured input length", () => {
  const ctx = { mediaDuration: url => ({ "v.mp4": 7.2, "long.mp4": 40 })[url] };
  assert.equal(evaluateFormula(SEEDANCE_EDIT, { resolution: "720p", video: "v.mp4" }, ctx), 2400000);
  assert.equal(evaluateFormula(SEEDANCE_EDIT, { resolution: "1080p", video: "long.mp4", duration: 5 }, ctx), 7500000, "clamped to max=15");
});

test("get_duration on an unmeasured input throws instead of guessing", () => {
  assert.throws(() => evaluateFormula(SEEDANCE_EDIT, { resolution: "720p", video: "v.mp4" }), /duration/i);
});

test("Tripo H3.1: boolean fields, compact syntax, chained additions", () => {
  const f = `{"total_price":base_price*((texture or pbr)?(texture_quality="detailed"?2:1.5):1)+(geometry_quality="detailed"?base_price*1:0)+(quad?base_price*0.25:0)}`;
  assert.equal(evaluateFormula(f, { base_price: 240000, texture: true, pbr: true, texture_quality: "detailed", geometry_quality: "detailed", quad: true }), 780000);
  assert.equal(evaluateFormula(f, { base_price: 240000, texture: false, pbr: false, texture_quality: "standard", geometry_quality: "standard", quad: false }), 240000);
});

test("MAI Image 2.5: $length(prompt)", () => {
  const f = `{"total_price": base_price + 100 * $ceil(($length(prompt) * 10) / 100)}`;
  assert.equal(evaluateFormula(f, { base_price: 50000, prompt: "hello" }), 50100);
});

test("multi-line formula bodies parse (P-Video 2 Pro text-to-video)", () => {
  const f = `{\n  "total_price": base_price * $min([15, ($exists(duration) ? duration : 5)]) * (resolution = "480p" ? (mode = "cost" ? 0.5 : mode = "quality" ? 2 : 1) : (mode = "cost" ? 1.25 : mode = "quality" ? 3.75 : 1.75))\n}`;
  assert.equal(evaluateFormula(f, { base_price: 20000, resolution: "720p", mode: "quality", duration: 8 }), 600000);
});

test("single-quoted strings (Kandinsky 5 Pro)", () => {
  const f = `{"total_price": base_price * (resolution = '1024P' ? 3 : 1) / 5 * duration}`;
  assert.equal(evaluateFormula(f, { base_price: 100000, resolution: "1024P", duration: 10 }), 600000);
});

test("refuses anything outside the formula language (no eval, no property walking)", () => {
  assert.throws(() => evaluateFormula(`{"total_price": $eval("1")}`, {}));
  assert.throws(() => evaluateFormula(`{"total_price": constructor.name}`, {}));
  assert.throws(() => evaluateFormula(`{"total_price": 1 +}`, {}));
  assert.equal(evaluateFormula(`{"total_price": $count(constructor)}`, {}), 0, "fields resolve to own data only");
});

test("every published formula in the generated table compiles", () => {
  assert.ok(PRICING_FORMULAS.length > 100, `only ${PRICING_FORMULAS.length} formulas`);
  for (const f of PRICING_FORMULAS) compileFormula(f);
});

// ── Per-request pricing from the payload the app actually sends ──
test("GPT Image 2 at high quality, 4K: price follows the settings (x discount)", () => {
  near(priceRequest(model("openai/gpt-image-2/text-to-image"), payloadFor("openai/gpt-image-2/text-to-image", { quality: "high", resolution: "4k" })), 0.684);
  near(priceRequest(model("openai/gpt-image-2/text-to-image"), payloadFor("openai/gpt-image-2/text-to-image")), 0.057, "default settings");
});

test("Phota 4K with a native batch of 2 costs 4x one default image", () => {
  near(priceRequest(model("wavespeed-ai/phota/text-to-image"), payloadFor("wavespeed-ai/phota/text-to-image", { resolution: "4K", numImages: 2 })), 0.36);
});

test("Flux Schnell x4 native matches the live charge ($0.012)", () => {
  near(priceRequest(model("wavespeed-ai/flux-schnell"), payloadFor("wavespeed-ai/flux-schnell", { numImages: 4 })), 0.012);
});

test("Veo 3.1 at 4 s, 720p, audio off", () => {
  near(priceRequest(model("google/veo3.1/text-to-video"), payloadFor("google/veo3.1/text-to-video", { duration: 4, resolution: "720p", generateAudio: false })), 0.8);
});

test("Nano Banana 2.1 edit: 3 inputs, 2K, web search (x 90% discount)", () => {
  const settings = { sourceImageUrl: "https://x/a.png", sourceImageUrls: ["https://x/b.png", "https://x/c.png"], resolution: "2k", enableWebSearch: true };
  near(priceRequest(model("google/nano-banana-2.1/edit"), payloadFor("google/nano-banana-2.1/edit", settings)), 0.072);
});

test("Kling V3.0 Pro: 10 s with sound", () => {
  near(priceRequest(model("kwaivgi/kling-v3.0-pro/text-to-video"), payloadFor("kwaivgi/kling-v3.0-pro/text-to-video", { duration: 10, sound: true })), 1.68);
});

test("input-length pricing uses the measured media duration, else falls back to the static price", () => {
  const m = model("bytedance/seedance-2.0/video-edit");
  const payload = payloadFor(m.id, { sourceVideoUrl: "https://x/v.mp4" });
  near(priceRequest(m, payload, { mediaDuration: url => url === "https://x/v.mp4" ? 7.2 : undefined }), 2.16);
  assert.equal(priceRequest(m, payload), null);
  near(requestCost(m, payload), m.price, "fallback");
});

test("a model with no published formula keeps its static price per image", () => {
  const unknown = { id: "nobody/unpriced", price: 0.05, params: {} };
  assert.equal(priceRequest(unknown, { prompt: "x" }), null);
  near(requestCost(unknown, { prompt: "x" }, { imagesPerRequest: 3 }), 0.15);
});

test("requestCost never double-counts a native batch the formula already prices", () => {
  const m = model("wavespeed-ai/flux-schnell");
  near(requestCost(m, payloadFor(m.id, { numImages: 4 }), { imagesPerRequest: 4 }), 0.012);
});

// Registry `price` is defined as one generation at the app's defaults, so the formula must reproduce it.
test("every formula-priced model reproduces its registry price at default settings", () => {
  const off = [];
  let checked = 0;
  for (const [category, list] of Object.entries(MODELS)) for (const m of list) {
    const entry = MODEL_PRICING[m.id];
    if (!entry?.formula && entry?.formula !== 0) continue;
    if (/get_duration/.test(PRICING_FORMULAS[entry.formula])) continue; // input-length priced: registry holds the "starts at" price
    const settings = { ...SETTINGS, prompt: "Public schema audit",
      resolution: m.params?.resolution?.default, duration: m.params?.duration?.default,
      sourceImageUrl: ["i2i", "i2v", "i23d", "avatar"].includes(category) ? "https://x/a.png" : "" };
    const price = priceRequest(m, buildPayload(m, settings, category));
    checked++;
    if (price === null || Math.abs(price - m.price) > 0.0005) off.push(`${m.id}: registry ${m.price}, formula ${price}`);
  }
  assert.ok(checked > 150, `only ${checked} models checked`);
  assert.deepEqual(off, []);
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
