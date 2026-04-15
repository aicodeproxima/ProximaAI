// ─── PROVIDER COLORS ───
export const PROVIDER_COLORS = {
  Google: "#4285f4", ByteDance: "#fe2c55", OpenAI: "#10a37f", Alibaba: "#ff6a00",
  Kwaivgi: "#7c3aed", WaveSpeed: "#06b6d4", Vidu: "#ec4899", Minimax: "#f59e0b",
  BFL: "#a855f7", Luma: "#f472b6", PixVerse: "#22d3ee", Pika: "#fb923c",
  Runway: "#14b8a6",
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

// ─── MODEL REGISTRY ───
export const MODELS = {
  image: [
    // Google Nano Banana
    { id: "google/nano-banana-2/text-to-image", name: "Nano Banana 2", provider: "Google", price: 0.0105, hot: true,
      params: { resolution: RES_NANO, negativePrompt: true, seed: true, optional: { webSearch: { paramName: "web_search", type: "boolean", default: false }, imgSearch: { paramName: "img_search", type: "boolean", default: false } } } },
    { id: "google/nano-banana-pro/text-to-image", name: "Nano Banana Pro", provider: "Google", price: 0.14, hot: true,
      params: { resolution: RES_NANO, negativePrompt: true, seed: true, optional: { webSearch: { paramName: "web_search", type: "boolean", default: false }, imgSearch: { paramName: "img_search", type: "boolean", default: false } } } },
    { id: "google/imagen4", name: "Imagen 4", provider: "Google", price: 0.08, hot: true,
      params: { resolution: RES_NANO, negativePrompt: true, seed: true } },

    // Flux
    { id: "wavespeed-ai/flux-dev", name: "Flux Dev", provider: "WaveSpeed", price: 0.03,
      params: { resolution: RES_FLUX, negativePrompt: false, seed: true, optional: { numInferenceSteps: { paramName: "num_inference_steps", type: "number", default: 28, min: 1, max: 50 }, guidanceScale: { paramName: "guidance_scale", type: "number", default: 3.5, min: 0, max: 20 } } } },
    { id: "wavespeed-ai/flux-schnell", name: "Flux Schnell", provider: "WaveSpeed", price: 0.01, hot: true,
      params: { resolution: RES_FLUX, negativePrompt: false, seed: true } },
    { id: "wavespeed-ai/flux-2-klein-4b/text-to-image-lora", name: "FLUX 2 Klein 4B", provider: "BFL", price: 0.01,
      params: { resolution: RES_FLUX, negativePrompt: false, seed: true } },
    { id: "wavespeed-ai/flux-2-klein-9b/text-to-image", name: "FLUX 2 Klein 9B", provider: "BFL", price: 0.02,
      params: { resolution: RES_FLUX, negativePrompt: false, seed: true } },

    // ByteDance Seedream
    { id: "bytedance/seedream-v5.0-lite", name: "Seedream 5.0 Lite", provider: "ByteDance", price: 0.035, hot: true,
      params: { resolution: RES_SEEDREAM5, negativePrompt: false, seed: false } },
    { id: "bytedance/seedream-v5.0-lite/sequential", name: "Seedream 5.0 Sequential", provider: "ByteDance", price: 0.035,
      params: { resolution: RES_SEEDREAM5, negativePrompt: false, seed: false, optional: { maxImages: { paramName: "max_images", type: "number", default: 1, min: 1, max: 15 } } } },
    { id: "bytedance/seedream-v4.5", name: "Seedream 4.5", provider: "ByteDance", price: 0.04,
      params: { resolution: RES_SEEDREAM, negativePrompt: true, seed: true } },

    // Alibaba
    { id: "alibaba/wan-2.6/text-to-image", name: "WAN 2.6", provider: "Alibaba", price: 0.02,
      params: { resolution: RES_WAN_T2I, negativePrompt: false, seed: true, optional: { enablePromptExpansion: { paramName: "enable_prompt_expansion", type: "boolean", default: false } } } },

    // WaveSpeed / Alibaba
    { id: "wavespeed-ai/qwen-image-2.0-pro/text-to-image", name: "Qwen Image 2.0 Pro", provider: "Alibaba", price: 0.07, hot: true,
      params: { resolution: RES_QWEN_PRO, negativePrompt: false, seed: true } },
    { id: "wavespeed-ai/qwen-image-text-to-image", name: "Qwen Image", provider: "Alibaba", price: 0.02,
      params: { resolution: RES_QWEN_PRO, negativePrompt: false, seed: true } },
    { id: "wavespeed-ai/phota/text-to-image", name: "Phota", provider: "WaveSpeed", price: 0.03,
      params: { resolution: RES_FLUX, negativePrompt: true, seed: true } },

    // OpenAI
    { id: "openai/dall-e-3", name: "DALL-E 3", provider: "OpenAI", price: 0.08,
      params: { resolution: { paramName: "size", options: [{ label: "1024x1024", value: "1024x1024" }, { label: "1024x1792", value: "1024x1792" }, { label: "1792x1024", value: "1792x1024" }], default: "1024x1024" }, negativePrompt: false, seed: false, outputFormat: false } },

    // Luma
    { id: "luma/photon", name: "Luma Photon", provider: "Luma", price: 0.03,
      params: { resolution: null, aspectRatio: AR_STANDARD, negativePrompt: false, seed: true, outputFormat: false } },
  ],

  i2i: [
    // Google Nano Banana Edit
    { id: "google/nano-banana-2/edit", name: "Nano Banana 2 Edit", provider: "Google", price: 0.0105, hot: true,
      params: { resolution: RES_NANO, negativePrompt: true, seed: true, maxImages: 14, optional: { webSearch: { paramName: "web_search", type: "boolean", default: false } } } },
    { id: "google/nano-banana-pro/edit", name: "Nano Banana Pro Edit", provider: "Google", price: 0.14, hot: true,
      params: { resolution: RES_NANO, negativePrompt: true, seed: true, maxImages: 8 } },
    { id: "google/gemini-2.5-flash-image/edit", name: "Gemini 2.5 Flash Edit", provider: "Google", price: 0.05,
      params: { resolution: null, negativePrompt: false, seed: false, maxImages: 10, outputFormat: false } },

    // ByteDance
    { id: "bytedance/seedream-v5.0-lite/edit", name: "Seedream 5.0 Lite Edit", provider: "ByteDance", price: 0.035, hot: true,
      params: { resolution: RES_SEEDREAM5, negativePrompt: false, seed: false, maxImages: 10 } },
    { id: "bytedance/seedream-v5.0-lite/edit-sequential", name: "Seedream 5.0 Edit Sequential", provider: "ByteDance", price: 0.035,
      params: { resolution: RES_SEEDREAM5, negativePrompt: false, seed: false, maxImages: 10, optional: { maxOutputImages: { paramName: "max_images", type: "number", default: 1, min: 1, max: 15 } } } },
    { id: "bytedance/seedream-v4.5/edit", name: "Seedream 4.5 Edit", provider: "ByteDance", price: 0.04,
      params: { resolution: RES_SEEDREAM, negativePrompt: true, seed: true, maxImages: 10 } },
    { id: "bytedance/seededit-v3", name: "SeedEdit V3", provider: "ByteDance", price: 0.03,
      params: { resolution: RES_SEEDREAM, negativePrompt: false, seed: true, maxImages: 5 } },

    // Alibaba WAN Edit
    { id: "alibaba/wan-2.7/image-edit", name: "WAN 2.7 Edit", provider: "Alibaba", price: 0.03, hot: true,
      params: { resolution: null, negativePrompt: false, seed: true, maxImages: 9 } },
    { id: "alibaba/wan-2.7/image-edit-pro", name: "WAN 2.7 Edit Pro", provider: "Alibaba", price: 0.075,
      params: { resolution: null, negativePrompt: false, seed: true, maxImages: 9 } },

    // Flux Edit
    { id: "wavespeed-ai/flux-2-pro/edit", name: "FLUX 2 Pro Edit", provider: "BFL", price: 0.04,
      params: { resolution: RES_FLUX, negativePrompt: false, seed: true, maxImages: 3 } },
    { id: "wavespeed-ai/flux-kontext-pro", name: "FLUX Kontext Pro", provider: "BFL", price: 0.04, hot: true,
      params: { resolution: null, aspectRatio: AR_STANDARD, negativePrompt: false, seed: true, imageParam: "image" } },

    // WaveSpeed
    { id: "wavespeed-ai/qwen-image-2.0-pro/edit", name: "Qwen Image 2.0 Pro Edit", provider: "Alibaba", price: 0.07, hot: true,
      params: { resolution: RES_QWEN_PRO, negativePrompt: false, seed: true, maxImages: 6 } },
    { id: "wavespeed-ai/qwen-image-edit", name: "Qwen Image Edit", provider: "Alibaba", price: 0.03,
      params: { resolution: null, negativePrompt: false, seed: true, imageParam: "image" } },
    { id: "wavespeed-ai/phota/edit", name: "Phota Edit", provider: "WaveSpeed", price: 0.03,
      params: { resolution: RES_FLUX, negativePrompt: true, seed: true, maxImages: 3 } },
    { id: "wavespeed-ai/firered-image-v1.1-edit", name: "FireRed Edit", provider: "WaveSpeed", price: 0.02,
      params: { resolution: null, negativePrompt: false, seed: true, imageParam: "image" } },
    { id: "wavespeed-ai/step1x-edit", name: "Step1X Edit", provider: "WaveSpeed", price: 0.02,
      params: { resolution: null, negativePrompt: false, seed: true, imageParam: "image" } },
  ],

  t2v: [
    // Alibaba WAN
    { id: "alibaba/wan-2.7/text-to-video", name: "WAN 2.7", provider: "Alibaba", price: 0.50, hot: true,
      params: { resolution: RES_VIDEO_WAN, duration: { options: [2,3,4,5,6,7,8,9,10,15], default: 5 }, negativePrompt: true, seed: true, optional: { enablePromptExpansion: { paramName: "enable_prompt_expansion", type: "boolean", default: false } } } },
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
    { id: "google/veo3.1-lite/text-to-video", name: "Veo 3.1 Lite", provider: "Google", price: 0.50,
      params: { resolution: RES_VIDEO_720_1080, aspectRatio: AR_VEO, duration: { options: [5,8], default: 5 }, negativePrompt: false, seed: true } },

    // Kling
    { id: "kwaivgi/kling-v3.0-pro/text-to-video", name: "Kling 3.0 Pro", provider: "Kwaivgi", price: 0.80, hot: true,
      params: { resolution: null, aspectRatio: AR_KLING, duration: { options: [5,10], default: 5 }, negativePrompt: true, seed: false, optional: { cfgScale: { paramName: "cfg_scale", type: "number", default: 0.5, min: 0, max: 1 }, sound: { paramName: "sound", type: "boolean", default: false } } } },

    // PixVerse
    { id: "pixverse/pixverse-v6/text-to-video", name: "PixVerse V6", provider: "PixVerse", price: 0.40,
      params: { resolution: RES_VIDEO_720_1080, aspectRatio: AR_STANDARD, duration: { options: [5,8], default: 5 }, negativePrompt: true, seed: true } },

    // Pika
    { id: "pika/v2.2-t2v", name: "Pika V2.2", provider: "Pika", price: 0.40,
      params: { resolution: RES_VIDEO_720_1080, duration: { options: [5,10], default: 5 }, negativePrompt: false, seed: true } },

    // ByteDance
    { id: "bytedance/waver-1.0", name: "Waver 1.0", provider: "ByteDance", price: 0.30,
      params: { resolution: RES_VIDEO_720_1080, duration: { options: [5], default: 5 }, negativePrompt: false, seed: true } },

    // Vidu
    { id: "vidu/q3/text-to-video", name: "Vidu Q3", provider: "Vidu", price: 0.30,
      params: { resolution: RES_VIDEO_720, duration: { options: [4,8], default: 4 }, negativePrompt: false, seed: true } },

    // Minimax
    { id: "minimax/hailuo-2.3/t2v-pro", name: "Hailuo 2.3", provider: "Minimax", price: 0.50,
      params: { resolution: RES_VIDEO_720_1080, duration: { options: [5], default: 5 }, negativePrompt: false, seed: true } },

    // WaveSpeed — Cosmos Predict
    { id: "wavespeed-ai/cosmos-predict-2.5/text-to-video", name: "Cosmos Predict 2.5", provider: "WaveSpeed", price: 0.25,
      params: { resolution: null, duration: { options: [5], default: 5 }, negativePrompt: false, seed: false } },

    // WaveSpeed — Kandinsky
    { id: "wavespeed-ai/kandinsky5-pro/text-to-video", name: "Kandinsky 5 Pro", provider: "WaveSpeed", price: 0.20,
      params: { resolution: RES_KANDINSKY, aspectRatio: AR_KANDINSKY, duration: { options: [5], default: 5 }, negativePrompt: false, seed: false } },
  ],

  i2v: [
    // Alibaba WAN
    { id: "alibaba/wan-2.7/image-to-video", name: "WAN 2.7 I2V", provider: "Alibaba", price: 0.50, hot: true,
      params: { resolution: RES_VIDEO_WAN, duration: { options: [2,3,4,5,6,7,8,9,10], default: 5 }, negativePrompt: true, seed: true } },
    { id: "alibaba/wan-2.6/image-to-video", name: "WAN 2.6 I2V", provider: "Alibaba", price: 0.50,
      params: { resolution: RES_VIDEO_WAN, duration: { options: [5], default: 5 }, negativePrompt: false, seed: true } },

    // Google Veo
    { id: "google/veo3/image-to-video", name: "Veo 3 I2V", provider: "Google", price: 3.20, flagship: true,
      params: { resolution: RES_VIDEO_720_1080, aspectRatio: AR_VEO, duration: { options: [4,6,8], default: 8 }, negativePrompt: true, seed: true, optional: { generateAudio: { paramName: "generate_audio", type: "boolean", default: true } } } },
    { id: "google/veo3-fast/image-to-video", name: "Veo 3 Fast I2V", provider: "Google", price: 1.20, hot: true,
      params: { resolution: RES_VIDEO_720_1080, aspectRatio: AR_VEO, duration: { options: [4,6,8], default: 8 }, negativePrompt: true, seed: true, optional: { generateAudio: { paramName: "generate_audio", type: "boolean", default: true } } } },
    { id: "google/veo3.1/image-to-video", name: "Veo 3.1 I2V", provider: "Google", price: 3.20,
      params: { resolution: { paramName: "resolution", options: [{ label: "720p", value: "720p" }, { label: "1080p", value: "1080p" }, { label: "4K", value: "4k" }], default: "1080p" }, aspectRatio: AR_VEO, duration: { options: [4,6,8], default: 8 }, negativePrompt: true, seed: true, optional: { generateAudio: { paramName: "generate_audio", type: "boolean", default: true } } } },
    { id: "google/veo3.1-fast/image-to-video", name: "Veo 3.1 Fast I2V", provider: "Google", price: 1.20, hot: true,
      params: { resolution: { paramName: "resolution", options: [{ label: "720p", value: "720p" }, { label: "1080p", value: "1080p" }, { label: "4K", value: "4k" }], default: "1080p" }, aspectRatio: AR_VEO, duration: { options: [4,6,8], default: 8 }, negativePrompt: true, seed: true, optional: { generateAudio: { paramName: "generate_audio", type: "boolean", default: true } } } },
    { id: "google/veo3.1-lite/image-to-video", name: "Veo 3.1 Lite I2V", provider: "Google", price: 0.50,
      params: { resolution: RES_VIDEO_720_1080, aspectRatio: AR_VEO, duration: { options: [5,8], default: 5 }, negativePrompt: false, seed: true } },
    { id: "google/veo3.1/reference-to-video", name: "Veo 3.1 Reference", provider: "Google", price: 3.20,
      params: { resolution: { paramName: "resolution", options: [{ label: "720p", value: "720p" }, { label: "1080p", value: "1080p" }, { label: "4K", value: "4k" }], default: "1080p" }, aspectRatio: AR_VEO, duration: { options: [4,6,8], default: 8 }, negativePrompt: false, seed: true } },

    // Kling
    { id: "kwaivgi/kling-v3.0-pro/image-to-video", name: "Kling 3.0 I2V", provider: "Kwaivgi", price: 0.80, hot: true,
      params: { resolution: null, aspectRatio: AR_KLING, duration: { options: [5,10], default: 5 }, negativePrompt: true, seed: false } },

    // Runway
    { id: "runwayml/gen4-turbo", name: "Runway Gen4 Turbo", provider: "Runway", price: 0.50, hot: true,
      params: { resolution: null, aspectRatio: AR_STANDARD, duration: { options: [5,10], default: 5 }, negativePrompt: false, seed: false } },

    // Luma
    { id: "luma/ray-2-i2v", name: "Luma Ray 2", provider: "Luma", price: 0.40,
      params: { resolution: null, aspectRatio: AR_STANDARD, duration: { options: [5,9], default: 5 }, negativePrompt: false, seed: true } },

    // PixVerse
    { id: "pixverse/pixverse-v6/image-to-video", name: "PixVerse V6 I2V", provider: "PixVerse", price: 0.40,
      params: { resolution: RES_VIDEO_720_1080, aspectRatio: AR_STANDARD, duration: { options: [5,8], default: 5 }, negativePrompt: false, seed: true } },

    // Pika
    { id: "pika/v2.2-i2v", name: "Pika V2.2 I2V", provider: "Pika", price: 0.40,
      params: { resolution: RES_VIDEO_720_1080, duration: { options: [5,10], default: 5 }, negativePrompt: false, seed: true } },

    // Vidu
    { id: "vidu/q3/image-to-video", name: "Vidu Q3 I2V", provider: "Vidu", price: 0.30,
      params: { resolution: RES_VIDEO_720, duration: { options: [4,8], default: 4 }, negativePrompt: false, seed: true } },

    // ByteDance Seedance I2V
    { id: "bytedance/seedance-v1.5-pro/image-to-video", name: "Seedance 1.5 Pro I2V", provider: "ByteDance", price: 0.26, hot: true,
      params: { resolution: { paramName: "resolution", options: [{ label: "480p", value: "480p" }, { label: "720p", value: "720p" }, { label: "1080p", value: "1080p" }], default: "720p" }, aspectRatio: AR_SEEDANCE, duration: { options: [4,5,6,7,8,9,10,11,12], default: 5 }, negativePrompt: false, seed: true, optional: { generateAudio: { paramName: "generate_audio", type: "boolean", default: true }, cameraFixed: { paramName: "camera_fixed", type: "boolean", default: false } } } },
    { id: "bytedance/seedance-v1.5-pro/image-to-video-fast", name: "Seedance 1.5 Pro I2V Fast", provider: "ByteDance", price: 0.20,
      params: { resolution: RES_VIDEO_720_1080, aspectRatio: AR_SEEDANCE, duration: { options: [4,5,6,7,8,9,10,11,12], default: 5 }, negativePrompt: false, seed: true, optional: { generateAudio: { paramName: "generate_audio", type: "boolean", default: true }, cameraFixed: { paramName: "camera_fixed", type: "boolean", default: false } } } },

    // WaveSpeed — Cosmos Predict I2V
    { id: "wavespeed-ai/cosmos-predict-2.5/image-to-video", name: "Cosmos Predict 2.5 I2V", provider: "WaveSpeed", price: 0.25,
      params: { resolution: null, duration: { options: [5], default: 5 }, negativePrompt: false, seed: false } },

    // WaveSpeed — Kandinsky I2V
    { id: "wavespeed-ai/kandinsky5-pro/image-to-video", name: "Kandinsky 5 Pro I2V", provider: "WaveSpeed", price: 0.20,
      params: { resolution: RES_KANDINSKY, aspectRatio: AR_KANDINSKY, duration: { options: [5], default: 5 }, negativePrompt: false, seed: false } },
  ],

  avatar: [
    { id: "wavespeed-ai/infinitetalk", name: "InfiniteTalk", provider: "WaveSpeed", price: 0.15, requiresAudio: true,
      params: { resolution: { paramName: "resolution", options: [{ label: "480p", value: "480p" }, { label: "720p", value: "720p" }], default: "480p" }, negativePrompt: false, seed: true } },
    { id: "kwaivgi/kling-v2-ai-avatar-pro", name: "Kling Avatar Pro", provider: "Kwaivgi", price: 0.34, hot: true, requiresAudio: true,
      params: { resolution: null, negativePrompt: false, seed: false } },
    { id: "wavespeed-ai/wan-2.2/animate", name: "WAN 2.2 Animate", provider: "WaveSpeed", price: 0.20, requiresVideo: true,
      params: { resolution: null, negativePrompt: false, seed: true } },
    { id: "wavespeed-ai/image-face-swap-pro", name: "Face Swap Pro", provider: "WaveSpeed", price: 0.05,
      params: { resolution: null, negativePrompt: false, seed: false } },
  ],
};

export const TYPE_LABELS = { image: "Image", i2i: "Image Edit", t2v: "Text → Video", i2v: "Image → Video", avatar: "Avatar" };
export const TYPE_ICONS = { image: "🖼️", i2i: "✏️", t2v: "🎬", i2v: "📸→🎬", avatar: "🧑‍🎤" };
