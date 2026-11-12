// Higgsfield API request validation and URL builder (api/higgsfield-proxy.ts).
// Validates and forwards allowed Higgsfield / Genjutsu endpoints.

export const HIGGSFIELD_BASE = "https://api.higgsfield.ai";
export const MAX_HF_BODY = 1024 * 1024; // 1 MB limit

const REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;
const isPlainObject = v => v !== null && typeof v === "object" && !Array.isArray(v);
const bad = (status, error) => ({ ok: false, status, error });

function parseObject(bodyText) {
  try {
    const v = JSON.parse(bodyText);
    return isPlainObject(v) ? v : null;
  } catch { return null; }
}

export function higgsfieldUpstream(method, rawPath, searchParams, bodyText) {
  const path = String(rawPath ?? "").replace(/^\/+/, "");
  const text = typeof bodyText === "string" ? bodyText : "";

  // 1. GET style presets for Genjutsu restyle
  if (method === "GET" && path === "models/higgsfield/genjutsu/restyle/v1.0/presets") {
    return { ok: true, method: "GET", url: `${HIGGSFIELD_BASE}/${path}` };
  }

  // 2. GET usage analytics
  if (method === "GET" && path === "models/usage") {
    const qs = searchParams ? searchParams.toString() : "";
    return { ok: true, method: "GET", url: `${HIGGSFIELD_BASE}/${path}${qs ? `?${qs}` : ""}` };
  }

  // 3. POST upload URL generation
  if (method === "POST" && path === "files/generate-upload-url") {
    if (text.length > MAX_HF_BODY) return bad(413, "Request too large");
    const b = parseObject(text);
    if (!b || typeof b.file_name !== "string") return bad(400, "Bad request: file_name required");
    return { ok: true, method: "POST", url: `${HIGGSFIELD_BASE}/${path}`, body: JSON.stringify(b) };
  }

  // 4. POST Genjutsu Motion Transfer
  if (method === "POST" && path === "higgsfield/genjutsu/motion-transfer/v1.0") {
    if (text.length > MAX_HF_BODY) return bad(413, "Request too large");
    const b = parseObject(text);
    if (!b || typeof b.video_url !== "string" || !Array.isArray(b.image_urls) || b.image_urls.length < 1) {
      return bad(400, "Bad request: video_url and 1-8 image_urls required");
    }
    return { ok: true, method: "POST", url: `${HIGGSFIELD_BASE}/${path}`, body: JSON.stringify(b) };
  }

  // 5. POST Genjutsu Object Swap
  if (method === "POST" && path === "higgsfield/genjutsu/object-swap/v1.0") {
    if (text.length > MAX_HF_BODY) return bad(413, "Request too large");
    const b = parseObject(text);
    if (!b || typeof b.video_url !== "string" || !Array.isArray(b.image_urls) || b.image_urls.length < 1) {
      return bad(400, "Bad request: video_url and 1-8 image_urls required");
    }
    return { ok: true, method: "POST", url: `${HIGGSFIELD_BASE}/${path}`, body: JSON.stringify(b) };
  }

  // 6. POST Genjutsu Restyle
  if (method === "POST" && path === "higgsfield/genjutsu/restyle/v1.0") {
    if (text.length > MAX_HF_BODY) return bad(413, "Request too large");
    const b = parseObject(text);
    if (!b || typeof b.video_url !== "string" || typeof b.preset_id !== "string") {
      return bad(400, "Bad request: video_url and preset_id required");
    }
    return { ok: true, method: "POST", url: `${HIGGSFIELD_BASE}/${path}`, body: JSON.stringify(b) };
  }

  // 7. GET status of a request: requests/:id/status
  const statusMatch = path.match(/^requests\/([A-Za-z0-9._-]+)\/status$/);
  if (method === "GET" && statusMatch) {
    const id = statusMatch[1];
    if (!REQUEST_ID.test(id)) return bad(400, "Bad request: invalid request_id");
    return { ok: true, method: "GET", url: `${HIGGSFIELD_BASE}/${path}` };
  }

  // 8. DELETE a request: requests/:id
  const deleteMatch = path.match(/^requests\/([A-Za-z0-9._-]+)$/);
  if (method === "DELETE" && deleteMatch) {
    const id = deleteMatch[1];
    if (!REQUEST_ID.test(id)) return bad(400, "Bad request: invalid request_id");
    return { ok: true, method: "DELETE", url: `${HIGGSFIELD_BASE}/${path}` };
  }

  return bad(404, "Not allowed");
}
