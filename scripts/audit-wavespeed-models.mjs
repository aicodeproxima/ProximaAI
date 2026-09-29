import { MODELS } from "../src/config/models.js";
import { buildPayload } from "../src/lib/payloadBuilder.js";

const PUBLIC_MODEL_ROOT = "https://wavespeed.ai/models/";
const CONCURRENCY = 8;
const SHOW_DETAILS = process.argv.includes("--details");
const SHOW_SCHEMA = process.argv.includes("--schema-json");
const MODEL_FILTER = process.argv.find(arg => arg.startsWith("--model="))?.slice("--model=".length);

function extractJsonObject(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
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

function extractRequestSchema(html) {
  const scripts = html.matchAll(/<script[^>]*>self\.__next_f\.push\((\[.*?\])\)<\/script>/gs);
  for (const match of scripts) {
    let flightData;
    try { flightData = JSON.parse(match[1]); } catch { continue; }
    const text = flightData?.[1];
    if (typeof text !== "string") continue;
    const marker = '"api_schema":';
    const markerIndex = text.indexOf(marker);
    if (markerIndex < 0) continue;
    const objectStart = text.indexOf("{", markerIndex + marker.length);
    const raw = objectStart >= 0 ? extractJsonObject(text, objectStart) : null;
    if (!raw) continue;
    try {
      const apiSchema = JSON.parse(raw);
      const run = apiSchema?.api_schemas?.find(item => item?.request_schema?.properties);
      if (run) return run.request_schema;
    } catch { /* try the next flight-data block */ }
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
  for (const [key, config] of Object.entries(model.params?.optional || {})) {
    optional[key] = nonDefaultValue(config);
  }
  return {
    prompt: "Public schema audit",
    negPrompt: "audit negative prompt",
    resolution: model.params?.resolution?.default,
    aspectRatio: model.params?.aspectRatio?.default || "auto",
    duration: model.params?.duration?.default,
    seed: "1234",
    sourceImageUrl: "https://example.com/source.png",
    sourceImageUrls: ["https://example.com/reference.png"],
    sourceVideoUrl: "https://example.com/source.mp4",
    sourceAudioUrl: "https://example.com/source.mp3",
    endFrameUrl: "https://example.com/end.png",
    refVideoUrl: "https://example.com/reference.mp4",
    perModelResolution: {},
    numImages: 2,
    briaPresets: model.params?.briaPreset
      ? { [model.id]: model.params.briaPreset.default }
      : {},
    ...optional,
  };
}

function compare(model, category, schema) {
  const issues = [];
  const properties = schema.properties || {};
  const required = schema.required || [];
  const payload = buildPayload(model, representativeSettings(model), category);

  for (const key of Object.keys(payload)) {
    if (!Object.hasOwn(properties, key)) issues.push(`emits unsupported field ${key}`);
  }
  for (const key of required) {
    if (payload[key] === undefined || payload[key] === "" || (Array.isArray(payload[key]) && payload[key].length === 0)) {
      issues.push(`does not emit required field ${key}`);
    }
  }

  const enumChecks = [model.params?.resolution, model.params?.aspectRatio, model.params?.briaPreset].filter(Boolean);
  for (const config of enumChecks) {
    const endpointEnum = properties[config.paramName]?.enum;
    if (!endpointEnum) continue;
    for (const option of config.options || []) {
      if (!endpointEnum.includes(option.value)) issues.push(`${config.paramName} option ${JSON.stringify(option.value)} is not public-schema valid`);
    }
  }
  if (model.params?.duration && properties.duration?.enum) {
    for (const duration of model.params.duration.options || []) {
      if (!properties.duration.enum.includes(duration)) issues.push(`duration option ${duration} is not public-schema valid`);
    }
  }
  for (const config of Object.values(model.params?.optional || {})) {
    const endpointEnum = properties[config.paramName]?.enum;
    const configured = config.values || config.options?.map(option => option.value) || [];
    if (!endpointEnum) continue;
    for (const value of configured) {
      if (!endpointEnum.includes(value)) issues.push(`${config.paramName} option ${JSON.stringify(value)} is not public-schema valid`);
    }
  }
  return [...new Set(issues)];
}

const allEntries = Object.entries(MODELS).flatMap(([category, models]) =>
  models.map(model => ({ category, model })),
);
const entries = MODEL_FILTER ? allEntries.filter(({ model }) => model.id === MODEL_FILTER) : allEntries;
const duplicateKeys = entries
  .map(({ category, model }) => `${category}:${model.id}`)
  .filter((key, index, all) => all.indexOf(key) !== index);
if (duplicateKeys.length) {
  console.error(`Duplicate registry entries: ${[...new Set(duplicateKeys)].join(", ")}`);
  process.exitCode = 1;
}

let cursor = 0;
const results = [];
async function worker() {
  while (cursor < entries.length) {
    const entry = entries[cursor++];
    const url = PUBLIC_MODEL_ROOT + entry.model.id;
    try {
      const response = await fetch(url, { headers: { "User-Agent": "ProximaAI-public-schema-audit/1.0" } });
      const html = await response.text();
      const schema = response.ok ? extractRequestSchema(html) : null;
      results.push({ ...entry, status: response.status, schema, issues: schema ? compare(entry.model, entry.category, schema) : [] });
    } catch (error) {
      results.push({ ...entry, status: 0, schema: null, issues: [], error: error.message });
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
results.sort((a, b) => a.category.localeCompare(b.category) || a.model.id.localeCompare(b.model.id));

const failures = results.filter(result => result.issues.length);
const unavailable = results.filter(result => !result.schema);
console.log(`Registry: ${entries.length} entries across ${Object.keys(MODELS).length} categories`);
console.log(`Public request schemas parsed: ${entries.length - unavailable.length}`);
console.log(`Unavailable public schemas/pages: ${unavailable.length}`);
for (const result of unavailable) console.log(`  UNAVAILABLE ${result.status} ${result.category} ${result.model.id}${result.error ? ` — ${result.error}` : ""}`);
console.log(`Schema/config mismatches: ${failures.reduce((sum, result) => sum + result.issues.length, 0)}`);
for (const result of failures) {
  for (const issue of result.issues) console.log(`  MISMATCH ${result.category} ${result.model.id} — ${issue}`);
  if (SHOW_DETAILS) {
    console.log(`    required: ${(result.schema.required || []).join(", ") || "(none)"}`);
    console.log(`    allowed: ${Object.keys(result.schema.properties || {}).join(", ")}`);
  }
}
if (SHOW_SCHEMA) {
  for (const result of results.filter(item => item.schema)) {
    console.log(`SCHEMA ${result.category} ${result.model.id}`);
    console.log(JSON.stringify(result.schema, null, 2));
  }
}
if (failures.length || duplicateKeys.length) process.exitCode = 1;
