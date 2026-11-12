// Genjutsu Studio: Higgsfield's Video-to-Video modes (Motion Transfer, Object Swap, Restyle), mobile-first (384 px).
// The source video lives in App's sourceImageUrl and the reference images in sourceImageUrls, the fields Generate checks
// and payloadBuilder sends (src/lib/payloadBuilder.js). Files are uploaded through App's uploadSingleFile (images shrunk
// first; the storage bucket takes 50 MB and the types in src/lib/higgsfield.js uploadProblem). What each mode still needs
// is hfInputProblem's (the same words Generate shows).
import { useState, useEffect, useRef } from "react";
import { listHiggsfieldPresets } from "../lib/api.js";
import { uploadProblem } from "../lib/higgsfield.js";

// What each mode does, from Higgsfield's descriptions of Genjutsu (higgsfield.ai/video-to-video, the Genjutsu
// Motion Transfer node docs at docs.comfy.org) and the model config (src/config/higgsfieldModels.js).
const MODES = [
  {
    id: "hf/genjutsu/motion-transfer", label: "Motion Transfer", mode: "motion-transfer",
    about: "Keeps your video's motion, camera moves, timing and audio, and rebuilds who and what is in it from your reference images: a new character, outfit, place or look.",
    needs: "A source video and 1 to 8 reference images.",
    tip: "In the prompt, say which reference replaces whom (for example “the dancer becomes the woman in image 1”). Anything you don't mention is rebuilt from the references.",
  },
  {
    id: "hf/genjutsu/object-swap", label: "Object Swap", mode: "object-swap",
    about: "Replaces one object or element in your video, such as a product, a prop or an outfit, with the one in your reference images, and keeps the rest of the footage as it was shot.",
    needs: "A source video and 1 to 8 reference images of the new object.",
    tip: "In the prompt, name what to swap (for example “replace the bottle with the can in image 1”).",
  },
  {
    id: "hf/genjutsu/restyle", label: "Restyle", mode: "restyle",
    about: "Redraws your whole video in an art style (anime, claymation, film looks and more) while the motion, framing and timing stay as you shot them.",
    needs: "A source video and a style preset. Reference images are optional (up to 5) to steer the look.",
    tip: "The prompt is optional: use it to describe details of the look you want.",
  },
];

const isUrl = (s) => /^https?:\/\/\S+$/.test(String(s || "").trim());
const labelStyle = { display: "block", fontSize: 11, color: "var(--text-muted, #94a3b8)", marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 };
const inputStyle = { width: "100%", boxSizing: "border-box", padding: "10px 12px", fontSize: 12, background: "rgba(0, 0, 0, 0.25)", border: "1px solid rgba(255, 255, 255, 0.1)", borderRadius: 8, color: "var(--text-primary, #ffffff)", outline: "none" };
const selectStyle = { width: "100%", padding: "10px 12px", fontSize: 12, background: "rgba(15, 23, 42, 0.8)", border: "1px solid rgba(255, 255, 255, 0.1)", borderRadius: 8, color: "var(--text-primary, #ffffff)", outline: "none" };
const buttonStyle = (primary, disabled) => ({
  minHeight: 44, padding: "0 12px", fontSize: 12, fontWeight: 700, borderRadius: 8, cursor: disabled ? "not-allowed" : "pointer",
  color: disabled ? "var(--text-muted, #64748b)" : "#ffffff",
  background: disabled ? "rgba(255, 255, 255, 0.04)" : primary ? "var(--accent, #6366f1)" : "rgba(255, 255, 255, 0.08)",
  border: "1px solid rgba(255, 255, 255, 0.12)",
});
const note = (color) => ({ fontSize: 11, color, marginTop: 6, lineHeight: 1.45 });
const RED = "#f87171", AMBER = "#fbbf24", MUTED = "var(--text-muted, #64748b)";

// The file with a type the bucket accepts (a picker may give none: the extension decides), or the reason it can't go.
function typedFile(file, kind) {
  const { problem, type } = uploadProblem(file, kind);
  if (problem) return { problem };
  return { file: file.type === type ? file : new File([file], file.name, { type, lastModified: file.lastModified }) };
}

export default function GenjutsuStudio({
  selectedModel, onSelectModel,
  sourceVideo, onSourceVideoChange, sourceDuration,
  refImages, onRefImagesChange,
  prompt, onPromptChange,
  resolution, onResolutionChange,
  selectedPreset, onPresetChange,
  uploadFile,
  font,
}) {
  const mode = selectedModel?.hf?.mode || "motion-transfer";
  const info = MODES.find(m => m.mode === mode) || MODES[0];
  const maxImages = selectedModel?.hf?.maxImages ?? 8;
  const images = Array.isArray(refImages) ? refImages.filter(Boolean) : [];
  const videoInputRef = useRef(null);
  const imageInputRef = useRef(null);
  const [videoState, setVideoState] = useState({ busy: false, error: "", note: "" });
  const [imageState, setImageState] = useState({ busy: false, error: "", note: "" });
  const [imageLink, setImageLink] = useState("");

  // Restyle presets: loaded once per visit to Restyle (and on Retry), never on every render (the callbacks App passes are
  // new each render; refs keep them out of the effect's dependencies).
  const [presetsState, setPresetsState] = useState({ loading: false, error: "", list: [] });
  const [presetsTry, setPresetsTry] = useState(0);
  const presetRef = useRef({ selectedPreset, onPresetChange });
  presetRef.current = { selectedPreset, onPresetChange };
  useEffect(() => {
    if (mode !== "restyle") return;
    let cancelled = false;
    setPresetsState(s => ({ ...s, loading: true, error: "" }));
    listHiggsfieldPresets().then(r => {
      if (cancelled) return;
      if (!r.ok) { setPresetsState({ loading: false, error: r.error, list: [] }); return; }
      setPresetsState({ loading: false, error: r.presets.length ? "" : "Higgsfield returned no style presets.", list: r.presets });
      const { selectedPreset: cur, onPresetChange: set } = presetRef.current;
      if (r.presets.length && !r.presets.some(p => p.id === cur)) set(r.presets[0].id);
    });
    return () => { cancelled = true; };
  }, [mode, presetsTry]);

  async function handleVideoFile(e) {
    const picked = (e.target.files || [])[0];
    if (videoInputRef.current) videoInputRef.current.value = "";   // the same file can be picked again
    if (!picked) return;
    const { file, problem } = typedFile(picked, "video");
    if (problem) { setVideoState({ busy: false, error: problem, note: "" }); return; }
    setVideoState({ busy: true, error: "", note: `Uploading ${file.name} (${(file.size / 1048576).toFixed(1)} MB)…` });
    try {
      const url = await uploadFile(file);
      if (!url) throw new Error("the upload returned no link");
      onSourceVideoChange(url);
      setVideoState({ busy: false, error: "", note: "" });
    } catch (err) {
      setVideoState({ busy: false, error: `Upload failed: ${err?.message || err}`, note: "" });
    }
  }

  async function handleImageFiles(e) {
    const picked = Array.from(e.target.files || []);
    if (imageInputRef.current) imageInputRef.current.value = "";
    if (picked.length === 0) return;
    const room = Math.max(0, maxImages - images.length);
    const errors = [];
    const ready = [];
    for (const f of picked) {
      const { file, problem } = typedFile(f, "image");
      if (problem) errors.push(problem); else ready.push(file);
    }
    if (ready.length > room) errors.push(`Only ${room} more ${room === 1 ? "image fits" : "images fit"} (this mode takes ${maxImages}): ${ready.length - room} not added.`);
    const toSend = ready.slice(0, room);
    if (toSend.length === 0) { setImageState({ busy: false, error: errors.join(" "), note: "" }); return; }
    setImageState({ busy: true, error: "", note: `Uploading ${toSend.length} ${toSend.length === 1 ? "image" : "images"}…` });
    const results = await Promise.allSettled(toSend.map(f => uploadFile(f)));
    const urls = [];
    results.forEach((r, i) => {
      if (r.status === "fulfilled" && r.value) urls.push(r.value);
      else errors.push(`"${toSend[i].name}" upload failed: ${r.reason?.message || r.reason || "no link returned"}`);
    });
    if (urls.length) onRefImagesChange([...images, ...urls].slice(0, maxImages));
    setImageState({ busy: false, error: errors.join(" "), note: "" });
  }

  function addImageLink() {
    const url = imageLink.trim();
    if (!isUrl(url)) { setImageState({ busy: false, error: "Paste a full image link that starts with https://", note: "" }); return; }
    if (images.length >= maxImages) { setImageState({ busy: false, error: `This mode takes at most ${maxImages} images.`, note: "" }); return; }
    onRefImagesChange([...images, url]);
    setImageLink("");
    setImageState({ busy: false, error: "", note: "" });
  }

  const durationNote = !isUrl(sourceVideo) ? null
    : sourceDuration === undefined ? { color: MUTED, text: "Measuring the video's length…" }
    : sourceDuration === null ? { color: MUTED, text: "This browser couldn't read the video's length; Higgsfield checks it (4 to 30 s)." }
    : sourceDuration < 4 ? { color: RED, text: `This video is ${sourceDuration.toFixed(1)} s; Higgsfield needs at least 4 s.` }
    : sourceDuration > 30 ? { color: AMBER, text: `This video is ${sourceDuration.toFixed(1)} s; only its first 30 s are used.` }
    : { color: MUTED, text: `Length: ${sourceDuration.toFixed(1)} s.` };

  return (
    <div style={{ background: "var(--bg-card, rgba(15, 23, 42, 0.6))", border: "1px solid var(--border-color, rgba(148, 163, 184, 0.15))", borderRadius: 14, padding: 14, marginBottom: 16, backdropFilter: "blur(12px)", fontFamily: font || "inherit" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary, #f1f5f9)", letterSpacing: 0.5 }}>GENJUTSU STUDIO · HIGGSFIELD</div>
        <div style={{ fontSize: 10, background: "rgba(99, 102, 241, 0.15)", color: "var(--accent, #818cf8)", padding: "3px 8px", borderRadius: 6, fontWeight: 600 }}>Video → Video</div>
      </div>

      {/* Mode selector */}
      <div role="tablist" aria-label="Genjutsu mode" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginBottom: 10 }}>
        {MODES.map(m => {
          const active = selectedModel?.id === m.id;
          return (
            <button key={m.id} type="button" role="tab" aria-selected={active} onClick={() => onSelectModel(m.id)} style={{
              minHeight: 40, padding: "6px 4px", fontSize: 11, fontWeight: active ? 700 : 500, borderRadius: 8, cursor: "pointer", textAlign: "center",
              color: active ? "#ffffff" : "var(--text-muted, #94a3b8)",
              background: active ? "var(--accent, #6366f1)" : "rgba(255, 255, 255, 0.04)",
              border: active ? "1px solid rgba(255, 255, 255, 0.2)" : "1px solid rgba(255, 255, 255, 0.06)",
            }}>{m.label}</button>
          );
        })}
      </div>

      {/* What this mode does */}
      <div style={{ background: "rgba(99, 102, 241, 0.08)", border: "1px solid rgba(99, 102, 241, 0.25)", borderRadius: 10, padding: "10px 12px", marginBottom: 14, fontSize: 12, lineHeight: 1.5, color: "var(--text-primary, #e2e8f0)" }}>
        <div style={{ fontWeight: 700, marginBottom: 4 }}>{info.label}</div>
        <div>{info.about}</div>
        <div style={{ marginTop: 6 }}><b>You need:</b> {info.needs}</div>
        <div style={{ marginTop: 4, color: "var(--text-muted, #94a3b8)" }}>{info.tip}</div>
      </div>

      {/* Source video */}
      <div style={{ marginBottom: 14 }}>
        <label style={labelStyle}>Source video (4 – 30 s, up to 50 MB)</label>
        {isUrl(sourceVideo) && (
          <video key={sourceVideo} src={sourceVideo} controls playsInline muted preload="metadata"
            style={{ width: "100%", maxHeight: 220, borderRadius: 8, background: "#000", marginBottom: 8, display: "block" }} />
        )}
        <div style={{ display: "grid", gridTemplateColumns: isUrl(sourceVideo) ? "1fr auto" : "1fr", gap: 8 }}>
          <button type="button" disabled={videoState.busy || !uploadFile} onClick={() => videoInputRef.current?.click()} style={buttonStyle(true, videoState.busy || !uploadFile)}>
            {videoState.busy ? "Uploading…" : isUrl(sourceVideo) ? "⬆ Replace video" : "⬆ Upload video"}
          </button>
          {isUrl(sourceVideo) && (
            <button type="button" disabled={videoState.busy} onClick={() => { onSourceVideoChange(""); setVideoState({ busy: false, error: "", note: "" }); }} style={buttonStyle(false, videoState.busy)}>Remove</button>
          )}
        </div>
        <input ref={videoInputRef} type="file" accept="video/mp4,video/quicktime,video/webm,video/x-matroska,video/*" style={{ display: "none" }} onChange={handleVideoFile} />
        <input type="url" inputMode="url" value={sourceVideo || ""} onChange={e => onSourceVideoChange(e.target.value)}
          placeholder="…or paste a video link (https://…)" autoCapitalize="off" autoCorrect="off" spellCheck={false}
          style={{ ...inputStyle, marginTop: 8 }} />
        {videoState.note && <div role="status" style={note(MUTED)}>{videoState.note}</div>}
        {videoState.error && <div role="alert" style={note(RED)}>{videoState.error}</div>}
        {durationNote && !videoState.busy && <div style={note(durationNote.color)}>{durationNote.text}</div>}
      </div>

      {/* Reference images */}
      <div style={{ marginBottom: 14 }}>
        <label style={labelStyle}>
          {mode === "restyle" ? `Style reference images (optional, up to ${maxImages})` : `Reference images (1 to ${maxImages})`}
          <span style={{ float: "right", textTransform: "none" }}>{images.length} / {maxImages}</span>
        </label>
        {images.length > 0 && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6, marginBottom: 8 }}>
            {images.map((url, i) => (
              <div key={`${url}-${i}`} style={{ position: "relative", aspectRatio: "1 / 1", borderRadius: 8, overflow: "hidden", background: "rgba(0, 0, 0, 0.3)", border: "1px solid rgba(255, 255, 255, 0.08)" }}>
                <img src={url} alt={`Reference ${i + 1}`} loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                <span style={{ position: "absolute", left: 4, bottom: 4, fontSize: 10, fontWeight: 700, color: "#fff", background: "rgba(0, 0, 0, 0.6)", borderRadius: 4, padding: "1px 5px" }}>{i + 1}</span>
                <button type="button" aria-label={`Remove image ${i + 1}`} onClick={() => onRefImagesChange(images.filter((_, j) => j !== i))}
                  style={{ position: "absolute", top: 2, right: 2, width: 32, height: 32, borderRadius: 16, border: "none", background: "rgba(0, 0, 0, 0.65)", color: "#fff", fontSize: 16, cursor: "pointer", lineHeight: "32px", padding: 0 }}>×</button>
              </div>
            ))}
          </div>
        )}
        <button type="button" disabled={imageState.busy || images.length >= maxImages || !uploadFile} onClick={() => imageInputRef.current?.click()}
          style={{ ...buttonStyle(true, imageState.busy || images.length >= maxImages || !uploadFile), width: "100%" }}>
          {imageState.busy ? "Uploading…" : images.length >= maxImages ? `${maxImages} images added (the most this mode takes)` : images.length ? "⬆ Add more images" : "⬆ Upload images"}
        </button>
        <input ref={imageInputRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/*" multiple style={{ display: "none" }} onChange={handleImageFiles} />
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, marginTop: 8 }}>
          <input type="url" inputMode="url" value={imageLink} onChange={e => setImageLink(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addImageLink(); } }}
            placeholder="…or paste an image link" autoCapitalize="off" autoCorrect="off" spellCheck={false} style={inputStyle} />
          <button type="button" onClick={addImageLink} disabled={!imageLink.trim()} style={buttonStyle(false, !imageLink.trim())}>Add</button>
        </div>
        {images.length > maxImages && (
          <div role="alert" style={note(AMBER)}>{info.label} takes at most {maxImages} images: remove {images.length - maxImages}.</div>
        )}
        {imageState.note && <div role="status" style={note(MUTED)}>{imageState.note}</div>}
        {imageState.error && <div role="alert" style={note(RED)}>{imageState.error}</div>}
      </div>

      {/* Restyle: style preset */}
      {mode === "restyle" && (
        <div style={{ marginBottom: 14 }}>
          <label style={labelStyle}>Style preset</label>
          {presetsState.list.length > 0 ? (
            <select value={selectedPreset || ""} onChange={e => onPresetChange(e.target.value)} disabled={presetsState.loading} style={selectStyle}>
              {presetsState.list.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: presetsState.loading ? "1fr" : "1fr auto", gap: 8, alignItems: "center" }}>
              <div style={{ ...inputStyle, color: presetsState.loading ? MUTED : RED }}>
                {presetsState.loading ? "Loading style presets…" : (presetsState.error || "No style presets loaded.")}
              </div>
              {!presetsState.loading && <button type="button" onClick={() => setPresetsTry(n => n + 1)} style={buttonStyle(false, false)}>Retry</button>}
            </div>
          )}
        </div>
      )}

      {/* Resolution & prompt */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 10 }}>
        <div>
          <label style={labelStyle}>Resolution</label>
          <select value={resolution || "720p"} onChange={e => onResolutionChange(e.target.value)} style={selectStyle}>
            <option value="480p">480p</option>
            <option value="720p">720p</option>
            <option value="1080p">1080p</option>
          </select>
        </div>
        <div>
          <label style={labelStyle}>Prompt (optional)</label>
          <input type="text" value={prompt || ""} onChange={e => onPromptChange(e.target.value)}
            placeholder={mode === "object-swap" ? "What to swap for what…" : mode === "restyle" ? "Details of the look…" : "Who replaces whom…"}
            style={inputStyle} />
        </div>
      </div>
    </div>
  );
}
