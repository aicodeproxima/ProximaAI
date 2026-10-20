// Tests for src/lib/taskDraft.js — the cockpit's planned tasks, their prices, and the picker's per-model labels.
// Run: node scripts/test-task-draft.mjs
import assert from "node:assert/strict";
import { draftTask, unitQuote, taskUserSettings } from "../src/lib/taskDraft.js";
import { planImageBatchRequests } from "../src/lib/payloadBuilder.js";
import { MODELS } from "../src/config/models.js";

let n = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", e.message.split("\n").filter(Boolean).slice(0, 6).join(" | ")); }
};
const near = (actual, expected, msg) => assert.ok(Math.abs(actual - expected) < 1e-9, `${msg || ""} expected ${expected}, got ${actual}`);
const model = id => Object.values(MODELS).flat().find(m => m.id === id) || assert.fail(`no registry model ${id}`);
const FORM = {
  genType: "image", prompt: "a red fox in snow", negPrompt: "", resolution: "1k", duration: 5, seed: "-1", aspectRatio: "auto",
  sourceImageUrl: "", sourceImageUrls: [], perModelRes: {}, optionalParams: {}, briaPresets: {},
  endFrameUrl: "", refVideoUrl: "", sourceAudioUrl: "", sourceVideoUrl: "",
};
const form = extra => ({ ...FORM, ...extra });
const estimate = (models, numImages, f, opts) => planImageBatchRequests(models, numImages, f.genType)
  .reduce((sum, plan) => sum + draftTask(plan, f, opts).quote.cost, 0);

test("picker label follows the current settings (GPT Image 2 high quality, 4K)", () => {
  const q = unitQuote(model("openai/gpt-image-2/text-to-image"), form({ resolution: "4k", optionalParams: { quality: "high" } }));
  near(q.cost, 0.684);
  assert.equal(q.exact, true);
  near(unitQuote(model("openai/gpt-image-2/text-to-image"), form()).cost, 0.057, "default settings");
});

test("each model's label is the price that model would be sent: shared resolution coerced per model", () => {
  near(unitQuote(model("wavespeed-ai/phota/text-to-image"), form({ resolution: "4k" })).cost, 0.18, "4k -> Phota's 4K");
});

test("label is one generation: unchanged by the batch count, while the estimate scales", () => {
  const flux = model("wavespeed-ai/flux-schnell"), pImage = Object.values(MODELS).flat().find(m => /p-image/i.test(m.id) && !(m.params?.maxBatchImages > 1));
  near(unitQuote(flux, form()).cost, 0.003);
  near(estimate([flux], 4, form()), 0.012, "native batch of 4");
  assert.ok(pImage, "a fan-out (non-native) batch model");
  near(estimate([pImage], 2, form()), 2 * unitQuote(pImage, form()).cost, "fan-out batch of 2");
});

test("for every model in every tab, the label equals the estimate when it is the only model (batch 1)", () => {
  const off = [];
  let checked = 0;
  for (const [genType, list] of Object.entries(MODELS)) {
    const f = form({ genType, resolution: "1080p", duration: 10, sourceImageUrl: "https://x/a.png", sourceImageUrls: ["https://x/b.png"],
      sourceAudioUrl: "https://x/a.mp3", sourceVideoUrl: "https://x/v.mp4", refVideoUrl: "https://x/r.mp4", optionalParams: { generateAudio: false, sound: true } });
    for (const m of list) {
      checked++;
      const label = unitQuote(m, f, { mediaDuration: () => 7.5 }).cost, est = estimate([m], 1, f, { mediaDuration: () => 7.5 });
      if (Math.abs(label - est) > 1e-9) off.push(`${m.id}: label ${label}, estimate ${est}`);
    }
  }
  assert.ok(checked > 250, `only ${checked} models`);
  assert.deepEqual(off, []);
});

test("an input whose length is not measured yet gives a non-exact static label", () => {
  const m = model("bytedance/seedance-2.0/video-edit");
  const f = form({ genType: "v2v", resolution: "720p", sourceImageUrl: "https://x/v.mp4" });
  const pending = unitQuote(m, f);
  assert.equal(pending.exact, false);
  near(pending.cost, m.price);
  const measured = unitQuote(m, f, { mediaDuration: url => (url === "https://x/v.mp4" ? 7.2 : undefined) });
  assert.equal(measured.exact, true);
  near(measured.cost, 2.16);
});

test("draft task carries its quote as price, batch position and per-request seed", () => {
  const pImage = Object.values(MODELS).flat().find(m => /p-image/i.test(m.id) && !(m.params?.maxBatchImages > 1));
  const plans = planImageBatchRequests([pImage], 3, "image");
  const drafts = plans.map(plan => draftTask(plan, form({ seed: "100" }), { id: "t", batchId: "b" }));
  assert.deepEqual(drafts.map(d => d.task.seed), ["100", "101", "102"]);
  assert.deepEqual(drafts.map(d => d.task.batchImageIndex), [1, 2, 3]);
  for (const d of drafts) { assert.equal(d.task.price, d.quote.cost); assert.equal(d.task.batchId, "b"); assert.equal(d.task.id, "t"); assert.equal(d.task.numImages, 1); }
});

test("taskUserSettings sends a video-edit source as the source video", () => {
  const s = taskUserSettings({ genType: "v2v", sourceImageUrl: "https://x/v.mp4", optionalParams: { quality: "high" } });
  assert.equal(s.sourceVideoUrl, "https://x/v.mp4");
  assert.equal(s.quality, "high");
  assert.equal(taskUserSettings({ genType: "avatar", sourceVideoUrl: "https://x/d.mp4", sourceImageUrl: "https://x/a.png" }).sourceVideoUrl, "https://x/d.mp4");
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
