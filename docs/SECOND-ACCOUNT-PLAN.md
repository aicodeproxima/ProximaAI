# Second account + kie.ai key (plan, 2026-10-25)

Owner, 2026-10-25: "I need the second account up and running and I need it able to support kie.ai API key" (theme work
parked). This plan is the lockdown session's part (src/App.jsx, src/lib/*, P2, P5, kie.ai). The server walls (P4) are
the RLS session's, see docs/MULTI-USER-PLAN.md §5.

**Done when:** a second person signs in on their own account, saves their kie.ai key in Settings, generates with kie.ai
models, and sees their results on every device they use. They never see the owner's data, and the owner never sees theirs.
The owner's account works exactly as before throughout.

**Gate:** no member account, not even a test one, exists before all of P4 is live. P4 is the RLS session's 4 migrations:
storage folders (applied 2026-10-25 20:18:55 UTC), per-account topic, the (device_id, id) tombstone key, and scoped
existence checks. Until then, every kie.ai step below is built and proven on the owner's own account.

## Decisions (defaults; the owner can overrule any of them)
- **K1. Keys are per account and per provider.** Settings gets two key boxes: WaveSpeed and kie.ai. The model list shows a
  provider's models only when the account has saved that provider's key. The owner's account is unchanged until the
  owner adds a kie.ai key.
- **K2. A kie.ai starter set, mirroring models the app already has.**
  - Images: Nano Banana 2 / Pro (text and edit), Seedream 5 Lite / Pro, GPT Image 2, Flux 2.
  - Video: Kling 3.0, Seedance 2 / 2 Fast, Veo 3.1, Wan 2.7, Hailuo 2.3, Grok Imagine.
  - Each model is wired from its own kie.ai page (input names, limits, price), so models are added one by one on request.
- **K3. Results arrive by polling while a device is open.** That works with the key alone.
  - kie.ai's optional webhook comes later, as a separate step. It is signed per kie.ai account (HMAC of taskId.timestamp,
    body not covered, so the server re-reads the task).
  - Until then, a kie.ai generation started and left with every device closed finishes on kie.ai. It shows up the
    next time a device opens, provided that happens within kie.ai's 14-day file window.
- **K4. "Delete means delete" with kie.ai has a provider limit: kie.ai has no delete API.** A delete still removes our
  rows, our archived files and the backups' copies, as today. kie.ai's own copy (tempfile.aiquickdraw.com) expires by
  itself after 14 days.
- **K5. Keys go into Supabase Vault** (plan D6), never into a table in clear text. The owner's existing WaveSpeed key
  keeps working through a fallback until it is moved.
- **K6. Prices.** kie.ai bills credits.
  - The estimate before a run comes from a per-model price table built from kie.ai's pages.
  - The cost recorded after a run is kie.ai's own `creditsConsumed`. A credit is about $0.005: derived, not published,
    and shown as credits plus an approximate dollar figure.
- **K7. Joining is by invite only** (owner ruling 2026-10-23).
  1. The owner creates a one-time code in Settings. It is valid for 7 days and stored hashed.
  2. The member opens `/join`, picks a name and password, and sees a backup code once.
  3. Then the member adds their own kie.ai key.

## Steps (each one: failing-first tests, a proven rollback where the server changes, 3 reviewers, deploy, live check)
- **S1 Server: members and keys** (migration `mu_p5_members_keys`, lockdown session).
  - invites: create_invite (owner only, returns the code once), join_with_invite (generic errors, the per-IP throttle
    from P1, the folder claim from P4).
  - provider keys in Vault: set_my_provider_key, clear_my_provider_key, my_provider_keys (fingerprints only), and
    get_provider_key (service role only; re-verifies the token, so revocation applies).
  - Tests: as anon with minted tokens, rolled back.
  - Apply order: after the RLS session's pending P4 migrations (E = 20261025400000, and 20261025450000).
    apply-migration.mjs refuses an older unrecorded file once a newer one is recorded.
- **S2 Proxy `api/kie-proxy.ts`** (a new file; ws-proxy.ts is untouched).
  - Verifies the session the same way ws-proxy does and reads the account's key server-side.
  - Allows exactly four kie.ai calls: createTask, recordInfo, credit, download-url. It strips callBackUrl until K3's
    webhook exists.
- **S3 Client provider layer.**
  - Models carry `api: "kie"`. submit and poll go to the right proxy.
  - A kie.ai result becomes the same task shape the app already uses.
  - Resume, the WaveSpeed delete paths and the WaveSpeed sweep never send a kie.ai id to WaveSpeed.
  - The archive copies kie.ai outputs into our storage.
- **S4 Screens.** The Settings key boxes (masked), the owner's invite button and the `/join` page, checked at 384 px.
- **S5 P2: per-account browser storage** (plan §5 P2).
  - Each account gets its own IndexedDB and localStorage keys.
  - Every queued write carries its account.
  - Switching accounts parks the other account's data: never shown, never replayed.
- **S6 Live proof.**
  - Two Playwright contexts on the live site, the owner plus a test member, after the gate. Counts only.
  - Then the real member's invite.

S1–S4 can be proven on the owner's account before the gate opens. S5 and S6 need the gate.

## Owner actions
- Rotate the kie.ai key that was pasted into chat. The new one is typed only into the app's Settings box.
- Give the member their invite code privately.
- K2: tell me which kie.ai models the member wants first, if they differ from the starter set.
