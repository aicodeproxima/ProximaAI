import { MODELS } from "../config/models.js";

export const MODEL_FAVORITES_SETTING = "favoriteModelsByType";

export function emptyModelFavorites() {
  return Object.fromEntries(Object.keys(MODELS).map(type => [type, []]));
}

// Dedupe ids and keep current models in registry order. Unknown ids remain at the
// end so a temporarily removed model becomes a favorite again if it returns.
export function normalizeModelFavorites(value) {
  const source = value?.byType && typeof value.byType === "object" ? value.byType : value;
  const normalized = emptyModelFavorites();

  for (const [type, models] of Object.entries(MODELS)) {
    const raw = Array.isArray(source?.[type])
      ? [...new Set(source[type].filter(id => typeof id === "string" && id.length > 0))]
      : [];
    const requested = new Set(raw);
    const knownIds = new Set(models.map(model => model.id));
    normalized[type] = [
      ...models.filter(model => requested.has(model.id)).map(model => model.id),
      ...raw.filter(id => !knownIds.has(id)),
    ];
  }

  return normalized;
}

export function readModelFavoritesSetting(value) {
  return {
    byType: normalizeModelFavorites(value),
    updatedAt: Number.isFinite(Number(value?.updatedAt)) ? Number(value.updatedAt) : 0,
  };
}

export function createModelFavoritesSetting(byType, updatedAt = Date.now()) {
  return {
    version: 1,
    updatedAt,
    byType: normalizeModelFavorites(byType),
  };
}

export function toggleModelFavorite(byType, type, modelId) {
  const next = normalizeModelFavorites(byType);
  if (!MODELS[type]?.some(model => model.id === modelId)) return next;

  const favorites = new Set(next[type]);
  if (favorites.has(modelId)) favorites.delete(modelId);
  else favorites.add(modelId);

  const knownIds = new Set(MODELS[type].map(model => model.id));
  next[type] = [
    ...MODELS[type].filter(model => favorites.has(model.id)).map(model => model.id),
    ...next[type].filter(id => !knownIds.has(id) && favorites.has(id)),
  ];
  return next;
}

export function getCategoryFavoriteIds(byType, type) {
  const saved = new Set(normalizeModelFavorites(byType)[type] || []);
  return (MODELS[type] || []).filter(model => saved.has(model.id)).map(model => model.id);
}
