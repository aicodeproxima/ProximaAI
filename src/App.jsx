import { useState, useEffect, useRef, useCallback, useReducer } from "react";

// ─── MODEL REGISTRY ───
const MODELS = {
  image: [
    { id: "google/nano-banana-2/text-to-image", name: "Nano Banana 2", provider: "Google", price: 0.0105, hot: true, resolutions: ["1k","2k","4k"], maxRefs: 14, webSearch: true, imgSearch: true },
    { id: "google/nano-banana-2/text-to-image-fast", name: "Nano Banana 2 Fast", provider: "Google", price: 0.045, hot: false, resolutions: ["2k","4k"], maxRefs: 14, webSearch: true, imgSearch: true },
    { id: "google/nano-banana-pro/text-to-image", name: "Nano Banana Pro", provider: "Google", price: 0.14, hot: true, resolutions: ["1k","2k","4k"], maxRefs: 8, webSearch: true, imgSearch: true },
    { id: "google/nano-banana/text-to-image", name: "Nano Banana", provider: "Google", price: 0.01, resolutions: ["1k","2k"], maxRefs: 4 },
    { id: "bytedance/seedream-v5.0-lite", name: "Seedream 5.0 Lite", provider: "ByteDance", price: 0.04, hot: true, resolutions: ["1k","2k","4k"] },
    { id: "bytedance/seedream-v4.5", name: "Seedream 4.5", provider: "ByteDance", price: 0.04, resolutions: ["1k","2k","4k"] },
    { id: "openai/gpt-image-1.5/text-to-image", name: "GPT Image 1.5", provider: "OpenAI", price: 0.08, resolutions: ["1k","2k"] },
    { id: "wavespeed-ai/qwen-image-2.0-text-to-image", name: "Qwen Image 2.0", provider: "Alibaba", price: 0.03, resolutions: ["1k","2k"] },
    { id: "wavespeed-ai/qwen-image-text-to-image", name: "Qwen Image", provider: "Alibaba", price: 0.02, resolutions: ["1k"] },
    { id: "alibaba/wan-2.6/text-to-image", name: "WAN 2.6", provider: "Alibaba", price: 0.02, resolutions: ["1k","2k"] },
    { id: "wavespeed-ai/flux-2-klein-4b-text-to-image", name: "FLUX 2 Klein", provider: "BFL", price: 0.01, resolutions: ["1k","2k"] },
    { id: "wavespeed-ai/z-image-turbo", name: "Z-Image Turbo", provider: "WaveSpeed", price: 0.005, resolutions: ["1k"], syncMode: true },
  ],
  t2v: [
    { id: "alibaba/wan-2.7/text-to-video", name: "WAN 2.7", provider: "Alibaba", price: 0.50, hot: true, resolutions: ["720p","1080p"], durations: [2,3,4,5,6,7,8,9,10,15], hasNeg: true, hasExpansion: true, hasAudio: true },
    { id: "alibaba/wan-2.6/text-to-video", name: "WAN 2.6", provider: "Alibaba", price: 0.50, resolutions: ["720p","1080p"], durations: [5] },
    { id: "alibaba/wan-2.5/text-to-video", name: "WAN 2.5", provider: "Alibaba", price: 0.30, resolutions: ["720p"], durations: [5] },
    { id: "bytedance/seedance-2.0/text-to-video", name: "Seedance 2.0", provider: "ByteDance", price: 0.90, hot: true, resolutions: ["480p"], durations: [5,10,15], hasAudio: true, maxRefs: 4, flagship: true },
    { id: "bytedance/seedance-2.0-fast/text-to-video", name: "Seedance 2.0 Fast", provider: "ByteDance", price: 0.60, resolutions: ["480p"], durations: [5,10,15], hasAudio: true, maxRefs: 4 },
    { id: "bytedance/seedance-v1.5-pro/text-to-video", name: "Seedance 1.5 Pro", provider: "ByteDance", price: 0.40, resolutions: ["480p","720p","1080p"], durations: [4,5,6,8,10,12], hasAudio: true },
    { id: "kwaivgi/kling-v3.0-pro/text-to-video", name: "Kling 3.0", provider: "Kwaivgi", price: 0.80, hot: true, resolutions: ["720p","1080p"], durations: [5,10] },
    { id: "kwaivgi/kling-video-o3-pro/text-to-video", name: "Kling O3", provider: "Kwaivgi", price: 0.80, hot: true, resolutions: ["720p","1080p"], durations: [5,10] },
    { id: "kwaivgi/kling-v2.6-pro/text-to-video", name: "Kling 2.6", provider: "Kwaivgi", price: 0.60, resolutions: ["720p","1080p"], durations: [5,10] },
    { id: "openai/sora-2/text-to-video", name: "Sora 2", provider: "OpenAI", price: 0.50, resolutions: ["720p","1080p"], durations: [5,10,15,20] },
    { id: "google/veo3.1/text-to-video", name: "Veo 3.1", provider: "Google", price: 2.0, resolutions: ["720p","1080p"], durations: [5,8] },
    { id: "vidu/q3/text-to-video", name: "Vidu Q3", provider: "Vidu", price: 0.30, resolutions: ["720p"], durations: [4,8] },
    { id: "minimax/hailuo-2.3/t2v-pro", name: "Hailuo 2.3", provider: "Minimax", price: 0.50, resolutions: ["720p","1080p"], durations: [5] },
    { id: "x-ai/grok-imagine-video/text-to-video", name: "Grok Imagine", provider: "X AI", price: 0.40, resolutions: ["720p"], durations: [5,10] },
  ],
  i2v: [
    { id: "alibaba/wan-2.7/image-to-video", name: "WAN 2.7 I2V", provider: "Alibaba", price: 0.50, hot: true, hasEndFrame: true, hasAudio: true },
    { id: "alibaba/wan-2.6/image-to-video", name: "WAN 2.6 I2V", provider: "Alibaba", price: 0.50 },
    { id: "alibaba/wan-2.6/image-to-video-spicy", name: "WAN 2.6 Spicy I2V", provider: "Alibaba", price: 0.50 },
    { id: "bytedance/seedance-2.0/image-to-video", name: "Seedance 2.0 I2V", provider: "ByteDance", price: 1.20, hot: true, flagship: true, maxRefs: 4, hasAudio: true },
    { id: "bytedance/seedance-2.0-fast/image-to-video", name: "Seedance 2.0 Fast I2V", provider: "ByteDance", price: 0.80, maxRefs: 4 },
    { id: "bytedance/seedance-v1.5-pro/image-to-video", name: "Seedance 1.5 Pro I2V", provider: "ByteDance", price: 0.40 },
    { id: "kwaivgi/kling-v3.0-pro/image-to-video", name: "Kling 3.0 I2V", provider: "Kwaivgi", price: 0.80, hot: true },
    { id: "kwaivgi/kling-video-o3-pro/image-to-video", name: "Kling O3 I2V", provider: "Kwaivgi", price: 0.80, hot: true },
    { id: "openai/sora-2/image-to-video", name: "Sora 2 I2V", provider: "OpenAI", price: 0.50 },
    { id: "google/veo3.1/image-to-video", name: "Veo 3.1 I2V", provider: "Google", price: 2.0 },
    { id: "vidu/q3/image-to-video", name: "Vidu Q3 I2V", provider: "Vidu", price: 0.30 },
    { id: "minimax/hailuo-2.3/i2v-pro", name: "Hailuo 2.3 I2V", provider: "Minimax", price: 0.50 },
  ],
  avatar: [
    { id: "wavespeed-ai/wan-2.2-animate", name: "WAN 2.2 Animate", provider: "WaveSpeed", price: 0.20, requiresVideo: true },
    { id: "wavespeed-ai/infinitetalk", name: "InfiniteTalk", provider: "WaveSpeed", price: 0.15, requiresAudio: true },
    { id: "kwaivgi/kling-v3.0-pro/motion-control", name: "Kling 3.0 Motion", provider: "Kwaivgi", price: 0.34, hot: true },
    { id: "kwaivgi/kling-v2.6-pro/motion-control", name: "Kling 2.6 Motion", provider: "Kwaivgi", price: 0.34 },
    { id: "wavespeed-ai/steady-dancer", name: "SteadyDancer", provider: "WaveSpeed", price: 0.20 },
    { id: "wavespeed-ai/image-face-swap", name: "Face Swapper", provider: "WaveSpeed", price: 0.05 },
  ],
  i2i: [
    { id: "google/nano-banana-2/edit", name: "Nano Banana 2 Edit", provider: "Google", price: 0.0105, hot: true, resolutions: ["1k","2k","4k"], maxRefs: 14, webSearch: true, imgSearch: true },
    { id: "google/nano-banana-2/edit-fast", name: "Nano Banana 2 Edit Fast", provider: "Google", price: 0.045, resolutions: ["2k","4k"], maxRefs: 14, webSearch: true },
    { id: "google/nano-banana-pro/edit", name: "Nano Banana Pro Edit", provider: "Google", price: 0.14, hot: true, resolutions: ["1k","2k","4k"], maxRefs: 8 },
    { id: "google/nano-banana-pro/edit-ultra", name: "Nano Banana Pro Edit Ultra", provider: "Google", price: 0.28, resolutions: ["2k","4k"], maxRefs: 8 },
    { id: "google/nano-banana/edit", name: "Nano Banana Edit", provider: "Google", price: 0.01, resolutions: ["1k","2k"] },
    { id: "bytedance/seedream-v5.0-lite/edit", name: "Seedream 5.0 Lite Edit", provider: "ByteDance", price: 0.04, hot: true, resolutions: ["1k","2k","4k"] },
    { id: "bytedance/seedream-v4.5/edit", name: "Seedream 4.5 Edit", provider: "ByteDance", price: 0.04, resolutions: ["2k","4k"], maxRefs: 10 },
    { id: "bytedance/seededit-v3", name: "SeedEdit V3", provider: "ByteDance", price: 0.03, resolutions: ["1k","2k"] },
    { id: "alibaba/wan-2.7/image-edit", name: "WAN 2.7 Edit", provider: "Alibaba", price: 0.03, hot: true, maxRefs: 9 },
    { id: "alibaba/wan-2.7/image-edit-pro", name: "WAN 2.7 Edit Pro", provider: "Alibaba", price: 0.075, maxRefs: 9 },
    { id: "alibaba/wan-2.6/image-edit", name: "WAN 2.6 Edit", provider: "Alibaba", price: 0.02 },
    { id: "alibaba/wan-2.5/image-edit", name: "WAN 2.5 Edit", provider: "Alibaba", price: 0.02 },
    { id: "wavespeed-ai/qwen-image-2.0/edit", name: "Qwen Image 2.0 Edit", provider: "Alibaba", price: 0.03 },
    { id: "wavespeed-ai/qwen-image-2.0-pro/edit", name: "Qwen Image 2.0 Pro Edit", provider: "Alibaba", price: 0.05 },
    { id: "openai/gpt-image-1.5/edit", name: "GPT Image 1.5 Edit", provider: "OpenAI", price: 0.08, resolutions: ["1k","2k"] },
    { id: "wavespeed-ai/flux-2-max/edit", name: "FLUX 2 Max Edit", provider: "BFL", price: 0.05 },
    { id: "wavespeed-ai/flux-2-pro/edit", name: "FLUX 2 Pro Edit", provider: "BFL", price: 0.04 },
    { id: "wavespeed-ai/flux-2-dev/edit", name: "FLUX 2 Dev Edit", provider: "BFL", price: 0.02 },
    { id: "wavespeed-ai/flux-2-flash/edit", name: "FLUX 2 Flash Edit", provider: "BFL", price: 0.01, syncMode: true },
    { id: "wavespeed-ai/flux-kontext-pro", name: "FLUX Kontext Pro", provider: "BFL", price: 0.04, hot: true },
    { id: "wavespeed-ai/flux-kontext-max", name: "FLUX Kontext Max", provider: "BFL", price: 0.08 },
    { id: "kwaivgi/kling-image-o3/edit", name: "Kling Image O3 Edit", provider: "Kwaivgi", price: 0.04, hot: true },
    { id: "x-ai/grok-imagine-image/edit", name: "Grok Imagine Edit", provider: "X AI", price: 0.03 },
    { id: "wavespeed-ai/firered-image-v1.1-edit", name: "FireRed Edit", provider: "WaveSpeed", price: 0.02 },
    { id: "wavespeed-ai/step1x-edit", name: "Step1X Edit", provider: "WaveSpeed", price: 0.02 },
  ]
};

const TYPE_LABELS = { image: "Image", i2i: "Image Edit", t2v: "Text → Video", i2v: "Image → Video", avatar: "Avatar" };
const TYPE_ICONS = { image: "🖼️", i2i: "✏️", t2v: "🎬", i2v: "📸→🎬", avatar: "🧑‍🎤" };
const PROVIDER_COLORS = { Google: "#4285f4", ByteDance: "#fe2c55", OpenAI: "#10a37f", Alibaba: "#ff6a00", Kwaivgi: "#7c3aed", WaveSpeed: "#06b6d4", Vidu: "#ec4899", Minimax: "#f59e0b", "X AI": "#ffffff", BFL: "#a855f7" };

// In the Vite version, Vite's dev server proxies /wavespeed/* to api.wavespeed.ai
// server-side, so there are no CORS issues and no third-party proxy is needed.
// In production builds, you'd need either a real backend proxy, a desktop wrapper
// (Tauri/Electron), or to keep using Vite's preview server.
const API_BASE = "/wavespeed/api/v3";

async function proxiedFetch(url, options = {}) {
  const res = await fetch(url, options);
  return { res, proxyIndex: 0 };
}

// ─── STYLES ───
const font = `'JetBrains Mono', 'Fira Code', monospace`;
const fontBody = `'DM Sans', 'Segoe UI', sans-serif`;

const css = `
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&family=JetBrains+Mono:wght@300;400;500;700&display=swap');

* { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg-deep: #0a0e17; --bg-card: #111827; --bg-hover: #1e293b; --bg-input: #0f172a;
  --border: #1e293b; --border-focus: #3b82f6;
  --text-primary: #f1f5f9; --text-secondary: #94a3b8; --text-muted: #64748b;
  --accent: #3b82f6; --accent-glow: rgba(59,130,246,0.15);
  --success: #22c55e; --warning: #f59e0b; --error: #ef4444;
  --amber: #f59e0b; --amber-glow: rgba(245,158,11,0.12);
}

body { background: var(--bg-deep); color: var(--text-primary); font-family: ${fontBody}; }

.prism-app { display: flex; height: 100vh; overflow: hidden; background: var(--bg-deep); }

.sidebar { width: 56px; background: #080c14; border-right: 1px solid var(--border); display: flex; flex-direction: column; align-items: center; padding: 12px 0; gap: 4px; flex-shrink: 0; }
.sidebar-btn { width: 40px; height: 40px; border: none; background: transparent; color: var(--text-muted); border-radius: 10px; cursor: pointer; font-size: 18px; display: flex; align-items: center; justify-content: center; transition: all 0.2s; }
.sidebar-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
.sidebar-btn.active { background: var(--accent-glow); color: var(--accent); border: 1px solid rgba(59,130,246,0.3); }
.sidebar-logo { font-size: 22px; margin-bottom: 16px; cursor: default; }

.main { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-width: 0; }
.topbar { height: 48px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; padding: 0 20px; flex-shrink: 0; background: #080c14; }
.topbar-title { font-family: ${font}; font-size: 13px; font-weight: 600; letter-spacing: 0.5px; color: var(--text-secondary); }
.balance-pill { font-family: ${font}; font-size: 12px; color: var(--success); background: rgba(34,197,94,0.1); border: 1px solid rgba(34,197,94,0.2); padding: 4px 10px; border-radius: 20px; }

.content { flex: 1; overflow-y: auto; padding: 20px; }

/* Cockpit */
.cockpit { display: grid; grid-template-columns: 340px 1fr; gap: 20px; height: 100%; }
.cockpit-left { display: flex; flex-direction: column; gap: 16px; overflow-y: auto; padding-right: 8px; }
.cockpit-right { overflow-y: auto; }

.card { background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px; padding: 16px; }
.card-title { font-family: ${font}; font-size: 11px; font-weight: 600; color: var(--text-muted); letter-spacing: 1px; text-transform: uppercase; margin-bottom: 10px; }

.type-tabs { display: flex; gap: 4px; background: var(--bg-input); border-radius: 10px; padding: 3px; }
.type-tab { flex: 1; padding: 8px 6px; border: none; background: transparent; color: var(--text-muted); font-size: 12px; font-family: ${fontBody}; font-weight: 500; border-radius: 8px; cursor: pointer; transition: all 0.2s; white-space: nowrap; }
.type-tab:hover { color: var(--text-secondary); }
.type-tab.active { background: var(--accent); color: white; }

.prompt-area { width: 100%; min-height: 90px; background: var(--bg-input); border: 1px solid var(--border); border-radius: 10px; padding: 12px; color: var(--text-primary); font-family: ${fontBody}; font-size: 14px; resize: vertical; outline: none; transition: border-color 0.2s; }
.prompt-area:focus { border-color: var(--border-focus); }
.prompt-area::placeholder { color: var(--text-muted); }

.model-grid { display: flex; flex-direction: column; gap: 4px; max-height: 240px; overflow-y: auto; }
.model-item { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-radius: 8px; cursor: pointer; transition: all 0.15s; border: 1px solid transparent; }
.model-item:hover { background: var(--bg-hover); }
.model-item.selected { background: var(--accent-glow); border-color: rgba(59,130,246,0.3); }
.model-check { width: 16px; height: 16px; border-radius: 4px; border: 2px solid var(--text-muted); display: flex; align-items: center; justify-content: center; flex-shrink: 0; transition: all 0.15s; font-size: 10px; }
.model-item.selected .model-check { background: var(--accent); border-color: var(--accent); color: white; }
.model-name { font-size: 13px; font-weight: 500; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-provider { font-size: 10px; font-family: ${font}; padding: 2px 6px; border-radius: 4px; font-weight: 500; }
.hot-badge { font-size: 9px; background: var(--error); color: white; padding: 1px 5px; border-radius: 3px; font-weight: 700; font-family: ${font}; }
.model-price { font-size: 11px; font-family: ${font}; color: var(--text-muted); }

.settings-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.settings-row label { font-size: 11px; color: var(--text-muted); font-weight: 500; }
.settings-select, .settings-input { background: var(--bg-input); border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; color: var(--text-primary); font-size: 12px; font-family: ${font}; outline: none; min-width: 70px; }
.settings-select:focus, .settings-input:focus { border-color: var(--border-focus); }

.gen-btn { width: 100%; padding: 12px; border: none; border-radius: 10px; font-family: ${font}; font-size: 14px; font-weight: 700; cursor: pointer; transition: all 0.2s; letter-spacing: 0.5px; }
.gen-btn.ready { background: linear-gradient(135deg, #3b82f6, #2563eb); color: white; }
.gen-btn.ready:hover { background: linear-gradient(135deg, #2563eb, #1d4ed8); transform: translateY(-1px); box-shadow: 0 4px 20px rgba(59,130,246,0.3); }
.gen-btn.running { background: var(--bg-hover); color: var(--warning); cursor: not-allowed; }
.gen-btn:disabled { opacity: 0.4; cursor: not-allowed; transform: none; box-shadow: none; }

.cost-bar { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: var(--amber-glow); border: 1px solid rgba(245,158,11,0.2); border-radius: 8px; font-size: 12px; }
.cost-bar .cost-amount { font-family: ${font}; color: var(--amber); font-weight: 600; }

/* Progress + Results */
.task-card { background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px; padding: 14px; margin-bottom: 12px; }
.task-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.task-model { font-size: 13px; font-weight: 600; }
.task-status { font-size: 11px; font-family: ${font}; padding: 3px 8px; border-radius: 12px; font-weight: 600; }
.task-status.pending { background: rgba(148,163,184,0.1); color: var(--text-muted); }
.task-status.processing { background: rgba(59,130,246,0.1); color: var(--accent); }
.task-status.completed { background: rgba(34,197,94,0.1); color: var(--success); }
.task-status.failed { background: rgba(239,68,68,0.1); color: var(--error); }
.task-timer { font-family: ${font}; font-size: 12px; color: var(--text-muted); margin-top: 4px; }
.task-progress { height: 3px; background: var(--bg-input); border-radius: 2px; margin-top: 8px; overflow: hidden; }
.task-progress-fill { height: 100%; background: var(--accent); border-radius: 2px; transition: width 0.5s ease; }

.result-img { width: 100%; border-radius: 8px; margin-top: 10px; cursor: pointer; transition: transform 0.2s; max-height: 300px; object-fit: cover; }
.result-img:hover { transform: scale(1.01); }
.result-video { width: 100%; border-radius: 8px; margin-top: 10px; max-height: 300px; }
.result-actions { display: flex; gap: 6px; margin-top: 8px; }
.result-action-btn { padding: 5px 10px; font-size: 11px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-input); color: var(--text-secondary); cursor: pointer; font-family: ${font}; transition: all 0.15s; }
.result-action-btn:hover { background: var(--bg-hover); color: var(--text-primary); border-color: var(--accent); }

.results-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }

/* Logs */
.log-row { display: grid; grid-template-columns: 140px 1fr 120px 80px 80px 60px; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--border); font-size: 12px; align-items: center; cursor: pointer; transition: background 0.15s; }
.log-row:hover { background: var(--bg-hover); }
.log-header { font-weight: 700; color: var(--text-muted); font-family: ${font}; font-size: 10px; letter-spacing: 0.5px; text-transform: uppercase; cursor: default; }
.log-header:hover { background: transparent; }
.log-prompt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-secondary); }
.log-models { font-family: ${font}; color: var(--text-muted); font-size: 11px; }
.log-cost { font-family: ${font}; color: var(--amber); }
.log-replay { padding: 3px 8px; font-size: 10px; border-radius: 4px; border: 1px solid var(--border); background: transparent; color: var(--accent); cursor: pointer; font-family: ${font}; }
.log-replay:hover { background: var(--accent-glow); }

/* Settings */
.setting-group { margin-bottom: 24px; }
.setting-label { font-size: 12px; font-weight: 600; color: var(--text-secondary); margin-bottom: 6px; }
.setting-input { width: 100%; background: var(--bg-input); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; color: var(--text-primary); font-family: ${font}; font-size: 13px; outline: none; }
.setting-input:focus { border-color: var(--border-focus); }
.setting-hint { font-size: 11px; color: var(--text-muted); margin-top: 4px; }

.api-test-btn { padding: 8px 16px; background: var(--accent); color: white; border: none; border-radius: 6px; font-family: ${font}; font-size: 12px; cursor: pointer; margin-top: 8px; transition: opacity 0.2s; }
.api-test-btn:hover:not(:disabled) { background: #2563eb; }
.api-test-btn:disabled { opacity: 0.5; cursor: not-allowed; }

/* Empty State */
.empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 300px; color: var(--text-muted); text-align: center; gap: 12px; }
.empty-state .emoji { font-size: 48px; }
.empty-state .msg { font-size: 14px; max-width: 300px; line-height: 1.5; }

/* Lightbox */
.lightbox { position: fixed; inset: 0; background: rgba(0,0,0,0.92); z-index: 1000; display: flex; align-items: center; justify-content: center; cursor: pointer; }
.lightbox img, .lightbox video { max-width: 92vw; max-height: 92vh; border-radius: 8px; }

/* Scrollbar */
::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: var(--text-muted); }

/* Animations */
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
@keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
.fade-in { animation: fadeIn 0.3s ease; }
.pulse { animation: pulse 1.5s ease-in-out infinite; }

@media (max-width: 768px) {
  .prism-app { flex-direction: column; }
  .sidebar { width: 100%; flex-direction: row; padding: 0 8px; gap: 2px; border-right: none; border-bottom: 1px solid var(--border); overflow-x: auto; flex-shrink: 0; height: 52px; justify-content: center; }
  .sidebar-logo { margin-bottom: 0; margin-right: 8px; font-size: 18px; }
  .sidebar-btn { width: 44px; height: 44px; font-size: 20px; }

  .topbar { height: 44px; padding: 0 16px; }
  .topbar-title { font-size: 11px; }

  .content { padding: 16px; }

  .cockpit { grid-template-columns: 1fr; gap: 16px; height: auto; }
  .cockpit-left { padding-right: 0; gap: 14px; }

  .type-tabs { gap: 2px; padding: 4px; border-radius: 12px; }
  .type-tab { padding: 10px 8px; font-size: 13px; border-radius: 10px; }

  .card { padding: 18px; border-radius: 14px; }
  .card-title { font-size: 12px; margin-bottom: 12px; }

  .prompt-area { min-height: 100px; padding: 14px; font-size: 16px; border-radius: 12px; }

  .model-grid { max-height: 280px; gap: 6px; }
  .model-item { padding: 12px 14px; border-radius: 10px; gap: 12px; }
  .model-check { width: 22px; height: 22px; border-radius: 6px; font-size: 13px; }
  .model-name { font-size: 15px; }
  .model-provider { font-size: 11px; padding: 3px 8px; border-radius: 5px; }
  .hot-badge { font-size: 10px; padding: 2px 6px; border-radius: 4px; }
  .model-price { font-size: 13px; }

  .settings-row { gap: 10px; }
  .settings-row label { font-size: 13px; }
  .settings-select, .settings-input { padding: 10px 12px; font-size: 14px; border-radius: 8px; min-width: 80px; }

  .gen-btn { padding: 16px; font-size: 16px; border-radius: 14px; }

  .cost-bar { padding: 12px 16px; font-size: 14px; border-radius: 10px; }

  .task-card { padding: 16px; border-radius: 14px; margin-bottom: 14px; }
  .task-model { font-size: 15px; }
  .task-status { font-size: 12px; padding: 4px 10px; }
  .task-timer { font-size: 13px; }

  .result-img { border-radius: 10px; max-height: 400px; }
  .result-video { border-radius: 10px; max-height: 400px; }
  .result-actions { gap: 8px; margin-top: 12px; flex-wrap: wrap; }
  .result-action-btn { padding: 10px 14px; font-size: 13px; border-radius: 8px; }

  .results-grid { grid-template-columns: 1fr; gap: 14px; }

  .log-row { grid-template-columns: 1fr 60px 50px; gap: 6px; padding: 12px 14px; font-size: 13px; }
  .log-row > :nth-child(1) { display: none; }
  .log-row > :nth-child(5), .log-row > :nth-child(6) { display: none; }
  .log-header > :nth-child(1) { display: none; }

  .setting-group { margin-bottom: 28px; }
  .setting-label { font-size: 14px; margin-bottom: 8px; }
  .setting-input { padding: 14px 16px; font-size: 15px; border-radius: 10px; }
  .setting-hint { font-size: 13px; margin-top: 6px; }
  .api-test-btn { padding: 12px 20px; font-size: 14px; border-radius: 8px; }

  .empty-state { height: 200px; }
  .empty-state .emoji { font-size: 40px; }
  .empty-state .msg { font-size: 15px; }
}
`;

// ─── HELPERS ───
function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function formatTime(ms) {
  if (ms < 1000) return `${ms}ms`;
  const s = (ms / 1000).toFixed(1);
  return s >= 60 ? `${(s / 60).toFixed(1)}m` : `${s}s`;
}
function formatCost(c) { return `$${c.toFixed(4)}`; }
function timeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

// ─── API SERVICE ───
async function submitTask(apiKey, modelSlug, payload) {
  const { res } = await proxiedFetch(`${API_BASE}/${modelSlug}`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw { code: res.status, message: err.message || res.statusText };
  }
  return res.json();
}

async function pollResult(apiKey, pollUrl) {
  // The WaveSpeed API returns absolute URLs like https://api.wavespeed.ai/api/v3/predictions/...
  // We rewrite them to go through Vite's local proxy to avoid CORS.
  let target = pollUrl;
  if (pollUrl.startsWith("http")) {
    target = pollUrl.replace(/^https?:\/\/api\.wavespeed\.ai/, "/wavespeed");
  } else if (!pollUrl.startsWith("/wavespeed")) {
    target = `${API_BASE}${pollUrl}`;
  }
  const { res } = await proxiedFetch(target, {
    headers: { "Authorization": `Bearer ${apiKey}` }
  });
  if (!res.ok) throw { code: res.status, message: res.statusText };
  return res.json();
}

async function checkBalance(apiKey) {
  try {
    const { res, proxyIndex } = await proxiedFetch(`${API_BASE}/balance`, {
      headers: { "Authorization": `Bearer ${apiKey}` }
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return { error: `HTTP ${res.status}${txt ? ": " + txt.slice(0, 150) : ""}`, balance: null, proxyIndex };
    }
    const data = await res.json();
    const balance = data?.data?.balance ?? data?.data?.credits ?? data?.balance ?? null;
    if (balance === null) {
      return { error: `Got response but no balance field. Raw: ${JSON.stringify(data).slice(0, 150)}`, balance: null, proxyIndex };
    }
    return { error: null, balance, proxyIndex };
  } catch (e) {
    return { error: e.message || "All CORS proxies failed", balance: null };
  }
}

// ─── MAIN APP ───
export default function PrismApp() {
  const [page, setPage] = useState("cockpit");
  const [apiKey, setApiKey] = useState("");
  const [balance, setBalance] = useState(null);
  const [genType, setGenType] = useState("image");
  const [selectedModels, setSelectedModels] = useState([]);
  const [prompt, setPrompt] = useState("");
  const [negPrompt, setNegPrompt] = useState("");
  const [resolution, setResolution] = useState("1k");
  const [duration, setDuration] = useState(5);
  const [seed, setSeed] = useState("-1");
  const [aspectRatio, setAspectRatio] = useState("auto");
  const [sourceImageUrl, setSourceImageUrl] = useState("");
  const [sourcePreview, setSourcePreview] = useState("");
  const [uploadStatus, setUploadStatus] = useState(""); // "" | "uploading" | "done" | "error"
  const [testStatus, setTestStatus] = useState(null); // null | "testing" | {ok, msg}
  const fileInputRef = useRef(null);
  const [tasks, setTasks] = useState([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [logs, setLogs] = useState([]);
  const [lightbox, setLightbox] = useState(null);
  const [activeCount, setActiveCount] = useState(0);
  const pollRefs = useRef({});
  const timerRefs = useRef({});

  // Load state from localStorage
  useEffect(() => {
    try {
      const key = localStorage.getItem("prism-api-key");
      if (key) setApiKey(key);
    } catch {}
    try {
      const logData = localStorage.getItem("prism-logs");
      if (logData) setLogs(JSON.parse(logData));
    } catch {}
  }, []);

  // Save API key
  useEffect(() => {
    if (apiKey) {
      try { localStorage.setItem("prism-api-key", apiKey); } catch {}
      checkBalance(apiKey).then(r => { if (r.balance !== null) setBalance(r.balance); });
    }
  }, [apiKey]);

  // Save logs
  useEffect(() => {
    if (logs.length > 0) {
      try { localStorage.setItem("prism-logs", JSON.stringify(logs.slice(0, 200))); } catch {}
    }
  }, [logs]);

  // Track active count
  useEffect(() => {
    const active = tasks.filter(t => t.status === "pending" || t.status === "processing").length;
    setActiveCount(active);
  }, [tasks]);

  const models = MODELS[genType] || [];
  const estCost = selectedModels.reduce((sum, id) => {
    const m = models.find(x => x.id === id);
    return sum + (m?.price || 0);
  }, 0);

  function toggleModel(id) {
    setSelectedModels(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }

  // ─── FILE UPLOAD ───
  async function handleFileSelect(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    // Instant local preview via base64
    const reader = new FileReader();
    reader.onload = (ev) => setSourcePreview(ev.target.result);
    reader.readAsDataURL(file);

    // Upload to WaveSpeed
    if (!apiKey) {
      setUploadStatus("error");
      return;
    }
    setUploadStatus("uploading");
    try {
      const formData = new FormData();
      formData.append("file", file);
      // Use proxiedFetch for the file upload too
      const { res } = await proxiedFetch(`${API_BASE}/media/upload/binary`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${apiKey}` },
        body: formData
      });
      if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
      const data = await res.json();
      const url = data?.data?.download_url || data?.data?.url;
      if (url) {
        setSourceImageUrl(url);
        setUploadStatus("done");
      } else {
        throw new Error("No URL returned");
      }
    } catch (err) {
      console.error("Upload error:", err);
      setUploadStatus("error");
      // Fallback: use base64 data URL (some models may not accept it but preview works)
    }
    // Reset input so same file can be re-selected
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function clearSourceImage() {
    setSourceImageUrl("");
    setSourcePreview("");
    setUploadStatus("");
  }

  // ─── GENERATION ENGINE ───
  async function handleGenerate() {
    if (!apiKey || !prompt.trim() || selectedModels.length === 0) return;
    if ((genType === "i2i" || genType === "i2v") && !sourceImageUrl.trim()) {
      alert("Please provide a source image URL for " + (genType === "i2i" ? "image editing" : "image-to-video"));
      return;
    }
    setIsGenerating(true);
    setPage("cockpit");

    const batchId = genId();
    const newTasks = selectedModels.map(modelId => {
      const model = models.find(m => m.id === modelId);
      return {
        id: genId(), batchId, modelId, modelName: model?.name || modelId,
        provider: model?.provider || "Unknown", price: model?.price || 0,
        status: "pending", startTime: Date.now(), endTime: null,
        wallClockMs: 0, inferenceMs: 0, outputs: [], error: null,
        prompt, negPrompt, resolution, duration, seed, aspectRatio, sourceImageUrl
      };
    });

    setTasks(prev => [...newTasks, ...prev]);

    // Fire all in parallel
    for (const task of newTasks) {
      (async () => {
        try {
          const payload = { prompt: task.prompt };
          if (task.negPrompt) payload.negative_prompt = task.negPrompt;
          if (genType === "image") {
            payload.resolution = task.resolution;
            if (task.aspectRatio !== "auto") payload.aspect_ratio = task.aspectRatio;
            payload.output_format = "png";
          } else if (genType === "i2i") {
            // Image editing — send source image(s)
            payload.images = [task.sourceImageUrl];
            if (task.resolution) payload.resolution = task.resolution;
            if (task.aspectRatio !== "auto") payload.aspect_ratio = task.aspectRatio;
            payload.output_format = "png";
          } else if (genType === "i2v") {
            // Image to video — send source image
            payload.image = task.sourceImageUrl;
            payload.resolution = task.resolution;
            payload.duration = parseInt(task.duration);
            if (task.aspectRatio !== "auto") payload.aspect_ratio = task.aspectRatio;
          } else {
            payload.resolution = task.resolution;
            payload.duration = parseInt(task.duration);
            if (task.aspectRatio !== "auto") payload.aspect_ratio = task.aspectRatio;
          }
          if (task.seed !== "-1") payload.seed = parseInt(task.seed);

          const submitRes = await submitTask(apiKey, task.modelId, payload);
          const taskId = submitRes?.data?.id;
          const pollUrl = submitRes?.data?.urls?.get || `${API_BASE}/predictions/${taskId}/result`;

          // Check if sync mode returned outputs directly
          if (submitRes?.data?.outputs?.length > 0) {
            const wallClock = Date.now() - task.startTime;
            setTasks(prev => prev.map(t => t.id === task.id ? {
              ...t, status: "completed", outputs: submitRes.data.outputs,
              endTime: Date.now(), wallClockMs: wallClock,
              inferenceMs: submitRes.data?.timings?.inference || wallClock
            } : t));
            return;
          }

          setTasks(prev => prev.map(t => t.id === task.id ? { ...t, status: "processing", taskId } : t));

          // Polling loop
          const pollInterval = genType === "image" ? 3000 : 15000;
          const maxTimeout = genType === "image" ? 300000 : Infinity;
          const startPoll = Date.now();

          const poll = async () => {
            if (maxTimeout !== Infinity && Date.now() - startPoll > maxTimeout) {
              setTasks(prev => prev.map(t => t.id === task.id ? { ...t, status: "failed", error: "Timeout", endTime: Date.now() } : t));
              return;
            }
            try {
              const result = await pollResult(apiKey, pollUrl);
              const data = result?.data || result;
              if (data.status === "completed" && data.outputs?.length > 0) {
                const wallClock = Date.now() - task.startTime;
                setTasks(prev => prev.map(t => t.id === task.id ? {
                  ...t, status: "completed", outputs: data.outputs,
                  endTime: Date.now(), wallClockMs: wallClock,
                  inferenceMs: data?.timings?.inference || wallClock,
                  nsfw: data?.has_nsfw_contents
                } : t));
              } else if (data.status === "failed") {
                setTasks(prev => prev.map(t => t.id === task.id ? {
                  ...t, status: "failed", error: data.error || "Generation failed", endTime: Date.now()
                } : t));
              } else {
                pollRefs.current[task.id] = setTimeout(poll, pollInterval);
              }
            } catch (e) {
              if (e.code === 429) {
                // Rate limited — backoff
                pollRefs.current[task.id] = setTimeout(poll, pollInterval * 2 + Math.random() * 2000);
              } else {
                setTasks(prev => prev.map(t => t.id === task.id ? {
                  ...t, status: "failed", error: e.message || "Poll error", endTime: Date.now()
                } : t));
              }
            }
          };

          pollRefs.current[task.id] = setTimeout(poll, pollInterval);

        } catch (e) {
          let errMsg = e.message || "Submit failed";
          if (e.code === 401) errMsg = "Invalid API key";
          if (e.code === 402) errMsg = "Insufficient balance";
          if (e.code === 429) errMsg = "Rate limited — try fewer models";
          setTasks(prev => prev.map(t => t.id === task.id ? {
            ...t, status: "failed", error: errMsg, endTime: Date.now()
          } : t));
        }
      })();
    }

    // Update timers
    const timerId = setInterval(() => {
      setTasks(prev => {
        const anyActive = prev.some(t => t.status === "pending" || t.status === "processing");
        if (!anyActive) {
          clearInterval(timerId);
          setIsGenerating(false);
          // Log the batch
          const batch = prev.filter(t => t.batchId === batchId);
          if (batch.length > 0) {
            const logEntry = {
              id: batchId, timestamp: Date.now(), prompt, negPrompt, genType,
              models: batch.map(t => t.modelName), resolution, duration, seed,
              tasks: batch.map(t => ({ model: t.modelName, status: t.status, wallClockMs: t.wallClockMs, cost: t.price, outputs: t.outputs, error: t.error })),
              totalCost: batch.reduce((s, t) => s + (t.status === "completed" ? t.price : 0), 0)
            };
            setLogs(prev => [logEntry, ...prev]);
          }
          // Refresh balance
          checkBalance(apiKey).then(r => { if (r.balance !== null) setBalance(r.balance); });
        }
        return prev.map(t => {
          if ((t.status === "pending" || t.status === "processing") && t.batchId === batchId) {
            return { ...t, wallClockMs: Date.now() - t.startTime };
          }
          return t;
        });
      });
    }, 500);
  }

  function cancelTask(taskId) {
    if (pollRefs.current[taskId]) clearTimeout(pollRefs.current[taskId]);
    setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: "failed", error: "Cancelled", endTime: Date.now() } : t));
  }

  function replayLog(log) {
    setPrompt(log.prompt);
    setNegPrompt(log.negPrompt || "");
    setGenType(log.genType);
    setResolution(log.resolution);
    setDuration(log.duration);
    setSeed(log.seed);
    // Try to reselect models
    const modelIds = (MODELS[log.genType] || []).filter(m => log.models.includes(m.name)).map(m => m.id);
    setSelectedModels(modelIds);
    setPage("cockpit");
  }

  // ─── RENDER ───
  const completedTasks = tasks.filter(t => t.status === "completed");
  const activeTasks = tasks.filter(t => t.status === "pending" || t.status === "processing");
  const resOptions = (genType === "image" || genType === "i2i") ? ["1k","2k","4k"] : ["480p","720p","1080p"];
  const arOptions = (genType === "image" || genType === "i2i")
    ? ["auto","1:1","3:2","2:3","3:4","4:3","4:5","5:4","9:16","16:9","21:9"]
    : ["16:9","9:16","4:3","3:4"];
  const needsImage = genType === "i2i" || genType === "i2v";

  return (
    <>
      <style>{css}</style>
      <div className="prism-app">
        {/* Sidebar */}
        <div className="sidebar">
          <div className="sidebar-logo" title="PRISM">◈</div>
          <button className={`sidebar-btn ${page==="cockpit"?"active":""}`} onClick={() => setPage("cockpit")} title="Cockpit">⚡</button>
          <button className={`sidebar-btn ${page==="gallery"?"active":""}`} onClick={() => setPage("gallery")} title="Gallery">🖼</button>
          <button className={`sidebar-btn ${page==="logs"?"active":""}`} onClick={() => setPage("logs")} title="Logs">📋</button>
          <button className={`sidebar-btn ${page==="settings"?"active":""}`} onClick={() => setPage("settings")} title="Settings">⚙</button>
          {activeCount > 0 && (
            <div style={{ position: "absolute", top: 68, left: 36, background: "var(--accent)", color: "white", fontSize: 9, fontWeight: 700, width: 16, height: 16, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: font }} className="pulse">{activeCount}</div>
          )}
        </div>

        {/* Main */}
        <div className="main">
          <div className="topbar">
            <div className="topbar-title">PRISM — {page === "cockpit" ? "GENERATION COCKPIT" : page === "gallery" ? "SAVED OUTPUTS" : page === "logs" ? "GENERATION LOG" : "SETTINGS"}</div>
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              {balance !== null && <div className="balance-pill">${Number(balance).toFixed(2)}</div>}
              {!apiKey && <span style={{ fontSize: 11, color: "var(--error)" }}>⚠ No API Key</span>}
            </div>
          </div>

          <div className="content">
            {/* ═══ COCKPIT ═══ */}
            {page === "cockpit" && (
              <div className="cockpit">
                <div className="cockpit-left">
                  {/* Type Tabs */}
                  <div className="type-tabs">
                    {Object.entries(TYPE_LABELS).map(([key, label]) => (
                      <button key={key} className={`type-tab ${genType===key?"active":""}`}
                        onClick={() => { setGenType(key); setSelectedModels([]); setResolution(key==="image"||key==="i2i"?"1k":"720p"); if (key !== "i2i" && key !== "i2v") { clearSourceImage(); } }}>
                        {TYPE_ICONS[key]} {label}
                      </button>
                    ))}
                  </div>

                  {/* Prompt */}
                  <div className="card">
                    <div className="card-title">{genType === "i2i" ? "Edit Instructions" : "Prompt"}</div>
                    <textarea className="prompt-area" placeholder={
                      genType === "i2i" ? "Describe the edit you want... (e.g., 'Change the background to a sunset beach')" :
                      genType === "i2v" ? "Describe the motion... (e.g., 'Slow camera push-in, subtle movement')" :
                      "Describe what you want to generate..."}
                      value={prompt} onChange={e => setPrompt(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) handleGenerate(); }} />
                    {(genType === "image" || genType === "i2i" || genType === "t2v") && (
                      <input type="text" className="prompt-area" style={{ minHeight: "auto", marginTop: 8, fontSize: 12, padding: 8 }}
                        placeholder="Negative prompt (optional)..." value={negPrompt} onChange={e => setNegPrompt(e.target.value)} />
                    )}
                  </div>

                  {/* Source Image — for i2i and i2v */}
                  {needsImage && (
                    <div className="card">
                      <div className="card-title" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span>Source Image *</span>
                        {uploadStatus === "done" && <span style={{ color: "var(--success)", fontSize: 10, fontWeight: 400 }}>✓ Uploaded to WaveSpeed</span>}
                        {uploadStatus === "uploading" && <span className="pulse" style={{ color: "var(--accent)", fontSize: 10, fontWeight: 400 }}>⏳ Uploading...</span>}
                        {uploadStatus === "error" && <span style={{ color: "var(--error)", fontSize: 10, fontWeight: 400 }}>✗ Upload failed — try URL</span>}
                      </div>

                      {/* Hidden file input — triggers native picker */}
                      <input type="file" ref={fileInputRef} accept="image/*" style={{ display: "none" }}
                        onChange={handleFileSelect} />

                      {/* Upload + URL buttons */}
                      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                        <button onClick={() => fileInputRef.current?.click()}
                          style={{
                            flex: 1, padding: "12px 8px", background: "var(--bg-input)", border: "2px dashed var(--border)",
                            borderRadius: 10, color: "var(--text-secondary)", cursor: "pointer", fontSize: 13,
                            fontFamily: fontBody, fontWeight: 500, transition: "all 0.2s", display: "flex",
                            flexDirection: "column", alignItems: "center", gap: 4
                          }}
                          onMouseOver={e => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.background = "var(--accent-glow)"; }}
                          onMouseOut={e => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.background = "var(--bg-input)"; }}>
                          <span style={{ fontSize: 24 }}>📁</span>
                          <span>Upload from Device</span>
                          <span style={{ fontSize: 10, color: "var(--text-muted)" }}>Gallery · Photos · Files</span>
                        </button>
                      </div>

                      {/* OR divider */}
                      <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "4px 0 10px" }}>
                        <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
                        <span style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: font }}>OR PASTE URL</span>
                        <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
                      </div>

                      {/* URL input */}
                      <input type="text" className="prompt-area" style={{ minHeight: "auto", fontSize: 12, padding: 10 }}
                        placeholder="https://example.com/image.png"
                        value={sourceImageUrl}
                        onChange={e => { setSourceImageUrl(e.target.value); setSourcePreview(e.target.value); setUploadStatus(e.target.value ? "done" : ""); }} />

                      {/* Preview */}
                      {(sourcePreview || sourceImageUrl) && (
                        <div style={{ marginTop: 10, position: "relative" }}>
                          <img src={sourcePreview || sourceImageUrl} alt="Source"
                            style={{ width: "100%", maxHeight: 180, objectFit: "contain", borderRadius: 8, border: "1px solid var(--border)", background: "#000" }}
                            onError={e => { e.target.style.display = "none"; }} />
                          <button onClick={clearSourceImage}
                            style={{ position: "absolute", top: 6, right: 6, background: "rgba(0,0,0,0.8)", color: "white", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 6, width: 26, height: 26, cursor: "pointer", fontSize: 13, display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
                          {uploadStatus === "uploading" && (
                            <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.6)", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center" }}>
                              <div className="pulse" style={{ color: "white", fontFamily: font, fontSize: 13 }}>Uploading to WaveSpeed...</div>
                            </div>
                          )}
                        </div>
                      )}

                      <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 6, lineHeight: 1.4 }}>
                        {genType === "i2i" ? "Upload the image you want to edit. Your prompt describes what to change." :
                         "Upload the image to animate into video. Your prompt describes the motion."}
                        {uploadStatus === "done" && sourceImageUrl && (
                          <span style={{ display: "block", marginTop: 2, color: "var(--text-secondary)", fontFamily: font, fontSize: 9, wordBreak: "break-all" }}>
                            {sourceImageUrl.length > 60 ? sourceImageUrl.slice(0, 60) + "..." : sourceImageUrl}
                          </span>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Model Selector */}
                  <div className="card">
                    <div className="card-title">Models — {selectedModels.length} selected</div>
                    <div className="model-grid">
                      {models.map(m => (
                        <div key={m.id} className={`model-item ${selectedModels.includes(m.id)?"selected":""}`} onClick={() => toggleModel(m.id)}>
                          <div className="model-check">{selectedModels.includes(m.id) ? "✓" : ""}</div>
                          <span className="model-name">{m.name}</span>
                          {m.hot && <span className="hot-badge">HOT</span>}
                          {m.flagship && <span className="hot-badge" style={{ background: "var(--accent)" }}>★</span>}
                          <span className="model-provider" style={{ background: (PROVIDER_COLORS[m.provider]||"#666")+"22", color: PROVIDER_COLORS[m.provider]||"#aaa" }}>{m.provider}</span>
                          <span className="model-price">{formatCost(m.price)}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Settings */}
                  <div className="card">
                    <div className="card-title">Settings</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      <div className="settings-row">
                        <label>Resolution</label>
                        <select className="settings-select" value={resolution} onChange={e => setResolution(e.target.value)}>
                          {resOptions.map(r => <option key={r} value={r}>{r.toUpperCase()}</option>)}
                        </select>
                        <label>Aspect</label>
                        <select className="settings-select" value={aspectRatio} onChange={e => setAspectRatio(e.target.value)}>
                          {arOptions.map(a => <option key={a} value={a}>{a === "auto" ? "Auto" : a}</option>)}
                        </select>
                      </div>
                      <div className="settings-row">
                        {(genType === "t2v" || genType === "i2v") && (
                          <>
                            <label>Duration</label>
                            <select className="settings-select" value={duration} onChange={e => setDuration(e.target.value)}>
                              {[2,3,4,5,6,7,8,9,10,12,15,20].map(d => <option key={d} value={d}>{d}s</option>)}
                            </select>
                          </>
                        )}
                        <label>Seed</label>
                        <input type="text" className="settings-input" style={{ width: 72 }} value={seed} onChange={e => setSeed(e.target.value)} />
                        <button onClick={() => setSeed(Math.floor(Math.random() * 999999).toString())} style={{ background: "transparent", border: "1px solid var(--border)", borderRadius: 6, padding: "5px 8px", cursor: "pointer", fontSize: 14 }} title="Random seed">🎲</button>
                      </div>
                    </div>
                  </div>

                  {/* Cost + Generate */}
                  {selectedModels.length > 0 && (
                    <div className="cost-bar">
                      <span style={{ color: "var(--text-secondary)", fontSize: 11 }}>Est. cost ({selectedModels.length} model{selectedModels.length > 1 ? "s" : ""})</span>
                      <span className="cost-amount">{formatCost(estCost)}</span>
                    </div>
                  )}

                  <button className={`gen-btn ${isGenerating ? "running" : "ready"}`}
                    disabled={!apiKey || !prompt.trim() || selectedModels.length === 0 || isGenerating || (needsImage && !sourceImageUrl.trim())}
                    onClick={handleGenerate}>
                    {isGenerating ? `⏳ GENERATING (${activeCount} active)...` :
                     !apiKey ? "⚠ SET API KEY IN SETTINGS" :
                     needsImage && !sourceImageUrl.trim() ? "⚠ ADD SOURCE IMAGE ABOVE" :
                     `⚡ ${genType === "i2i" ? "EDIT" : "GENERATE"}${selectedModels.length > 0 ? ` ACROSS ${selectedModels.length} MODELS` : ""}`}
                  </button>
                  <div style={{ fontSize: 10, color: "var(--text-muted)", textAlign: "center" }}>Ctrl+Enter to generate</div>
                </div>

                {/* Results */}
                <div className="cockpit-right">
                  {tasks.length === 0 ? (
                    <div className="empty-state">
                      <div className="emoji">◈</div>
                      <div className="msg">Select models, write a prompt, and hit Generate to fire parallel requests across all selected models simultaneously.</div>
                    </div>
                  ) : (
                    <div className="results-grid">
                      {tasks.map(task => (
                        <div key={task.id} className="task-card fade-in">
                          <div className="task-header">
                            <div>
                              <span className="task-model">{task.modelName}</span>
                              <span style={{ fontSize: 10, color: PROVIDER_COLORS[task.provider] || "#aaa", marginLeft: 6 }}>{task.provider}</span>
                            </div>
                            <span className={`task-status ${task.status}`}>
                              {task.status === "pending" ? "PENDING" : task.status === "processing" ? "PROCESSING" : task.status === "completed" ? "DONE" : "FAILED"}
                            </span>
                          </div>

                          <div className="task-timer">
                            {task.status === "completed" ? `✓ ${formatTime(task.wallClockMs)}` :
                             task.status === "failed" ? `✗ ${task.error}` :
                             <span className="pulse">⏱ {formatTime(task.wallClockMs)}</span>}
                            {task.status === "completed" && <span style={{ marginLeft: 8, color: "var(--amber)" }}>{formatCost(task.price)}</span>}
                          </div>

                          {(task.status === "pending" || task.status === "processing") && (
                            <>
                              <div className="task-progress">
                                <div className="task-progress-fill" style={{
                                  width: `${Math.min(95, (task.wallClockMs / (genType === "image" ? 10000 : 180000)) * 100)}%`
                                }} />
                              </div>
                              <button className="result-action-btn" style={{ marginTop: 6, fontSize: 10 }} onClick={() => cancelTask(task.id)}>✕ Cancel</button>
                            </>
                          )}

                          {task.status === "completed" && task.outputs?.map((url, i) => {
                            const isVideo = url.includes(".mp4") || url.includes("video") || genType === "t2v" || genType === "i2v";
                            return isVideo ? (
                              <video key={i} className="result-video" src={url} controls autoPlay muted loop playsInline />
                            ) : (
                              <img key={i} className="result-img" src={url} alt={task.modelName}
                                onClick={() => setLightbox(url)} loading="lazy" />
                            );
                          })}

                          {task.status === "completed" && (
                            <div className="result-actions">
                              <button className="result-action-btn" onClick={async () => {
                                try {
                                  const url = task.outputs?.[0];
                                  if (!url) return;
                                  const resp = await fetch(url);
                                  const blob = await resp.blob();
                                  const ext = (genType === "t2v" || genType === "i2v" || genType === "avatar") ? "mp4" : "png";
                                  const fname = `${task.modelName.replace(/\s+/g, "_")}_${Date.now()}.${ext}`;
                                  const a = document.createElement("a");
                                  a.href = URL.createObjectURL(blob);
                                  a.download = fname;
                                  document.body.appendChild(a);
                                  a.click();
                                  a.remove();
                                  URL.revokeObjectURL(a.href);
                                } catch (e) { window.open(task.outputs?.[0], "_blank"); }
                              }}>↓ Save</button>
                              <button className="result-action-btn" onClick={() => { navigator.clipboard?.writeText(task.outputs?.[0] || ""); }}>📋 URL</button>
                              <button className="result-action-btn" onClick={() => { setSeed(Math.floor(Math.random()*999999).toString()); }}>🔄 New seed</button>
                              {(genType === "image" || genType === "i2i") && (
                                <button className="result-action-btn" style={{ color: "var(--accent)", borderColor: "rgba(59,130,246,0.3)" }}
                                  onClick={() => { setSourceImageUrl(task.outputs?.[0] || ""); setSourcePreview(task.outputs?.[0] || ""); setUploadStatus("done"); setGenType("i2i"); setSelectedModels([]); setPrompt(""); }}>
                                  ✏️ Edit
                                </button>
                              )}
                              {(genType === "image" || genType === "i2i") && (
                                <button className="result-action-btn" style={{ color: "var(--warning)", borderColor: "rgba(245,158,11,0.3)" }}
                                  onClick={() => { setSourceImageUrl(task.outputs?.[0] || ""); setSourcePreview(task.outputs?.[0] || ""); setUploadStatus("done"); setGenType("i2v"); setSelectedModels([]); setPrompt(""); }}>
                                  🎬 Animate
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ═══ GALLERY ═══ */}
            {page === "gallery" && (
              <div>
                <h2 style={{ fontFamily: font, fontSize: 16, marginBottom: 16, color: "var(--text-secondary)" }}>Completed Outputs ({completedTasks.length})</h2>
                {completedTasks.length === 0 ? (
                  <div className="empty-state"><div className="emoji">🖼️</div><div className="msg">Your generated outputs will appear here after generation.</div></div>
                ) : (
                  <div className="results-grid">
                    {completedTasks.map(task => (
                      <div key={task.id} className="task-card">
                        <div style={{ fontSize: 12, fontWeight: 600 }}>{task.modelName}</div>
                        <div style={{ fontSize: 11, color: "var(--text-muted)", margin: "4px 0" }}>{task.prompt?.slice(0, 60)}...</div>
                        {task.outputs?.map((url, i) => {
                          const isVideo = url.includes(".mp4") || url.includes("video");
                          return isVideo
                            ? <video key={i} className="result-video" src={url} controls muted playsInline />
                            : <img key={i} className="result-img" src={url} alt="" onClick={() => setLightbox(url)} />;
                        })}
                        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: 11, color: "var(--text-muted)", fontFamily: font }}>
                          <span>{formatTime(task.wallClockMs)}</span>
                          <span>{formatCost(task.price)}</span>
                          <span>{timeAgo(task.endTime)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ═══ LOGS ═══ */}
            {page === "logs" && (
              <div>
                <h2 style={{ fontFamily: font, fontSize: 16, marginBottom: 16, color: "var(--text-secondary)" }}>Generation Log ({logs.length} entries)</h2>
                {logs.length === 0 ? (
                  <div className="empty-state"><div className="emoji">📋</div><div className="msg">Your generation history will appear here. Each entry can be replayed with one click.</div></div>
                ) : (
                  <div style={{ border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
                    <div className="log-row log-header">
                      <span>Time</span><span>Prompt</span><span>Models</span><span>Type</span><span>Cost</span><span></span>
                    </div>
                    {logs.map(log => (
                      <div key={log.id} className="log-row" onClick={() => replayLog(log)}>
                        <span style={{ fontFamily: font, fontSize: 11, color: "var(--text-muted)" }}>{timeAgo(log.timestamp)}</span>
                        <span className="log-prompt">{log.prompt}</span>
                        <span className="log-models">{log.models.length} model{log.models.length > 1 ? "s" : ""}</span>
                        <span style={{ fontSize: 11 }}>{TYPE_ICONS[log.genType]}</span>
                        <span className="log-cost">{formatCost(log.totalCost)}</span>
                        <button className="log-replay" onClick={e => { e.stopPropagation(); replayLog(log); }}>▶</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ═══ SETTINGS ═══ */}
            {page === "settings" && (
              <div style={{ maxWidth: 500 }}>
                <h2 style={{ fontFamily: font, fontSize: 16, marginBottom: 24, color: "var(--text-secondary)" }}>Settings</h2>
                <div className="setting-group">
                  <div className="setting-label">WaveSpeed API Key</div>
                  <input type="password" className="setting-input" placeholder="Enter your WaveSpeed API key..."
                    value={apiKey} onChange={e => { setApiKey(e.target.value); setTestStatus(null); }} />
                  <div className="setting-hint">Get your key at <span style={{ color: "var(--accent)" }}>wavespeed.ai/settings</span>. Stored locally in your browser. Requests are forwarded to WaveSpeed through Vite's dev server proxy on your machine — no third-party services involved, your API key never leaves your computer.</div>
                  {apiKey && (
                    <button className="api-test-btn"
                      disabled={testStatus === "testing"}
                      onClick={async () => {
                        setTestStatus("testing");
                        const r = await checkBalance(apiKey);
                        if (r.balance !== null) {
                          setBalance(r.balance);
                          setTestStatus({ ok: true, msg: `Connected! Balance: $${Number(r.balance).toFixed(4)}` });
                        } else {
                          setTestStatus({ ok: false, msg: r.error ? r.error : "Could not verify key. Check if it's correct." });
                        }
                      }}>
                      {testStatus === "testing" ? "Testing..." : "Test Connection"}
                    </button>
                  )}
                  {testStatus && testStatus !== "testing" && (
                    <div style={{
                      marginTop: 10, padding: "10px 12px", borderRadius: 8, fontSize: 12,
                      fontFamily: font, fontWeight: 500,
                      background: testStatus.ok ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
                      border: `1px solid ${testStatus.ok ? "rgba(34,197,94,0.3)" : "rgba(239,68,68,0.3)"}`,
                      color: testStatus.ok ? "var(--success)" : "var(--error)"
                    }}>
                      {testStatus.ok ? "✓ " : "✗ "}{testStatus.msg}
                    </div>
                  )}
                  {testStatus === "testing" && (
                    <div className="pulse" style={{ marginTop: 10, fontSize: 12, color: "var(--accent)", fontFamily: font }}>
                      ⏳ Contacting WaveSpeed API...
                    </div>
                  )}
                  {balance !== null && testStatus !== "testing" && !testStatus && <div style={{ marginTop: 8, fontFamily: font, fontSize: 13, color: "var(--success)" }}>Balance: ${Number(balance).toFixed(4)}</div>}
                </div>

                <div className="setting-group">
                  <div className="setting-label">Default Settings</div>
                  <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
                    <div>
                      <label style={{ fontSize: 11, color: "var(--text-muted)" }}>Image Resolution</label>
                      <select className="settings-select" style={{ display: "block", marginTop: 4 }}>
                        <option>1K</option><option>2K</option><option>4K</option>
                      </select>
                    </div>
                    <div>
                      <label style={{ fontSize: 11, color: "var(--text-muted)" }}>Video Duration</label>
                      <select className="settings-select" style={{ display: "block", marginTop: 4 }}>
                        <option>5s</option><option>10s</option><option>15s</option>
                      </select>
                    </div>
                  </div>
                </div>

                <div className="setting-group">
                  <div className="setting-label">About</div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>
                    <strong style={{ color: "var(--text-primary)" }}>PRISM v1.0</strong> — Parallel Rendering & Inference Studio for Media<br />
                    {Object.values(MODELS).flat().length} models registered across {Object.keys(MODELS).length} categories<br />
                    Powered by WaveSpeed.ai unified API
                  </div>
                </div>

                {logs.length > 0 && (
                  <div className="setting-group">
                    <div className="setting-label">Data</div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button className="api-test-btn" style={{ background: "var(--error)" }} onClick={() => { if (confirm("Clear all generation logs?")) { setLogs([]); try { localStorage.removeItem("prism-logs"); } catch {} } }}>Clear Logs ({logs.length})</button>
                      <button className="api-test-btn" onClick={() => { setTasks([]); }}>Clear Active Tasks</button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Lightbox */}
        {lightbox && (
          <div className="lightbox" onClick={() => setLightbox(null)}>
            <img src={lightbox} alt="Full resolution" />
          </div>
        )}
      </div>
    </>
  );
}
