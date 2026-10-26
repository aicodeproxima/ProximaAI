// Compares what the app shows and bills with WaveSpeed's LIVE pricing, for every registry model.
//   node scripts/wavespeed-model-data.mjs --out=<dir> --pricing=<dir>/modelPricing.live.js
//   node scripts/tools/check-live-prices.mjs --data=<dir> [--reference-seconds=5] [--max-combos=20000]
// Reports (exit 1 when any is non-empty; 2 on bad usage):
//   REGISTRY: the price shown in the model list (src/config/models.js `price`) differs from live at the app's default
//     settings; for input-length priced models (get_duration) at a reference input of --reference-seconds (default 5).
//   BILLING: the shipped table (src/config/modelPricing.js) and the live one price some request differently: every
//     combination of the model's options (lists, `values` enums, booleans, numeric min/default/max, batch size), with
//     image, video, audio and reference inputs attached and, for input-length models, inputs of 1-60 s. Compared exactly
//     in millionths of a dollar (both sides round the same way).
//   UNEVALUABLE: a formula neither table could evaluate for some request (never counted as a match).
//   LOST: a model with a formula in one table and not the other.
//   CONSTANT: an input-length model whose live price is the same for a 1 s and a 60 s input (a check that cannot fail).
//   FIXED: a model without a formula whose registry price differs from the page's price.
// Review 2026-10-26 (price tooling lens): the first version attached no media, passed a number where the evaluator
// takes a function, never varied `values` enums, numbers or batch size, moved one option at a time, compared with a
// $0.0005 tolerance and let "both null" pass. kie.ai models are not covered (their own price list).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { compileFormula } from "../../src/lib/priceFormula.js";
import { MODEL_PRICING, PRICING_FORMULAS } from "../../src/config/modelPricing.js";
import { MODELS } from "../../src/config/models.js";
import { buildPayload } from "../../src/lib/payloadBuilder.js";

const arg = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const dir = arg("data");
const REF_S = Number(arg("reference-seconds") || 5);
const MAX_COMBOS = Number(arg("max-combos") || 20000);
const liveFile = dir && path.join(dir, "modelPricing.live.js");
if (!dir || !fs.existsSync(liveFile) || !fs.existsSync(path.join(dir, "index.json"))) {
  console.error("usage: node scripts/tools/check-live-prices.mjs --data=<dir> [--reference-seconds=5] [--max-combos=20000]");
  console.error("  <dir> holds index.json and modelPricing.live.js from wavespeed-model-data.mjs --out=<dir> --pricing=<dir>/modelPricing.live.js");
  process.exit(2);
}
const LIVE = await import(pathToFileURL(path.resolve(liveFile)).href);
const INDEX = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8"));
const pagePrice = Object.fromEntries(INDEX.map(r => [r.id, r.startsAt]));

const MEDIA = { sourceImageUrl: "https://x.test/a.png", sourceVideoUrl: "https://x.test/v.mp4", sourceAudioUrl: "https://x.test/a.mp3",
  refVideoUrl: "https://x.test/r.mp4" };
const SETTINGS = { prompt: "Public schema audit", negPrompt: "", aspectRatio: "auto", seed: "-1", perModelResolution: {}, numImages: 1, briaPresets: {} };
const settingsFor = (m, extra = {}) => ({ ...SETTINGS, ...MEDIA, resolution: m.params?.resolution?.default,
  duration: m.params?.duration?.default, ...extra });

// Millionths of a dollar, as WaveSpeed bills: round(total x discount / 100). null when the formula cannot be applied.
const millionths = (entry, formulas, payload, seconds) => {
  if (!entry || entry.formula === undefined) return null;
  try {
    const total = compileFormula(formulas[entry.formula])({ ...entry.defaults, ...payload, base_price: entry.base },
      { mediaDuration: () => seconds });
    return typeof total === "number" && Number.isFinite(total) && total >= 0 ? Math.round(total * entry.discount / 100) : null;
  } catch { return null; }
};
const usd = (u) => (u === null ? "null" : `$${u / 1e6}`);

// Every priced option of a model: [payload field, values]. Numbers take their min, default and max.
const valuesOf = (spec) => {
  if (!spec || typeof spec !== "object") return [];
  if (Array.isArray(spec.options)) return spec.options.map(o => (o && typeof o === "object" ? o.value : o));
  if (Array.isArray(spec.values)) return spec.values.map(o => (o && typeof o === "object" ? o.value : o));
  if (spec.type === "boolean") return [true, false];
  if (spec.type === "number") return [...new Set([spec.min, spec.default, spec.max].filter(v => typeof v === "number"))];
  return [];
};
const fieldsOf = (m) => {
  const out = [];
  for (const [key, spec] of Object.entries(m.params || {})) {
    if (key === "optional") { for (const [k, s] of Object.entries(spec || {})) { const v = valuesOf(s); if (v.length > 1) out.push([s.paramName || k, v]); } continue; }
    const v = valuesOf(spec);
    if (v.length > 1) out.push([spec.paramName || key, v]);
  }
  return out;
};
function* product(fields, i = 0, acc = {}) {
  if (i === fields.length) { yield acc; return; }
  const [name, values] = fields[i];
  for (const v of values) yield* product(fields, i + 1, { ...acc, [name]: v });
}
const usesDuration = (entry, formulas) => !!entry && /get_duration/.test(formulas[entry.formula] || "");

const all = Object.entries(MODELS).flatMap(([category, list]) => list.map(m => ({ m, category })));
const registryOff = [], billingOff = [], unevaluable = [], lost = [], constant = [], fixedOff = [], truncated = [], lengthFree = [];
let formulaModels = 0, requests = 0, inputModels = 0;
for (const { m, category } of all) {
  const shipped = MODEL_PRICING[m.id], live = LIVE.MODEL_PRICING[m.id];
  const hasS = shipped?.formula !== undefined, hasL = live?.formula !== undefined;
  if (!hasS && !hasL) {
    const page = pagePrice[m.id];
    if (!Number.isFinite(page) || Math.round(page * 1e6) !== Math.round(m.price * 1e6)) fixedOff.push(`${m.id} [${category}] registry $${m.price} vs page $${page}`);
    continue;
  }
  if (hasS !== hasL) { lost.push(`${m.id} [${category}] formula ${hasS ? "shipped but not live" : "live but not shipped"}`); continue; }
  formulaModels++;
  const byLength = usesDuration(live, LIVE.PRICING_FORMULAS) || usesDuration(shipped, PRICING_FORMULAS);
  if (byLength) inputModels++;
  const seconds = byLength ? [1, 3, 5, 10, 30, 60] : [0];

  // registry: live at the defaults (input-length models: at the reference input)
  const base = buildPayload(m, settingsFor(m), category);
  const regLive = millionths(live, LIVE.PRICING_FORMULAS, base, byLength ? REF_S : 0);
  if (regLive === null || regLive !== Math.round(m.price * 1e6)) registryOff.push(`${m.id} [${category}] registry $${m.price} live ${usd(regLive)}${byLength ? ` (at a ${REF_S} s input)` : ""}`);
  if (byLength) {
    // Only when the app's request carries an input the formula measures (text-to-video and reference models measure
    // optional reference clips the app never sends: their price really does not depend on a length).
    const measured = [...(LIVE.PRICING_FORMULAS[live.formula] || "").matchAll(/get_duration\(\s*([A-Za-z_][\w]*)/g)].map(x => x[1]);
    const carried = measured.filter(k => base[k] !== undefined && base[k] !== "" && !(Array.isArray(base[k]) && !base[k].length));
    const a = millionths(live, LIVE.PRICING_FORMULAS, base, 1), b = millionths(live, LIVE.PRICING_FORMULAS, base, 60);
    if (carried.length && a !== null && a === b) constant.push(`${m.id} [${category}] live ${usd(a)} at 1 s and at 60 s although it sends ${carried.join(", ")}`);
    if (!carried.length) lengthFree.push(m.id);
  }

  // billing: every option combination, every batch size, every input length
  const fields = fieldsOf(m);
  const batch = m.params?.maxBatchImages > 1 ? Array.from({ length: m.params.maxBatchImages }, (_, i) => i + 1) : [1];
  let combos = 0, worst = null, nulls = 0;
  outer: for (const n of batch) {
    const p0 = buildPayload(m, settingsFor(m, { numImages: n }), category);
    for (const opts of product(fields)) {
      if (combos >= MAX_COMBOS) { truncated.push(`${m.id}: ${MAX_COMBOS} of more combinations`); break outer; }
      combos++;
      const p = { ...p0, ...opts };
      for (const s of seconds) {
        requests++;
        const x = millionths(shipped, PRICING_FORMULAS, p, s), y = millionths(live, LIVE.PRICING_FORMULAS, p, s);
        if (x === null && y === null) { nulls++; continue; }
        if (x !== y) {
          const d = x === null || y === null ? Infinity : Math.abs(x - y);
          if (!worst || d > worst.d) worst = { d, x, y, at: { ...opts, ...(n > 1 ? { num_images: n } : {}), ...(byLength ? { input_s: s } : {}) } };
        }
      }
    }
  }
  if (nulls) unevaluable.push(`${m.id} [${category}] ${nulls} request(s) neither table could price`);
  if (worst) billingOff.push(`${m.id} [${category}] shipped ${usd(worst.x)} live ${usd(worst.y)} at ${JSON.stringify(worst.at)} (${combos} combinations)`);
}

const section = (title, list) => { console.log(`\n${title}: ${list.length}`); for (const l of list) console.log(`  ${l}`); };
console.log(`models ${all.length}: ${formulaModels} with a formula in both tables (${inputModels} priced by input length), ` +
  `${fixedOff.length + all.length - formulaModels - lost.length - fixedOff.length} fixed-price checked, ${lost.length} lost; ${requests} requests priced`);
section("REGISTRY price differs from live", registryOff);
section("BILLING differs from live", billingOff);
section("UNEVALUABLE (never a match)", unevaluable);
section("LOST formula", lost);
section("CONSTANT over input length (cannot fail)", constant);
section("FIXED-price registry differs from the page", fixedOff);
if (truncated.length) section("TRUNCATED combinations (not every option checked)", truncated);
console.log(`\n(input-length formulas whose measured inputs the app never sends, so priced at a fixed amount: ${lengthFree.length})`);
process.exit(registryOff.length || billingOff.length || unevaluable.length || lost.length || constant.length || fixedOff.length ? 1 : 0);
