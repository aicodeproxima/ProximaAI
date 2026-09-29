// ─── PROVIDER COLORS ───
export const PROVIDER_COLORS = {
  Google: "#4285f4", ByteDance: "#fe2c55", OpenAI: "#10a37f", Alibaba: "#ff6a00",
  Kwaivgi: "#7c3aed", WaveSpeed: "#06b6d4", Vidu: "#ec4899", Minimax: "#f59e0b",
  BFL: "#a855f7", Luma: "#f472b6", PixVerse: "#22d3ee", Pika: "#fb923c",
  Runway: "#14b8a6", NVIDIA: "#76b900",
};

// Resolution presets for common schemes
const RES_NANO = {
  paramName: "resolution",
  options: [
    { label: "1K", value: "1k" },
    { label: "2K", value: "2k" },
    { label: "4K", value: "4k" },
  ],
  default: "1k",
};
const RES_NANO_2K = {
  paramName: "resolution",
  options: [
    { label: "2K", value: "2k" },
    { label: "4K", value: "4k" },
  ],
  default: "2k",
};
const RES_NANO_12 = {
  paramName: "resolution",
  options: [
    { label: "1K", value: "1k" },
    { label: "2K", value: "2k" },
  ],
  default: "1k",
};
const RES_FLUX = {
  paramName: "size",
  options: [
    { label: "512x512", value: "512*512" },
    { label: "768x768", value: "768*768" },
    { label: "1024x1024", value: "1024*1024" },
    { label: "1024x768 (4:3)", value: "1024*768" },
    { label: "768x1024 (3:4)", value: "768*1024" },
    { label: "1024x576 (16:9)", value: "1024*576" },
    { label: "576x1024 (9:16)", value: "576*1024" },
    { label: "1280x720 (HD)", value: "1280*720" },
    { label: "1536x1024", value: "1536*1024" },
  ],
  default: "1024*1024",
};
const RES_SEEDREAM = {
  paramName: "size",
  options: [
    { label: "1024x1024", value: "1024*1024" },
    { label: "2048x2048", value: "2048*2048" },
    { label: "1024x768", value: "1024*768" },
    { label: "768x1024", value: "768*1024" },
  ],
  default: "1024*1024",
};
const RES_SEEDREAM5 = {
  paramName: "size",
  options: [
    { label: "2048x2048 (1:1)", value: "2048*2048" },
    { label: "2560x1440 (16:9)", value: "2560*1440" },
    { label: "1440x2560 (9:16)", value: "1440*2560" },
    { label: "2048x1536 (4:3)", value: "2048*1536" },
    { label: "1536x2048 (3:4)", value: "1536*2048" },
    { label: "4096x4096", value: "4096*4096" },
  ],
  default: "2048*2048",
};
const RES_QWEN_PRO = {
  paramName: "size",
  options: [
    { label: "1024x1024 (1:1)", value: "1024*1024" },
    { label: "1024x576 (16:9)", value: "1024*576" },
    { label: "576x1024 (9:16)", value: "576*1024" },
    { label: "1024x768 (4:3)", value: "1024*768" },
    { label: "768x1024 (3:4)", value: "768*1024" },
    { label: "2048x2048", value: "2048*2048" },
  ],
  default: "1024*1024",
};
const RES_KANDINSKY = {
  paramName: "resolution",
  options: [
    { label: "512p", value: "512p" },
    { label: "1024p", value: "1024p" },
  ],
  default: "512p",
};
const AR_SEEDANCE = {
  paramName: "aspect_ratio",
  options: [
    { label: "21:9", value: "21:9" },
    { label: "16:9", value: "16:9" },
    { label: "4:3", value: "4:3" },
    { label: "1:1", value: "1:1" },
    { label: "3:4", value: "3:4" },
    { label: "9:16", value: "9:16" },
  ],
  default: "16:9",
};
const AR_KANDINSKY = {
  paramName: "aspect_ratio",
  options: [
    { label: "3:2", value: "3:2" },
    { label: "1:1", value: "1:1" },
    { label: "2:3", value: "2:3" },
  ],
  default: "3:2",
};
const RES_WAN_T2I = {
  paramName: "size",
  options: [
    { label: "1024x1024", value: "1024*1024" },
    { label: "768x1024", value: "768*1024" },
    { label: "1024x768", value: "1024*768" },
  ],
  default: "1024*1024",
};
const RES_VIDEO_720_1080 = {
  paramName: "resolution",
  options: [
    { label: "720p", value: "720p" },
    { label: "1080p", value: "1080p" },
  ],
  default: "720p",
};
const RES_VIDEO_720 = {
  paramName: "resolution",
  options: [{ label: "720p", value: "720p" }],
  default: "720p",
};
const RES_VIDEO_480 = {
  paramName: "resolution",
  options: [{ label: "480p", value: "480p" }],
  default: "480p",
};
const RES_VIDEO_WAN = {
  paramName: "size",
  options: [
    { label: "1280x720", value: "1280*720" },
    { label: "720x1280", value: "720*1280" },
    { label: "1920x1080", value: "1920*1080" },
    { label: "1080x1920", value: "1080*1920" },
    { label: "832x480", value: "832*480" },
    { label: "480x832", value: "480*832" },
  ],
  default: "1280*720",
};
const AR_STANDARD = {
  paramName: "aspect_ratio",
  options: [
    { label: "16:9", value: "16:9" },
    { label: "9:16", value: "9:16" },
    { label: "1:1", value: "1:1" },
    { label: "4:3", value: "4:3" },
    { label: "3:4", value: "3:4" },
  ],
  default: "16:9",
};
const AR_BRIA = {
  paramName: "aspect_ratio",
  options: [
    { label: "1:1", value: "1:1" },
    { label: "16:9", value: "16:9" },
    { label: "9:16", value: "9:16" },
    { label: "3:2", value: "3:2" },
    { label: "2:3", value: "2:3" },
    { label: "4:3", value: "4:3" },
    { label: "3:4", value: "3:4" },
    { label: "4:5", value: "4:5" },
    { label: "5:4", value: "5:4" },
  ],
  default: "1:1",
};
const AR_GPT = {
  paramName: "aspect_ratio",
  options: [
    { label: "1:1", value: "1:1" },
    { label: "16:9", value: "16:9" },
    { label: "9:16", value: "9:16" },
    { label: "3:2", value: "3:2" },
    { label: "2:3", value: "2:3" },
    { label: "3:4", value: "3:4" },
    { label: "4:3", value: "4:3" },
    { label: "4:5", value: "4:5" },
    { label: "5:4", value: "5:4" },
    { label: "21:9", value: "21:9" },
  ],
  default: "1:1",
};
const QUALITY_GPT = {
  paramName: "quality",
  options: [
    { label: "Low", value: "low" },
    { label: "Medium", value: "medium" },
    { label: "High", value: "high" },
  ],
  default: "low",
};
const AR_KLING = {
  paramName: "aspect_ratio",
  options: [
    { label: "16:9", value: "16:9" },
    { label: "9:16", value: "9:16" },
    { label: "1:1", value: "1:1" },
  ],
  default: "16:9",
};
const AR_VEO = {
  paramName: "aspect_ratio",
  options: [
    { label: "16:9", value: "16:9" },
    { label: "9:16", value: "9:16" },
  ],
  default: "16:9",
};
// ─── New presets for the 2026-06 model additions (Part B) ───
const RES_VIDEO_480_4K = {
  paramName: "resolution",
  options: [
    { label: "480p", value: "480p" }, { label: "720p", value: "720p" },
    { label: "1080p", value: "1080p" }, { label: "4K", value: "4k" },
  ],
  default: "720p",
};
const RES_VIDEO_480_1080 = {
  paramName: "resolution",
  options: [{ label: "480p", value: "480p" }, { label: "720p", value: "720p" }, { label: "1080p", value: "1080p" }],
  default: "720p",
};
const RES_VIDEO_480_720 = {
  paramName: "resolution",
  options: [{ label: "480p", value: "480p" }, { label: "720p", value: "720p" }],
  default: "480p",
};
const RES_COSMOS_I2V = {
  paramName: "resolution",
  options: [{ label: "256p", value: "256p" }, { label: "480p", value: "480p" }, { label: "720p", value: "720p" }],
  default: "480p",
};
const DUR_SEEDANCE = { options: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], default: 5 };
const DUR_KLING3 = { options: [3, 5, 10, 15], default: 5 };
const DUR_COSMOS = { options: [1, 2, 3, 4, 5, 6, 7], default: 5 };

// Current-generation WaveSpeed schemas use a shared set of wide image ratios.
const AR_IMAGE_WIDE = {
  paramName: "aspect_ratio",
  options: [
    { label: "1:1", value: "1:1" }, { label: "1:2", value: "1:2" },
    { label: "2:1", value: "2:1" }, { label: "1:3", value: "1:3" },
    { label: "3:1", value: "3:1" }, { label: "2:3", value: "2:3" },
    { label: "3:2", value: "3:2" }, { label: "3:4", value: "3:4" },
    { label: "4:3", value: "4:3" }, { label: "4:5", value: "4:5" },
    { label: "5:4", value: "5:4" }, { label: "9:16", value: "9:16" },
    { label: "16:9", value: "16:9" }, { label: "9:21", value: "9:21" },
    { label: "21:9", value: "21:9" },
  ],
  default: "1:1",
};
const AR_NANO2 = {
  paramName: "aspect_ratio",
  options: [
    { label: "1:1", value: "1:1" }, { label: "3:2", value: "3:2" },
    { label: "2:3", value: "2:3" }, { label: "3:4", value: "3:4" },
    { label: "4:3", value: "4:3" }, { label: "4:5", value: "4:5" },
    { label: "5:4", value: "5:4" }, { label: "9:16", value: "9:16" },
    { label: "16:9", value: "16:9" }, { label: "21:9", value: "21:9" },
    { label: "1:4", value: "1:4" }, { label: "4:1", value: "4:1" },
    { label: "1:8", value: "1:8" }, { label: "8:1", value: "8:1" },
  ],
  default: "1:1",
};
const AR_NANO_PRO = {
  ...AR_NANO2,
  options: AR_NANO2.options.filter(option => !["1:4", "4:1", "1:8", "8:1"].includes(option.value)),
};
const RES_PHOTA = {
  paramName: "resolution",
  options: [{ label: "1K", value: "1K" }, { label: "4K", value: "4K" }],
  default: "1K",
};
const AR_PHOTA = {
  paramName: "aspect_ratio",
  options: ["auto", "1:1", "16:9", "4:3", "3:4", "9:16"].map(value => ({ label: value, value })),
  default: "auto",
};
const AR_KLING_IMAGE = {
  paramName: "aspect_ratio",
  options: [
    { label: "16:9", value: "16:9" }, { label: "9:16", value: "9:16" },
    { label: "1:1", value: "1:1" }, { label: "4:3", value: "4:3" },
    { label: "3:4", value: "3:4" }, { label: "3:2", value: "3:2" },
    { label: "2:3", value: "2:3" }, { label: "21:9", value: "21:9" },
  ],
  default: "16:9",
};
const AR_WAN3 = {
  paramName: "aspect_ratio",
  options: [
    { label: "16:9", value: "16:9" }, { label: "9:16", value: "9:16" },
    { label: "1:1", value: "1:1" }, { label: "4:3", value: "4:3" },
    { label: "3:4", value: "3:4" },
  ],
  default: "16:9",
};
const AR_FLUX3 = {
  paramName: "aspect_ratio",
  options: [
    { label: "21:9", value: "21:9" }, { label: "2:1", value: "2:1" },
    { label: "16:9", value: "16:9" }, { label: "4:3", value: "4:3" },
    { label: "1:1", value: "1:1" }, { label: "3:4", value: "3:4" },
    { label: "9:16", value: "9:16" },
  ],
  default: "16:9",
};
const AR_H3 = {
  paramName: "aspect_ratio",
  options: [
    { label: "21:9", value: "21:9" }, { label: "16:9", value: "16:9" },
    { label: "4:3", value: "4:3" }, { label: "1:1", value: "1:1" },
    { label: "3:4", value: "3:4" }, { label: "9:16", value: "9:16" },
  ],
  default: "16:9",
};
const AR_H3_WS = {
  ...AR_H3,
  options: [...AR_H3.options, { label: "9:21", value: "9:21" }],
};
const AR_LUMA_SIZE = {
  paramName: "size",
  options: [
    { label: "16:9", value: "16:9" }, { label: "9:16", value: "9:16" },
    { label: "1:1", value: "1:1" }, { label: "4:3", value: "4:3" },
    { label: "3:4", value: "3:4" },
  ],
  default: "16:9",
};
const AR_LUMA_REFRAME = {
  ...AR_LUMA_SIZE,
  options: [...AR_LUMA_SIZE.options, { label: "21:9", value: "21:9" }],
};
const RES_IMAGE_1K_2K = {
  paramName: "resolution",
  options: [{ label: "1K", value: "1k" }, { label: "2K", value: "2k" }],
  default: "1k",
};
const RES_IMAGE_1K_15K_2K = {
  paramName: "resolution",
  options: [{ label: "1K", value: "1k" }, { label: "1.5K", value: "1.5k" }, { label: "2K", value: "2k" }],
  default: "1k",
};
const RES_IMAGE_1K_2K_4K = {
  paramName: "resolution",
  options: [{ label: "1K", value: "1k" }, { label: "2K", value: "2k" }, { label: "4K", value: "4k" }],
  default: "1k",
};
const RES_NANO2 = {
  paramName: "resolution",
  options: [
    { label: "0.5K", value: "0.5k" }, { label: "1K", value: "1k" },
    { label: "2K", value: "2k" }, { label: "4K", value: "4k" },
  ],
  default: "1k",
};
const RES_NANO2_FAST = {
  paramName: "resolution",
  options: [{ label: "2K", value: "2k" }, { label: "4K", value: "4k" }],
  default: "2k",
};
const RES_VIDEO_480_720_1080 = {
  paramName: "resolution",
  options: [{ label: "480p", value: "480p" }, { label: "720p", value: "720p" }, { label: "1080p", value: "1080p" }],
  default: "720p",
};
const RES_VIDEO_480_720_1080_4K = {
  paramName: "resolution",
  options: [...RES_VIDEO_480_720_1080.options, { label: "4K", value: "4k" }],
  default: "720p",
};
const RES_VIDEO_540_720_1080 = {
  paramName: "resolution",
  options: [{ label: "540p", value: "540p" }, { label: "720p", value: "720p" }, { label: "1080p", value: "1080p" }],
  default: "540p",
};
const RES_VIDEO_540_720_1080_DEFAULT_720 = {
  ...RES_VIDEO_540_720_1080,
  default: "720p",
};
const RES_VIDEO_360_540_720_1080 = {
  paramName: "resolution",
  options: [
    { label: "360p", value: "360p" }, { label: "540p", value: "540p" },
    { label: "720p", value: "720p" }, { label: "1080p", value: "1080p" },
  ],
  default: "720p",
};
const RES_VIDEO_720_1080_2K_4K = {
  paramName: "resolution",
  options: [
    { label: "720p", value: "720p" }, { label: "1080p", value: "1080p" },
    { label: "2K", value: "2k" }, { label: "4K", value: "4k" },
  ],
  default: "720p",
};
const RES_VIDEO_H3 = {
  paramName: "resolution",
  options: [{ label: "480p", value: "480p" }, { label: "540p", value: "540p" }, { label: "768p", value: "768p" }, { label: "1080p", value: "1080p" }],
  default: "480p",
};
const RES_VIDEO_H3_OFFICIAL = {
  paramName: "resolution",
  options: [{ label: "768p", value: "768p" }, { label: "2K", value: "2k" }],
  default: "768p",
};
const RES_VIDEO_FLUX3 = {
  paramName: "resolution",
  options: [{ label: "720p", value: "720p" }, { label: "1080p", value: "1080p" }],
  default: "720p",
};
const DUR_2_30 = Array.from({ length: 29 }, (_, i) => i + 2);
const DUR_1_15 = Array.from({ length: 15 }, (_, i) => i + 1);
const DUR_1_16 = Array.from({ length: 16 }, (_, i) => i + 1);
const DUR_3_15 = Array.from({ length: 13 }, (_, i) => i + 3);
const DUR_4_30 = Array.from({ length: 27 }, (_, i) => i + 4);
const DUR_5_20 = Array.from({ length: 16 }, (_, i) => i + 5);

// ─── MODEL REGISTRY ───
export const MODELS = {
  image: [
    // Google Nano Banana
    { id: "google/nano-banana-2/text-to-image", name: "Nano Banana 2", provider: "Google", price: 0.063, hot: true,
      params: { resolution: RES_NANO2, aspectRatio: AR_NANO2, negativePrompt: false, seed: false,
        optional: { enableWebSearch: { paramName: "enable_web_search", type: "boolean", default: false }, enableImageSearch: { paramName: "enable_image_search", type: "boolean", default: false } } } },
    { id: "google/nano-banana-2/text-to-image-fast", name: "Nano Banana 2 Fast", provider: "Google", price: 0.045, hot: true,
      params: { resolution: RES_NANO2_FAST, aspectRatio: AR_NANO2, negativePrompt: false, seed: false,
        optional: { enableWebSearch: { paramName: "enable_web_search", type: "boolean", default: false } } } },
    { id: "google/nano-banana-2-lite/text-to-image", name: "Nano Banana 2 Lite", provider: "Google", price: 0.04,
      params: { resolution: null, aspectRatio: AR_NANO2, negativePrompt: false, seed: false } },
    { id: "google/nano-banana-pro/text-to-image", name: "Nano Banana Pro", provider: "Google", price: 0.14, hot: true,
      params: { resolution: RES_NANO, aspectRatio: AR_NANO_PRO, negativePrompt: false, seed: false } },
    { id: "google/imagen4", name: "Imagen 4", provider: "Google", price: 0.08, hot: true,
      params: { resolution: RES_NANO_12, negativePrompt: true, seed: true } },

    // Flux
    { id: "wavespeed-ai/flux-dev", name: "Flux Dev", provider: "WaveSpeed", price: 0.03,
      params: { resolution: RES_FLUX, negativePrompt: false, seed: true, maxBatchImages: 4, optional: { numInferenceSteps: { paramName: "num_inference_steps", type: "number", default: 28, min: 1, max: 50 }, guidanceScale: { paramName: "guidance_scale", type: "number", default: 3.5, min: 0, max: 20 } } } },
    { id: "wavespeed-ai/flux-schnell", name: "Flux Schnell", provider: "WaveSpeed", price: 0.01, hot: true,
      params: { resolution: RES_FLUX, negativePrompt: false, seed: true, maxBatchImages: 4 } },
    { id: "wavespeed-ai/flux-2-klein-4b/text-to-image-lora", name: "FLUX 2 Klein 4B", provider: "BFL", price: 0.01,
      params: { resolution: RES_FLUX, negativePrompt: false, seed: true, outputFormat: false } },
    { id: "wavespeed-ai/flux-2-klein-9b/text-to-image", name: "FLUX 2 Klein 9B", provider: "BFL", price: 0.02,
      params: { resolution: RES_FLUX, negativePrompt: false, seed: true, outputFormat: false } },

    // ByteDance Seedream
    { id: "bytedance/seedream-v5.0-lite", name: "Seedream 5.0 Lite", provider: "ByteDance", price: 0.035, hot: true,
      params: { resolution: RES_SEEDREAM5, negativePrompt: false, seed: false } },
    { id: "bytedance/seedream-v5.0-lite/sequential", name: "Seedream 5.0 Sequential", provider: "ByteDance", price: 0.035,
      params: { resolution: RES_SEEDREAM5, negativePrompt: false, seed: false, optional: { maxImages: { paramName: "max_images", type: "number", default: 1, min: 1, max: 15 } } } },
    { id: "bytedance/seedream-v5.0-flash", name: "Seedream 5.0 Flash", provider: "ByteDance", price: 0.0243, hot: true,
      params: { resolution: RES_IMAGE_1K_15K_2K, aspectRatio: AR_IMAGE_WIDE, negativePrompt: false, seed: false } },
    { id: "bytedance/seedream-v5.0-pro", name: "Seedream 5.0 Pro", provider: "ByteDance", price: 0.0405, flagship: true,
      params: { resolution: RES_IMAGE_1K_15K_2K, aspectRatio: AR_IMAGE_WIDE, negativePrompt: false, seed: false,
        optional: { promptOptimizationMode: { paramName: "prompt_optimization_mode", type: "enum", values: ["standard", "fast"], default: "standard" } } } },
    { id: "bytedance/seedream-v4.5", name: "Seedream 4.5", provider: "ByteDance", price: 0.04,
      params: { resolution: RES_SEEDREAM, negativePrompt: false, seed: false, outputFormat: false } },

    // Alibaba
    { id: "alibaba/wan-2.6/text-to-image", name: "WAN 2.6", provider: "Alibaba", price: 0.02,
      params: { resolution: RES_WAN_T2I, negativePrompt: false, seed: true, outputFormat: false, optional: { enablePromptExpansion: { paramName: "enable_prompt_expansion", type: "boolean", default: false } } } },

    // WaveSpeed / Alibaba
    { id: "wavespeed-ai/qwen-image-2.0-pro/text-to-image", name: "Qwen Image 2.0 Pro", provider: "Alibaba", price: 0.07, hot: true,
      params: { resolution: RES_QWEN_PRO, negativePrompt: false, seed: true, outputFormat: false } },
    { id: "alibaba/qwen-image-3.0/text-to-image", name: "Qwen Image 3.0", provider: "Alibaba", price: 0.03, hot: true,
      params: { resolution: RES_IMAGE_1K_2K, aspectRatio: AR_IMAGE_WIDE, negativePrompt: false, seed: true, outputFormat: false,
        optional: { enablePromptExpansion: { paramName: "enable_prompt_expansion", type: "boolean", default: true } } } },
    { id: "alibaba/qwen-image-3.0-pro/text-to-image", name: "Qwen Image 3.0 Pro", provider: "Alibaba", price: 0.04, flagship: true,
      params: { resolution: RES_IMAGE_1K_2K, aspectRatio: AR_IMAGE_WIDE, negativePrompt: false, seed: true, outputFormat: false,
        optional: { enablePromptExpansion: { paramName: "enable_prompt_expansion", type: "boolean", default: true } } } },
    { id: "wavespeed-ai/qwen-image/text-to-image", name: "Qwen Image", provider: "Alibaba", price: 0.02,
      params: { resolution: RES_QWEN_PRO, negativePrompt: false, seed: true } },
    { id: "wavespeed-ai/phota/text-to-image", name: "Phota", provider: "WaveSpeed", price: 0.03,
      params: { resolution: RES_PHOTA, aspectRatio: AR_PHOTA, negativePrompt: false, seed: false, maxBatchImages: 4 } },

    // OpenAI
    { id: "openai/dall-e-3", name: "DALL-E 3", provider: "OpenAI", price: 0.08,
      params: { resolution: { paramName: "size", options: [{ label: "1024x1024", value: "1024*1024" }, { label: "1024x1792", value: "1024*1792" }, { label: "1792x1024", value: "1792*1024" }], default: "1024*1024" }, negativePrompt: false, seed: false, outputFormat: false } },

    // Luma
    { id: "luma/photon", name: "Luma Photon", provider: "Luma", price: 0.03,
      params: { resolution: null, negativePrompt: false, seed: false, outputFormat: false } },

    // OpenAI GPT Image 2.0
    { id: "openai/gpt-image-2/text-to-image", name: "GPT Image 2.0", provider: "OpenAI", price: 0.01, hot: true,
      params: { resolution: RES_NANO, aspectRatio: AR_GPT, negativePrompt: false, seed: false, outputFormat: false,
        optional: { quality: { paramName: "quality", type: "enum", values: ["low", "medium", "high"], default: "low" } } } },
    { id: "openai/gpt-image-2.5-flare/text-to-image", name: "GPT Image 2.5 Flare", provider: "OpenAI", price: 0.024, hot: true,
      params: { resolution: RES_IMAGE_1K_2K_4K, aspectRatio: AR_IMAGE_WIDE, negativePrompt: false, seed: false,
        optional: { quality: { paramName: "quality", type: "enum", values: ["low", "medium", "high", "xhigh", "max"], default: "medium" } } } },
    { id: "openai/gpt-image-2.5-sunburst/text-to-image", name: "GPT Image 2.5 Sunburst", provider: "OpenAI", price: 0.024, flagship: true,
      params: { resolution: RES_IMAGE_1K_2K_4K, aspectRatio: AR_IMAGE_WIDE, negativePrompt: false, seed: false,
        optional: { quality: { paramName: "quality", type: "enum", values: ["low", "medium", "high", "xhigh", "max"], default: "medium" } } } },

    // MiniMax H3 open-weights image generation
    { id: "wavespeed-ai/minimax-h3/text-to-image", name: "MiniMax H3 Image", provider: "Minimax", price: 0.02, hot: true,
      params: { resolution: RES_IMAGE_1K_2K, aspectRatio: AR_IMAGE_WIDE, negativePrompt: false, seed: true } },
    { id: "wavespeed-ai/minimax-h3/text-to-image-lora", name: "MiniMax H3 Image LoRA", provider: "Minimax", price: 0.02,
      params: { resolution: RES_IMAGE_1K_2K, aspectRatio: AR_IMAGE_WIDE, negativePrompt: false, seed: true } },

    // Kuaishou Kling O3 image generation
    { id: "kwaivgi/kling-image-o3/text-to-image", name: "Kling O3 Image", provider: "Kwaivgi", price: 0.028, hot: true,
      params: { resolution: RES_IMAGE_1K_2K_4K, aspectRatio: AR_KLING_IMAGE, negativePrompt: false, seed: false, maxBatchImages: 9 } },

    // Bria
    { id: "bria/text-to-image-3.2", name: "Bria 3.2", provider: "Bria", price: 0.04,
      params: { resolution: null, aspectRatio: AR_BRIA, negativePrompt: true, seed: true, outputFormat: false } },
    { id: "bria/fibo", name: "Bria FIBO", provider: "Bria", price: 0.04,
      params: { resolution: null, aspectRatio: AR_BRIA, negativePrompt: true, seed: true, outputFormat: false } },

    // ─── 2026-06 additions ───
    { id: "wavespeed-ai/qwen-image/text-to-image-2512", name: "Qwen Image 2512", provider: "Alibaba", price: 0.02,
      params: { resolution: RES_QWEN_PRO, negativePrompt: false, seed: true } },
    { id: "alibaba/wan-2.7/text-to-image", name: "WAN 2.7 Image", provider: "Alibaba", price: 0.03,
      params: { resolution: RES_WAN_T2I, negativePrompt: false, seed: true, outputFormat: false,
        optional: { thinkingMode: { paramName: "thinking_mode", type: "boolean", default: false } } } },
    { id: "nvidia/cosmos-3-super/text-to-image", name: "Cosmos 3 Super", provider: "NVIDIA", price: 0.04,
      params: { resolution: { paramName: "size", options: AR_STANDARD.options, default: "1:1" }, negativePrompt: true, seed: false,
        optional: { guidanceScale: { paramName: "guidance_scale", type: "number", default: 4, min: 0, max: 20 }, numInferenceSteps: { paramName: "num_inference_steps", type: "number", default: 28, min: 1, max: 50 } } } },
    { id: "google/gemini-3-pro-image/text-to-image", name: "Gemini 3 Pro Image", provider: "Google", price: 0.14,
      params: { resolution: RES_NANO, aspectRatio: AR_NANO_PRO, negativePrompt: false, seed: false } },
  ],

  i2i: [
    // Google Nano Banana Edit
    { id: "google/nano-banana-2/edit", name: "Nano Banana 2 Edit", provider: "Google", price: 0.063, hot: true,
      params: { resolution: RES_NANO2, aspectRatio: AR_NANO2, negativePrompt: false, seed: false, maxImages: 14,
        optional: { enableWebSearch: { paramName: "enable_web_search", type: "boolean", default: false }, enableImageSearch: { paramName: "enable_image_search", type: "boolean", default: false } } } },
    { id: "google/nano-banana-2/edit-fast", name: "Nano Banana 2 Edit Fast", provider: "Google", price: 0.045, hot: true,
      params: { resolution: RES_NANO2_FAST, aspectRatio: AR_NANO2, negativePrompt: false, seed: false, maxImages: 14,
        optional: { enableWebSearch: { paramName: "enable_web_search", type: "boolean", default: false } } } },
    { id: "google/nano-banana-2-lite/edit", name: "Nano Banana 2 Lite Edit", provider: "Google", price: 0.04,
      params: { resolution: null, aspectRatio: AR_NANO2, negativePrompt: false, seed: false, maxImages: 4 } },
    { id: "google/nano-banana-pro/edit", name: "Nano Banana Pro Edit", provider: "Google", price: 0.14, hot: true,
      params: { resolution: RES_NANO, aspectRatio: AR_NANO_PRO, negativePrompt: false, seed: false, maxImages: 8 } },
    { id: "google/gemini-2.5-flash-image/edit", name: "Gemini 2.5 Flash Edit", provider: "Google", price: 0.05,
      params: { resolution: null, negativePrompt: false, seed: false, maxImages: 10, outputFormat: false } },

    // ByteDance
    { id: "bytedance/seedream-v5.0-lite/edit", name: "Seedream 5.0 Lite Edit", provider: "ByteDance", price: 0.035, hot: true,
      params: { resolution: RES_SEEDREAM5, negativePrompt: false, seed: false, maxImages: 10 } },
    { id: "bytedance/seedream-v5.0-lite/edit-sequential", name: "Seedream 5.0 Edit Sequential", provider: "ByteDance", price: 0.035,
      params: { resolution: RES_SEEDREAM5, negativePrompt: false, seed: false, maxImages: 10, optional: { maxOutputImages: { paramName: "max_images", type: "number", default: 1, min: 1, max: 15 } } } },
    { id: "bytedance/seedream-v5.0-flash/edit", name: "Seedream 5.0 Flash Edit", provider: "ByteDance", price: 0.0243, hot: true,
      params: { resolution: RES_IMAGE_1K_15K_2K, aspectRatio: AR_IMAGE_WIDE, negativePrompt: false, seed: false, maxImages: 10 } },
    { id: "bytedance/seedream-v5.0-pro/edit", name: "Seedream 5.0 Pro Edit", provider: "ByteDance", price: 0.0405, flagship: true,
      params: { resolution: RES_IMAGE_1K_15K_2K, aspectRatio: AR_IMAGE_WIDE, negativePrompt: false, seed: false, maxImages: 10,
        optional: { promptOptimizationMode: { paramName: "prompt_optimization_mode", type: "enum", values: ["standard", "fast"], default: "standard" } } } },
    { id: "bytedance/seedream-v5.0-flash/layer-decomposition", name: "Seedream 5.0 Flash Layers", provider: "ByteDance", price: 0.459,
      params: { resolution: RES_IMAGE_1K_15K_2K, negativePrompt: false, seed: false, imageParam: "image", noPrompt: true } },
    { id: "bytedance/seedream-v5.0-pro/layer-decomposition", name: "Seedream 5.0 Pro Layers", provider: "ByteDance", price: 0.75,
      params: { resolution: RES_IMAGE_1K_15K_2K, negativePrompt: false, seed: false, imageParam: "image", noPrompt: true,
        optional: { promptOptimizationMode: { paramName: "prompt_optimization_mode", type: "enum", values: ["standard", "fast"], default: "standard" } } } },
    { id: "bytedance/seedream-v4.5/edit", name: "Seedream 4.5 Edit", provider: "ByteDance", price: 0.04,
      params: { resolution: RES_SEEDREAM, negativePrompt: false, seed: false, outputFormat: false, maxImages: 10 } },
    { id: "bytedance/seededit-v3", name: "SeedEdit V3", provider: "ByteDance", price: 0.03,
      params: { resolution: RES_SEEDREAM, negativePrompt: false, seed: true, imageParam: "image" } },

    // Alibaba WAN Edit
    { id: "alibaba/wan-2.7/image-edit", name: "WAN 2.7 Edit", provider: "Alibaba", price: 0.03, hot: true,
      params: { resolution: RES_WAN_T2I, negativePrompt: false, seed: true, outputFormat: false, maxImages: 9 } },
    { id: "alibaba/wan-2.7/image-edit-pro", name: "WAN 2.7 Edit Pro", provider: "Alibaba", price: 0.075,
      params: { resolution: RES_WAN_T2I, negativePrompt: false, seed: true, outputFormat: false, maxImages: 9 } },

    // Flux Edit
    { id: "wavespeed-ai/flux-2-pro/edit", name: "FLUX 2 Pro Edit", provider: "BFL", price: 0.04,
      params: { resolution: RES_FLUX, negativePrompt: false, seed: true, outputFormat: false, maxImages: 3 } },
    { id: "wavespeed-ai/flux-kontext-pro", name: "FLUX Kontext Pro", provider: "BFL", price: 0.04, hot: true,
      params: { resolution: null, aspectRatio: AR_STANDARD, negativePrompt: false, seed: false, outputFormat: false, imageParam: "image" } },

    // WaveSpeed
    { id: "wavespeed-ai/qwen-image-2.0-pro/edit", name: "Qwen Image 2.0 Pro Edit", provider: "Alibaba", price: 0.07, hot: true,
      params: { resolution: RES_QWEN_PRO, negativePrompt: false, seed: true, outputFormat: false, maxImages: 6 } },
    { id: "alibaba/qwen-image-3.0/edit", name: "Qwen Image 3.0 Edit", provider: "Alibaba", price: 0.03, hot: true,
      params: { resolution: RES_IMAGE_1K_2K, aspectRatio: AR_IMAGE_WIDE, negativePrompt: false, seed: true, outputFormat: false, maxImages: 3,
        optional: { enablePromptExpansion: { paramName: "enable_prompt_expansion", type: "boolean", default: true } } } },
    { id: "alibaba/qwen-image-3.0-pro/edit", name: "Qwen Image 3.0 Pro Edit", provider: "Alibaba", price: 0.04, flagship: true,
      params: { resolution: RES_IMAGE_1K_2K, aspectRatio: AR_IMAGE_WIDE, negativePrompt: false, seed: true, outputFormat: false, maxImages: 3,
        optional: { enablePromptExpansion: { paramName: "enable_prompt_expansion", type: "boolean", default: true } } } },
    { id: "wavespeed-ai/qwen-image/edit", name: "Qwen Image Edit", provider: "Alibaba", price: 0.03,
      params: { resolution: null, negativePrompt: false, seed: true, imageParam: "image" } },
    { id: "wavespeed-ai/phota/edit", name: "Phota Edit", provider: "WaveSpeed", price: 0.03,
      params: { resolution: RES_PHOTA, aspectRatio: AR_PHOTA, negativePrompt: false, seed: false, maxImages: 3, maxBatchImages: 4 } },
    { id: "wavespeed-ai/firered-image-v1.1/edit", name: "FireRed Edit", provider: "WaveSpeed", price: 0.02,
      params: { resolution: RES_WAN_T2I, negativePrompt: false, seed: false, outputFormat: false } },
    { id: "wavespeed-ai/step1x-edit", name: "Step1X Edit", provider: "WaveSpeed", price: 0.02,
      params: { resolution: null, negativePrompt: false, seed: true, outputFormat: false, imageParam: "image" } },

    // OpenAI GPT Image 2.0 Edit
    { id: "openai/gpt-image-2/edit", name: "GPT Image 2.0 Edit", provider: "OpenAI", price: 0.03, hot: true,
      params: { resolution: RES_NANO, aspectRatio: AR_GPT, negativePrompt: false, seed: false, outputFormat: false, maxImages: 4,
        optional: { quality: { paramName: "quality", type: "enum", values: ["low", "medium", "high"], default: "low" } } } },
    { id: "openai/gpt-image-2.5-flare/edit", name: "GPT Image 2.5 Flare Edit", provider: "OpenAI", price: 0.034, hot: true,
      params: { resolution: RES_IMAGE_1K_2K_4K, aspectRatio: AR_IMAGE_WIDE, negativePrompt: false, seed: false, maxImages: 16,
        optional: { quality: { paramName: "quality", type: "enum", values: ["low", "medium", "high", "xhigh", "max"], default: "medium" } } } },
    { id: "openai/gpt-image-2.5-sunburst/edit", name: "GPT Image 2.5 Sunburst Edit", provider: "OpenAI", price: 0.034, flagship: true,
      params: { resolution: RES_IMAGE_1K_2K_4K, aspectRatio: AR_IMAGE_WIDE, negativePrompt: false, seed: false, maxImages: 16,
        optional: { quality: { paramName: "quality", type: "enum", values: ["low", "medium", "high", "xhigh", "max"], default: "medium" } } } },

    // MiniMax H3 open-weights image editing
    { id: "wavespeed-ai/minimax-h3/image-edit", name: "MiniMax H3 Image Edit", provider: "Minimax", price: 0.03,
      params: { resolution: RES_IMAGE_1K_2K, aspectRatio: AR_IMAGE_WIDE, negativePrompt: false, seed: true, maxImages: 9 } },
    { id: "wavespeed-ai/minimax-h3/image-edit-lora", name: "MiniMax H3 Image Edit LoRA", provider: "Minimax", price: 0.03,
      params: { resolution: RES_IMAGE_1K_2K, aspectRatio: AR_IMAGE_WIDE, negativePrompt: false, seed: true, maxImages: 9 } },

    // Kuaishou Kling O3 multi-reference image editing
    { id: "kwaivgi/kling-image-o3/edit", name: "Kling O3 Image Edit", provider: "Kwaivgi", price: 0.028, hot: true,
      params: { resolution: RES_IMAGE_1K_2K_4K, aspectRatio: { ...AR_KLING_IMAGE, default: "auto" }, negativePrompt: false, seed: false, maxImages: 10, maxBatchImages: 9 } },

    // Bria FIBO Edit + utility tools
    { id: "bria/fibo/edit", name: "Bria FIBO Edit", provider: "Bria", price: 0.04,
      params: { resolution: null, negativePrompt: true, seed: true, outputFormat: false, imageParam: "images", maxImages: 1 } },
    { id: "bria/fibo/image-blend", name: "Bria Blend", provider: "Bria", price: 0.04,
      params: { resolution: null, negativePrompt: false, seed: false, outputFormat: false, imageParam: "image" } },
    { id: "bria/fibo/restore", name: "Bria Restore", provider: "Bria", price: 0.04,
      params: { resolution: null, negativePrompt: false, seed: false, outputFormat: false, imageParam: "image", noPrompt: true } },
    { id: "bria/fibo/colorize", name: "Bria Colorize", provider: "Bria", price: 0.04,
      params: { resolution: null, negativePrompt: false, seed: false, outputFormat: false, imageParam: "image", noPrompt: true,
        briaPreset: { paramName: "style", default: "contemporary color",
          options: [
            { label: "Contemporary", value: "contemporary color" },
            { label: "Vivid", value: "vivid color" },
            { label: "B&W", value: "black and white colors" },
            { label: "Sepia Vintage", value: "sepia vintage" },
          ] } } },
    { id: "bria/fibo/relight", name: "Bria Relight", provider: "Bria", price: 0.04,
      params: { resolution: null, negativePrompt: false, seed: false, outputFormat: false, imageParam: "image", noPrompt: true,
        briaPreset: { paramName: "light_type", default: "midday",
          options: [
            { label: "Midday", value: "midday" },
            { label: "Sunrise", value: "sunrise light" },
            { label: "Moonlight", value: "moonlight lighting" },
            { label: "Fog", value: "fog-diffused lighting" },
          ] } } },
    { id: "bria/fibo/reseason", name: "Bria Reseason", provider: "Bria", price: 0.04,
      params: { resolution: null, negativePrompt: false, seed: false, outputFormat: false, imageParam: "image", noPrompt: true,
        briaPreset: { paramName: "season", default: "summer",
          options: [
            { label: "Spring", value: "spring" },
            { label: "Summer", value: "summer" },
            { label: "Autumn", value: "autumn" },
            { label: "Winter", value: "winter" },
          ] } } },
    { id: "bria/expand", name: "Bria Expand", provider: "Bria", price: 0.04,
      params: { resolution: null, aspectRatio: AR_BRIA, negativePrompt: false, seed: false, outputFormat: false, imageParam: "image", noPrompt: true } },
    { id: "bria/remove-background", name: "Bria Remove BG", provider: "Bria", price: 0.018,
      params: { resolution: null, negativePrompt: false, seed: false, outputFormat: false, imageParam: "image", noPrompt: true } },
    { id: "bria/increase-resolution", name: "Bria Upscale", provider: "Bria", price: 0.04,
      params: { resolution: null, negativePrompt: false, seed: false, outputFormat: false, imageParam: "image", noPrompt: true,
        briaPreset: { paramName: "desired_increase", default: 2,
          options: [
            { label: "2x", value: 2 },
            { label: "4x", value: 4 },
          ] } } },
    // Models requiring complex inputs (mask, products) — will need follow-up UI for full support
    { id: "bria/eraser", name: "Bria Eraser", provider: "Bria", price: 0.04,
      params: { resolution: null, negativePrompt: false, seed: false, outputFormat: false, imageParam: "image", noPrompt: true,
        maxImages: 2, auxImageParam: "mask_image", requiresSecondImage: true } },
    { id: "bria/embed-product", name: "Bria Embed Product", provider: "Bria", price: 0.04,
      params: { resolution: null, negativePrompt: false, seed: true, outputFormat: false, imageParam: "image", noPrompt: true,
        maxImages: 2, productImageParam: "products", requiresSecondImage: true,
        optional: {
          productX: { type: "number", default: 128, min: 0, max: 4096, payload: false },
          productY: { type: "number", default: 128, min: 0, max: 4096, payload: false },
          productWidth: { type: "number", default: 512, min: 1, max: 4096, payload: false },
          productHeight: { type: "number", default: 512, min: 1, max: 4096, payload: false },
        } } },

    // ─── 2026-06 additions ───
    { id: "wavespeed-ai/qwen-image/edit-2511", name: "Qwen Edit 2511", provider: "Alibaba", price: 0.02,
      params: { resolution: null, negativePrompt: false, seed: true, maxImages: 3 } },
    { id: "google/gemini-3-pro-image/edit", name: "Gemini 3 Pro Edit", provider: "Google", price: 0.14,
      params: { resolution: RES_NANO, aspectRatio: AR_NANO_PRO, negativePrompt: false, seed: false, maxImages: 8 } },
  ],

  i23d: [
    // Image-to-3D models — input: source image, output: 3D mesh URL (.glb)
    { id: "wavespeed-ai/hunyuan3d-v3/image-to-3d", name: "Hunyuan3D V3", provider: "Tencent", price: 0.225,
      params: { resolution: null, negativePrompt: false, seed: false, outputFormat: false, imageParam: "image", noPrompt: true } },
    { id: "hyper3d/rodin-v2/image-to-3d", name: "Hyper3D Rodin v2", provider: "Hyper3D", price: 0.40,
      params: { resolution: null, negativePrompt: false, seed: false, outputFormat: false, imageParam: "images", maxImages: 4 } },
    { id: "wavespeed-ai/meshy6/image-to-3d", name: "Meshy 6", provider: "Meshy", price: 0.20,
      params: { resolution: null, negativePrompt: false, seed: false, outputFormat: false, imageParam: "image", noPrompt: true } },
    { id: "tripo3d/h3.1/image-to-3d", name: "Tripo3D H3.1", provider: "Tripo3D", price: 0.20,
      params: { resolution: null, negativePrompt: false, seed: true, seedParam: "model_seed", outputFormat: false, imageParam: "image", noPrompt: true } },
  ],

  t2v: [
    // ByteDance Seedance 2.5 — standard + Turbo
    { id: "bytedance/seedance-2.5/text-to-video", name: "Seedance 2.5", provider: "ByteDance", price: 0.81, hot: true,
      params: { resolution: RES_VIDEO_480_720_1080_4K, aspectRatio: AR_SEEDANCE, duration: { options: DUR_4_30, default: 5 }, negativePrompt: false, seed: false,
        optional: { generateAudio: { paramName: "generate_audio", type: "boolean", default: true } } } },
    { id: "bytedance/seedance-2.5/text-to-video-turbo", name: "Seedance 2.5 Turbo", provider: "ByteDance", price: 0.90, flagship: true,
      params: { resolution: RES_VIDEO_720_1080, aspectRatio: AR_SEEDANCE, duration: { options: DUR_4_30, default: 5 }, negativePrompt: false, seed: false,
        optional: { generateAudio: { paramName: "generate_audio", type: "boolean", default: true } } } },

    // Black Forest Labs FLUX 3 — production + Draft
    { id: "black-forest-labs/flux-3/text-to-video", name: "FLUX 3", provider: "BFL", price: 0.85, flagship: true,
      params: { resolution: RES_VIDEO_FLUX3, aspectRatio: AR_FLUX3, duration: { options: DUR_5_20, default: 5 }, negativePrompt: false, seed: false,
        optional: { generateAudio: { paramName: "generate_audio", type: "boolean", default: true } } } },
    { id: "black-forest-labs/flux-3/text-to-video-draft", name: "FLUX 3 Draft", provider: "BFL", price: 0.30, hot: true,
      params: { resolution: null, aspectRatio: AR_FLUX3, duration: { options: DUR_5_20, default: 5 }, negativePrompt: false, seed: false,
        optional: { generateAudio: { paramName: "generate_audio", type: "boolean", default: true } } } },

    // Alibaba WAN
    { id: "alibaba/wan-3.0/text-to-video", name: "WAN 3.0", provider: "Alibaba", price: 0.475, hot: true,
      params: { resolution: RES_VIDEO_480_720_1080, aspectRatio: AR_WAN3, duration: { options: DUR_2_30, default: 5 }, negativePrompt: false, seed: true,
        optional: { enablePromptExpansion: { paramName: "enable_prompt_expansion", type: "boolean", default: false }, generateAudio: { paramName: "generate_audio", type: "boolean", default: true } } } },
    { id: "alibaba/wan-3.0-prime/text-to-video", name: "WAN 3.0 Prime", provider: "Alibaba", price: 0.7125, flagship: true,
      params: { resolution: RES_VIDEO_480_720_1080, aspectRatio: AR_WAN3, duration: { options: DUR_2_30, default: 5 }, negativePrompt: false, seed: true,
        optional: { enablePromptExpansion: { paramName: "enable_prompt_expansion", type: "boolean", default: false }, generateAudio: { paramName: "generate_audio", type: "boolean", default: true } } } },
    { id: "alibaba/wan-2.7/text-to-video", name: "WAN 2.7", provider: "Alibaba", price: 0.50, hot: true,
      params: { resolution: RES_VIDEO_720_1080, aspectRatio: AR_STANDARD, duration: { options: [2,3,4,5,6,7,8,9,10,11,12,13,14,15], default: 5 }, negativePrompt: true, seed: true, optional: { enablePromptExpansion: { paramName: "enable_prompt_expansion", type: "boolean", default: false } } } },
    { id: "alibaba/wan-2.5/text-to-video", name: "WAN 2.5", provider: "Alibaba", price: 0.30,
      params: { resolution: RES_VIDEO_WAN, duration: { options: [5,10], default: 5 }, negativePrompt: true, seed: true } },

    // Google Veo
    { id: "google/veo3", name: "Veo 3", provider: "Google", price: 3.20, hot: true, flagship: true,
      params: { resolution: RES_VIDEO_720_1080, aspectRatio: AR_VEO, duration: { options: [4,6,8], default: 8 }, negativePrompt: true, seed: true, optional: { generateAudio: { paramName: "generate_audio", type: "boolean", default: true } } } },
    { id: "google/veo3-fast", name: "Veo 3 Fast", provider: "Google", price: 1.20, hot: true,
      params: { resolution: RES_VIDEO_720_1080, aspectRatio: AR_VEO, duration: { options: [4,6,8], default: 8 }, negativePrompt: true, seed: true, optional: { generateAudio: { paramName: "generate_audio", type: "boolean", default: true } } } },
    { id: "google/veo3.1/text-to-video", name: "Veo 3.1", provider: "Google", price: 3.20, flagship: true,
      params: { resolution: { paramName: "resolution", options: [{ label: "720p", value: "720p" }, { label: "1080p", value: "1080p" }, { label: "4K", value: "4k" }], default: "1080p" }, aspectRatio: AR_VEO, duration: { options: [4,6,8], default: 8 }, negativePrompt: true, seed: true, optional: { generateAudio: { paramName: "generate_audio", type: "boolean", default: true } } } },
    { id: "google/veo3.1-fast/text-to-video", name: "Veo 3.1 Fast", provider: "Google", price: 1.20, hot: true,
      params: { resolution: { paramName: "resolution", options: [{ label: "720p", value: "720p" }, { label: "1080p", value: "1080p" }, { label: "4K", value: "4k" }], default: "1080p" }, aspectRatio: AR_VEO, duration: { options: [4,6,8], default: 8 }, negativePrompt: true, seed: true, optional: { generateAudio: { paramName: "generate_audio", type: "boolean", default: true } } } },
    { id: "google/veo3.1-lite/text-to-video", name: "Veo 3.1 Lite", provider: "Google", price: 0.30,
      params: { resolution: RES_VIDEO_720_1080, aspectRatio: AR_VEO, duration: { options: [4,6,8], default: 6 }, negativePrompt: true, seed: true } },

    // OpenAI Sora 2 — all public text-to-video variants
    { id: "openai/sora-2/text-to-video", name: "Sora 2", provider: "OpenAI", price: 0.40, hot: true,
      params: { resolution: { paramName: "size", options: [{ label: "720x1280", value: "720*1280" }, { label: "1280x720", value: "1280*720" }], default: "720*1280" }, duration: { options: [4,8,12,16,20], default: 4 }, negativePrompt: false, seed: false } },
    { id: "openai/sora-2/text-to-video-pro", name: "Sora 2 Pro", provider: "OpenAI", price: 1.20,
      params: { resolution: { paramName: "size", options: [{ label: "720x1280", value: "720*1280" }, { label: "1280x720", value: "1280*720" }, { label: "1024x1792", value: "1024*1792" }, { label: "1792x1024", value: "1792*1024" }, { label: "1920x1080", value: "1920*1080" }, { label: "1080x1920", value: "1080*1920" }], default: "720*1280" }, duration: { options: [4,8,12,16,20], default: 4 }, negativePrompt: false, seed: false } },
    { id: "openai/sora-2-pro/text-to-video", name: "Sora 2 Pro HQ", provider: "OpenAI", price: 1.20, flagship: true,
      params: { resolution: { paramName: "size", options: [{ label: "720x1280", value: "720*1280" }, { label: "1280x720", value: "1280*720" }, { label: "1024x1792", value: "1024*1792" }, { label: "1792x1024", value: "1792*1024" }, { label: "1920x1080", value: "1920*1080" }, { label: "1080x1920", value: "1080*1920" }], default: "1280*720" }, duration: { options: [4,8,12,16,20], default: 4 }, negativePrompt: false, seed: false } },

    // Kling
    { id: "kwaivgi/kling-v3.0-pro/text-to-video", name: "Kling 3.0 Pro", provider: "Kwaivgi", price: 0.80, hot: true,
      params: { resolution: null, aspectRatio: AR_KLING, duration: { options: [5,10], default: 5 }, negativePrompt: true, seed: false, optional: { cfgScale: { paramName: "cfg_scale", type: "number", default: 0.5, min: 0, max: 1 }, sound: { paramName: "sound", type: "boolean", default: false } } } },
    { id: "kwaivgi/kling-video-o3-std/text-to-video", name: "Kling O3 Standard", provider: "Kwaivgi", price: 0.42, hot: true,
      params: { resolution: null, aspectRatio: AR_KLING, duration: { options: DUR_3_15, default: 5 }, negativePrompt: false, seed: false,
        optional: { sound: { paramName: "sound", type: "boolean", default: false } } } },
    { id: "kwaivgi/kling-video-o3-pro/text-to-video", name: "Kling O3 Pro", provider: "Kwaivgi", price: 0.56, flagship: true,
      params: { resolution: null, aspectRatio: AR_KLING, duration: { options: DUR_3_15, default: 5 }, negativePrompt: false, seed: false,
        optional: { sound: { paramName: "sound", type: "boolean", default: false } } } },
    { id: "kwaivgi/kling-video-o3-4k/text-to-video", name: "Kling O3 4K", provider: "Kwaivgi", price: 2.10,
      params: { resolution: null, aspectRatio: AR_KLING, duration: { options: DUR_3_15, default: 5 }, negativePrompt: false, seed: false,
        optional: { sound: { paramName: "sound", type: "boolean", default: false } } } },

    // PixVerse
    { id: "pixverse/pixverse-v6/text-to-video", name: "PixVerse V6", provider: "PixVerse", price: 0.10, hot: true,
      params: { resolution: RES_VIDEO_360_540_720_1080, aspectRatio: AR_KLING_IMAGE, duration: { options: DUR_1_15, default: 5 }, negativePrompt: false, seed: false,
        optional: { generateAudio: { paramName: "generate_audio_switch", type: "boolean", default: false }, thinkingType: { paramName: "thinking_type", type: "enum", values: ["enabled", "disabled", "auto"], default: "auto" } } } },

    // Pika
    { id: "pika/v2.2-t2v", name: "Pika V2.2", provider: "Pika", price: 0.40,
      params: { resolution: { paramName: "size", options: [{ label: "1280x720", value: "1280*720" }, { label: "720x1280", value: "720*1280" }], default: "1280*720" }, duration: { options: [5,10], default: 5 }, negativePrompt: false, seed: false } },

    // Vidu
    { id: "vidu/q3/text-to-video", name: "Vidu Q3", provider: "Vidu", price: 0.35, hot: true,
      params: { resolution: RES_VIDEO_540_720_1080_DEFAULT_720, aspectRatio: { ...AR_WAN3, default: "4:3" }, duration: { options: DUR_1_16, default: 5 }, negativePrompt: false, seed: true,
        optional: { generateAudio: { paramName: "generate_audio", type: "boolean", default: true }, bgm: { paramName: "bgm", type: "boolean", default: true } } } },
    { id: "vidu/q3-pro/text-to-video", name: "Vidu Q3 Pro", provider: "Vidu", price: 0.25,
      params: { resolution: RES_VIDEO_540_720_1080_DEFAULT_720, duration: { options: DUR_1_16, default: 5 }, negativePrompt: false, seed: true,
        optional: { generateAudio: { paramName: "generate_audio", type: "boolean", default: true }, bgm: { paramName: "bgm", type: "boolean", default: true } } } },

    // Minimax
    { id: "minimax/hailuo-2.3/t2v-pro", name: "Hailuo 2.3", provider: "Minimax", price: 0.50,
      params: { resolution: null, duration: null, negativePrompt: false, seed: false,
        optional: { enablePromptExpansion: { paramName: "enable_prompt_expansion", type: "boolean", default: false } } } },

    // MiniMax H3 — official + WaveSpeed open-weights deployment
    { id: "minimax/h3/text-to-video", name: "MiniMax H3 Official", provider: "Minimax", price: 0.70, flagship: true,
      params: { resolution: RES_VIDEO_H3_OFFICIAL, aspectRatio: AR_H3, duration: { options: [4,5,6,7,8,9,10,11,12,13,14,15], default: 5 }, negativePrompt: false, seed: false } },
    { id: "wavespeed-ai/minimax-h3/text-to-video", name: "MiniMax H3 WaveSpeed", provider: "Minimax", price: 0.10, hot: true,
      params: { resolution: RES_VIDEO_H3, aspectRatio: AR_H3_WS, duration: { options: DUR_3_15, default: 5 }, negativePrompt: false, seed: true } },
    { id: "wavespeed-ai/minimax-h3/text-to-video-lora", name: "MiniMax H3 T2V LoRA", provider: "Minimax", price: 0.125,
      params: { resolution: RES_VIDEO_H3, aspectRatio: AR_H3_WS, duration: { options: DUR_3_15, default: 5 }, negativePrompt: false, seed: true } },

    // Luma Ray 3.2
    { id: "luma/ray-3.2/text-to-video", name: "Luma Ray 3.2", provider: "Luma", price: 0.50, hot: true,
      params: { resolution: RES_VIDEO_540_720_1080, aspectRatio: AR_LUMA_SIZE, duration: { options: [5,10], default: 5 }, negativePrompt: false, seed: false } },

    // WaveSpeed — Cosmos Predict
    { id: "wavespeed-ai/cosmos-predict-2.5/text-to-video", name: "Cosmos Predict 2.5", provider: "WaveSpeed", price: 0.25,
      params: { resolution: null, duration: null, negativePrompt: false, seed: false } },

    // WaveSpeed — Kandinsky
    { id: "wavespeed-ai/kandinsky5-pro/text-to-video", name: "Kandinsky 5 Pro", provider: "WaveSpeed", price: 0.20,
      params: { resolution: RES_KANDINSKY, aspectRatio: AR_KANDINSKY, duration: { options: [5], default: 5 }, negativePrompt: false, seed: false } },

    // ─── 2026-06 additions ───
    { id: "bytedance/seedance-2.0/text-to-video", name: "Seedance 2.0", provider: "ByteDance", price: 0.60,
      params: { resolution: RES_VIDEO_480_4K, aspectRatio: AR_SEEDANCE, duration: DUR_SEEDANCE, negativePrompt: false, seed: false, optional: { generateAudio: { paramName: "generate_audio", type: "boolean", default: true } } } },
    { id: "kwaivgi/kling-v3.0-std/text-to-video", name: "Kling 3.0 Std", provider: "Kwaivgi", price: 0.42,
      params: { resolution: null, aspectRatio: AR_KLING, duration: DUR_KLING3, negativePrompt: true, seed: false, optional: { cfgScale: { paramName: "cfg_scale", type: "number", default: 0.5, min: 0, max: 1 }, sound: { paramName: "sound", type: "boolean", default: false } } } },
  ],

  i2v: [
    // ByteDance Seedance 2.5 — first frame + optional last frame
    { id: "bytedance/seedance-2.5/image-to-video", name: "Seedance 2.5 I2V", provider: "ByteDance", price: 0.81, hot: true,
      params: { resolution: RES_VIDEO_480_720_1080_4K, duration: { options: DUR_4_30, default: 5 }, negativePrompt: false, seed: false, maxImages: 2, lastImageParam: "last_image",
        optional: { generateAudio: { paramName: "generate_audio", type: "boolean", default: true } } } },
    { id: "bytedance/seedance-2.5/image-to-video-turbo", name: "Seedance 2.5 I2V Turbo", provider: "ByteDance", price: 0.90, flagship: true,
      params: { resolution: RES_VIDEO_720_1080, duration: { options: DUR_4_30, default: 5 }, negativePrompt: false, seed: false, maxImages: 2, lastImageParam: "last_image",
        optional: { generateAudio: { paramName: "generate_audio", type: "boolean", default: true } } } },

    // Black Forest Labs FLUX 3 — production, Draft, and start/end frame variants
    { id: "black-forest-labs/flux-3/image-to-video", name: "FLUX 3 I2V", provider: "BFL", price: 0.85, flagship: true,
      params: { resolution: RES_VIDEO_FLUX3, aspectRatio: AR_FLUX3, duration: { options: DUR_5_20, default: 5 }, negativePrompt: false, seed: false,
        optional: { generateAudio: { paramName: "generate_audio", type: "boolean", default: true } } } },
    { id: "black-forest-labs/flux-3/image-to-video-draft", name: "FLUX 3 I2V Draft", provider: "BFL", price: 0.30, hot: true,
      params: { resolution: null, aspectRatio: AR_FLUX3, duration: { options: DUR_5_20, default: 5 }, negativePrompt: false, seed: false,
        optional: { generateAudio: { paramName: "generate_audio", type: "boolean", default: true } } } },
    { id: "black-forest-labs/flux-3/start-end-to-video", name: "FLUX 3 Start + End", provider: "BFL", price: 0.85,
      params: { resolution: RES_VIDEO_FLUX3, aspectRatio: AR_FLUX3, duration: { options: DUR_5_20, default: 5 }, negativePrompt: false, seed: false, maxImages: 2, startEndFrames: true,
        optional: { generateAudio: { paramName: "generate_audio", type: "boolean", default: true } } } },
    { id: "black-forest-labs/flux-3/start-end-to-video-draft", name: "FLUX 3 Start + End Draft", provider: "BFL", price: 0.30,
      params: { resolution: null, aspectRatio: AR_FLUX3, duration: { options: DUR_5_20, default: 5 }, negativePrompt: false, seed: false, maxImages: 2, startEndFrames: true,
        optional: { generateAudio: { paramName: "generate_audio", type: "boolean", default: true } } } },

    // Alibaba WAN
    { id: "alibaba/wan-3.0/image-to-video", name: "WAN 3.0 I2V", provider: "Alibaba", price: 0.475, hot: true,
      params: { resolution: RES_VIDEO_480_720_1080, aspectRatio: AR_WAN3, duration: { options: DUR_2_30, default: 5 }, negativePrompt: false, seed: true, maxImages: 2, lastImageParam: "last_image",
        optional: { enablePromptExpansion: { paramName: "enable_prompt_expansion", type: "boolean", default: false }, generateAudio: { paramName: "generate_audio", type: "boolean", default: true } } } },
    { id: "alibaba/wan-3.0-prime/image-to-video", name: "WAN 3.0 Prime I2V", provider: "Alibaba", price: 0.7125, flagship: true,
      params: { resolution: RES_VIDEO_480_720_1080, aspectRatio: AR_WAN3, duration: { options: DUR_2_30, default: 5 }, negativePrompt: false, seed: true, maxImages: 2, lastImageParam: "last_image",
        optional: { enablePromptExpansion: { paramName: "enable_prompt_expansion", type: "boolean", default: false }, generateAudio: { paramName: "generate_audio", type: "boolean", default: true } } } },
    { id: "alibaba/wan-3.0/reference-to-video", name: "WAN 3.0 Reference", provider: "Alibaba", price: 0.475,
      params: { resolution: RES_VIDEO_480_720_1080, aspectRatio: AR_WAN3, duration: { options: DUR_2_30, default: 5 }, negativePrompt: false, seed: true, imageParam: "reference_images", maxImages: 10, sourceOptional: true,
        optional: { enablePromptExpansion: { paramName: "enable_prompt_expansion", type: "boolean", default: false }, generateAudio: { paramName: "generate_audio", type: "boolean", default: true } } } },
    { id: "alibaba/wan-3.0-prime/reference-to-video", name: "WAN 3.0 Prime Reference", provider: "Alibaba", price: 0.7125,
      params: { resolution: RES_VIDEO_480_720_1080, aspectRatio: AR_WAN3, duration: { options: DUR_2_30, default: 5 }, negativePrompt: false, seed: true, imageParam: "reference_images", maxImages: 10, sourceOptional: true,
        optional: { enablePromptExpansion: { paramName: "enable_prompt_expansion", type: "boolean", default: false }, generateAudio: { paramName: "generate_audio", type: "boolean", default: true } } } },
    { id: "alibaba/wan-2.7/image-to-video", name: "WAN 2.7 I2V", provider: "Alibaba", price: 0.50, hot: true,
      params: { resolution: RES_VIDEO_720_1080, duration: { options: [2,3,4,5,6,7,8,9,10,11,12,13,14,15], default: 5 }, negativePrompt: true, seed: true, maxImages: 2, lastImageParam: "last_image",
        optional: { enablePromptExpansion: { paramName: "enable_prompt_expansion", type: "boolean", default: false } } } },
    { id: "alibaba/wan-2.6/image-to-video", name: "WAN 2.6 I2V", provider: "Alibaba", price: 0.50,
      params: { resolution: RES_VIDEO_720_1080, duration: { options: [5,10,15], default: 5 }, negativePrompt: true, seed: true,
        optional: { shotType: { paramName: "shot_type", type: "enum", values: ["single", "multi"], default: "single" }, enablePromptExpansion: { paramName: "enable_prompt_expansion", type: "boolean", default: false } } } },

    // Google Veo
    { id: "google/veo3/image-to-video", name: "Veo 3 I2V", provider: "Google", price: 3.20, flagship: true,
      params: { resolution: RES_VIDEO_720_1080, aspectRatio: AR_VEO, duration: { options: [4,6,8], default: 8 }, negativePrompt: true, seed: true, optional: { generateAudio: { paramName: "generate_audio", type: "boolean", default: true } } } },
    { id: "google/veo3-fast/image-to-video", name: "Veo 3 Fast I2V", provider: "Google", price: 1.20, hot: true,
      params: { resolution: RES_VIDEO_720_1080, aspectRatio: AR_VEO, duration: { options: [4,6,8], default: 8 }, negativePrompt: true, seed: true, optional: { generateAudio: { paramName: "generate_audio", type: "boolean", default: true } } } },
    { id: "google/veo3.1/image-to-video", name: "Veo 3.1 I2V", provider: "Google", price: 3.20,
      params: { resolution: { paramName: "resolution", options: [{ label: "720p", value: "720p" }, { label: "1080p", value: "1080p" }, { label: "4K", value: "4k" }], default: "1080p" }, aspectRatio: AR_VEO, duration: { options: [4,6,8], default: 8 }, negativePrompt: true, seed: true, maxImages: 2, lastImageParam: "last_image", optional: { generateAudio: { paramName: "generate_audio", type: "boolean", default: true } } } },
    { id: "google/veo3.1-fast/image-to-video", name: "Veo 3.1 Fast I2V", provider: "Google", price: 1.20, hot: true,
      params: { resolution: { paramName: "resolution", options: [{ label: "720p", value: "720p" }, { label: "1080p", value: "1080p" }, { label: "4K", value: "4k" }], default: "1080p" }, aspectRatio: AR_VEO, duration: { options: [4,6,8], default: 8 }, negativePrompt: true, seed: true, maxImages: 2, lastImageParam: "last_image", optional: { generateAudio: { paramName: "generate_audio", type: "boolean", default: true } } } },
    { id: "google/veo3.1-lite/image-to-video", name: "Veo 3.1 Lite I2V", provider: "Google", price: 0.30,
      params: { resolution: RES_VIDEO_720_1080, aspectRatio: AR_VEO, duration: { options: [4,6,8], default: 8 }, negativePrompt: true, seed: true } },
    { id: "google/veo3.1/reference-to-video", name: "Veo 3.1 Reference", provider: "Google", price: 3.20,
      params: { resolution: { paramName: "resolution", options: [{ label: "720p", value: "720p" }, { label: "1080p", value: "1080p" }, { label: "4K", value: "4k" }], default: "1080p" }, negativePrompt: true, seed: true, imageParam: "images", maxImages: 3,
        optional: { generateAudio: { paramName: "generate_audio", type: "boolean", default: true } } } },
    { id: "google/veo3.1-fast/reference-to-video", name: "Veo 3.1 Fast Reference", provider: "Google", price: 0.64, hot: true,
      params: { resolution: RES_VIDEO_720_1080, aspectRatio: AR_VEO, negativePrompt: true, seed: true, imageParam: "images", maxImages: 3,
        optional: { generateAudio: { paramName: "generate_audio", type: "boolean", default: false } } } },
    { id: "google/veo3.1-lite/start-end-to-video", name: "Veo 3.1 Lite Start + End", provider: "Google", price: 0.40,
      params: { resolution: RES_VIDEO_720_1080, aspectRatio: AR_VEO, negativePrompt: true, seed: true, maxImages: 2, lastImageParam: "last_image", requiresLastImage: true } },

    // OpenAI Sora 2 — all public image-to-video variants
    { id: "openai/sora-2/image-to-video", name: "Sora 2 I2V", provider: "OpenAI", price: 0.40, hot: true,
      params: { resolution: null, duration: { options: [4,8,12,16,20], default: 4 }, negativePrompt: false, seed: false } },
    { id: "openai/sora-2/image-to-video-pro", name: "Sora 2 I2V Pro", provider: "OpenAI", price: 1.20,
      params: { resolution: RES_VIDEO_720_1080, duration: { options: [4,8,12,16,20], default: 4 }, negativePrompt: false, seed: false } },
    { id: "openai/sora-2-pro/image-to-video", name: "Sora 2 Pro I2V HQ", provider: "OpenAI", price: 1.20, flagship: true,
      params: { resolution: RES_VIDEO_720_1080, duration: { options: [4,8,12,16,20], default: 4 }, negativePrompt: false, seed: false } },

    // Kling
    { id: "kwaivgi/kling-v3.0-pro/image-to-video", name: "Kling 3.0 I2V", provider: "Kwaivgi", price: 0.80, hot: true,
      params: { resolution: null, duration: { options: [5,10], default: 5 }, negativePrompt: true, seed: false, maxImages: 2, lastImageParam: "end_image" } },
    { id: "kwaivgi/kling-video-o3-std/image-to-video", name: "Kling O3 Standard I2V", provider: "Kwaivgi", price: 0.42, hot: true,
      params: { resolution: null, duration: { options: DUR_3_15, default: 5 }, negativePrompt: false, seed: false, maxImages: 2, lastImageParam: "end_image",
        optional: { sound: { paramName: "sound", type: "boolean", default: false } } } },
    { id: "kwaivgi/kling-video-o3-pro/image-to-video", name: "Kling O3 Pro I2V", provider: "Kwaivgi", price: 0.56, flagship: true,
      params: { resolution: null, duration: { options: DUR_3_15, default: 5 }, negativePrompt: false, seed: false, maxImages: 2, lastImageParam: "end_image",
        optional: { sound: { paramName: "sound", type: "boolean", default: false } } } },
    { id: "kwaivgi/kling-video-o3-4k/image-to-video", name: "Kling O3 4K I2V", provider: "Kwaivgi", price: 2.10,
      params: { resolution: null, duration: { options: DUR_3_15, default: 5 }, negativePrompt: false, seed: false, maxImages: 2, lastImageParam: "end_image",
        optional: { sound: { paramName: "sound", type: "boolean", default: false } } } },
    { id: "kwaivgi/kling-video-o3-std/reference-to-video", name: "Kling O3 Standard Reference", provider: "Kwaivgi", price: 0.42,
      params: { resolution: null, aspectRatio: AR_KLING, duration: { options: DUR_3_15, default: 5 }, negativePrompt: false, seed: false, imageParam: "images", maxImages: 7, sourceOptional: true,
        optional: { sound: { paramName: "sound", type: "boolean", default: false } } } },
    { id: "kwaivgi/kling-video-o3-pro/reference-to-video", name: "Kling O3 Pro Reference", provider: "Kwaivgi", price: 0.56,
      params: { resolution: null, aspectRatio: AR_KLING, duration: { options: DUR_3_15, default: 5 }, negativePrompt: false, seed: false, imageParam: "images", maxImages: 7, sourceOptional: true,
        optional: { sound: { paramName: "sound", type: "boolean", default: false } } } },
    { id: "kwaivgi/kling-video-o3-4k/reference-to-video", name: "Kling O3 4K Reference", provider: "Kwaivgi", price: 2.10,
      params: { resolution: null, aspectRatio: AR_KLING, duration: { options: DUR_3_15, default: 5 }, negativePrompt: false, seed: false, imageParam: "images", maxImages: 7, sourceOptional: true,
        optional: { sound: { paramName: "sound", type: "boolean", default: false } } } },

    // Runway
    { id: "runwayml/gen4-turbo", name: "Runway Gen4 Turbo", provider: "Runway", price: 0.50, hot: true,
      params: { resolution: null, aspectRatio: AR_STANDARD, duration: { options: [5,10], default: 5 }, negativePrompt: false, seed: false } },

    // Luma
    { id: "luma/ray-2-i2v", name: "Luma Ray 2", provider: "Luma", price: 0.40,
      params: { resolution: { paramName: "size", options: [{ label: "1280x720", value: "1280*720" }, { label: "720x1280", value: "720*1280" }], default: "1280*720" }, duration: { options: [5,10], default: 5 }, negativePrompt: false, seed: false } },
    { id: "luma/ray-3.2/image-to-video", name: "Luma Ray 3.2 I2V", provider: "Luma", price: 0.50, hot: true,
      params: { resolution: RES_VIDEO_540_720_1080, aspectRatio: AR_LUMA_SIZE, duration: { options: [5], default: 5 }, negativePrompt: false, seed: false, maxImages: 2, lastImageParam: "last_image" } },

    // PixVerse
    { id: "pixverse/pixverse-v6/image-to-video", name: "PixVerse V6 I2V", provider: "PixVerse", price: 0.10, hot: true,
      params: { resolution: RES_VIDEO_360_540_720_1080, duration: { options: DUR_1_15, default: 5 }, negativePrompt: false, seed: false,
        optional: { generateAudio: { paramName: "generate_audio_switch", type: "boolean", default: false }, thinkingType: { paramName: "thinking_type", type: "enum", values: ["enabled", "disabled", "auto"], default: "auto" } } } },
    { id: "pixverse/pixverse-v6/reference-to-video", name: "PixVerse V6 Reference", provider: "PixVerse", price: 1.00,
      params: { resolution: { ...RES_VIDEO_360_540_720_1080, options: [{ label: "Auto", value: "auto" }, ...RES_VIDEO_360_540_720_1080.options] }, aspectRatio: { ...AR_KLING_IMAGE, default: "auto" }, duration: { options: DUR_1_15, default: 5 }, negativePrompt: false, seed: false, imageParam: "images", maxImages: 10, sourceOptional: true,
        optional: { generateAudio: { paramName: "generate_audio_switch", type: "boolean", default: false } } } },
    { id: "pixverse/pixverse-v6/transition", name: "PixVerse V6 Transition", provider: "PixVerse", price: 0.025,
      params: { resolution: RES_VIDEO_360_540_720_1080, aspectRatio: AR_KLING_IMAGE, duration: { options: DUR_1_15, default: 5 }, negativePrompt: true, seed: true, maxImages: 2, lastImageParam: "end_image",
        optional: { generateAudio: { paramName: "generate_audio_switch", type: "boolean", default: false } } } },

    // Pika
    { id: "pika/v2.2-i2v", name: "Pika V2.2 I2V", provider: "Pika", price: 0.40,
      params: { resolution: { paramName: "size", options: [{ label: "1280x720", value: "1280*720" }, { label: "720x1280", value: "720*1280" }], default: "1280*720" }, duration: { options: [5,10], default: 5 }, negativePrompt: false, seed: false } },

    // ByteDance Waver 1.0 is image-conditioned despite its endpoint name.
    { id: "bytedance/waver-1.0", name: "Waver 1.0", provider: "ByteDance", price: 0.30,
      params: { resolution: null, duration: null, negativePrompt: false, seed: true } },

    // Vidu
    { id: "vidu/q3/image-to-video", name: "Vidu Q3 I2V", provider: "Vidu", price: 0.35, hot: true,
      params: { resolution: RES_VIDEO_540_720_1080_DEFAULT_720, duration: { options: DUR_1_16, default: 5 }, negativePrompt: false, seed: true,
        optional: { generateAudio: { paramName: "generate_audio", type: "boolean", default: true }, bgm: { paramName: "bgm", type: "boolean", default: true } } } },
    { id: "vidu/q3-pro/image-to-video", name: "Vidu Q3 Pro I2V", provider: "Vidu", price: 0.25,
      params: { resolution: RES_VIDEO_540_720_1080_DEFAULT_720, duration: { options: DUR_1_16, default: 5 }, negativePrompt: false, seed: true,
        optional: { generateAudio: { paramName: "generate_audio", type: "boolean", default: true }, bgm: { paramName: "bgm", type: "boolean", default: true } } } },
    { id: "vidu/q3-turbo/image-to-video", name: "Vidu Q3 Turbo I2V", provider: "Vidu", price: 0.30,
      params: { resolution: RES_VIDEO_540_720_1080_DEFAULT_720, duration: { options: DUR_1_16, default: 5 }, negativePrompt: false, seed: true,
        optional: { generateAudio: { paramName: "generate_audio", type: "boolean", default: true }, bgm: { paramName: "bgm", type: "boolean", default: true } } } },
    { id: "vidu/q3/image-to-video-pro", name: "Vidu Q3 I2V High-Res", provider: "Vidu", price: 0.45, flagship: true,
      params: { resolution: RES_VIDEO_720_1080_2K_4K, duration: { options: DUR_1_16, default: 5 }, negativePrompt: false, seed: true,
        optional: { generateAudio: { paramName: "generate_audio", type: "boolean", default: true }, bgm: { paramName: "bgm", type: "boolean", default: true } } } },
    { id: "vidu/q3/start-end-to-video", name: "Vidu Q3 Start + End", provider: "Vidu", price: 0.35,
      params: { resolution: RES_VIDEO_540_720_1080_DEFAULT_720, duration: { options: DUR_1_16, default: 5 }, negativePrompt: false, seed: true, maxImages: 2, lastImageParam: "last_image", requiresLastImage: true,
        optional: { generateAudio: { paramName: "generate_audio", type: "boolean", default: true }, bgm: { paramName: "bgm", type: "boolean", default: true } } } },
    { id: "vidu/q3-pro/start-end-to-video", name: "Vidu Q3 Pro Start + End", provider: "Vidu", price: 0.25,
      params: { resolution: RES_VIDEO_540_720_1080_DEFAULT_720, duration: { options: DUR_1_16, default: 5 }, negativePrompt: false, seed: true, maxImages: 2, lastImageParam: "last_image", requiresLastImage: true,
        optional: { generateAudio: { paramName: "generate_audio", type: "boolean", default: true }, bgm: { paramName: "bgm", type: "boolean", default: true } } } },
    { id: "vidu/q3-turbo/start-end-to-video", name: "Vidu Q3 Turbo Start + End", provider: "Vidu", price: 0.30,
      params: { resolution: RES_VIDEO_540_720_1080_DEFAULT_720, duration: { options: DUR_1_16, default: 5 }, negativePrompt: false, seed: true, maxImages: 2, lastImageParam: "last_image", requiresLastImage: true,
        optional: { generateAudio: { paramName: "generate_audio", type: "boolean", default: true }, bgm: { paramName: "bgm", type: "boolean", default: true } } } },
    { id: "vidu/q3/reference-to-video", name: "Vidu Q3 Reference", provider: "Vidu", price: 0.35,
      params: { resolution: RES_VIDEO_360_540_720_1080, aspectRatio: AR_WAN3, duration: { options: DUR_1_16, default: 5 }, negativePrompt: false, seed: true, imageParam: "images", maxImages: 4,
        optional: { generateAudio: { paramName: "generate_audio", type: "boolean", default: true } } } },
    { id: "vidu/q3-ad", name: "Vidu Q3 Ad", provider: "Vidu", price: 0.15,
      params: { resolution: RES_VIDEO_720_1080, aspectRatio: AR_WAN3, duration: { options: Array.from({ length: 14 }, (_, i) => i + 3), default: 5 }, negativePrompt: false, seed: true, imageParam: "images", maxImages: 7,
        optional: { generateAudio: { paramName: "generate_audio", type: "boolean", default: true } } } },

    // ByteDance Seedance I2V
    { id: "bytedance/seedance-v1.5-pro/image-to-video", name: "Seedance 1.5 Pro I2V", provider: "ByteDance", price: 0.26, hot: true,
      params: { resolution: { paramName: "resolution", options: [{ label: "480p", value: "480p" }, { label: "720p", value: "720p" }, { label: "1080p", value: "1080p" }], default: "720p" }, aspectRatio: AR_SEEDANCE, duration: { options: [4,5,6,7,8,9,10,11,12], default: 5 }, negativePrompt: false, seed: true, optional: { generateAudio: { paramName: "generate_audio", type: "boolean", default: true }, cameraFixed: { paramName: "camera_fixed", type: "boolean", default: false } } } },
    { id: "bytedance/seedance-v1.5-pro/image-to-video-fast", name: "Seedance 1.5 Pro I2V Fast", provider: "ByteDance", price: 0.20,
      params: { resolution: RES_VIDEO_720_1080, aspectRatio: AR_SEEDANCE, duration: { options: [4,5,6,7,8,9,10,11,12], default: 5 }, negativePrompt: false, seed: true, optional: { generateAudio: { paramName: "generate_audio", type: "boolean", default: true }, cameraFixed: { paramName: "camera_fixed", type: "boolean", default: false } } } },

    // MiniMax H3 — official + WaveSpeed open-weights I2V/reference variants
    { id: "minimax/h3/image-to-video", name: "MiniMax H3 Official I2V", provider: "Minimax", price: 0.70, flagship: true,
      params: { resolution: RES_VIDEO_H3_OFFICIAL, duration: { options: [4,5,6,7,8,9,10,11,12,13,14,15], default: 5 }, negativePrompt: false, seed: false, maxImages: 2, lastImageParam: "last_image" } },
    { id: "minimax/h3/reference-to-video", name: "MiniMax H3 Official Reference", provider: "Minimax", price: 0.70,
      params: { resolution: RES_VIDEO_H3_OFFICIAL, aspectRatio: AR_H3, duration: { options: [4,5,6,7,8,9,10,11,12,13,14,15], default: 5 }, negativePrompt: false, seed: false, imageParam: "reference_images", maxImages: 9, sourceOptional: true } },
    { id: "wavespeed-ai/minimax-h3/image-to-video", name: "MiniMax H3 WaveSpeed I2V", provider: "Minimax", price: 0.10, hot: true,
      params: { resolution: RES_VIDEO_H3, duration: { options: DUR_3_15, default: 5 }, negativePrompt: false, seed: true, maxImages: 2, lastImageParam: "last_image" } },
    { id: "wavespeed-ai/minimax-h3/reference-to-video", name: "MiniMax H3 WaveSpeed Reference", provider: "Minimax", price: 0.125,
      params: { resolution: RES_VIDEO_H3, aspectRatio: AR_H3_WS, duration: { options: DUR_3_15, default: 5 }, negativePrompt: false, seed: true, imageParam: "reference_images", maxImages: 9, sourceOptional: true } },
    { id: "wavespeed-ai/minimax-h3/image-to-video-lora", name: "MiniMax H3 I2V LoRA", provider: "Minimax", price: 0.125,
      params: { resolution: RES_VIDEO_H3, duration: { options: DUR_3_15, default: 5 }, negativePrompt: false, seed: true, maxImages: 2, lastImageParam: "last_image" } },
    { id: "wavespeed-ai/minimax-h3/reference-to-video-lora", name: "MiniMax H3 Reference LoRA", provider: "Minimax", price: 0.15,
      params: { resolution: RES_VIDEO_H3, aspectRatio: AR_H3_WS, duration: { options: DUR_3_15, default: 5 }, negativePrompt: false, seed: true, imageParam: "reference_images", maxImages: 9, sourceOptional: true } },
    { id: "wavespeed-ai/minimax-h3-singularity/image-to-video", name: "MiniMax H3 Singularity I2V", provider: "Minimax", price: 0.125, hot: true,
      params: { resolution: RES_VIDEO_H3, duration: { options: DUR_3_15, default: 5 }, negativePrompt: false, seed: true, maxImages: 2, lastImageParam: "last_image" } },
    { id: "wavespeed-ai/minimax-h3-singularity/image-to-video-lora", name: "MiniMax H3 Singularity I2V LoRA", provider: "Minimax", price: 0.1563,
      params: { resolution: RES_VIDEO_H3, duration: { options: DUR_3_15, default: 5 }, negativePrompt: false, seed: true, maxImages: 2, lastImageParam: "last_image" } },
    { id: "wavespeed-ai/minimax-h3-singularity/reference-to-video", name: "MiniMax H3 Singularity Reference", provider: "Minimax", price: 0.125,
      params: { resolution: RES_VIDEO_H3, aspectRatio: AR_H3_WS, duration: { options: DUR_3_15, default: 5 }, negativePrompt: false, seed: true, imageParam: "reference_images", maxImages: 9, sourceOptional: true } },
    { id: "wavespeed-ai/minimax-h3-singularity/reference-to-video-lora", name: "MiniMax H3 Singularity Reference LoRA", provider: "Minimax", price: 0.15,
      params: { resolution: RES_VIDEO_H3, aspectRatio: AR_H3_WS, duration: { options: DUR_3_15, default: 5 }, negativePrompt: false, seed: true, imageParam: "reference_images", maxImages: 9, sourceOptional: true } },

    // WaveSpeed — Cosmos Predict I2V
    { id: "wavespeed-ai/cosmos-predict-2.5/image-to-video", name: "Cosmos Predict 2.5 I2V", provider: "WaveSpeed", price: 0.25,
      params: { resolution: null, duration: null, negativePrompt: false, seed: false } },

    // WaveSpeed — Kandinsky I2V
    { id: "wavespeed-ai/kandinsky5-pro/image-to-video", name: "Kandinsky 5 Pro I2V", provider: "WaveSpeed", price: 0.20,
      params: { resolution: RES_KANDINSKY, duration: { options: [5], default: 5 }, negativePrompt: false, seed: false } },

    // ─── 2026-06 additions (standard) ───
    { id: "bytedance/seedance-2.0/image-to-video", name: "Seedance 2.0 I2V", provider: "ByteDance", price: 0.60,
      params: { resolution: RES_VIDEO_480_4K, aspectRatio: AR_SEEDANCE, duration: DUR_SEEDANCE, negativePrompt: false, seed: false, maxImages: 2, lastImageParam: "last_image", optional: { generateAudio: { paramName: "generate_audio", type: "boolean", default: true } } } },
    { id: "kwaivgi/kling-v3.0-std/image-to-video", name: "Kling 3.0 Std I2V", provider: "Kwaivgi", price: 0.42,
      params: { resolution: null, duration: DUR_KLING3, negativePrompt: true, seed: false, endFrame: "end_image", optional: { cfgScale: { paramName: "cfg_scale", type: "number", default: 0.5, min: 0, max: 1 }, sound: { paramName: "sound", type: "boolean", default: false } } } },
    { id: "nvidia/cosmos-3-super/image-to-video", name: "Cosmos 3 Super I2V", provider: "NVIDIA", price: 0.05,
      params: { resolution: { paramName: "size", options: AR_STANDARD.options, default: "16:9" }, duration: { options: DUR_COSMOS.options, default: 7 }, negativePrompt: true, seed: false,
        optional: { guidanceScale: { paramName: "guidance_scale", type: "number", default: 6, min: 0, max: 20 }, numInferenceSteps: { paramName: "num_inference_steps", type: "number", default: 28, min: 1, max: 50 } } } },
    { id: "alibaba/wan-2.7/reference-to-video", name: "WAN 2.7 Reference", provider: "Alibaba", price: 0.50,
      params: { resolution: RES_VIDEO_720_1080, duration: { options: [5, 10, 15], default: 5 }, negativePrompt: true, seed: true, referenceVideos: "videos", optional: { enablePromptExpansion: { paramName: "enable_prompt_expansion", type: "boolean", default: false } } } },

    // ─── 2026-06 additions (spicy / uncensored) ───
    { id: "bytedance/seedance-2.0/image-to-video-spicy", name: "Seedance 2.0 Spicy", provider: "ByteDance", price: 0.60,
      params: { resolution: RES_VIDEO_480_1080, aspectRatio: AR_SEEDANCE, duration: DUR_SEEDANCE, negativePrompt: false, seed: true } },
    { id: "bytedance/seedance-2.0-fast/image-to-video-spicy", name: "Seedance 2.0 Fast Spicy", provider: "ByteDance", price: 0.50,
      params: { resolution: RES_VIDEO_480_1080, aspectRatio: AR_SEEDANCE, duration: DUR_SEEDANCE, negativePrompt: false, seed: true } },
    { id: "bytedance/seedance-2.0-mini/image-to-video-spicy", name: "Seedance 2.0 Mini Spicy", provider: "ByteDance", price: 0.30,
      params: { resolution: RES_VIDEO_480_4K, aspectRatio: AR_SEEDANCE, duration: DUR_SEEDANCE, negativePrompt: false, seed: true } },
    { id: "bytedance/seedance-v1.5-pro/image-to-video-spicy", name: "Seedance 1.5 Pro Spicy", provider: "ByteDance", price: 0.06,
      params: { resolution: RES_VIDEO_480_1080, aspectRatio: AR_SEEDANCE, duration: { options: [4, 5, 6, 7, 8, 9, 10, 11, 12], default: 5 }, negativePrompt: false, seed: true } },
    { id: "wavespeed-ai/wan-2.2-spicy/image-to-video", name: "WAN 2.2 Spicy", provider: "Alibaba", price: 0.15,
      params: { resolution: RES_VIDEO_480_720, duration: { options: [5, 8], default: 5 }, negativePrompt: false, seed: true } },
    { id: "alibaba/wan-2.6/image-to-video-spicy", name: "WAN 2.6 Spicy", provider: "Alibaba", price: 0.50,
      params: { resolution: RES_VIDEO_720_1080, duration: { options: [5, 10, 15], default: 5 }, negativePrompt: false, seed: true } },
    { id: "alibaba/wan-2.7/image-to-video-spicy", name: "WAN 2.7 Spicy", provider: "Alibaba", price: 0.50,
      params: { resolution: RES_VIDEO_720_1080, duration: { options: [5, 10, 15], default: 5 }, negativePrompt: false, seed: true } },
  ],

  v2v: [
    // Google Veo 3.1 extension tiers
    { id: "google/veo3.1/video-extend", name: "Veo 3.1 Extend", provider: "Google", price: 3.20,
      params: { resolution: { ...RES_VIDEO_720_1080, default: "1080p" }, negativePrompt: true, seed: true } },
    { id: "google/veo3.1-fast/video-extend", name: "Veo 3.1 Fast Extend", provider: "Google", price: 1.20, hot: true,
      params: { resolution: { ...RES_VIDEO_720_1080, default: "1080p" }, negativePrompt: true, seed: true } },

    // Kuaishou Kling O3 conversational editing and video-reference tiers
    { id: "kwaivgi/kling-video-o3-std/video-edit", name: "Kling O3 Standard Video Edit", provider: "Kwaivgi", price: 0.63, hot: true,
      params: { resolution: null, negativePrompt: false, seed: false,
        optional: { keepOriginalSound: { paramName: "keep_original_sound", type: "boolean", default: true } } } },
    { id: "kwaivgi/kling-video-o3-pro/video-edit", name: "Kling O3 Pro Video Edit", provider: "Kwaivgi", price: 0.84, flagship: true,
      params: { resolution: null, negativePrompt: false, seed: false,
        optional: { keepOriginalSound: { paramName: "keep_original_sound", type: "boolean", default: true } } } },
    { id: "kwaivgi/kling-video-o3-4k/video-edit", name: "Kling O3 4K Video Edit", provider: "Kwaivgi", price: 2.31,
      params: { resolution: null, negativePrompt: false, seed: false,
        optional: { keepOriginalSound: { paramName: "keep_original_sound", type: "boolean", default: true } } } },
    { id: "kwaivgi/kling-video-o3-4k/video-reference", name: "Kling O3 4K Video Reference", provider: "Kwaivgi", price: 2.31,
      params: { resolution: null, aspectRatio: AR_KLING, duration: { options: DUR_3_15, default: 5 }, negativePrompt: false, seed: false,
        optional: { keepOriginalSound: { paramName: "keep_original_sound", type: "boolean", default: true } } } },

    // ByteDance Seedance 2.5 video editing + extension
    { id: "bytedance/seedance-2.5/video-edit", name: "Seedance 2.5 Video Edit", provider: "ByteDance", price: 0.99, hot: true,
      params: { resolution: RES_VIDEO_480_720_1080_4K, negativePrompt: false, seed: false,
        optional: { generateAudio: { paramName: "generate_audio", type: "boolean", default: true } } } },
    { id: "bytedance/seedance-2.5/video-edit-turbo", name: "Seedance 2.5 Video Edit Turbo", provider: "ByteDance", price: 1.17, flagship: true,
      params: { resolution: RES_VIDEO_720_1080, negativePrompt: false, seed: false,
        optional: { generateAudio: { paramName: "generate_audio", type: "boolean", default: true } } } },
    { id: "bytedance/seedance-2.5/video-extend", name: "Seedance 2.5 Video Extend", provider: "ByteDance", price: 0.99,
      params: { resolution: RES_VIDEO_480_720_1080_4K, duration: { options: DUR_4_30, default: 5 }, negativePrompt: false, seed: false,
        optional: { generateAudio: { paramName: "generate_audio", type: "boolean", default: true } } } },

    // Alibaba WAN 3.0 + Prime video editing + extension
    { id: "alibaba/wan-3.0/video-edit", name: "WAN 3.0 Video Edit", provider: "Alibaba", price: 0.50, hot: true,
      params: { resolution: RES_VIDEO_480_720_1080, duration: { options: [2,3,4,5,6,7,8,9,10,11,12,13,14,15], default: 5 }, negativePrompt: false, seed: true,
        optional: { enablePromptExpansion: { paramName: "enable_prompt_expansion", type: "boolean", default: false }, generateAudio: { paramName: "generate_audio", type: "boolean", default: true } } } },
    { id: "alibaba/wan-3.0/video-extend", name: "WAN 3.0 Video Extend", provider: "Alibaba", price: 0.50,
      params: { resolution: RES_VIDEO_480_720_1080, duration: { options: DUR_2_30, default: 5 }, negativePrompt: false, seed: true,
        optional: { enablePromptExpansion: { paramName: "enable_prompt_expansion", type: "boolean", default: false }, generateAudio: { paramName: "generate_audio", type: "boolean", default: true } } } },
    { id: "alibaba/wan-3.0-prime/video-edit", name: "WAN 3.0 Prime Video Edit", provider: "Alibaba", price: 0.75, flagship: true,
      params: { resolution: RES_VIDEO_480_720_1080, duration: { options: [2,3,4,5,6,7,8,9,10,11,12,13,14,15], default: 5 }, negativePrompt: false, seed: true,
        optional: { enablePromptExpansion: { paramName: "enable_prompt_expansion", type: "boolean", default: false }, generateAudio: { paramName: "generate_audio", type: "boolean", default: true } } } },
    { id: "alibaba/wan-3.0-prime/video-extend", name: "WAN 3.0 Prime Video Extend", provider: "Alibaba", price: 0.75,
      params: { resolution: RES_VIDEO_480_720_1080, duration: { options: DUR_2_30, default: 5 }, negativePrompt: false, seed: true,
        optional: { enablePromptExpansion: { paramName: "enable_prompt_expansion", type: "boolean", default: false }, generateAudio: { paramName: "generate_audio", type: "boolean", default: true } } } },

    // Black Forest Labs FLUX 3 video workflows
    { id: "black-forest-labs/flux-3/video-edit", name: "FLUX 3 Video Edit", provider: "BFL", price: 0.03,
      params: { resolution: null, negativePrompt: false, seed: false } },
    { id: "black-forest-labs/flux-3/video-extend", name: "FLUX 3 Video Extend", provider: "BFL", price: 2.05,
      params: { resolution: RES_VIDEO_FLUX3, aspectRatio: AR_FLUX3, duration: { options: DUR_5_20, default: 5 }, negativePrompt: false, seed: false,
        optional: { generateAudio: { paramName: "generate_audio", type: "boolean", default: true } } } },
    { id: "black-forest-labs/flux-3/video-extend-draft", name: "FLUX 3 Video Extend Draft", provider: "BFL", price: 0.60, hot: true,
      params: { resolution: null, aspectRatio: AR_FLUX3, duration: { options: DUR_5_20, default: 5 }, negativePrompt: false, seed: false,
        optional: { generateAudio: { paramName: "generate_audio", type: "boolean", default: true } } } },
    { id: "black-forest-labs/flux-3/video-upscale", name: "FLUX 3 Video Upscale", provider: "BFL", price: 0.79,
      params: { resolution: null, negativePrompt: false, seed: false, noPrompt: true,
        optional: { creativity: { paramName: "creativity", type: "number", default: 1, min: 0, max: 1 }, upscaleFactor: { paramName: "upscale_factor", type: "number", default: 2, min: 1.5, max: 3 } } } },

    // MiniMax H3 video workflows
    { id: "wavespeed-ai/minimax-h3/video-edit", name: "MiniMax H3 Video Edit", provider: "Minimax", price: 0.125, hot: true,
      params: { resolution: RES_VIDEO_H3, aspectRatio: AR_H3_WS, duration: { options: DUR_3_15, default: 5 }, negativePrompt: false, seed: true,
        optional: { generateAudio: { paramName: "generate_audio", type: "boolean", default: true } } } },
    { id: "wavespeed-ai/minimax-h3/video-extend", name: "MiniMax H3 Video Extend", provider: "Minimax", price: 0.10,
      params: { resolution: RES_VIDEO_H3, duration: { options: DUR_3_15, default: 5 }, negativePrompt: false, seed: true } },
    { id: "wavespeed-ai/minimax-h3/controlnet-union", name: "MiniMax H3 Motion Control", provider: "Minimax", price: 0.15,
      params: { resolution: RES_VIDEO_H3, negativePrompt: false, seed: true,
        optional: { controlType: { paramName: "control_type", type: "enum", values: ["pose", "depth", "canny", "soft_edge", "lines", "scribble", "gray"], default: "pose" }, controlStrength: { paramName: "control_strength", type: "number", default: 1, min: 0, max: 2 }, generateAudio: { paramName: "generate_audio", type: "boolean", default: true } } } },

    // Luma Ray 3.2 video editing + reframing
    { id: "luma/ray-3.2/video-edit", name: "Luma Ray 3.2 Video Edit", provider: "Luma", price: 0.72,
      params: { resolution: RES_VIDEO_540_720_1080, duration: { options: [5,10], default: 5 }, negativePrompt: false, seed: false } },
    { id: "luma/ray-3.2/video-reframing", name: "Luma Ray 3.2 Reframe", provider: "Luma", price: 0.06,
      params: { resolution: RES_VIDEO_540_720_1080, aspectRatio: AR_LUMA_REFRAME, negativePrompt: false, seed: false } },

    // PixVerse V6 video extension
    { id: "pixverse/pixverse-v6/extend", name: "PixVerse V6 Extend", provider: "PixVerse", price: 0.025,
      params: { resolution: RES_VIDEO_360_540_720_1080, duration: { options: DUR_1_15, default: 5 }, negativePrompt: true, seed: true,
        optional: { generateAudio: { paramName: "generate_audio_switch", type: "boolean", default: false } } } },
  ],

  avatar: [
    { id: "bytedance/seedance-2.5/talking-avatar", name: "Seedance 2.5 Talking Avatar", provider: "ByteDance", price: 1.10, hot: true, requiresAudio: true,
      params: { resolution: { paramName: "resolution", options: [{ label: "480p", value: "480p" }, { label: "720p", value: "720p" }], default: "720p" }, negativePrompt: false, seed: false, noPrompt: true } },
    { id: "wavespeed-ai/infinitetalk", name: "InfiniteTalk", provider: "WaveSpeed", price: 0.15, requiresAudio: true,
      params: { resolution: { paramName: "resolution", options: [{ label: "480p", value: "480p" }, { label: "720p", value: "720p" }], default: "480p" }, negativePrompt: false, seed: true, audioParam: "audio" } },
    { id: "kwaivgi/kling-v2-ai-avatar-pro", name: "Kling Avatar Pro", provider: "Kwaivgi", price: 0.34, hot: true, requiresAudio: true,
      params: { resolution: null, negativePrompt: false, seed: false, audioParam: "audio" } },
    { id: "wavespeed-ai/wan-2.2/animate", name: "WAN 2.2 Animate", provider: "WaveSpeed", price: 0.20, requiresVideo: true,
      params: { resolution: null, negativePrompt: false, seed: true, videoParam: "video" } },
    { id: "wavespeed-ai/image-face-swap-pro", name: "Face Swap Pro", provider: "WaveSpeed", price: 0.05,
      params: { resolution: null, negativePrompt: false, seed: false, noPrompt: true,
        maxImages: 2, auxImageParam: "face_image", requiresSecondImage: true } },
  ],
};

export const TYPE_LABELS = { image: "Image", i2i: "Image Edit", i23d: "Image → 3D", t2v: "Text → Video", i2v: "Image → Video", v2v: "Video Edit", avatar: "Avatar" };
export const TYPE_ICONS = { image: "🖼️", i2i: "✏️", i23d: "🧊", t2v: "🎬", i2v: "📸→🎬", v2v: "🎞️", avatar: "🧑‍🎤" };
