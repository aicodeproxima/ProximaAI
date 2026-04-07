// Builds a per-model API payload using the model's params config.
// Each model gets its OWN payload — no universal assumptions.

export function buildPayload(model, userSettings, genType) {
  const payload = {};
  const p = model.params;
  if (!p) return { prompt: userSettings.prompt };

  // Prompt is always required
  payload.prompt = userSettings.prompt;

  // Resolution/size — use model's own param name and value format
  if (p.resolution) {
    // Check if user has a per-model override for this model's resolution
    const perModel = userSettings.perModelResolution?.[model.id];
    const val = perModel || userSettings.resolution || p.resolution.default;
    // Only send if the value is valid for this model
    const validValues = p.resolution.options.map(o => o.value);
    payload[p.resolution.paramName] = validValues.includes(val) ? val : p.resolution.default;
  }

  // Aspect ratio — only if model supports it
  if (p.aspectRatio) {
    const ar = userSettings.aspectRatio;
    if (ar && ar !== "auto") {
      const validAR = p.aspectRatio.options.map(o => o.value);
      payload[p.aspectRatio.paramName] = validAR.includes(ar) ? ar : p.aspectRatio.default;
    } else {
      payload[p.aspectRatio.paramName] = p.aspectRatio.default;
    }
  }

  // Duration — always send for models that define it, falling back to model default
  if (p.duration) {
    const dur = parseInt(userSettings.duration) || p.duration.default;
    const validDurs = p.duration.options;
    payload.duration = validDurs.includes(dur) ? dur : p.duration.default;
  }

  // Negative prompt — only if model supports it AND user provided one
  if (p.negativePrompt && userSettings.negPrompt?.trim()) {
    payload.negative_prompt = userSettings.negPrompt.trim();
  }

  // Seed — only if model supports it AND user set a specific one
  if (p.seed && userSettings.seed && userSettings.seed !== "-1") {
    payload.seed = parseInt(userSettings.seed);
  }

  // Source image for i2i — some models use `images: [url]` (array), others use `image: url` (string)
  if (genType === "i2i" && userSettings.sourceImageUrl) {
    const imageParam = p.imageParam || "images"; // default to "images" (array) for backward compat
    if (imageParam === "image") {
      payload.image = userSettings.sourceImageUrl;
    } else {
      payload.images = [userSettings.sourceImageUrl];
    }
  }

  // Source image for i2v
  if (genType === "i2v" && userSettings.sourceImageUrl) {
    payload.image = userSettings.sourceImageUrl;
  }

  // Source image/audio for avatar
  if (genType === "avatar" && userSettings.sourceImageUrl) {
    payload.image = userSettings.sourceImageUrl;
  }

  // Output format — only for WaveSpeed-hosted models that support it
  if ((genType === "image" || genType === "i2i") && p.outputFormat !== false) {
    payload.output_format = "png";
  }

  // Model-specific optional params
  if (p.optional) {
    for (const [key, config] of Object.entries(p.optional)) {
      const userVal = userSettings[key];
      if (userVal !== undefined && userVal !== config.default) {
        payload[config.paramName] = config.type === "number" ? parseFloat(userVal) : userVal;
      }
    }
  }

  return payload;
}
