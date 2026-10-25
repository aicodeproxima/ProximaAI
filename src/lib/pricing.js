// What one WaveSpeed request costs, from the payload buildPayload() produced for the user's real settings.
// WaveSpeed fills omitted fields with their schema defaults before applying the model's formula, so the
// generated table carries those defaults; the result is formula total x discount_rate, in dollars.
import { MODEL_PRICING, PRICING_FORMULAS } from "../config/modelPricing.js";
import { compileFormula } from "./priceFormula.js";
import { kieInput, kieCost } from "./kie.js";

// Exact price in dollars, or null when it cannot be computed (no published formula, an input whose
// duration has not been measured yet, or a formula the evaluator rejects).
export function priceRequest(model, payload, { mediaDuration } = {}) {
  // kie.ai (src/config/kieModels.js): its own price list in credits, read from the input kie.ai will get.
  if (model?.api === "kie") {
    try {
      const credits = model.kie.credits(kieInput(model, payload));
      return typeof credits === "number" && Number.isFinite(credits) && credits >= 0 ? kieCost(credits) : null;
    } catch {
      return null;
    }
  }
  const entry = model && Object.hasOwn(MODEL_PRICING, model.id) ? MODEL_PRICING[model.id] : null;
  if (!entry || entry.formula === undefined) return null;
  try {
    const vars = { ...entry.defaults, ...payload, base_price: entry.base };
    const total = compileFormula(PRICING_FORMULAS[entry.formula])(vars, { mediaDuration });
    if (typeof total !== "number" || !Number.isFinite(total) || total < 0) return null;
    return Math.round(total * entry.discount / 100) / 1e6;
  } catch {
    return null;
  }
}

// cost is always a number: the exact price when known, else the registry's default-settings price per image.
// exact is false only when a published formula could not be applied (e.g. an input still being measured).
// A native batch is already inside the formula (num_images), so imagesPerRequest only scales the fallback.
export function quoteRequest(model, payload, { imagesPerRequest = 1, mediaDuration } = {}) {
  const price = priceRequest(model, payload, { mediaDuration });
  const hasFormula = Boolean(model && Object.hasOwn(MODEL_PRICING, model.id));
  return { cost: price ?? (model?.price || 0) * imagesPerRequest, exact: price !== null || !hasFormula };
}

export function requestCost(model, payload, options) {
  return quoteRequest(model, payload, options).cost;
}
