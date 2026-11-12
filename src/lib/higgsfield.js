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
