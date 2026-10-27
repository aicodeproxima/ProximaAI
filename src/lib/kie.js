// kie.ai on the client (docs/SECOND-ACCOUNT-PLAN.md S3). Pure, so node tests run it (scripts/test-kie-client.mjs).
// A kie.ai model is an entry of src/config/kieModels.js with api "kie". buildPayload() fills its fields under kie.ai's
// own names (the catalog declares them); kieInput() makes that kie.ai's createTask input. kie.ai's answers are turned
// into the shapes the app already handles for WaveSpeed: a submit becomes {data: {id, urls: {get}}}, a poll becomes
// {data: {status, outputs, error, timings}}, so the task, poll, resume and archive paths stay the same.

export const KIE_CREDIT_USD = 0.005;   // kie.ai's price list: 14 credits = $0.07 (derived; kie.ai does not publish it)
export const KIE_PROXY_ROOT = "/api/kie";
export const KIE_MODEL_PREFIX = "kie/";

export const KIE_NAME_SUFFIX = " · kie.ai";   // every kie.ai model's display name ends with it (the catalog test checks)
export const isKieModelId = (id) => typeof id === "string" && id.startsWith(KIE_MODEL_PREFIX);
// A kie.ai generation, from whatever the caller holds: a task (modelId, modelName) or a History item (model, the name).
// History items and some internal shapes carry no modelId, so the name is read too (S3 review #4/#8/#13).
export const isKieGeneration = (t) => isKieModelId(t?.modelId)
  || [t?.modelName, t?.model].some(n => typeof n === "string" && n.endsWith(KIE_NAME_SUFFIX));
export const isKiePollUrl = (url) => typeof url === "string" && url.startsWith(`${KIE_PROXY_ROOT}/`);
export const kiePollUrl = (taskId) => `${KIE_PROXY_ROOT}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`;

// The createTask input: buildPayload's fields, kept only when kie.ai documents them for this model (model.kie.fields),
// with the model's fixes applied: `ensure` fills a field kie.ai requires when the payload left it out (an option still
// at its default is not sent by buildPayload), `fixed` always wins, `strings` are sent as strings (kie.ai types Kling's
// duration as a string), and `maxItems` caps a list.
export function kieInput(model, payload) {
  const k = model.kie;
  const src = { ...(k.ensure || {}), ...payload, ...(k.fixed || {}) };
  if (typeof k.fix === "function") Object.assign(src, k.fix(src));   // per-model rules kie.ai states across fields
  const out = {};
  for (const f of k.fields) {
    let v = src[f];
    if (v === undefined || v === null || v === "") continue;
    if (k.strings?.includes(f)) v = String(v);
    if (Array.isArray(v)) {
      if (k.maxItems?.[f]) v = v.slice(0, k.maxItems[f]);
      if (!v.length) continue;
    }
    out[f] = v;
  }
  return out;
}

// What kie.ai would refuse anyway, checked before anything is sent (nothing is charged): a field longer than kie.ai
// accepts for this model (model.kie.maxLength). A message for the task, or null.
export function kieInputProblem(model, input) {
  for (const [f, max] of Object.entries(model?.kie?.maxLength || {})) {
    const v = input?.[f];
    if (typeof v === "string" && v.length > max) {
      return `This ${f === "prompt" ? "prompt" : f.replace(/_/g, " ")} is ${v.length.toLocaleString("en-US")} characters; ${model.name} accepts up to ${max.toLocaleString("en-US")}.`;
    }
  }
  return null;
}

// kie.ai's own refusals ({code} other than 200, answered with HTTP 200) become the same plain objects api.js throws for
// HTTP refusals ({code, message}), marked kie so nothing reads them as a WaveSpeed key problem, and answered: kie.ai
// replied, so the task was not created (S3 review #3: a 500/501/505 code is a refusal, not a lost submit).
const refusal = (code, message) => ({ code, message, kie: true, answered: true });

export function kieSubmitResult(json) {
  if (!json || typeof json !== "object") throw refusal(0, "Unexpected answer from kie.ai");
  if (json.code !== 200) throw refusal(typeof json.code === "number" ? json.code : 0, json.msg || "kie.ai refused the request");
  const id = json.data?.taskId;
  if (typeof id !== "string" || !id) throw refusal(0, "kie.ai returned no task id");
  return { data: { id, status: "created", urls: { get: kiePollUrl(id) } } };
}

const STATES = { waiting: "created", queuing: "created", generating: "processing" };
// The finished file(s): resultUrls on most models; Veo 3.1's page shows result_urls under data (2026-10-26), so every
// documented spelling is read.
function resultUrls(resultJson) {
  try {
    const r = typeof resultJson === "string" ? JSON.parse(resultJson) : resultJson;
    const list = [r?.resultUrls, r?.result_urls, r?.data?.resultUrls, r?.data?.result_urls].find(Array.isArray);
    return list ? list.filter(u => typeof u === "string" && u) : [];
  } catch { return []; }
}

// A malformed answer throws a plain Error, which the poll loop retries; kie.ai's refusals (e.g. 422: no such task for
// this key) are HTTP-like and end the poll as api.js's do.
export function kiePollResult(json) {
  if (!json || typeof json !== "object") throw new Error("Unexpected answer from kie.ai");
  if (json.code !== 200) throw refusal(typeof json.code === "number" ? json.code : 0, json.msg || "kie.ai refused the poll");
  const d = json.data || {};
  if (d.state === "success") {
    const outputs = resultUrls(d.resultJson);
    if (!outputs.length) return { data: { status: "failed", error: "kie.ai finished without a file" } };
    const credits = Number(d.creditsConsumed);
    return { data: { status: "completed", outputs, timings: { inference: (Number(d.costTime) || 0) * 1000 },
      kieCredits: Number.isFinite(credits) ? credits : null } };
  }
  if (d.state === "fail") return { data: { status: "failed", error: d.failMsg || `kie.ai could not make it (${d.failCode || "no code"})` } };
  return { data: { status: STATES[d.state] || "processing" } };
}

export const kieCost = (credits) => Math.round(credits * KIE_CREDIT_USD * 1e6) / 1e6;

// The top bar's kie.ai balance (owner 2026-10-26): credits and their dollar value at kie.ai's standard rate.
export function kieBalanceLabel(credits) {
  if (typeof credits !== "number" || !Number.isFinite(credits)) return "";
  const cr = credits.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return `kie ${cr} cr · $${(credits * KIE_CREDIT_USD).toFixed(2)}`;
}
