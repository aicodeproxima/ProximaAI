// Pull WaveSpeed public schema + pricing for every registry model (and optional new targets)
// into one JSON file per model, flagging schema/payload mismatches and price drift.
// Usage: node scripts/wavespeed-model-data.mjs --out=<dir> [--targets=<targets.json>]
//   targets.json: [{ category, id, name, provider, replaces? }] — models not yet in the registry.
import fs from "node:fs";
import path from "node:path";
import { MODELS } from "../src/config/models.js";
import { buildPayload } from "../src/lib/payloadBuilder.js";

const arg = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const CONCURRENCY = 8;

function extractJsonObject(text, start) {
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

function flightTexts(html) {
  const texts = [];
  for (const match of html.matchAll(/<script[^>]*>self\.__next_f\.push\((\[.*?\])\)<\/script>/gs)) {
    try { const t = JSON.parse(match[1])?.[1]; if (typeof t === "string") texts.push(t); } catch { /* skip */ }
  }
  return texts;
}

function extractRequestSchema(texts) {
  for (const text of texts) {
    const at = text.indexOf('"api_schema":');
    if (at < 0) continue;
    const start = text.indexOf("{", at + 13);
    const raw = start >= 0 ? extractJsonObject(text, start) : null;
    try {
      const run = raw && JSON.parse(raw)?.api_schemas?.find(item => item?.request_schema?.properties);
      if (run) return run.request_schema;
    } catch { /* next block */ }
  }
  return null;
}

// base_price is in millionths of a dollar; discount_rate is the percent actually charged.
function extractPricing(texts, id) {
  const esc = id.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const re = new RegExp(`"${esc}","base_price":(\\d+(?:\\.\\d+)?),"discount_rate":(\\d+(?:\\.\\d+)?)(?:,"formula":("(?:[^"\\\\]|\\\\.)*"))?`);
  for (const text of texts) {
    const m = text.match(re);
    if (!m) continue;
    const base = Number(m[1]), discount = Number(m[2]);
    return {
      basePrice: base / 1e6,
      discountRate: discount,
      startsAt: Math.round(base * discount / 100) / 1e6,
      formula: m[3] ? JSON.parse(m[3]) : null,
    };
  }
  return null;
}

// When WaveSpeed published the page's own model: the detail record's created_at follows api_server_domain.
// (Related-model cards on the same page carry their own created_at, so the anchor matters.)
function extractCreatedAt(texts) {
  for (const text of texts) {
    const m = text.match(/"api_server_domain":"[^"]*","created_at":"(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
  }
  return null;
}

function nonDefaultValue(config) {
  if (config.type === "boolean") return !config.default;
  if (config.type === "number") {
    const candidate = Number(config.default ?? 0) + 1;
    return config.max === undefined ? candidate : Math.min(candidate, config.max);
  }
  const values = config.values || config.options?.map(option => option.value) || [];
  return values.find(value => value !== config.default) ?? config.default;
}

function representativeSettings(model) {
  const optional = {};
  for (const [key, config] of Object.entries(model.params?.optional || {})) optional[key] = nonDefaultValue(config);
  return {
    prompt: "Public schema audit", negPrompt: "audit negative prompt",
    resolution: model.params?.resolution?.default, aspectRatio: model.params?.aspectRatio?.default || "auto",
    duration: model.params?.duration?.default, seed: "1234",
    sourceImageUrl: "https://example.com/source.png", sourceImageUrls: ["https://example.com/reference.png"],
    sourceVideoUrl: "https://example.com/source.mp4", sourceAudioUrl: "https://example.com/source.mp3",
    endFrameUrl: "https://example.com/end.png", refVideoUrl: "https://example.com/reference.mp4",
    perModelResolution: {}, numImages: 2,
    briaPresets: model.params?.briaPreset ? { [model.id]: model.params.briaPreset.default } : {},
    ...optional,
  };
}

// Same checks as scripts/audit-wavespeed-models.mjs, exported for reuse by the apply step.
export function compare(model, category, schema) {
  const issues = [];
  const properties = schema.properties || {};
  const payload = buildPayload(model, representativeSettings(model), category);
  for (const key of Object.keys(payload)) if (!Object.hasOwn(properties, key)) issues.push(`emits unsupported field ${key}`);
  for (const key of schema.required || []) {
    const v = payload[key];
    if (v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) issues.push(`does not emit required field ${key}`);
  }
  for (const config of [model.params?.resolution, model.params?.aspectRatio, model.params?.briaPreset].filter(Boolean)) {
    const endpointEnum = properties[config.paramName]?.enum;
    if (!endpointEnum) continue;
    for (const option of config.options || []) {
      if (!endpointEnum.includes(option.value)) issues.push(`${config.paramName} option ${JSON.stringify(option.value)} is not public-schema valid`);
    }
  }
  if (model.params?.duration && properties.duration?.enum) {
    for (const d of model.params.duration.options || []) if (!properties.duration.enum.includes(d)) issues.push(`duration option ${d} is not public-schema valid`);
  }
  for (const config of Object.values(model.params?.optional || {})) {
    const apiDefault = properties[config.paramName]?.default;
    if (config.payload !== false && apiDefault !== undefined && apiDefault !== config.default) issues.push(`${config.paramName} default ${JSON.stringify(config.default)} differs from API default ${JSON.stringify(apiDefault)} (defaults are not sent, so the API value runs)`);
    const endpointEnum = properties[config.paramName]?.enum;
    if (!endpointEnum) continue;
    for (const v of config.values || config.options?.map(o => o.value) || []) {
      if (!endpointEnum.includes(v)) issues.push(`${config.paramName} option ${JSON.stringify(v)} is not public-schema valid`);
    }
  }
  return [...new Set(issues)];
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
if (isMain) {
  const OUT = arg("out");
  if (!OUT) throw new Error("--out=<dir> is required");
  const TARGETS = arg("targets") ? JSON.parse(fs.readFileSync(arg("targets"), "utf8")) : [];
  const items = [
    ...Object.entries(MODELS).flatMap(([category, list]) => list.map(model => ({ category, id: model.id, model }))),
    ...TARGETS.map(t => ({ ...t, model: null })),
  ];
  fs.mkdirSync(path.join(OUT, "data"), { recursive: true });
  let cursor = 0;
  const index = [];
  async function worker() {
    while (cursor < items.length) {
      const n = cursor++, item = items[n];
      let status = 0, schema = null, pricing = null, createdAt = null, error;
      try {
        const res = await fetch("https://wavespeed.ai/models/" + item.id, { headers: { "User-Agent": "ProximaAI-model-data/1.0" } });
        status = res.status;
        if (res.ok) {
          const texts = flightTexts(await res.text());
          schema = extractRequestSchema(texts); pricing = extractPricing(texts, item.id); createdAt = extractCreatedAt(texts);
        }
      } catch (e) { error = e.message; }
      const issues = item.model && schema ? compare(item.model, item.category, schema) : [];
      const registryPrice = item.model?.price ?? null;
      const priceMatch = registryPrice !== null && pricing ? Math.abs(registryPrice - pricing.startsAt) < 0.0005 : null;
      const rec = { n, id: item.id, category: item.category, isNew: !item.model, name: item.model?.name ?? item.name,
        provider: item.model?.provider ?? item.provider, replaces: item.replaces, status, error,
        registry: item.model, createdAt, pricing, priceMatch, auditIssues: issues, schema };
      fs.writeFileSync(path.join(OUT, "data", `${n}.json`), JSON.stringify(rec, null, 1));
      index.push({ n, id: item.id, category: item.category, isNew: rec.isNew, status, hasSchema: !!schema,
        hasPricing: !!pricing, createdAt, registryPrice, startsAt: pricing?.startsAt ?? null, priceMatch, issues: issues.length });
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  index.sort((a, b) => a.n - b.n);
  fs.writeFileSync(path.join(OUT, "index.json"), JSON.stringify(index, null, 1));
  // --release-dates=<file>: regenerate the module the picker uses to put newest models first within each family.
  if (arg("release-dates")) {
    const dated = index.filter(i => !i.isNew && i.createdAt).sort((a, b) => a.id.localeCompare(b.id));
    fs.writeFileSync(arg("release-dates"), [
      "// GENERATED by scripts/wavespeed-model-data.mjs --release-dates — do not edit by hand.",
      "// When WaveSpeed published each model (its public page's created_at). Drives newest-first order within a family.",
      "export const MODEL_RELEASED = {",
      ...dated.map(i => `  ${JSON.stringify(i.id)}: ${JSON.stringify(i.createdAt)},`),
      "};", "",
    ].join("\n"));
    console.log(`release dates: ${dated.length}/${index.filter(i => !i.isNew).length} written to ${arg("release-dates")}`);
  }
  const reg = index.filter(i => !i.isNew), fresh = index.filter(i => i.isNew);
  console.log(`registry ${reg.length}: schema ${reg.filter(i => i.hasSchema).length}, pricing ${reg.filter(i => i.hasPricing).length}, price match ${reg.filter(i => i.priceMatch).length}, price drift ${reg.filter(i => i.priceMatch === false).length}, audit issues ${reg.filter(i => i.issues).length}`);
  console.log(`new ${fresh.length}: schema ${fresh.filter(i => i.hasSchema).length}, pricing ${fresh.filter(i => i.hasPricing).length}, not found ${fresh.filter(i => i.status !== 200).map(i => i.id).join(" ") || "-"}`);
}
