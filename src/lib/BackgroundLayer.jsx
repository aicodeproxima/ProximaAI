import { useEffect, useMemo, useRef } from "react";

/**
 * BackgroundLayer — animated app background for ProximaAI.
 *   type: 'orbs' | 'stars' | 'matrix' | 'grid' | 'none'
 *   accent: hex color used to tint each effect (e.g. theme accent)
 */
export default function BackgroundLayer({ type = "orbs", accent = "#6366f1" }) {
  if (type === "none") return null;
  if (type === "stars")  return <Stars accent={accent} />;
  if (type === "matrix") return <Matrix accent={accent} />;
  if (type === "grid")   return <Grid accent={accent} />;
  return <Orbs accent={accent} />;
}

// ── Orbs: two floating radial-gradient blobs ───────────────────────────────
function Orbs({ accent }) {
  return (
    <div style={BASE}>
      <style>{KF_ORB_FLOAT}</style>
      <div style={{ position:"absolute", width:"min(380px, 80vw)", height:"min(380px, 80vw)", borderRadius:"50%", top:-120, left:"min(-100px, -20vw)", background:`radial-gradient(circle, ${accent}30 0%, transparent 65%)`, animation:"orbFloat 9s ease-in-out infinite" }} />
      <div style={{ position:"absolute", width:"min(260px, 60vw)", height:"min(260px, 60vw)", borderRadius:"50%", bottom:120, right:"min(-60px, -15vw)", background:`radial-gradient(circle, ${accent}26 0%, transparent 65%)`, animation:"orbFloat 13s ease-in-out infinite reverse" }} />
    </div>
  );
}

// ── Stars: 70 random twinkling dots ────────────────────────────────────────
function Stars({ accent }) {
  const stars = useMemo(() => Array.from({ length: 70 }, () => ({
    x: Math.random() * 100,
    y: Math.random() * 100,
    size: 1 + Math.random() * 2.2,
    delay: Math.random() * 4,
    dur: 2 + Math.random() * 4,
    tiny: Math.random() > 0.7,
  })), []);
  return (
    <div style={BASE}>
      <style>{`@keyframes starTwinkle{0%,100%{opacity:.15;transform:scale(1)}50%{opacity:1;transform:scale(1.25)}}`}</style>
      {stars.map((s, i) => (
        <div key={i} style={{
          position: "absolute",
          left: s.x + "%",
          top: s.y + "%",
          width: s.size,
          height: s.size,
          borderRadius: "50%",
          background: s.tiny ? "#ffffff" : accent,
          boxShadow: `0 0 ${s.size * 3}px ${s.tiny ? "#ffffff88" : accent + "aa"}`,
          animation: `starTwinkle ${s.dur}s ease-in-out ${s.delay}s infinite`,
        }} />
      ))}
    </div>
  );
}

// ── Matrix: falling katakana on a canvas ───────────────────────────────────
function Matrix({ accent }) {
  const canvasRef = useRef(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const chars = "アイウエオカキクケコサシスセソタチツテトナニヌネノ01";
    let w, h, cols, drops, raf;
    const resize = () => {
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cols = Math.max(1, Math.floor(w / 14));
      drops = new Array(cols).fill(0).map(() => Math.random() * -60);
    };
    resize();
    window.addEventListener("resize", resize);
    let last = 0;
    const draw = (t) => {
      if (t - last < 55) { raf = requestAnimationFrame(draw); return; }
      last = t;
      ctx.fillStyle = "rgba(0,0,0,0.09)";
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = accent;
      ctx.font = '13px "JetBrains Mono", "Fira Code", monospace';
      for (let i = 0; i < cols; i++) {
        const ch = chars[Math.floor(Math.random() * chars.length)];
        ctx.fillText(ch, i * 14, drops[i] * 14);
        if (drops[i] * 14 > h && Math.random() > 0.975) drops[i] = 0;
        drops[i]++;
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", resize); };
  }, [accent]);
  return <canvas ref={canvasRef} style={{ ...BASE, opacity: 0.35, width: "100%", height: "100%" }} />;
}

// ── Grid: pulsing radial-masked grid lines ─────────────────────────────────
function Grid({ accent }) {
  return (
    <div style={{
      ...BASE,
      backgroundImage: `linear-gradient(${accent}33 1px, transparent 1px), linear-gradient(90deg, ${accent}33 1px, transparent 1px)`,
      backgroundSize: "36px 36px",
      animation: "gridPulse 6s ease-in-out infinite",
      maskImage: "radial-gradient(ellipse at center, black 35%, transparent 85%)",
      WebkitMaskImage: "radial-gradient(ellipse at center, black 35%, transparent 85%)",
    }}>
      <style>{`@keyframes gridPulse{0%,100%{opacity:.25}50%{opacity:.55}}`}</style>
    </div>
  );
}

const BASE = { position: "fixed", inset: 0, pointerEvents: "none", zIndex: 0, overflow: "hidden" };
const KF_ORB_FLOAT = `@keyframes orbFloat{0%,100%{transform:translate(0,0) scale(1)}33%{transform:translate(18px,-14px) scale(1.05)}66%{transform:translate(-14px,8px) scale(.95)}}`;
