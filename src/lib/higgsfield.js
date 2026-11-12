// Higgsfield client integration for ProximaAI.
// Maps Higgsfield Genjutsu endpoints to standard ProximaAI submit and poll shapes.

import { hfModelById } from "../config/higgsfieldModels.js";

export const HIGGSFIELD_PROXY_ROOT = "/api/higgsfield";
export const HF_MODEL_PREFIX = "hf/";

export const isHiggsfieldModelId = (id) => typeof id === "string" && id.startsWith(HF_MODEL_PREFIX);
export const isHiggsfieldPollUrl = (url) => typeof url === "string" && url.startsWith(`${HIGGSFIELD_PROXY_ROOT}/`);
export const higgsfieldPollUrl = (requestId) => `${HIGGSFIELD_PROXY_ROOT}/requests/${encodeURIComponent(requestId)}/status`;

export function higgsfieldSubmitResult(data) {
  const reqId = data?.request_id || data?.id;
  if (!reqId) {
    throw { code: 500, message: data?.error || data?.message || "Invalid response from Higgsfield" };
  }
  return {
    data: {
      id: reqId,
      urls: {
        get: higgsfieldPollUrl(reqId)
      }
    }
  };
}

// What a Genjutsu run still needs, in the words the studio's Generate button shows (null = ready to run). The limits come
// from the model config (src/config/higgsfieldModels.js): every mode needs a source video of at least 4 s (a longer one
// than 30 s runs on its first 30 s); Motion Transfer and Object Swap need 1 to 8 reference images; Restyle needs a style
// preset and takes up to 5 optional images. duration: seconds as measured in the browser, null = unreadable here,
// undefined = not measured yet (Higgsfield checks it either way).
export function hfInputProblem(model, { video, images, preset, duration } = {}) {
  const hf = model?.hf;
  if (!hf) return null;
  if (!String(video || "").trim()) return "Add a source video";
  if (typeof duration === "number" && hf.minDuration && duration < hf.minDuration) {
    return `The source video is ${Math.round(duration * 10) / 10} s; Higgsfield needs at least ${hf.minDuration} s`;
  }
  const n = (images || []).filter(Boolean).length;
  if (n < (hf.minImages || 0)) return hf.minImages === 1 ? "Add at least 1 reference image" : `Add at least ${hf.minImages} reference images`;
  if (hf.maxImages != null && n > hf.maxImages) {
    return `This mode takes at most ${hf.maxImages} reference images: remove ${n - hf.maxImages}`;
  }
  if (hf.fields?.includes("preset_id") && !String(preset || "").trim()) return "Pick a style preset";
  return null;
}

// The storage bucket's limits (storage.buckets 'generations', measured 2026-11-12: 50 MB, these types). Images are shrunk
// before upload (imageUpload.js), so only their type is checked here. A picker that gives no type gets one from the file
// extension (an untyped upload is refused by the bucket). Returns { problem: null | text, type }.
export const HF_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
const HF_TYPES = {
  video: { mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska" },
  image: { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" },
};
const HF_TYPE_WORDS = { video: "an MP4, MOV, WebM or MKV video", image: "a JPEG, PNG, WebP or GIF image" };
export function uploadProblem(file, kind) {
  const allowed = HF_TYPES[kind];
  const ext = /\.([a-z0-9]{2,5})$/i.exec(file?.name || "")?.[1]?.toLowerCase();
  const type = file?.type || (ext && allowed[ext]) || "";
  const name = file?.name || "This file";
  if (!Object.values(allowed).includes(type)) {
    return { problem: `"${name}" can't be uploaded here: choose ${HF_TYPE_WORDS[kind]}.`, type };
  }
  if (kind === "video" && file.size > HF_UPLOAD_MAX_BYTES) {
    return { problem: `"${name}" is ${(file.size / 1048576).toFixed(1)} MB; uploads are limited to 50 MB. Trim it or export it at a lower resolution, then try again.`, type };
  }
  return { problem: null, type };
}

// The Restyle presets answer -> [{ id, name }] (the list arrives as items or presets; an entry without an id is dropped).
export function hfPresetList(data) {
  const list = Array.isArray(data?.items) ? data.items : Array.isArray(data?.presets) ? data.presets : [];
  return list.map(p => ({ id: p?.id ?? p?.preset_id ?? p?.slug, name: p?.name ?? p?.title }))
    .filter(p => p.id != null && String(p.id) !== "")
    .map(p => ({ id: String(p.id), name: p.name ? String(p.name) : String(p.id) }));
}

export function higgsfieldPollResult(data) {
  const st = data?.status;
  let status = "processing";
  if (st === "completed" || st === "succeeded") status = "completed";
  else if (st === "failed" || st === "error" || st === "canceled") status = "failed";

  const videoUrl = data?.video?.url || data?.video_url || data?.output_url || data?.output?.[0] || data?.url;
  const outputs = videoUrl ? [videoUrl] : [];

  return {
    data: {
      status,
      outputs,
      error: status === "failed" ? (data?.error || data?.message || "Higgsfield generation failed") : null
    }
  };
}
