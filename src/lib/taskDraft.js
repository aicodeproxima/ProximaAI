// The cockpit's planned tasks and what they cost. The estimate, handleGenerate and the model picker all go
// through draftTask(), so a label, the estimate and a task's price are the price of the same payload.
// `form` is the cockpit's current settings: { genType, prompt, negPrompt, resolution, duration, seed, aspectRatio,
// sourceImageUrl, sourceImageUrls, perModelRes, optionalParams, briaPresets, endFrameUrl, refVideoUrl,
// sourceAudioUrl, sourceVideoUrl }.
import { buildPayload, chosenResolution, chosenDuration } from "./payloadBuilder.js";
import { quoteRequest } from "./pricing.js";

// The per-model resolutions the form stands for. With models of different resolution schemes (param names) the cockpit
// shows one dropdown per model. A model with `exact` options (kie.ai's; payloadBuilder.js chosenResolution) then gets its
// own pick or its default: another scheme's value means nothing to it (S3 review #2: Kling took a stale 720p as its 4K
// mode). Every other model keeps what it always got, the shared value matched to its options (S3 verification #7: filling
// WaveSpeed models with their bare default changed the owner's prices), and its dropdown shows that value
// (chosenResolution). With one scheme the shared dropdown decides, as before.
export function effectivePerModelRes(configs, perModelRes = {}) {
  const withRes = (configs || []).filter(m => m?.params?.resolution);
  if (new Set(withRes.map(m => m.params.resolution.paramName)).size <= 1) {
    // One scheme: the shared dropdown is the only one on screen, so a pick made earlier in a per-model dropdown (since
    // hidden: the model that split the schemes was deselected) no longer decides (S3 second verification B: Kling kept
    // sending its 4K pick while the shared dropdown showed 720p).
    const stale = withRes.filter(m => perModelRes[m.id] !== undefined);
    if (!stale.length) return perModelRes;
    const out = { ...perModelRes };
    for (const m of stale) delete out[m.id];
    return out;
  }
  const missing = withRes.filter(m => m.params.resolution.exact && !perModelRes[m.id]);
  if (!missing.length) return perModelRes;
  const out = { ...perModelRes };
  for (const m of missing) out[m.id] = m.params.resolution.default;
  return out;
}
// What a picker label prices model `m` with: the per-model values as they will be once `m` is selected too (adding it may
// split the schemes), so its label is the price of what selecting it sends (S3 verification #7).
export function labelPerModelRes(selectedConfigs, m, perModelRes = {}) {
  return effectivePerModelRes([...(selectedConfigs || []).filter(x => x.id !== m.id), m], perModelRes);
}
// The shared resolution dropdown's note: each model without `value` and the resolution it gets instead (S3 verification
// #4: "will use nearest valid" was not true for kie.ai's exact options).
export function resolutionNotes(modelsInScheme, value) {
  const out = [];
  for (const m of modelsInScheme || []) {
    const p = m?.params?.resolution;
    if (!p || p.options.some(o => String(o.value).toLowerCase() === String(value).toLowerCase())) continue;
    const v = chosenResolution(m, { resolution: value });
    out.push({ name: m.name, label: p.options.find(o => o.value === v)?.label ?? String(v) });
  }
  return out;
}
// The card's resolution and duration: the values buildPayload sends (same resolvers). Used by draftTask and Regenerate
// (S3 verification #5: Regenerate copied the original's labels while it rebuilt the payload).
export function runLabels(model, settings = {}) {
  const rp = model?.params?.resolution;
  const sentR = chosenResolution(model, settings);
  const opt = rp ? (rp.options.find(o => o.value === sentR) || rp.options.find(o => o.value === rp.default)) : null;
  return { actualRes: opt?.label || null, actualDur: chosenDuration(model, settings) };
}

// What buildPayload() receives for a task. Shared by submit, regenerate and every price.
export function taskUserSettings(task, type = task.genType) {
  return {
    prompt: task.prompt, negPrompt: task.negPrompt,
    resolution: task.resolution, duration: task.duration,
    seed: task.seed, aspectRatio: task.aspectRatio,
    sourceImageUrl: task.sourceImageUrl,
    sourceImageUrls: task.sourceImageUrls || [],
    sourceVideoUrl: type === "v2v" ? task.sourceImageUrl : (task.sourceVideoUrl || ""),
    sourceAudioUrl: task.sourceAudioUrl || "",
    perModelResolution: task.perModelResolution || {},
    numImages: task.numImages || 1,
    ...(task.optionalParams || {}),
    briaPresets: task.briaPresets || {},
    endFrameUrl: task.endFrameUrl, refVideoUrl: task.refVideoUrl,
  };
}

// One planned request (an item of planImageBatchRequests) as a task, priced from the payload it will send.
export function draftTask({ model, nativeBatch, requestIndex, requestCount, imagesPerRequest, totalImages }, form,
  { id = null, batchId = null, startTime = Date.now(), mediaDuration } = {}) {
  const { genType, resolution, duration, seed, perModelRes, sourceImageUrl, sourceImageUrls } = form;
  const modelId = model.id;
  // C4: coercion-aware resolution/duration this model will ACTUALLY receive (for the card)
  // The values buildPayload sends (same resolvers), so the card never shows one value while another is sent.
  const { actualRes, actualDur } = runLabels(model, { perModelResolution: perModelRes, resolution, duration });
  const parsedSeed = Number.parseInt(seed, 10);
  const taskSeed = !nativeBatch && requestCount > 1 && Number.isFinite(parsedSeed) && seed !== "-1"
    ? String(parsedSeed + requestIndex) : seed;
  const task = {
    id, batchId, modelId, modelName: model?.name || modelId,
    provider: model?.provider || "Unknown", price: 0,
    status: "pending", startTime, endTime: null,
    wallClockMs: 0, inferenceMs: 0, outputs: [], error: null,
    genType, prompt: form.prompt, negPrompt: form.negPrompt, resolution, duration, seed: taskSeed,
    aspectRatio: form.aspectRatio, sourceImageUrl,
    sourceImageUrls: sourceImageUrls.length > 0 ? sourceImageUrls : (sourceImageUrl ? [sourceImageUrl] : []),
    perModelResolution: perModelRes, numImages: imagesPerRequest, requestedImages: totalImages,
    batchImageIndex: requestCount > 1 ? requestIndex + 1 : null,
    optionalParams: form.optionalParams, briaPresets: form.briaPresets, endFrameUrl: form.endFrameUrl,
    refVideoUrl: form.refVideoUrl, sourceAudioUrl: form.sourceAudioUrl, sourceVideoUrl: form.sourceVideoUrl,
    actualRes, actualDur
  };
  const quote = quoteRequest(model, buildPayload(model, taskUserSettings(task), genType), { imagesPerRequest, mediaDuration });
  task.price = quote.cost;
  return { task, quote };
}

// The model picker's label: one generation of `model` at the current settings (a batch of one), so models
// compare per unit while the estimate shows the batch total.
export function unitQuote(model, form, { mediaDuration } = {}) {
  const single = { model, nativeBatch: false, requestIndex: 0, requestCount: 1, imagesPerRequest: 1, totalImages: 1 };
  return draftTask(single, form, { startTime: 0, mediaDuration }).quote;
}
