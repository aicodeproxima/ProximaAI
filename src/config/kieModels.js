// kie.ai starter models (docs/SECOND-ACCOUNT-PLAN.md K2). Shown only to an account that saved a kie.ai key.
// Each entry uses the app's param shapes (src/lib/payloadBuilder.js) under kie.ai's own field names, so buildPayload
// fills kie.ai's input directly; `kie` holds what src/lib/kie.js kieInput needs (the documented fields, fixes) and the
// price in kie.ai credits for one request. Fields, options and required fields are checked against kie.ai's request
// schemas (scripts/fixtures/kie-schemas.json) by scripts/test-kie-client.mjs; credits come from kie.ai's price list
// (POST https://api.kie.ai/client/v1/model-pricing/page, read 2026-10-25). `price` is dollars at default settings.
// Resolution options are `exact` (payloadBuilder.js chosenResolution): another model's value never maps by nearest number.

const opts = (values, label = v => v) => values.map(v => ({ label: label(v), value: v }));
const ar = (paramName, values, def) => ({ paramName, options: opts(values, v => v === "auto" ? "Auto" : v === "adaptive" ? "Adaptive" : v), default: def });
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const RES_K = { paramName: "resolution", options: opts(["1K", "2K", "4K"]), default: "1K", exact: true };

const NANO2_AR = ["auto", "1:1", "2:3", "3:2", "1:4", "4:1", "3:4", "4:3", "4:5", "5:4", "1:8", "8:1", "9:16", "16:9", "21:9"];
const NANOPRO_AR = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9", "auto"];
const SEEDREAM_AR = ["1:1", "4:3", "3:4", "16:9", "9:16", "2:3", "3:2", "21:9"];
const GPT2_NO_AR = { "2K": ["5:4", "4:5", "3:1", "1:3", "9:21"], "4K": ["3:1", "1:3", "9:21"] };
const GPT2_AR = ["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "3:1", "1:3", "21:9", "9:21"];

const nano2 = {
  kieModel: "nano-banana-2", provider: "Google", price: 0.04,
  params: { resolution: RES_K, aspectRatio: ar("aspect_ratio", NANO2_AR, "auto"), negativePrompt: false, seed: false },
  kie: { fields: ["prompt", "image_input", "aspect_ratio", "resolution", "output_format"], maxItems: { image_input: 10 },
    maxLength: { prompt: 20000 }, credits: i => ({ "1K": 8, "2K": 12, "4K": 18 })[i.resolution || "1K"] },
};
const nanoPro = {
  kieModel: "nano-banana-pro", provider: "Google", price: 0.09,
  params: { resolution: RES_K, aspectRatio: ar("aspect_ratio", NANOPRO_AR, "auto"), negativePrompt: false, seed: false },   // auto: an edit keeps its shape
  kie: { fields: ["prompt", "image_input", "aspect_ratio", "resolution", "output_format"], maxItems: { image_input: 8 },
    maxLength: { prompt: 20000 }, credits: i => (i.resolution === "4K" ? 24 : 18) },
};
const seedreamLite = {
  provider: "ByteDance", price: 0.0275,
  params: { resolution: { paramName: "quality", options: [{ label: "Basic", value: "basic" }, { label: "High", value: "high" }, { label: "Ultra", value: "ultra" }], default: "basic", exact: true },
    aspectRatio: ar("aspect_ratio", SEEDREAM_AR, "1:1"), negativePrompt: false, seed: false },
  kie: { fields: ["prompt", "image_urls", "aspect_ratio", "quality", "output_format"], maxItems: { image_urls: 14 },
    maxLength: { prompt: 2995 }, credits: () => 5.5 },
};
const gpt2 = {
  provider: "OpenAI", price: 0.03,
  params: { resolution: RES_K, aspectRatio: ar("aspect_ratio", GPT2_AR, "auto"), negativePrompt: false, seed: false, outputFormat: false },
  kie: { fields: ["prompt", "input_urls", "aspect_ratio", "resolution"], maxItems: { input_urls: 16 }, maxLength: { prompt: 20000 },
    // kie.ai's page: 2K does not support 5:4, 4:5, 3:1, 1:3 or 9:21, and 4K not 3:1, 1:3 or 9:21 (S3 review #6): auto then.
    fix: i => ((GPT2_NO_AR[i.resolution] || []).includes(i.aspect_ratio) ? { aspect_ratio: "auto" } : {}),
    credits: i => ({ "1K": 6, "2K": 10, "4K": 16 })[i.resolution || "1K"] },
};

// Kling 3.0: "mode" is its resolution (std 720p, pro 1080p, 4K); sound and multi_shots are required by kie.ai.
const KLING_PER_S = { std: [14, 20], pro: [18, 27], "4K": [67, 67] };
const kling = {
  kieModel: "kling-3.0/video", provider: "Kwaivgi", price: 0.35,
  params: { resolution: { paramName: "mode", options: [{ label: "720p (Standard)", value: "std" }, { label: "1080p (Pro)", value: "pro" }, { label: "4K", value: "4K" }], default: "std", exact: true },
    aspectRatio: ar("aspect_ratio", ["16:9", "9:16", "1:1"], "16:9"), duration: { options: range(3, 15), default: 5 },
    negativePrompt: false, seed: false,
    optional: { sound: { paramName: "sound", type: "boolean", default: false } } },
  kie: { fields: ["prompt", "image_urls", "sound", "duration", "aspect_ratio", "mode", "multi_shots"], strings: ["duration"],
    ensure: { sound: false }, fixed: { multi_shots: false }, maxItems: { image_urls: 2 }, maxLength: { prompt: 2500 },
    credits: i => (KLING_PER_S[i.mode] || KLING_PER_S.std)[i.sound ? 1 : 0] * Number(i.duration || 5) },
};
// Seedance 2: priced per second by resolution (kie.ai's "no video input" rows; the app sends no reference video).
const SEEDANCE_PER_S = { "480p": 19, "720p": 41, "1080p": 102, "4k": 208 };
const seedance = {
  kieModel: "bytedance/seedance-2", provider: "ByteDance", price: 1.025,
  params: { resolution: { paramName: "resolution", options: opts(["480p", "720p", "1080p", "4k"], v => v === "4k" ? "4K" : v), default: "720p", exact: true,
      aliases: { "360p": "480p", "540p": "720p", "768p": "720p", "1024p": "1080p", "1440p": "1080p", "2k": "1080p" } },
    aspectRatio: ar("aspect_ratio", ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive"], "16:9"),
    duration: { options: range(4, 15), default: 5 }, negativePrompt: false, seed: false,
    optional: { generateAudio: { paramName: "generate_audio", type: "boolean", default: true } } },
  kie: { fields: ["prompt", "first_frame_url", "last_frame_url", "generate_audio", "resolution", "aspect_ratio", "duration"],
    maxLength: { prompt: 20000 }, credits: i => (SEEDANCE_PER_S[i.resolution] || SEEDANCE_PER_S["720p"]) * Number(i.duration || 5) },
};
const WAN_PER_S = { "720p": 16, "1080p": 24 };
// The app's other p-sizes map to the nearest Wan offers (S3 verification #4: 480p went to the 1080p default, 1.5x the price).
const wanRes = { paramName: "resolution", options: opts(["720p", "1080p"]), default: "1080p", exact: true,
  aliases: { "360p": "720p", "480p": "720p", "540p": "720p", "768p": "720p", "1440p": "1080p", "2k": "1080p", "4k": "1080p" } };
const WAN_MAX = { prompt: 5000, negative_prompt: 500 };
const wanCredits = i => (WAN_PER_S[i.resolution] || WAN_PER_S["1080p"]) * Number(i.duration || 5);

export const KIE_MODELS = {
  image: [
    { id: "kie/nano-banana-2/text-to-image", name: "Nano Banana 2 · kie.ai", ...nano2 },
    { id: "kie/nano-banana-pro/text-to-image", name: "Nano Banana Pro · kie.ai", ...nanoPro },
    { id: "kie/seedream-5-lite/text-to-image", name: "Seedream 5.0 Lite · kie.ai", kieModel: "seedream/5-lite-text-to-image", ...seedreamLite,
      kie: { ...seedreamLite.kie, fields: seedreamLite.kie.fields.filter(x => x !== "image_urls") } },
    { id: "kie/gpt-image-2/text-to-image", name: "GPT Image 2 · kie.ai", kieModel: "gpt-image-2-text-to-image", ...gpt2,
      kie: { ...gpt2.kie, fields: gpt2.kie.fields.filter(x => x !== "input_urls") } },
  ],
  i2i: [
    { id: "kie/nano-banana-2/edit", name: "Nano Banana 2 Edit · kie.ai", ...nano2, params: { ...nano2.params, imageParam: "image_input", maxImages: 10 } },
    { id: "kie/nano-banana-pro/edit", name: "Nano Banana Pro Edit · kie.ai", ...nanoPro, params: { ...nanoPro.params, imageParam: "image_input", maxImages: 8 } },
    { id: "kie/seedream-5-lite/edit", name: "Seedream 5.0 Lite Edit · kie.ai", kieModel: "seedream/5-lite-image-to-image", ...seedreamLite,
      params: { ...seedreamLite.params, imageParam: "image_urls", maxImages: 14 } },
    { id: "kie/gpt-image-2/edit", name: "GPT Image 2 Edit · kie.ai", kieModel: "gpt-image-2-image-to-image", ...gpt2, params: { ...gpt2.params, imageParam: "input_urls", maxImages: 16 } },
  ],
  t2v: [
    { id: "kie/kling-3.0/text-to-video", name: "Kling 3.0 · kie.ai", ...kling },
    { id: "kie/seedance-2/text-to-video", name: "Seedance 2.0 · kie.ai", ...seedance },
    { id: "kie/wan-2.7/text-to-video", name: "Wan 2.7 · kie.ai", kieModel: "wan/2-7-text-to-video", provider: "Alibaba", price: 0.6,
      params: { resolution: wanRes, aspectRatio: ar("ratio", ["16:9", "9:16", "1:1", "4:3", "3:4"], "16:9"), duration: { options: range(2, 15), default: 5 },
        negativePrompt: true, seed: true },
      kie: { fields: ["prompt", "negative_prompt", "resolution", "ratio", "duration", "seed"], maxLength: WAN_MAX, credits: wanCredits } },
  ],
  i2v: [
    { id: "kie/kling-3.0/image-to-video", name: "Kling 3.0 Image to Video · kie.ai", ...kling, params: { ...kling.params, imageParam: "image_urls" } },
    { id: "kie/seedance-2/image-to-video", name: "Seedance 2.0 Image to Video · kie.ai", ...seedance,
      params: { ...seedance.params, startEndFrames: true, startImageParam: "first_frame_url", endImageParam: "last_frame_url" } },
    { id: "kie/wan-2.7/image-to-video", name: "Wan 2.7 Image to Video · kie.ai", kieModel: "wan/2-7-image-to-video", provider: "Alibaba", price: 0.6,
      params: { resolution: wanRes, duration: { options: range(2, 15), default: 5 }, negativePrompt: true, seed: true,
        startEndFrames: true, startImageParam: "first_frame_url", endImageParam: "last_frame_url" },
      kie: { fields: ["prompt", "negative_prompt", "first_frame_url", "last_frame_url", "resolution", "duration", "seed"], maxLength: WAN_MAX, credits: wanCredits } },
  ],
};
for (const list of Object.values(KIE_MODELS)) for (const m of list) m.api = "kie";

const BY_ID = new Map(Object.values(KIE_MODELS).flat().map(m => [m.id, m]));
export const kieModelById = (id) => BY_ID.get(id) ?? null;
