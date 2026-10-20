# Configurable model favorites — rollout status

Date: 2026-10-20

## Outcome

ProximaAI now supports user-controlled model favorites in every registered workflow:

- Image
- Image Edit
- Image to 3D
- Text to Video
- Image to Video
- Video Edit
- Avatar

Every model row has an independent empty/filled star. Selecting or deselecting a model and adding or removing it from favorites are separate actions. Removing a favorite does not deselect that model.

The model-card header has a category-level `★ FAV N` button. Pressing it replaces the current selection with every valid favorite in that category, in registry order. The control is disabled at zero favorites. `ALL` and `NONE` remain available as separate actions.

## Persistence and sync

- The persisted cloud setting is `favoriteModelsByType` with a version, client update timestamp, and category-to-model-id map.
- The local IndexedDB key includes the active account scope, preventing one signed-in account's preferences from being loaded into another account on the same browser.
- The cloud row remains account-scoped by the existing Supabase `device_id` convention.
- Local state updates immediately when a star is pressed.
- Before every cloud write, the newest snapshot is placed in the durable failed-sync queue under the dedicated `model-favorites` kind.
- Favorite writes are serialized. Rapid clicks cannot allow an older snapshot to land after a newer one.
- The retry entry is removed only after Supabase confirms the write. Forced saves and startup replay use the same serialized path.
- Logout waits for any active favorite write while the current account scope is still captured.
- Reset Everything clears the in-memory and account-scoped local favorites and removes any stale retry intent before clearing cloud settings.
- Current model IDs are displayed and selected in registry order. Unknown saved IDs are retained non-destructively so a temporarily removed model can recover its favorite state if it returns.

## Accessibility and responsive behavior

- Model selection and model favoriting are separate semantic buttons, so there are no nested interactive controls.
- Each star exposes `aria-pressed`, a model-specific add/remove label, and a tooltip.
- The category favorite button exposes its count and selected state.
- Keyboard focus rings are present on model choices, row stars, and header controls.
- Mobile row stars and header actions use a minimum 44px tap target.
- The narrow layout gives the row star its own grid column and keeps provider/price metadata under the model name.

## Validation

- `npm run build`: PASS.
- Helper assertions: PASS for add, remove, deduplication, stale-id preservation, JSON round trip, and registry-order selection.
- Category matrix: PASS across all seven workflows.
- Production bundle: deployed from commit `c741656`; the live bundle contains the new favorites state, labels, and persistence logic.
- Live browser render: PASS for independent row stars and the category-level `★ FAV 0`, `ALL`, and `NONE` controls on the authenticated cockpit.
- No favorite was added or removed during production QA, so the user's real preference set was not changed.

## Privacy boundary honored during implementation

No Gallery or Logs page was opened, and no generation, prediction, or history API was queried. The authenticated cockpit itself places saved-output cards beside the model picker; browser inspection stopped without interacting with that area or using any of its data.

