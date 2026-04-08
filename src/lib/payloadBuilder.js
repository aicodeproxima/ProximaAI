// Builds a per-model API payload using the model's params config.
// Each model gets its OWN payload — no universal assumptions.

/**
 * Find the nearest valid option for a given value.
 *
 * For numbers: picks the numerically closest option.
 * For strings: tries an exact match first, then a case-insensitive match,
 *   then attempts to parse a leading number from both value and options
 *   (e.g. "1080p" → 1080) and picks the numerically closest.
 * Always falls back to defaultVal when no reasonable match exists.
 *
 * @param {*}        value      - The user-chosen value
 * @param {Array}    options    - Array of valid values for this model
 * @param {*}        defaultVal - The model's declared default
 * @returns {*} The best valid value to send
 */
export function nearestValid(value, options, defaultVal) {
  // Nothing to match against — return the default
  if (!options || options.length === 0) return defaultVal;

  // Exact match — fast path
  if (options.includes(value)) return value;

  // --- Numeric path ---
  const numVal = typeof value === "number" ? value : parseFloat(value);
  const allNumeric = options.every(o => typeof o === "number" || (typeof o === "string" && !isNaN(parseFloat(o)) && String(parseFloat(o)) === o.trim()));

  if (!isNaN(numVal) && allNumeric) {
    // All options are numeric (or numeric strings) — pick closest
    let best = options[0];
    let bestDist = Math.abs(parseFloat(best) - numVal);
    for (let i = 1; i < options.length; i++) {
      const dist = Math.abs(parseFloat(options[i]) - numVal);
      if (dist < bestDist) {
        best = options[i];
        bestDist = dist;
      }
    }
    return best;
  }

  // --- String path ---
  if (typeof value === "string") {
    const lower = value.toLowerCase().trim();

    // Case-insensitive exact match
    const ciMatch = options.find(o => typeof o === "string" && o.toLowerCase().trim() === lower);
    if (ciMatch) return ciMatch;

    // Try to extract leading numbers from resolution-style strings (e.g. "1080p", "720p", "1280x720")
    const extractNum = (s) => {
      const m = String(s).match(/^(\d+)/);
      return m ? parseInt(m[1], 10) : NaN;
    };

    const valNum = extractNum(value);
    if (!isNaN(valNum)) {
      let best = null;
      let bestDist = Infinity;
      for (const opt of options) {
        const optNum = extractNum(opt);
        if (!isNaN(optNum)) {
          const dist = Math.abs(optNum - valNum);
          if (dist < bestDist) {
            best = opt;
            bestDist = dist;
          }
        }
      }
      if (best !== null) return best;
    }
  }

  // No reasonable match — use default
  return defaultVal;
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
    const perModel = userSettings.perModelResolution?.[model.id];
    const val = perModel || userSettings.resolution || p.resolution.default;
    const validValues = p.resolution.options.map(o => o.value);
    payload[p.resolution.paramName] = nearestValid(val, validValues, p.resolution.default);
  }

  // Aspect ratio — only if model supports it
  if (p.aspectRatio) {
    const ar = userSettings.aspectRatio;
    if (ar && ar !== "auto") {
      const validAR = p.aspectRatio.options.map(o => o.value);
      // Aspect ratios are categorical — no numeric proximity makes sense,
      // so nearestValid will either exact-match or fall back to default.
      payload[p.aspectRatio.paramName] = nearestValid(ar, validAR, p.aspectRatio.default);
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
    payload.duration = nearestValid(dur, validDurs, p.duration.default);
  }

  // Negative prompt — only if model supports it AND user provided one
  if (p.negativePrompt && userSettings.negPrompt?.trim()) {
    payload.negative_prompt = userSettings.negPrompt.trim();
  }

  // Seed — only if model supports it AND user set a specific one
  if (p.seed && userSettings.seed && userSettings.seed !== "-1") {
    payload.seed = parseInt(userSettings.seed);
  }

  // Source image(s) for i2i — primary image (Ref 1) + additional refs merged into one array
  if (genType === "i2i") {
    const imageParam = p.imageParam || "images";
    // Always start with the primary source image (Ref 1)
    const allImages = [];
    if (userSettings.sourceImageUrl?.trim()) {
      allImages.push(userSettings.sourceImageUrl.trim());
    }
    // Append additional reference images (Ref 2, 3, etc.)
    if (userSettings.sourceImageUrls?.length > 0) {
      for (const url of userSettings.sourceImageUrls) {
        if (url?.trim() && !allImages.includes(url.trim())) {
          allImages.push(url.trim());
        }
      }
    }
    if (allImages.length > 0) {
      if (imageParam === "image") {
        payload.image = allImages[0]; // singular models only get first image
      } else {
        payload.images = allImages; // multi-image models get the full array
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

  // Batch num_images — for models that support generating multiple images per request
  if (userSettings.numImages && userSettings.numImages > 1 && (genType === "image" || genType === "i2i")) {
    const maxBatch = p.maxBatchImages || 4;
    payload.num_images = Math.min(parseInt(userSettings.numImages), maxBatch);
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
