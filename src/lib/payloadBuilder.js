// Builds a per-model API payload using the model's params config.
// Each model gets its OWN payload — no universal assumptions.

// Find the closest value in an array of numbers to the target
function closestValue(arr, target) {
  return arr.reduce((prev, curr) =>
    Math.abs(curr - target) < Math.abs(prev - target) ? curr : prev
  );
}

export function buildPayload(model, userSettings, genType) {
  const payload = {};
  const p = model.params;
  if (!p) return { prompt: userSettings.prompt };

  // Prompt — required for most types, optional for avatar
  if (userSettings.prompt?.trim()) {
    payload.prompt = userSettings.prompt;
  } else if (genType !== "avatar") {
    payload.prompt = userSettings.prompt || "";
  }

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

  // Duration — always send for models that define it.
  // Use the closest valid duration for this model, not just the default,
  // so that when multiple models are selected the user's intent is preserved.
  if (p.duration) {
    const dur = parseInt(userSettings.duration) || p.duration.default;
    const validDurs = p.duration.options;
    payload.duration = validDurs.includes(dur) ? dur : closestValue(validDurs, dur);
  }

  // Negative prompt — only if model supports it AND user provided one
  if (p.negativePrompt && userSettings.negPrompt?.trim()) {
    payload.negative_prompt = userSettings.negPrompt.trim();
  }

  // Seed — only if model supports it AND user set a specific one
  if (p.seed && userSettings.seed && userSettings.seed !== "-1") {
    payload.seed = parseInt(userSettings.seed);
  }

  // Source image(s) for i2i — supports multi-image for models with maxImages > 1
  if (genType === "i2i") {
    const imageParam = p.imageParam || "images"; // default to "images" (array) for backward compat
    // Collect all image URLs — sourceImageUrls (array) takes priority, fall back to single sourceImageUrl
    const allImages = userSettings.sourceImageUrls?.length > 0
      ? userSettings.sourceImageUrls.filter(u => u?.trim())
      : userSettings.sourceImageUrl ? [userSettings.sourceImageUrl] : [];
    if (allImages.length > 0) {
      if (imageParam === "image") {
        payload.image = allImages[0]; // singular models only get first image
      } else {
        payload.images = allImages;
      }
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
