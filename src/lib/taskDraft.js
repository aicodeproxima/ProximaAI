// The cockpit's planned tasks and what they cost. The estimate, handleGenerate and the model picker all go
// through draftTask(), so a label, the estimate and a task's price are the price of the same payload.
// `form` is the cockpit's current settings: { genType, prompt, negPrompt, resolution, duration, seed, aspectRatio,
// sourceImageUrl, sourceImageUrls, perModelRes, optionalParams, briaPresets, endFrameUrl, refVideoUrl,
// sourceAudioUrl, sourceVideoUrl }.
import { buildPayload } from "./payloadBuilder.js";
import { quoteRequest } from "./pricing.js";

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
  const rp = model?.params?.resolution;
  const chosenR = rp ? (perModelRes[modelId] || resolution || rp.default) : null;
  const actualResOpt = rp ? (rp.options.find(o => o.value === chosenR) || rp.options.find(o => o.value === rp.default)) : null;
  const dp = model?.params?.duration;
  const actualDur = dp ? (dp.options.includes(Number(duration)) ? Number(duration) : dp.default) : null;
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
    actualRes: actualResOpt?.label || null, actualDur
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
