// Every model the app knows, by type: WaveSpeed's registry (models.js, which WaveSpeed's own scripts read and check)
// plus the kie.ai starter models (kieModels.js). Lookups by id use CATALOG, so a kie.ai task from another device or
// an older batch still finds its model; what the picker offers is visibleModels (docs/SECOND-ACCOUNT-PLAN.md K1).
import { MODELS } from "./models.js";
import { KIE_MODELS } from "./kieModels.js";
import { isKieGeneration } from "../lib/kie.js";

export const CATALOG = Object.fromEntries(Object.keys(MODELS).map(type => [type, [...MODELS[type], ...(KIE_MODELS[type] || [])]]));

// keys: the providers this account has a saved key for (a Set), or null while unknown (not read yet, or a server
// without provider keys). kie.ai models are offered only with a kie.ai key; WaveSpeed's unless the account is known
// to hold a kie.ai key and no WaveSpeed key (an account with no key at all still sees WaveSpeed's list, as before).
export function visibleModels(type, keys) {
  const ws = MODELS[type] || [], kie = KIE_MODELS[type] || [];
  if (!keys) return ws;
  const hasKie = keys.has("kie");
  return [...(keys.has("wavespeed") || !hasKie ? ws : []), ...(hasKie ? kie : [])];
}

// The edit model "Edit" on a result opens with (S3 review #5): one the picker offers (visible), from the same provider API
// as the result (kie.ai or WaveSpeed) and the same model maker; else the same maker on the other API; else none.
export function editModelFor(task, visible) {
  const api = isKieGeneration(task) ? "kie" : "wavespeed";
  return (visible || []).find(m => (m.api || "wavespeed") === api && m.provider === task?.provider)
    || (visible || []).find(m => m.provider === task?.provider) || null;
}
