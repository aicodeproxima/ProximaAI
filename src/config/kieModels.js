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

// ─── Added 2026-10-26: kie.ai's top image and video models (owner: "Make sure we have all the top video and image models
// on Kie ai"; research wf_a22c1d11-56c over kie.ai's market and price list, read 2026-10-26). Schemas in the fixture. ───
const imgCount = (i, f) => (Array.isArray(i[f]) ? i[f].length : 0);
const vid = (values, labels = {}) => opts(values, v => labels[v] || v);
const nano21 = {
  kieModel: "nano-banana-2-1", provider: "Google", price: 0.02,
  params: { resolution: RES_K, aspectRatio: ar("aspect_ratio", NANO2_AR, "auto"), negativePrompt: false, seed: false },
  kie: { fields: ["prompt", "image_input", "aspect_ratio", "resolution", "output_format"], maxItems: { image_input: 10 },
    maxLength: { prompt: 20000 }, credits: i => ({ "1K": 4, "2K": 6, "4K": 9 })[i.resolution || "1K"] },
};
// GPT Image 2.5 (Sunburst: quality, Flare: speed; the same price). 27:16, 16:27, 9:8 and 8:9 are 1K only: auto above it.
const GPT25_AR = ["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9", "27:16", "16:27", "9:8", "8:9"];
const GPT25_1K_ONLY = ["27:16", "16:27", "9:8", "8:9"];
const gpt25 = {
  provider: "OpenAI", price: 0.03,
  params: { resolution: RES_K, aspectRatio: ar("aspect_ratio", GPT25_AR, "auto"), negativePrompt: false, seed: false, outputFormat: false },
  kie: { fields: ["prompt", "input_urls", "aspect_ratio", "resolution"], maxItems: { input_urls: 16 }, maxLength: { prompt: 20000 },
    fix: i => (i.resolution && i.resolution !== "1K" && GPT25_1K_ONLY.includes(i.aspect_ratio) ? { aspect_ratio: "auto" } : {}),
    credits: i => ({ "1K": 6, "2K": 10, "4K": 16 })[i.resolution || "1K"] },
};
// Seedream 5.0 Pro: quality is its size (basic 1K, high 2K); an edit's input images after the first cost 0.5 credits each
// (kie.ai's row "input image, First image free"). Aspect ratio and quality are required, with no default: always sent.
const seedreamPro = {
  provider: "ByteDance", price: 0.035,
  params: { resolution: { paramName: "quality", options: [{ label: "Basic (1K)", value: "basic" }, { label: "High (2K)", value: "high" }], default: "basic", exact: true },
    aspectRatio: ar("aspect_ratio", SEEDREAM_AR, "1:1"), negativePrompt: false, seed: false },
  kie: { fields: ["prompt", "image_urls", "aspect_ratio", "quality"], maxItems: { image_urls: 10 }, maxLength: { prompt: 5000 },
    credits: i => (i.quality === "high" ? 14 : 7) + 0.5 * Math.max(0, imgCount(i, "image_urls") - 1) },
};
const seedreamFlash = {
  provider: "ByteDance", price: 0.0162,
  params: { resolution: { paramName: "size", options: opts(["1K", "1.5K", "2K"]), default: "1K", exact: true },
    aspectRatio: ar("aspect_ratio", SEEDREAM_AR, "1:1"), negativePrompt: false, seed: false },
  kie: { fields: ["prompt", "image_urls", "aspect_ratio", "size"], maxItems: { image_urls: 10 }, maxLength: { prompt: 5000 }, credits: () => 3.24 },
};
const FLUX3_AR = ["1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16", "21:9", "9:21"];
const flux3 = {
  provider: "Black Forest Labs", price: 0.008,
  params: { resolution: RES_K, aspectRatio: ar("aspect_ratio", FLUX3_AR, "1:1"), negativePrompt: false, seed: false },
  kie: { fields: ["prompt", "image_urls", "aspect_ratio", "resolution"], maxItems: { image_urls: 10 }, maxLength: { prompt: 5000 },
    credits: i => ({ "1K": 1.6, "2K": 2.5, "4K": 6.5 })[i.resolution || "1K"] },
};
const grokImage = {
  provider: "xAI", price: 0.02,
  params: { aspectRatio: ar("aspect_ratio", ["1:1", "2:3", "3:2", "16:9", "9:16"], "1:1"), negativePrompt: false, seed: false },
  kie: { fields: ["prompt", "image_urls", "aspect_ratio"], maxItems: { image_urls: 5 }, maxLength: { prompt: 8000 }, credits: () => 4 },
};
// Qwen Image 3.0 Pro: its aspect field is image_size; an edit pays 0.5 credits per input image (kie.ai's "input" rows).
const qwen3Pro = {
  provider: "Alibaba", price: 0.032,
  params: { resolution: { paramName: "resolution", options: opts(["1K", "2K"]), default: "1K", exact: true },
    aspectRatio: ar("image_size", ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9"], "16:9"), negativePrompt: true, seed: false },
  kie: { fields: ["prompt", "image_urls", "resolution", "image_size", "negative_prompt"], maxItems: { image_urls: 3 },
    maxLength: { prompt: 5000, negative_prompt: 5000 }, credits: i => (i.resolution === "2K" ? 12 : 6.4) + 0.5 * imgCount(i, "image_urls") },
};
// Wan 2.7 Image Pro makes 4 images per request unless told (kie.ai's default n): the app makes its own batches, one each.
const wanImagePro = {
  kieModel: "wan/2-7-image-pro", provider: "Alibaba", price: 0.06,
  params: { resolution: { ...RES_K, default: "2K" }, aspectRatio: ar("aspect_ratio", ["1:1", "16:9", "4:3", "21:9", "3:4", "9:16", "8:1", "1:8"], "1:1"),
    negativePrompt: false, seed: false },
  kie: { fields: ["prompt", "input_urls", "aspect_ratio", "resolution", "n"], fixed: { n: 1 }, maxItems: { input_urls: 9 }, maxLength: { prompt: 5000 },
    credits: i => 12 * (Number(i.n) || 1) },
};
const FRAMES = { startEndFrames: true, startImageParam: "first_frame_url", endImageParam: "last_frame_url" };
// Seedance 2.5: per second by size, kie.ai's "no video" rows (the app sends no reference video).
const SEEDANCE25_PER_S = { "480p": 28, "720p": 63, "1080p": 158 };
const seedance25 = {
  kieModel: "bytedance/seedance-2-5", provider: "ByteDance", price: 1.575,
  params: { resolution: { paramName: "resolution", options: vid(["480p", "720p", "1080p"]), default: "720p", exact: true,
      aliases: { "360p": "480p", "540p": "720p", "768p": "720p", "1024p": "1080p", "1440p": "1080p", "2k": "1080p", "4k": "1080p" } },
    aspectRatio: ar("aspect_ratio", ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive"], "adaptive"),
    duration: { options: range(4, 15), default: 5 }, negativePrompt: false, seed: false,
    optional: { generateAudio: { paramName: "generate_audio", type: "boolean", default: true } } },
  kie: { fields: ["prompt", "first_frame_url", "last_frame_url", "generate_audio", "resolution", "aspect_ratio", "duration"],
    maxLength: { prompt: 20480 }, credits: i => (SEEDANCE25_PER_S[i.resolution] || SEEDANCE25_PER_S["720p"]) * Number(i.duration || 5) },
};
// Veo 3.1: one entry per tier (Lite, Fast, Quality): kie.ai's price is per video by tier and size, at 4, 6 or 8 s.
const VEO_PER_VIDEO = { veo3_lite: { "720p": 30, "1080p": 35, "4k": 150 }, veo3_fast: { "720p": 60, "1080p": 65, "4k": 180 },
  veo3: { "720p": 250, "1080p": 255, "4k": 370 } };
const veo = (tier, price, generationType) => ({
  kieModel: "veo-3-1", provider: "Google", price,
  params: { resolution: { paramName: "resolution", options: vid(["720p", "1080p", "4k"], { "4k": "4K" }), default: "720p", exact: true,
      aliases: { "480p": "720p", "540p": "720p", "768p": "720p", "1440p": "1080p", "2k": "1080p" } },
    aspectRatio: ar("aspect_ratio", ["16:9", "9:16", "Auto"], "16:9"), duration: { options: [4, 6, 8], default: 8 }, negativePrompt: false, seed: false },
  kie: { fields: ["prompt", "model", "generation_type", "image_urls", "aspect_ratio", "resolution", "duration"],
    fixed: { model: tier, generation_type: generationType }, maxItems: { image_urls: 2 },
    credits: i => VEO_PER_VIDEO[tier][i.resolution] ?? VEO_PER_VIDEO[tier]["720p"] },
});
// Kling 4.0 (keyframe-to-video): text-to-video without a frame, image-to-video from a first (and last) frame.
const KLING4_PER_S = { "720p": 28.5, "1080p": 42.5 };
const kling4 = {
  kieModel: "kling-4.0/keyframe-to-video", provider: "Kwaivgi", price: 0.7125,
  params: { resolution: { paramName: "resolution", options: vid(["720p", "1080p"]), default: "720p", exact: true,
      aliases: { "480p": "720p", "540p": "720p", "768p": "720p", "1440p": "1080p", "2k": "1080p", "4k": "1080p" } },
    aspectRatio: ar("aspect_ratio", ["auto", "16:9", "9:16", "1:1", "21:9"], "16:9"), duration: { options: range(3, 30), default: 5 },
    negativePrompt: false, seed: false },
  kie: { fields: ["prompt", "duration", "resolution", "aspect_ratio", "first_frame_url", "last_frame_url"], maxLength: { prompt: 8000 },
    credits: i => (KLING4_PER_S[i.resolution] || KLING4_PER_S["720p"]) * Number(i.duration || 5) },
};
// Wan 3.0 (and Prime): per second by size; kie.ai's sizes are upper-case ("1080P"); 2 to 30 s without a video input.
const WAN3_PER_S = { "480P": 8, "720P": 16, "1080P": 32 }, WAN3_PRIME_PER_S = { "480P": 12.2, "720P": 25.2, "1080P": 50.4 };
const wan3Res = { paramName: "resolution", options: [{ label: "480p", value: "480P" }, { label: "720p", value: "720P" }, { label: "1080p", value: "1080P" }],
  default: "1080P", exact: true,
  aliases: { "360p": "480P", "480p": "480P", "540p": "720P", "720p": "720P", "768p": "720P", "1080p": "1080P", "1440p": "1080P", "2k": "1080P", "4k": "1080P" } };
const wan3 = (kieModel, perS, price) => ({
  kieModel, provider: "Alibaba", price,
  params: { resolution: wan3Res, aspectRatio: ar("aspect_ratio", ["adaptive", "16:9", "4:3", "1:1", "3:4", "9:16"], "adaptive"),
    duration: { options: range(2, 30), default: 5 }, negativePrompt: false, seed: false,
    optional: { audio: { paramName: "audio", type: "boolean", default: true } } },
  kie: { fields: ["prompt", "first_frame_url", "last_frame_url", "resolution", "aspect_ratio", "duration", "audio"], maxLength: { prompt: 20000 },
    credits: i => (perS[i.resolution] || perS["1080P"]) * Number(i.duration || 5) },
});
// Gemini Omni Flash 1.1: per video by duration (4/6/8/10 s; kie.ai types it a string); 4K costs more.
const OMNI_CREDITS = { 4: [63, 147], 6: [84, 168], 8: [105, 189], 10: [126, 210] };
const omni = {
  kieModel: "google/gemini-omni-flash-1-1", provider: "Google", price: 0.42,
  params: { resolution: { paramName: "resolution", options: vid(["360p", "720p", "1080p", "4k"], { "4k": "4K" }), default: "720p", exact: true,
      aliases: { "480p": "360p", "540p": "720p", "768p": "720p", "1440p": "1080p", "2k": "1080p" } },
    aspectRatio: ar("aspect_ratio", ["16:9", "9:16"], "16:9"), duration: { options: [4, 6, 8, 10], default: 6 }, negativePrompt: false, seed: false },
  kie: { fields: ["prompt", "first_frame_url", "last_frame_url", "duration", "aspect_ratio", "resolution"], strings: ["duration"],
    maxLength: { prompt: 20000 }, credits: i => (OMNI_CREDITS[Number(i.duration) || 6] || OMNI_CREDITS[6])[i.resolution === "4k" ? 1 : 0] },
};
const PIXVERSE_PER_S = { "360p": [4.8, 7.2], "540p": [7.2, 8.8], "720p": [8.8, 12], "1080p": [17.6, 22.4] };
const pixverse = {
  provider: "PixVerse", price: 0.22,
  params: { resolution: { paramName: "quality", options: vid(["360p", "540p", "720p", "1080p"]), default: "720p", exact: true,
      aliases: { "480p": "540p", "768p": "720p", "1440p": "1080p", "2k": "1080p", "4k": "1080p" } },
    duration: { options: range(1, 15), default: 5 }, negativePrompt: false, seed: false,
    optional: { generateAudio: { paramName: "generate_audio_switch", type: "boolean", default: false } } },
  kie: { fields: ["prompt", "image_urls", "aspect_ratio", "quality", "duration", "generate_audio_switch"], maxItems: { image_urls: 1 },
    maxLength: { prompt: 5000 }, credits: i => (PIXVERSE_PER_S[i.quality] || PIXVERSE_PER_S["720p"])[i.generate_audio_switch ? 1 : 0] * Number(i.duration || 5) },
};
const MINIMAX_PER_S = { "768P": 8, "2K": 13 };
const minimax = {
  provider: "MiniMax", price: 0.39,
  params: { resolution: { paramName: "resolution", options: [{ label: "768p", value: "768P" }, { label: "2K", value: "2K" }], default: "2K", exact: true,
      aliases: { "480p": "768P", "540p": "768P", "720p": "768P", "768p": "768P", "1080p": "2K", "1440p": "2K", "2k": "2K", "4k": "2K" } },
    duration: { options: range(4, 15), default: 6 }, negativePrompt: false, seed: false },
  kie: { fields: ["prompt", "aspect_ratio", "first_frame_url", "last_frame_url", "duration", "resolution"], maxLength: { prompt: 7000 },
    credits: i => (MINIMAX_PER_S[i.resolution] || MINIMAX_PER_S["2K"]) * Number(i.duration || 6) },
};
const HAPPYHORSE_PER_S = { "720p": 22.5, "1080p": 29 };
const happyhorse = {
  provider: "Alibaba", price: 0.725,
  params: { resolution: { paramName: "resolution", options: vid(["720p", "1080p"]), default: "1080p", exact: true,
      aliases: { "480p": "720p", "540p": "720p", "768p": "720p", "1440p": "1080p", "2k": "1080p", "4k": "1080p" } },
    duration: { options: range(3, 15), default: 5 }, negativePrompt: false, seed: false },
  kie: { fields: ["prompt", "image_urls", "resolution", "aspect_ratio", "duration"], maxItems: { image_urls: 1 }, maxLength: { prompt: 5000 },
    credits: i => (HAPPYHORSE_PER_S[i.resolution] || HAPPYHORSE_PER_S["1080p"]) * Number(i.duration || 5) },
};
const VIDU_PER_S = { "540p": 7.2, "720p": 15.2, "1080p": 19.2, "2k": 30.4, "4k": 62.4 };
const drop = (k, ...fields) => ({ ...k, fields: k.fields.filter(f => !fields.includes(f)) });

export const KIE_MODELS = {
  image: [
    { id: "kie/nano-banana-2/text-to-image", name: "Nano Banana 2 · kie.ai", ...nano2 },
    { id: "kie/nano-banana-pro/text-to-image", name: "Nano Banana Pro · kie.ai", ...nanoPro },
    { id: "kie/seedream-5-lite/text-to-image", name: "Seedream 5.0 Lite · kie.ai", kieModel: "seedream/5-lite-text-to-image", ...seedreamLite,
      kie: { ...seedreamLite.kie, fields: seedreamLite.kie.fields.filter(x => x !== "image_urls") } },
    { id: "kie/gpt-image-2/text-to-image", name: "GPT Image 2 · kie.ai", kieModel: "gpt-image-2-text-to-image", ...gpt2,
      kie: { ...gpt2.kie, fields: gpt2.kie.fields.filter(x => x !== "input_urls") } },
    { id: "kie/nano-banana-2.1/text-to-image", name: "Nano Banana 2.1 · kie.ai", ...nano21 },
    { id: "kie/gpt-image-2.5-sunburst/text-to-image", name: "GPT Image 2.5 Sunburst · kie.ai", kieModel: "gpt-image-2-5-sunburst-text-to-image", ...gpt25,
      kie: drop(gpt25.kie, "input_urls") },
    { id: "kie/gpt-image-2.5-flare/text-to-image", name: "GPT Image 2.5 Flare · kie.ai", kieModel: "gpt-image-2-5-flare-text-to-image", ...gpt25,
      kie: drop(gpt25.kie, "input_urls") },
    { id: "kie/seedream-5-pro/text-to-image", name: "Seedream 5.0 Pro · kie.ai", kieModel: "seedream/5-pro-text-to-image", ...seedreamPro,
      kie: drop(seedreamPro.kie, "image_urls") },
    { id: "kie/seedream-5-flash/text-to-image", name: "Seedream 5.0 Flash · kie.ai", kieModel: "seedream/5-flash-text-to-image", ...seedreamFlash,
      kie: drop(seedreamFlash.kie, "image_urls") },
    { id: "kie/flux-3-klein/text-to-image", name: "Flux 3 Klein · kie.ai", kieModel: "flux-3/klein-text-to-image", ...flux3, kie: drop(flux3.kie, "image_urls") },
    { id: "kie/grok-imagine-image-2.0/text-to-image", name: "Grok Imagine Image 2.0 · kie.ai", kieModel: "grok-imagine-image-2-0/text-to-image", ...grokImage,
      kie: drop(grokImage.kie, "image_urls") },
    { id: "kie/qwen-image-3.0-pro/text-to-image", name: "Qwen Image 3.0 Pro · kie.ai", kieModel: "qwen3/pro-text-to-image", ...qwen3Pro,
      kie: drop(qwen3Pro.kie, "image_urls") },
    { id: "kie/wan-2.7-image-pro/text-to-image", name: "Wan 2.7 Image Pro · kie.ai", ...wanImagePro, kie: drop(wanImagePro.kie, "input_urls") },
  ],
  i2i: [
    { id: "kie/nano-banana-2/edit", name: "Nano Banana 2 Edit · kie.ai", ...nano2, params: { ...nano2.params, imageParam: "image_input", maxImages: 10 } },
    { id: "kie/nano-banana-pro/edit", name: "Nano Banana Pro Edit · kie.ai", ...nanoPro, params: { ...nanoPro.params, imageParam: "image_input", maxImages: 8 } },
    { id: "kie/seedream-5-lite/edit", name: "Seedream 5.0 Lite Edit · kie.ai", kieModel: "seedream/5-lite-image-to-image", ...seedreamLite,
      params: { ...seedreamLite.params, imageParam: "image_urls", maxImages: 14 } },
    { id: "kie/gpt-image-2/edit", name: "GPT Image 2 Edit · kie.ai", kieModel: "gpt-image-2-image-to-image", ...gpt2, params: { ...gpt2.params, imageParam: "input_urls", maxImages: 16 } },
    { id: "kie/nano-banana-2.1/edit", name: "Nano Banana 2.1 Edit · kie.ai", ...nano21, params: { ...nano21.params, imageParam: "image_input", maxImages: 10 } },
    { id: "kie/gpt-image-2.5-sunburst/edit", name: "GPT Image 2.5 Sunburst Edit · kie.ai", kieModel: "gpt-image-2-5-sunburst-image-to-image", ...gpt25,
      params: { ...gpt25.params, imageParam: "input_urls", maxImages: 16 } },
    { id: "kie/gpt-image-2.5-flare/edit", name: "GPT Image 2.5 Flare Edit · kie.ai", kieModel: "gpt-image-2-5-flare-image-to-image", ...gpt25,
      params: { ...gpt25.params, imageParam: "input_urls", maxImages: 16 } },
    { id: "kie/seedream-5-pro/edit", name: "Seedream 5.0 Pro Edit · kie.ai", kieModel: "seedream/5-pro-image-to-image", ...seedreamPro,
      params: { ...seedreamPro.params, imageParam: "image_urls", maxImages: 10 } },
    { id: "kie/seedream-5-flash/edit", name: "Seedream 5.0 Flash Edit · kie.ai", kieModel: "seedream/5-flash-image-to-image", ...seedreamFlash,
      params: { ...seedreamFlash.params, imageParam: "image_urls", maxImages: 10 } },
    { id: "kie/flux-3-klein/edit", name: "Flux 3 Klein Edit · kie.ai", kieModel: "flux-3/klein-edit-image", ...flux3,
      params: { ...flux3.params, aspectRatio: ar("aspect_ratio", [...FLUX3_AR, "auto"], "auto"), imageParam: "image_urls", maxImages: 10 } },
    { id: "kie/grok-imagine-image-2.0/edit", name: "Grok Imagine Image 2.0 Edit · kie.ai", kieModel: "grok-imagine-image-2-0/image-edit", ...grokImage,
      params: { ...grokImage.params, aspectRatio: ar("aspect_ratio", ["1:1", "2:3", "3:2", "16:9", "9:16", "auto"], "auto"), imageParam: "image_urls", maxImages: 5 } },
    { id: "kie/qwen-image-3.0-pro/edit", name: "Qwen Image 3.0 Pro Edit · kie.ai", kieModel: "qwen3/pro-image-to-image", ...qwen3Pro, price: 0.0345,
      params: { ...qwen3Pro.params, imageParam: "image_urls", maxImages: 3 } },
    { id: "kie/wan-2.7-image-pro/edit", name: "Wan 2.7 Image Pro Edit · kie.ai", ...wanImagePro, params: { ...wanImagePro.params, imageParam: "input_urls", maxImages: 9 } },
  ],
  t2v: [
    { id: "kie/kling-3.0/text-to-video", name: "Kling 3.0 · kie.ai", ...kling },
    { id: "kie/seedance-2/text-to-video", name: "Seedance 2.0 · kie.ai", ...seedance },
    { id: "kie/wan-2.7/text-to-video", name: "Wan 2.7 · kie.ai", kieModel: "wan/2-7-text-to-video", provider: "Alibaba", price: 0.6,
      params: { resolution: wanRes, aspectRatio: ar("ratio", ["16:9", "9:16", "1:1", "4:3", "3:4"], "16:9"), duration: { options: range(2, 15), default: 5 },
        negativePrompt: true, seed: true },
      kie: { fields: ["prompt", "negative_prompt", "resolution", "ratio", "duration", "seed"], maxLength: WAN_MAX, credits: wanCredits } },
    { id: "kie/seedance-2.5/text-to-video", name: "Seedance 2.5 · kie.ai", ...seedance25 },
    { id: "kie/veo-3.1-lite/text-to-video", name: "Veo 3.1 Lite · kie.ai", ...veo("veo3_lite", 0.15, "TEXT_2_VIDEO") },
    { id: "kie/veo-3.1-fast/text-to-video", name: "Veo 3.1 Fast · kie.ai", ...veo("veo3_fast", 0.3, "TEXT_2_VIDEO") },
    { id: "kie/veo-3.1/text-to-video", name: "Veo 3.1 · kie.ai", ...veo("veo3", 1.25, "TEXT_2_VIDEO") },
    { id: "kie/kling-4.0/text-to-video", name: "Kling 4.0 · kie.ai", ...kling4 },
    { id: "kie/wan-3.0/text-to-video", name: "Wan 3.0 · kie.ai", ...wan3("wan/3-0-video", WAN3_PER_S, 0.8) },
    { id: "kie/wan-3.0-prime/text-to-video", name: "Wan 3.0 Prime · kie.ai", ...wan3("wan/3-0-video-prime", WAN3_PRIME_PER_S, 1.26) },
    { id: "kie/gemini-omni-flash-1.1/text-to-video", name: "Gemini Omni Flash 1.1 · kie.ai", ...omni },
    { id: "kie/pixverse-v6-max/text-to-video", name: "PixVerse V6 Max · kie.ai", kieModel: "pixverse-v6-max/text-to-video", ...pixverse,
      params: { ...pixverse.params, aspectRatio: ar("aspect_ratio", ["16:9", "4:3", "1:1", "3:4", "9:16", "2:3", "3:2", "21:9"], "16:9") },
      kie: drop(pixverse.kie, "image_urls") },
    { id: "kie/minimax-h3/text-to-video", name: "MiniMax H3 · kie.ai", kieModel: "minimax-h3/text-to-video", ...minimax,
      params: { ...minimax.params, aspectRatio: ar("aspect_ratio", ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"], "16:9") },
      kie: drop(minimax.kie, "first_frame_url", "last_frame_url") },
    { id: "kie/happyhorse-1.1/text-to-video", name: "HappyHorse 1.1 · kie.ai", kieModel: "happyhorse-1-1/text-to-video", ...happyhorse,
      params: { ...happyhorse.params, aspectRatio: ar("aspect_ratio", ["16:9", "9:16", "1:1", "4:3", "3:4", "4:5", "5:4", "9:21", "21:9"], "16:9") },
      kie: drop(happyhorse.kie, "image_urls") },
  ],
  i2v: [
    { id: "kie/kling-3.0/image-to-video", name: "Kling 3.0 Image to Video · kie.ai", ...kling, params: { ...kling.params, imageParam: "image_urls" } },
    { id: "kie/seedance-2/image-to-video", name: "Seedance 2.0 Image to Video · kie.ai", ...seedance,
      params: { ...seedance.params, startEndFrames: true, startImageParam: "first_frame_url", endImageParam: "last_frame_url" } },
    { id: "kie/wan-2.7/image-to-video", name: "Wan 2.7 Image to Video · kie.ai", kieModel: "wan/2-7-image-to-video", provider: "Alibaba", price: 0.6,
      params: { resolution: wanRes, duration: { options: range(2, 15), default: 5 }, negativePrompt: true, seed: true,
        startEndFrames: true, startImageParam: "first_frame_url", endImageParam: "last_frame_url" },
      kie: { fields: ["prompt", "negative_prompt", "first_frame_url", "last_frame_url", "resolution", "duration", "seed"], maxLength: WAN_MAX, credits: wanCredits } },
    { id: "kie/seedance-2.5/image-to-video", name: "Seedance 2.5 Image to Video · kie.ai", ...seedance25, params: { ...seedance25.params, ...FRAMES } },
    { id: "kie/veo-3.1-lite/image-to-video", name: "Veo 3.1 Lite Image to Video · kie.ai", ...veo("veo3_lite", 0.15, "FIRST_AND_LAST_FRAMES_2_VIDEO"),
      params: { ...veo("veo3_lite", 0.15).params, imageParam: "image_urls" } },
    { id: "kie/veo-3.1-fast/image-to-video", name: "Veo 3.1 Fast Image to Video · kie.ai", ...veo("veo3_fast", 0.3, "FIRST_AND_LAST_FRAMES_2_VIDEO"),
      params: { ...veo("veo3_fast", 0.3).params, imageParam: "image_urls" } },
    { id: "kie/veo-3.1/image-to-video", name: "Veo 3.1 Image to Video · kie.ai", ...veo("veo3", 1.25, "FIRST_AND_LAST_FRAMES_2_VIDEO"),
      params: { ...veo("veo3", 1.25).params, imageParam: "image_urls" } },
    { id: "kie/kling-4.0/image-to-video", name: "Kling 4.0 Image to Video · kie.ai", ...kling4, params: { ...kling4.params, ...FRAMES } },
    { id: "kie/wan-3.0/image-to-video", name: "Wan 3.0 Image to Video · kie.ai", ...wan3("wan/3-0-video", WAN3_PER_S, 0.8),
      params: { ...wan3("wan/3-0-video", WAN3_PER_S, 0.8).params, ...FRAMES } },
    { id: "kie/wan-3.0-prime/image-to-video", name: "Wan 3.0 Prime Image to Video · kie.ai", ...wan3("wan/3-0-video-prime", WAN3_PRIME_PER_S, 1.26),
      params: { ...wan3("wan/3-0-video-prime", WAN3_PRIME_PER_S, 1.26).params, ...FRAMES } },
    { id: "kie/gemini-omni-flash-1.1/image-to-video", name: "Gemini Omni Flash 1.1 Image to Video · kie.ai", ...omni, params: { ...omni.params, ...FRAMES } },
    { id: "kie/grok-imagine-video-1.5/image-to-video", name: "Grok Imagine Video 1.5 · kie.ai", kieModel: "grok-imagine-video-1-5-preview", provider: "xAI", price: 0.096,
      params: { resolution: { paramName: "resolution", options: vid(["480p", "720p"]), default: "480p", exact: true,
          aliases: { "360p": "480p", "540p": "480p", "768p": "720p", "1080p": "720p", "1440p": "720p", "2k": "720p", "4k": "720p" } },
        aspectRatio: ar("aspect_ratio", ["auto", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"], "auto"), duration: { options: range(1, 15), default: 8 },
        negativePrompt: false, seed: false, imageParam: "image_urls" },
      // kie.ai's list has no 1080p price, so 1080p is not offered
      kie: { fields: ["prompt", "image_urls", "aspect_ratio", "resolution", "duration"], maxItems: { image_urls: 1 }, maxLength: { prompt: 4096 },
        credits: i => (i.resolution === "720p" ? 4.5 : 2.4) * Number(i.duration || 8) } },
    { id: "kie/pixverse-v6-max/image-to-video", name: "PixVerse V6 Max Image to Video · kie.ai", kieModel: "pixverse-v6-max/image-to-video", ...pixverse,
      params: { ...pixverse.params, imageParam: "image_urls" }, kie: drop(pixverse.kie, "aspect_ratio") },
    { id: "kie/minimax-h3/image-to-video", name: "MiniMax H3 Image to Video · kie.ai", kieModel: "minimax-h3/image-to-video", ...minimax,
      params: { ...minimax.params, ...FRAMES }, kie: drop(minimax.kie, "aspect_ratio") },
    // Vidu Q4 takes one image as a string (image_url)
    { id: "kie/vidu-q4/image-to-video", name: "Vidu Q4 Image to Video · kie.ai", kieModel: "vidu-q4/image-to-video", provider: "Vidu", price: 0.38,
      params: { resolution: { paramName: "resolution", options: vid(["540p", "720p", "1080p", "2k", "4k"], { "2k": "2K", "4k": "4K" }), default: "720p", exact: true,
          aliases: { "360p": "540p", "480p": "540p", "768p": "720p", "1440p": "2k" } },
        duration: { options: range(3, 16), default: 5 }, negativePrompt: false, seed: false,
        startEndFrames: true, startImageParam: "image_url",
        optional: { audio: { paramName: "audio", type: "boolean", default: true } } },
      kie: { fields: ["prompt", "image_url", "duration", "resolution", "audio"], maxLength: { prompt: 20000 },
        credits: i => (VIDU_PER_S[i.resolution] || VIDU_PER_S["720p"]) * Number(i.duration || 5) } },
    { id: "kie/happyhorse-1.1/image-to-video", name: "HappyHorse 1.1 Image to Video · kie.ai", kieModel: "happyhorse-1-1/image-to-video", ...happyhorse,
      params: { ...happyhorse.params, imageParam: "image_urls" }, kie: drop(happyhorse.kie, "aspect_ratio") },
  ],
};
for (const list of Object.values(KIE_MODELS)) for (const m of list) m.api = "kie";

const BY_ID = new Map(Object.values(KIE_MODELS).flat().map(m => [m.id, m]));
export const kieModelById = (id) => BY_ID.get(id) ?? null;
