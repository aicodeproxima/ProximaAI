// Genjutsu Studio (src/components/GenjutsuStudio.jsx): what each mode still needs before it can run, which files the
// upload accepts, how the Restyle presets answer is read, and what the payload sends. Pure: no network. Run: npm test
import assert from "node:assert/strict";
import { hfInputProblem, uploadProblem, hfPresetList, HF_UPLOAD_MAX_BYTES } from "../src/lib/higgsfield.js";
import { hfModelById } from "../src/config/higgsfieldModels.js";
import { buildPayload } from "../src/lib/payloadBuilder.js";

let passed = 0, failed = 0;
function test(name, fn) {   // synchronous on purpose: an async body would always "pass"
  try { fn(); passed++; } catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); }
}

const MT = hfModelById("hf/genjutsu/motion-transfer");
const OS = hfModelById("hf/genjutsu/object-swap");
const RS = hfModelById("hf/genjutsu/restyle");
const V = "https://x.supabase.co/storage/v1/object/public/generations/uploads/u/clip.mp4";
const I = n => Array.from({ length: n }, (_, i) => `https://x/img${i}.png`);

test("every mode needs a source video", () => {
  for (const m of [MT, OS, RS]) assert.equal(hfInputProblem(m, { video: " ", images: I(2), preset: "p1" }), "Add a source video");
});
test("Motion Transfer and Object Swap need 1 to 8 reference images", () => {
  for (const m of [MT, OS]) {
    assert.equal(hfInputProblem(m, { video: V, images: [] }), "Add at least 1 reference image");
    assert.equal(hfInputProblem(m, { video: V, images: I(1) }), null);
    assert.equal(hfInputProblem(m, { video: V, images: I(8) }), null);
    assert.match(hfInputProblem(m, { video: V, images: I(9) }), /at most 8 reference images.*remove 1/);
  }
});
test("Restyle needs a preset; its images are optional, at most 5", () => {
  assert.equal(hfInputProblem(RS, { video: V, images: [] }), "Pick a style preset");
  assert.equal(hfInputProblem(RS, { video: V, images: [], preset: "p1" }), null);
  assert.match(hfInputProblem(RS, { video: V, images: I(6), preset: "p1" }), /at most 5 reference images.*remove 1/);
});
test("a measured clip under 4 s is named; over 30 s runs (Higgsfield uses the first 30 s)", () => {
  assert.match(hfInputProblem(MT, { video: V, images: I(1), duration: 2.5 }), /2\.5 s.*at least 4 s/);
  assert.equal(hfInputProblem(MT, { video: V, images: I(1), duration: 45 }), null);
  assert.equal(hfInputProblem(MT, { video: V, images: I(1), duration: null }), null);   // unreadable here: Higgsfield checks it
});
test("a model that is not Higgsfield has nothing to add", () => {
  assert.equal(hfInputProblem({ id: "wavespeed/x" }, {}), null);
});

test("uploads: the storage bucket's video and image types, 50 MB", () => {
  assert.equal(HF_UPLOAD_MAX_BYTES, 50 * 1024 * 1024);
  assert.equal(uploadProblem({ name: "a.mp4", type: "video/mp4", size: 10e6 }, "video").problem, null);
  assert.equal(uploadProblem({ name: "a.mov", type: "video/quicktime", size: 10e6 }, "video").problem, null);
  assert.match(uploadProblem({ name: "big.mp4", type: "video/mp4", size: 82 * 1024 * 1024 }, "video").problem, /big\.mp4.*82\.0 MB.*limited to 50 MB/);
  assert.match(uploadProblem({ name: "a.avi", type: "video/x-msvideo", size: 1e6 }, "video").problem, /MP4, MOV, WebM or MKV/);
  assert.match(uploadProblem({ name: "pic.png", type: "image/png", size: 1e6 }, "video").problem, /MP4, MOV, WebM or MKV/);
  assert.equal(uploadProblem({ name: "p.jpg", type: "image/jpeg", size: 9e6 }, "image").problem, null);   // shrunk before upload
  assert.match(uploadProblem({ name: "p.heic", type: "image/heic", size: 1e6 }, "image").problem, /JPEG, PNG, WebP or GIF/);
});
test("uploads: a file the picker gave no type is typed from its extension", () => {
  assert.deepEqual(uploadProblem({ name: "clip.MOV", type: "", size: 1e6 }, "video"), { problem: null, type: "video/quicktime" });
  assert.deepEqual(uploadProblem({ name: "x.webp", type: "", size: 1e6 }, "image"), { problem: null, type: "image/webp" });
  assert.match(uploadProblem({ name: "noext", type: "", size: 1e6 }, "video").problem, /MP4, MOV, WebM or MKV/);
});

test("presets: items or presets, entries without an id dropped, a name for each", () => {
  assert.deepEqual(hfPresetList({ items: [{ id: "a", name: "Anime" }, { name: "no id" }, { id: "b" }] }),
    [{ id: "a", name: "Anime" }, { id: "b", name: "b" }]);
  assert.deepEqual(hfPresetList({ presets: [{ preset_id: "c", title: "Clay" }] }), [{ id: "c", name: "Clay" }]);
  assert.deepEqual(hfPresetList(null), []);
});

test("payload: the video the studio shows, never another tab's leftover", () => {
  const p = buildPayload(MT, { sourceImageUrl: V, sourceVideoUrl: "https://x/avatar-tab.mp4", sourceImageUrls: I(2), resolution: "720p" }, "v2v");
  assert.equal(p.video_url, V);
  assert.deepEqual(p.image_urls, I(2));
});
test("payload: preset_id only for Restyle", () => {
  const mt = buildPayload(MT, { sourceImageUrl: V, sourceImageUrls: I(1), presetId: "p1", resolution: "720p" }, "v2v");
  assert.equal("preset_id" in mt, false);
  const rs = buildPayload(RS, { sourceImageUrl: V, sourceImageUrls: [], presetId: "p1", resolution: "720p" }, "v2v");
  assert.equal(rs.preset_id, "p1");
  assert.equal("image_urls" in rs, false);
});

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
