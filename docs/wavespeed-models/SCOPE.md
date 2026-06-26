# SCOPE — frozen contract for the 2026-06-26 proxima build run

Source of truth for: upload fix + 21 NEW models + full-capability UI + integrity guards.
**Re-read this + `tail .proxima-buildlog.jsonl` before EVERY batch.** New ideas/extra models
go to `out-of-scope-findings.md`, NOT into this run.

## Baseline (Z0, git 74c5577)
Existing models in `src/config/models.js` = **88** (image 19, i2i 28, i23d 4, t2v 15, i2v 18,
avatar 4). (An earlier explore agent claimed 121 — inflated/hallucinated. 88 is ground truth.)
Expected after run: 88 + 21 = **109** (minus any target dropped for an unfixable slug).

## Part A — Upload fix
- [x] **A** — DONE + VERIFIED (commit 13c29cd): 7.88 MB image → downscale → POST **200** →
  WaveSpeed CDN url returned; live app "Uploaded to WaveSpeed". (Full image-edit gen *using* an
  uploaded image is covered when verifying i2i models in Part B.)

## Part B — 21 NEW models (all verified ABSENT at Z0)
PASS per model = slug + params + any new field names re-verified vs the model's LIVE
wavespeed.ai page, added to `models.js`, AND a real cheap test-gen reaches status=completed (logged
verbatim). Slug that can't be made to work → drop to out-of-scope, note in log.

Flagship (14):
- [ ] wavespeed-ai/qwen-image/text-to-image-2512      → MODELS.image
- [ ] wavespeed-ai/qwen-image/edit-2511               → MODELS.i2i  (imageParam "images")
- [ ] google/veo3.1-fast/reference-to-video           → MODELS.i2v  (reference images; needs C2)
- [ ] google/veo3.1-lite/start-end-to-video           → MODELS.i2v  (start+end frame; needs C2)
- [ ] bytedance/seedance-2.0/text-to-video            → MODELS.t2v
- [ ] bytedance/seedance-2.0/image-to-video           → MODELS.i2v
- [ ] kwaivgi/kling-v3.0-std/text-to-video            → MODELS.t2v
- [ ] kwaivgi/kling-v3.0-std/image-to-video           → MODELS.i2v
- [ ] alibaba/wan-2.7/text-to-image                   → MODELS.image
- [ ] alibaba/wan-2.7/reference-to-video              → MODELS.i2v  (reference video; needs C2)
- [ ] nvidia/cosmos-3-super/text-to-image             → MODELS.image  (add NVIDIA provider color)
- [ ] nvidia/cosmos-3-super/image-to-video            → MODELS.i2v
- [ ] google/gemini-3-pro-image/text-to-image         → MODELS.image  (same engine as nano-banana-pro)
- [ ] google/gemini-3-pro-image/edit                  → MODELS.i2i  (imageParam "images")

Spicy / uncensored i2v (7):
- [ ] bytedance/seedance-2.0/image-to-video-spicy        → MODELS.i2v
- [ ] bytedance/seedance-2.0-fast/image-to-video-spicy   → MODELS.i2v
- [ ] bytedance/seedance-2.0-mini/image-to-video-spicy   → MODELS.i2v  (MEDIUM-confidence slug — verify FIRST)
- [ ] bytedance/seedance-v1.5-pro/image-to-video-spicy   → MODELS.i2v
- [ ] wavespeed-ai/wan-2.2-spicy/image-to-video          → MODELS.i2v
- [ ] alibaba/wan-2.6/image-to-video-spicy               → MODELS.i2v
- [ ] alibaba/wan-2.7/image-to-video-spicy               → MODELS.i2v

## Part C — full per-model capability
- [x] **C1** — DONE + VERIFIED (8f4b4d4): panel renders per-model (Flux: num_inference_steps +
  guidance_scale; Bria Colorize: preset dropdown). Set num_inference_steps=35 → appeared in the
  captured flux-dev POST payload; defaults correctly omitted.
- [x] **C2** — DONE + VERIFIED (84e0c86): field names verified vs live pages; Node payloadBuilder
  tests PASS (veo-start-end→{image,last_image}, veo-ref→{images}, wan-ref→{videos}, kling→{end_image});
  veo start-end accepted 200 by WaveSpeed end-to-end.
- B status: 21 slugs ALL VALID (free probe, $0 — none "Model not found"). Image side (4 t2i + 2 i2i)
  + veo-start-end → 200 OK real submit; qwen-2512 polled to COMPLETED w/ output. 14 video/spicy:
  slug+param validated free; real-gen sweep (~$6) offered to user.
- [ ] **C3** — avatar audio + driving-video uploaders + Generate validation + payload wiring
  (requiresAudio: InfiniteTalk, Kling-Avatar; requiresVideo: WAN-Animate). Field names verified per page.
- [ ] **C4** — num_images respects min(maxImages,maxBatchImages); show each model's coerced
  resolution/duration on its result card.

## Decisions (frozen)
- Model scope: image + video only; flagship + spicy. New models un-featured (no `hot`).
- Browser = source of truth. Every slug verified vs live page + real gen. No "looks right".
