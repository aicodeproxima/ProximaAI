import { useLayoutEffect } from "react";
import { getThemePalette } from "./themes.js";

/**
 * useTheme — applies the selected theme as CSS custom properties on the
 * document root. Call once in the top-level component:
 *   useTheme({ theme: 'midnight', lightMode: false })
 *
 * Sets BOTH generic theme vars (--bg, --text, --accent, etc.) AND ProximaAI's
 * pre-existing variable names (--bg-deep, --text-primary, --accent, etc.) so
 * the entire app re-skins with no additional refactoring.
 */
export default function useTheme(settings) {
  useLayoutEffect(() => {
    if (!settings) return;
    const palette = getThemePalette(settings.theme || "default", !!settings.lightMode);
    const root = document.documentElement;

    // Generic theme vars (for new components and the background layer)
    Object.entries(palette).forEach(([k, v]) => {
      root.style.setProperty(`--${camelToKebab(k)}`, v);
    });

    // Map to ProximaAI's pre-existing CSS variable names so the whole app
    // (all inline styles referencing var(--accent), var(--bg-deep), etc.)
    // re-skins instantly without touching every component.
    root.style.setProperty("--bg-deep", palette.bg);
    root.style.setProperty("--bg-card", palette.cardBg);
    root.style.setProperty("--bg-hover", palette.surfaceHover);
    root.style.setProperty("--bg-input", palette.inputBg);
    root.style.setProperty("--border", palette.border);
    root.style.setProperty("--border-focus", palette.accent);
    root.style.setProperty("--text-primary", palette.text);
    root.style.setProperty("--text-secondary", palette.textSecondary);
    root.style.setProperty("--text-muted", palette.textMuted);
    root.style.setProperty("--accent", palette.accent);
    root.style.setProperty("--accent-glow", palette.accentGlow || `${palette.accent}29`);
    root.style.setProperty("--glass", palette.cardBg);
    root.style.setProperty("--glass-border", palette.border);

    root.style.colorScheme = settings.lightMode ? "light" : "dark";
  }, [settings?.theme, settings?.lightMode]);
}

function camelToKebab(s) {
  return s.replace(/([A-Z])/g, "-$1").toLowerCase();
}
