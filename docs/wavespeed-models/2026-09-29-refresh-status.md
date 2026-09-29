# WaveSpeed model refresh — status and handoff

Date: 2026-09-29  
Workspace: `C:\Users\aicod\Projects\ProximaAI\deploy`  
Branch: `main`

## Objective

Refresh ProximaAI's WaveSpeed-backed image and video catalog with the newest public model families and every practical generation tier or modality: Standard, Lite, Pro, Fast/Turbo, Draft, Prime, 4K, image edit, image-to-video, reference-to-video, start/end-frame video, video edit, video extend, motion control, avatar, and upscale where the existing app can supply the required inputs.

## Privacy boundary

- Do not read, enumerate, search, poll, or otherwise probe the user's private WaveSpeed generation or prediction history.
- Research and validation use only public WaveSpeed catalog, collection, model, documentation, and embedded public request-schema pages.
- No private prediction/result endpoint has been inspected during this refresh.
- No paid generation is required for the remaining verification. Browser verification must not press Generate.

## Public sources used

- `https://wavespeed.ai/apis`
- Family pages for Seedream 5, Seedance 2.5, WAN 3.0, Qwen Image 3.0, GPT Image 2.5, FLUX 3, MiniMax H3, Kling O3, Vidu Q3, Veo 3.1, Nano Banana 2, Sora 2, and the public PixVerse/Luma collections.
- Individual public model pages at `https://wavespeed.ai/models/<model-id>`. Their embedded `api_schema.api_schemas[].request_schema` objects are the parameter source of truth.

No account history endpoint was used.

## Implemented locally

The refresh commit was created locally as `f706c5b` and is being rebased onto the newer remote `origin/main` foundation (`8ad5b0c`). The remote foundation already contains valuable prior work: image downscaling, dynamic Advanced parameters, start/end and reference inputs, avatar audio/video inputs, batch controls, bulk selection, proxy/security changes, and 21 earlier model additions. Those changes have been preserved in the resolved files.

After merging the September refresh with the newer remote catalog, the registry contains 214 unique models across seven workflows:

| Workflow | Models |
| --- | ---: |
| Text-to-image | 34 |
| Image edit | 43 |
| Image-to-3D | 4 |
| Text-to-video | 33 |
| Image-to-video | 72 |
| Video edit/extend/control | 23 |
| Avatar | 5 |

Current-family coverage recorded before rebasing:

| Family | Configured endpoints | Public family coverage |
| --- | ---: | --- |
| Seedream 5 | 10 | Complete public family |
| Seedance 2.5 | 8 | Complete public family |
| WAN 3.0 + Prime | 10 | Complete public family |
| Qwen Image 3.0 | 4 | Complete public family |
| GPT Image 2.5 Flare/Sunburst | 4 | Complete public family |
| FLUX 3 + Draft | 10 | Complete public family |
| MiniMax H3 official/open/Singularity/LoRA-ready | 20 | Complete public family |
| Kling O3 generation/edit | 15 | All image/video generation and edit endpoints; Kling Elements asset creation is not a generation workflow |
| Veo 3.1 Standard/Fast/Lite | 11 | Complete public family |
| Nano Banana 2 Standard/Fast/Lite | 6 | Complete public family |
| PixVerse V6 | 5 | Complete V6 generation/edit family |
| Luma Ray 3.2 | 4 | Complete Ray 3.2 family |
| Vidu Q3 | 11 | All direct generation/reference/tier/ad endpoints; `drama` and `drama-clip` require structured asset objects not supported by the current simple generator UI |

Other notable additions include Sora 2 public variants and a dedicated Video Edit tab for video-to-video, extension, reframing, motion-control, and upscaling endpoints.

## Payload/UI work

- Added a `v2v` workflow and source-video handling.
- Added audio input handling for talking-avatar models.
- Added multi-reference image routing for both image edit and image-to-video.
- Added support for first/last frame fields whose names vary by endpoint (`start_image`/`end_image`, `image`/`last_image`, and `image`/`end_image`).
- Added reference-array routing (`images`, `reference_images`) and preserved the remote branch's dedicated `referenceImages`, `referenceVideos`, and Advanced-parameter controls.
- Added strict batch behavior: `num_images` is only sent to schemas that explicitly support it.
- Corrected stale public pricing and parameter ranges for Nano Banana 2, PixVerse V6, Vidu Q3, Veo 3.1 Lite, and GPT Image 2.5 Edit.
- Corrected stale contracts across the pre-existing catalog too: WAN 2.6/2.7 resolution fields, Pika/Luma size values, Seedream 4.5 capabilities, Google/Phota aspect ratios, no-prompt utilities, avatar media gating, and current Bria mask/product inputs.
- Reclassified Waver 1.0 as image-to-video because its current public schema requires an image.
- Added a reusable public-only audit at `scripts/audit-wavespeed-models.mjs`.
- Bumped the service-worker cache to `proximaai-v3` because payload behavior changed.

## Validation status

- `npm run build`: PASS.
- Registry import/build: PASS.
- Total models: 214.
- Duplicate model IDs: 0.
- Full public-schema audit: all 214 configured endpoints checked through public model pages.
- Parsed public request schemas: 204.
- Public pages currently unavailable/404: 10 legacy entries retained for backward compatibility (`google/imagen4`, `openai/dall-e-3`, `bytedance/seededit-v3`, and seven legacy Spicy endpoints).
- Unsupported outgoing fields: 0.
- Missing required payload fields in the representative payload harness: 0.
- Invalid configured enum, duration, resolution, or aspect-ratio values: 0.
- Public image/edit batch audit: only six schemas expose `num_images`; the registry now explicitly marks those six.

The audit command is `node scripts/audit-wavespeed-models.mjs`; add `--details` for allowed/required field summaries or `--model=<model-id> --schema-json` for a single public schema. It only fetches public model pages and constructs local payloads. It does not submit generations or read prediction history.

## Current Git/rebase state

`git push origin main` was rejected because `origin/main` had advanced from `b51e38f` to `8ad5b0c`. A rebase onto `origin/main` was started to preserve the newer remote work.

Current state before completing the rebase:

- `src/config/models.js` contains the remote 21-model work, the September family refresh, public-schema corrections, and no duplicate IDs.
- `public/sw.js` is staged in the rebase with cache version `proximaai-v3`.
- All `src/App.jsx` and `src/lib/payloadBuilder.js` conflict markers are resolved.
- The richer C2/C3 input cards and reusable `CockpitTaskCard` renderer were retained.
- Duplicate audio state/handlers and duplicate payload assignments were removed.
- v2v source videos, avatar driving videos, end frames, reference videos, auxiliary mask/face/product images, and regeneration persistence now route independently.
- The current production build passes after the merge resolutions.

Do not abort or skip the rebase unless this document is re-evaluated first; the local commit and remote work both contain required pieces.

## Remaining steps

1. Stage the resolved files and finish `git rebase --continue`.
2. Run the production build, full 214-entry public-schema audit, registry duplicate test, conflict-marker scan, and `git diff --check` once more on the completed rebase.
3. Push `main` and wait for Vercel deployment.
4. Verify the deployed browser UI: all seven workflow tabs, representative Standard/Lite/Pro/Fast/Reference cards, source-video panel, start/end-frame panel, avatar audio panel, Advanced settings, and mobile-width tab layout. Do not submit a generation and do not open History.
5. Confirm the deployed bundle contains representative new model IDs and `proximaai-v3`.

## Non-generation endpoints intentionally not exposed

- Kling Advanced Elements: returns reusable element assets/IDs rather than an image/video generation result.
- Sora Characters: creates reusable character IDs rather than a normal media result.
- Vidu Q3 Drama and Drama Clip: require structured `assets` objects plus name/content fields; the current generator UI cannot form a valid request without a dedicated drama-builder interface.

These are product-surface gaps, not missing Lite/Pro/Fast/Reference variants.
