# Out-of-scope findings (2026-06-26 run) — do NOT act on without a new decision

Park anything discovered mid-run here instead of expanding scope (anti-drift guard 10).

## Known, parked at start
- ~119 OTHER new WaveSpeed models the research found but we are NOT adding this run: older
  generations (imagen3, seedream v3/v4, kling v1.6–v2.1, wan-2.2 non-spicy), per-resolution
  duplicate slugs (seedance-v1-pro-t2v-480p/720p/1080p, wan-2.2 t2v-480p/720p, …), LoRA-input
  variants, trainers, translate/utility, and 34 new 3D / avatar / audio models. Full catalog:
  workflow output `wpgwpq1bm.output`.
- Bria Eraser needs a `mask` input; Bria Embed-Product needs a `products` list — no UI today
  (sweep agent 6). Separate feature.
- Multi-model per-model override redesign beyond C4 (sweep agent 2's tabbed per-model panel idea).
- Earlier explore agent's model inventory was inflated (121 vs actual 88) — do not reuse that
  agent's table; re-derive from `models.js`.
