// The kie.ai proxy's request rules (api/kie-proxy.ts; docs/SECOND-ACCOUNT-PLAN.md S2). Pure, so node tests run it
// (scripts/test-kie-proxy.mjs). Exactly four kie.ai calls pass, each rebuilt from the fields it needs, never copied:
//   POST api/v1/jobs/createTask      {model, input}            (callBackUrl and anything else dropped: the browser never
//                                                               chooses where results go; a webhook is a later step, K3)
//   GET  api/v1/jobs/recordInfo      ?taskId=                  (the poll)
//   GET  api/v1/chat/credit                                    (the balance; also how Settings checks a saved key)
//   POST api/v1/common/download-url  {url}                     (a 20-minute download link for a result file)
// kie.ai answers HTTP 200 with its own `code` for most errors, so the proxy passes its JSON through unchanged.

export const KIE_BASE = "https://api.kie.ai";
export const MAX_KIE_BODY = 1024 * 1024;

const MODEL = /^[A-Za-z0-9._/-]{1,128}$/;
const TASK_ID = /^[A-Za-z0-9._-]{1,128}$/;   // kie.ai's own ids carry the model name, dots included (task_kling-3.0_<ms>)
const isPlainObject = v => v !== null && typeof v === "object" && !Array.isArray(v);
const bad = (status, error) => ({ ok: false, status, error });

function parseObject(bodyText) {
  try {
    const v = JSON.parse(bodyText);
    return isPlainObject(v) ? v : null;
  } catch { return null; }
}

// method, the path after /api/kie/ (a leading slash is fine), the request's query, its body as text.
// Answers {ok: true, method, url, body?} to forward, or {ok: false, status, error}.
export function kieUpstream(method, rawPath, searchParams, bodyText) {
  const path = String(rawPath ?? "").replace(/^\/+/, "");
  const text = typeof bodyText === "string" ? bodyText : "";
  if (method === "POST" && path === "api/v1/jobs/createTask") {
    if (text.length > MAX_KIE_BODY) return bad(413, "Request too large");
    const b = parseObject(text);
    if (!b || typeof b.model !== "string" || !MODEL.test(b.model) || !isPlainObject(b.input)) return bad(400, "Bad request");
    return { ok: true, method, url: `${KIE_BASE}/${path}`, body: JSON.stringify({ model: b.model, input: b.input }) };
  }
  if (method === "GET" && path === "api/v1/jobs/recordInfo") {
    const id = searchParams?.get?.("taskId") ?? "";
    if (!TASK_ID.test(id)) return bad(400, "Bad request");
    return { ok: true, method, url: `${KIE_BASE}/${path}?taskId=${id}` };
  }
  if (method === "GET" && path === "api/v1/chat/credit") {
    return { ok: true, method, url: `${KIE_BASE}/${path}` };
  }
  if (method === "POST" && path === "api/v1/common/download-url") {
    const b = parseObject(text);
    const url = b?.url;
    if (typeof url !== "string" || url.length > 2048 || !url.startsWith("https://")) return bad(400, "Bad request");
    try { new URL(url); } catch { return bad(400, "Bad request"); }
    return { ok: true, method, url: `${KIE_BASE}/${path}`, body: JSON.stringify({ url }) };
  }
  return bad(404, "Not allowed");
}
