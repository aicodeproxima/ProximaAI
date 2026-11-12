// Dedicated Genjutsu Studio component for Video-to-Video workflows (Motion Transfer, Object Swap, Restyle).
// Mobile-first responsive layout constrained to 384px viewport.
import { useState, useEffect } from "react";

export default function GenjutsuStudio({
  selectedModel,
  onSelectModel,
  sourceVideo,
  onSourceVideoChange,
  refImages,
  onRefImagesChange,
  prompt,
  onPromptChange,
  resolution,
  onResolutionChange,
  selectedPreset,
  onPresetChange,
  font
}) {
  const [presets, setPresets] = useState([]);
  const [loadingPresets, setLoadingPresets] = useState(false);

  const mode = selectedModel?.hf?.mode || "motion-transfer";

  useEffect(() => {
    if (mode === "restyle" && presets.length === 0) {
      setLoadingPresets(true);
      fetch("/api/higgsfield/models/higgsfield/genjutsu/restyle/v1.0/presets")
        .then(r => r.ok ? r.json() : { presets: [] })
        .then(data => {
          if (Array.isArray(data?.presets)) {
            setPresets(data.presets);
            if (!selectedPreset && data.presets.length > 0) {
              onPresetChange(data.presets[0].id);
            }
          }
        })
        .catch(() => {})
        .finally(() => setLoadingPresets(false));
    }
  }, [mode, presets.length, selectedPreset, onPresetChange]);

  const modes = [
    { id: "hf/genjutsu/motion-transfer", label: "Motion Transfer", mode: "motion-transfer" },
    { id: "hf/genjutsu/object-swap", label: "Object Swap", mode: "object-swap" },
    { id: "hf/genjutsu/restyle", label: "Restyle", mode: "restyle" }
  ];

  return (
    <div style={{
      background: "var(--bg-card, rgba(15, 23, 42, 0.6))",
      border: "1px solid var(--border-color, rgba(148, 163, 184, 0.15))",
      borderRadius: 14,
      padding: 14,
      marginBottom: 16,
      backdropFilter: "blur(12px)",
      fontFamily: font || "inherit"
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary, #f1f5f9)", letterSpacing: 0.5 }}>
          GENJUTSU STUDIO · HIGGSFIELD
        </div>
        <div style={{
          fontSize: 10,
          background: "rgba(99, 102, 241, 0.15)",
          color: "var(--accent, #818cf8)",
          padding: "3px 8px",
          borderRadius: 6,
          fontWeight: 600
        }}>
          Video → Video
        </div>
      </div>

      {/* Mode Selector */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginBottom: 14 }}>
        {modes.map(m => {
          const active = selectedModel?.id === m.id;
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => onSelectModel(m.id)}
              style={{
                padding: "8px 4px",
                fontSize: 11,
                fontWeight: active ? 700 : 500,
                color: active ? "#ffffff" : "var(--text-muted, #94a3b8)",
                background: active ? "var(--accent, #6366f1)" : "rgba(255, 255, 255, 0.04)",
                border: active ? "1px solid rgba(255, 255, 255, 0.2)" : "1px solid rgba(255, 255, 255, 0.06)",
                borderRadius: 8,
                cursor: "pointer",
                textAlign: "center",
                transition: "all 0.15s ease"
              }}
            >
              {m.label}
            </button>
          );
        })}
      </div>

      {/* Source Video Input */}
      <div style={{ marginBottom: 12 }}>
        <label style={{ display: "block", fontSize: 11, color: "var(--text-muted, #94a3b8)", marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>
          Source Video (4s – 30s)
        </label>
        <input
          type="text"
          value={sourceVideo || ""}
          onChange={e => onSourceVideoChange(e.target.value)}
          placeholder="https://... source video URL (mp4 / webm)"
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "10px 12px",
            fontSize: 12,
            background: "rgba(0, 0, 0, 0.25)",
            border: "1px solid rgba(255, 255, 255, 0.1)",
            borderRadius: 8,
            color: "var(--text-primary, #ffffff)",
            outline: "none"
          }}
        />
        <div style={{ fontSize: 10, color: "var(--text-muted, #64748b)", marginTop: 4 }}>
          Must be 4 to 30 seconds. Longer videos are trimmed automatically.
        </div>
      </div>

      {/* Mode-Specific Controls */}
      {mode === "restyle" ? (
        <div style={{ marginBottom: 12 }}>
          <label style={{ display: "block", fontSize: 11, color: "var(--text-muted, #94a3b8)", marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>
            Artistic Style Preset
          </label>
          <select
            value={selectedPreset || ""}
            onChange={e => onPresetChange(e.target.value)}
            disabled={loadingPresets}
            style={{
              width: "100%",
              padding: "10px 12px",
              fontSize: 12,
              background: "rgba(15, 23, 42, 0.8)",
              border: "1px solid rgba(255, 255, 255, 0.1)",
              borderRadius: 8,
              color: "var(--text-primary, #ffffff)",
              outline: "none"
            }}
          >
            {loadingPresets ? (
              <option>Loading style presets...</option>
            ) : presets.length > 0 ? (
              presets.map(p => (
                <option key={p.id} value={p.id}>{p.name || p.id}</option>
              ))
            ) : (
              <option value="anime_classic">Anime Classic (Default)</option>
            )}
          </select>
        </div>
      ) : (
        <div style={{ marginBottom: 12 }}>
          <label style={{ display: "block", fontSize: 11, color: "var(--text-muted, #94a3b8)", marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>
            Reference Image URLs (1 to 8 images, comma-separated)
          </label>
          <textarea
            rows={2}
            value={Array.isArray(refImages) ? refImages.join(", ") : (refImages || "")}
            onChange={e => {
              const urls = e.target.value.split(",").map(s => s.trim()).filter(Boolean);
              onRefImagesChange(urls);
            }}
            placeholder="https://...image1.png, https://...image2.png"
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: "10px 12px",
              fontSize: 12,
              background: "rgba(0, 0, 0, 0.25)",
              border: "1px solid rgba(255, 255, 255, 0.1)",
              borderRadius: 8,
              color: "var(--text-primary, #ffffff)",
              outline: "none",
              resize: "vertical"
            }}
          />
          <div style={{ fontSize: 10, color: "var(--text-muted, #64748b)", marginTop: 4 }}>
            Characters or objects to map onto the source video motion.
          </div>
        </div>
      )}

      {/* Resolution & Prompt */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 10, marginBottom: 12 }}>
        <div>
          <label style={{ display: "block", fontSize: 11, color: "var(--text-muted, #94a3b8)", marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>
            Resolution
          </label>
          <select
            value={resolution || "720p"}
            onChange={e => onResolutionChange(e.target.value)}
            style={{
              width: "100%",
              padding: "9px 10px",
              fontSize: 12,
              background: "rgba(15, 23, 42, 0.8)",
              border: "1px solid rgba(255, 255, 255, 0.1)",
              borderRadius: 8,
              color: "var(--text-primary, #ffffff)",
              outline: "none"
            }}
          >
            <option value="480p">480p ($0.15/s)</option>
            <option value="720p">720p ($0.34/s)</option>
            <option value="1080p">1080p ($0.83/s)</option>
          </select>
        </div>
        <div>
          <label style={{ display: "block", fontSize: 11, color: "var(--text-muted, #94a3b8)", marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>
            Guidance Prompt (Optional)
          </label>
          <input
            type="text"
            value={prompt || ""}
            onChange={e => onPromptChange(e.target.value)}
            placeholder="Style or motion instructions..."
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: "9px 12px",
              fontSize: 12,
              background: "rgba(0, 0, 0, 0.25)",
              border: "1px solid rgba(255, 255, 255, 0.1)",
              borderRadius: 8,
              color: "var(--text-primary, #ffffff)",
              outline: "none"
            }}
          />
        </div>
      </div>
    </div>
  );
}
