// Every model the app knows, by type: WaveSpeed's registry (models.js),
// kie.ai starter models (kieModels.js), and Higgsfield Genjutsu models (higgsfieldModels.js).
import { MODELS } from "./models.js";
import { KIE_MODELS } from "./kieModels.js";
import { HF_MODELS } from "./higgsfieldModels.js";
import { isKieGeneration } from "../lib/kie.js";

export const CATALOG = Object.fromEntries(
  Object.keys(MODELS).map(type => [
    type,
    [...(MODELS[type] || []), ...(KIE_MODELS[type] || []), ...(HF_MODELS[type] || [])]
  ])
);

export function visibleModels(type, keys) {
  const ws = MODELS[type] || [];
  const kie = KIE_MODELS[type] || [];
  const hf = HF_MODELS[type] || [];

  if (!keys) return [...ws, ...hf];
  const hasKie = keys.has("kie");
  const hasHf = keys.has("higgsfield");

  return [
    ...(keys.has("wavespeed") || (!hasKie && !hasHf) ? ws : []),
    ...(hasKie ? kie : []),
    ...(hasHf ? hf : (type === "v2v" ? hf : []))
  ];
}

export function editModelFor(task, visible) {
  const api = task?.api || (isKieGeneration(task) ? "kie" : "wavespeed");
  return (visible || []).find(m => (m.api || "wavespeed") === api && m.provider === task?.provider)
    || (visible || []).find(m => m.provider === task?.provider) || null;
}
