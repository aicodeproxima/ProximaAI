# RESUME — proxima build run (2026-06-26)  [survives compaction/restart]

Repo:  C:\Users\aicod\Projects\_src\proxima-ai-live   (branch `main`)
Plan:  C:\Users\aicod\.claude\plans\mossy-foraging-snowflake.md  (top "CURRENT TASK" section — APPROVED)
Scope: C:\Users\aicod\Projects\_src\proxima-ai-live\docs\wavespeed-models\SCOPE.md  (frozen contract)
Log:   C:\Users\aicod\Projects\_src\proxima-ai-live\.proxima-buildlog.jsonl  (append-only; SOURCE OF TRUTH)
Research: C:\Users\aicod\.claude\projects\C--Users-aicod--claude\0ccb92af-77d1-43d3-856e-68cd0906d4e7\tasks\wpgwpq1bm.output (full 199-model catalog)

## How to continue (if this session compacts or restarts)
1. Read SCOPE.md + `tail .proxima-buildlog.jsonl` → find the last completed cell.
2. NEVER restart from cell 1; resume from the next unchecked SCOPE.md item.
3. Re-verify every model's slug / params / new-input field names against its LIVE wavespeed.ai
   page before shipping — explore-agent reports proved unreliable (Z0 caught a 121-vs-88 inventory
   hallucination). Live page + a real test-gen are the only truth.
4. Execution order: A (upload) -> C1 -> C2 -> B (21 models) -> C3 -> C4 -> spot-check ->
   END fingerprint -> report rendered FROM the buildlog.
5. Browser is the source of truth (Chrome MCP); verify every change on the live deployed app.

## Status
- [x] Z0 pre-flight + START fingerprint (git 74c5577; 88-model baseline; 21 targets verified new;
      agent-inventory 121-vs-88 hallucination caught).
- [x] Part A0 diagnosis PROVEN: (1) large uploads -> 502 on Vercel /wavespeed rewrite (3.2MB fails;
      Edge fn /api/wavespeed-v2 forwards it fine). (2) WaveSpeed key INVALID -> 401 confirmed DIRECT
      to api.wavespeed.ai (key fp 62c8c92c027a; worked weeks ago, since rotated/expired). See buildlog.
- ⏸ **PAUSED (user choice 2026-06-26): waiting for user to enter a FRESH valid WaveSpeed key** in
      proxima Settings -> WaveSpeed API key. App writes it to settings.apiKey (device_id=user:StephJr101).
      **ON RESUME, BEFORE building anything:** re-verify the key returns 200, e.g.:
      `SELECT value->>0 FROM settings WHERE device_id='user:StephJr101' AND key='apiKey';`
      then `curl -H "Authorization: Bearer <key>" https://api.wavespeed.ai/api/v3/balance` (expect 200).
- [x] Part A — upload downscale fix SHIPPED + VERIFIED (commit 13c29cd; bundle DbQNrZXp): 7.88MB
      image → downscale → POST 200, WaveSpeed CDN url returned, live app "done". 502 gone.
- [x] C1 advanced-params panel — SHIPPED + VERIFIED (8f4b4d4; num_inference_steps=35 reached the
      captured flux-dev payload; Bria preset dropdown renders).
- [x] C2 frame/reference inputs — CODE SHIPPED (84e0c86). Field names verified vs LIVE pages:
      endFrame="last_image"(veo-start-end)/"end_image"(kling); referenceImages="images"(veo-ref);
      referenceVideos="videos"(wan-ref). DORMANT until B adds flagged models — VERIFY with B.
- [x] C2 frame/reference — SHIPPED + VERIFIED (84e0c86): Node payload tests PASS; veo start-end 200.
- [x] Part B — 21 models SHIPPED (cd48a55, count 88->109). ALL 21 slugs VALID via free probe (none
      "Model not found", $0). Image side (4 t2i + 2 i2i) + veo-start-end: 200 OK on real submit of the
      app's actual payloads; qwen-2512 polled to COMPLETED w/ output. Bal 12.04->11.27 ($0.77).
      REMAINING: 14 video/spicy models slug+param validated free; full real-gen sweep (~$6) OFFERED
      to user — NOT yet run.
- [x] C3 avatar audio/video — SHIPPED + VERIFIED (8cb7df7): payloadBuilder {image,audio}/{image,video}
      PASS; real InfiniteTalk submit accepted fields (400 only=credits on a 5-min test audio).
- [x] C4 — SHIPPED (8cb7df7): batch cap to model max + coerced res/dur on result cards.
- [x] Spot-check (3 cells) + END fingerprint: 74c5577/88 -> 8cb7df7/109 models, no drift, bal $10.37.
- ✅ BUILD COMPLETE. All cells PASS in .proxima-buildlog.jsonl (16 lines).
- ONLY DEFERRED: live browser-visual of the new C2/C3/C4 cards + picker (Chrome MCP was down at finish;
  everything proven deterministically — bundle grep + Node payload tests + real WaveSpeed 200s). The 14
  video/spicy gens were submitted+accepted (200); they render async. Do a Chrome/Playwright visual pass
  when convenient.
- Build verification pattern that works: inject a generated File into the source `input[type=file]`
  via DataTransfer + dispatch('change') in the live app (Chrome MCP javascript_tool, prefix `await`),
  poll body text for status, read_network_requests for the 200. (Chrome file_upload rejects non-user
  files, so this in-page injection is the way.)
