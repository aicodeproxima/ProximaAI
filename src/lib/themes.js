/**
 * Mission Control theme system (adapted for ProximaAI).
 *
 * Each palette key is converted by useTheme.js to a kebab-case CSS custom
 * property on document.documentElement (e.g. surfaceHover -> --surface-hover).
 * ProximaAI's pre-existing --accent variable is also mapped from the theme.
 */

export const THEMES = {
  default:  { name: 'Indigo Void',    bg: '#020510', surface: '#0d0d1a', accent: '#6366f1' },
  purple:   { name: 'Dark Purple',    bg: '#050508', surface: '#0d0d1a', accent: '#8b5cf6' },
  midnight: { name: 'Midnight Blue',  bg: '#020510', surface: '#080d1a', accent: '#3b82f6' },
  crimson:  { name: 'Deep Crimson',   bg: '#080205', surface: '#150508', accent: '#ef4444' },
  forest:   { name: 'Forest Dark',    bg: '#020805', surface: '#050d06', accent: '#10b981' },
  gold:     { name: 'Obsidian Gold',  bg: '#080600', surface: '#120e00', accent: '#f59e0b' },
};

// Full dark palettes — applied as CSS variables
export const DARK_PALETTES = {
  default: {
    bg:'#020510', surface:'#0d0d1a', surfaceHover:'rgba(26,16,40,0.35)',
    text:'#e2e8f0', textSecondary:'#94a3b8', textMuted:'#64748b', textDisabled:'#475569', textFaint:'#334155',
    border:'rgba(99,102,241,0.12)', borderHover:'rgba(99,102,241,0.28)',
    cardBg:'rgba(10,14,28,0.18)', inputBg:'rgba(10,20,40,0.22)',
    navBg:'rgba(5,8,22,0.35)', modalBg:'rgba(8,12,25,0.92)',
    accent:'#6366f1', accentGlow:'rgba(99,102,241,0.15)',
  },
  purple: {
    bg:'#050508', surface:'#0d0d1a', surfaceHover:'rgba(26,16,40,0.35)',
    text:'#e8e0f0', textSecondary:'#9985b5', textMuted:'#8a7aa8', textDisabled:'#8878c0', textFaint:'#9b8fc0',
    border:'rgba(139,92,246,0.14)', borderHover:'rgba(139,92,246,0.3)',
    cardBg:'rgba(18,12,32,0.2)', inputBg:'rgba(20,14,40,0.22)',
    navBg:'rgba(4,4,10,0.4)', modalBg:'rgba(13,13,26,0.92)',
    accent:'#8b5cf6', accentGlow:'rgba(139,92,246,0.18)',
  },
  midnight: {
    bg:'#020510', surface:'#080d1a', surfaceHover:'rgba(14,21,40,0.35)',
    text:'#dce6f8', textSecondary:'#95a9c5', textMuted:'#7a8fa8', textDisabled:'#7890c0', textFaint:'#8ba0c8',
    border:'rgba(59,130,246,0.14)', borderHover:'rgba(59,130,246,0.3)',
    cardBg:'rgba(12,18,35,0.2)', inputBg:'rgba(12,22,42,0.22)',
    navBg:'rgba(2,5,16,0.4)', modalBg:'rgba(8,13,26,0.92)',
    accent:'#3b82f6', accentGlow:'rgba(59,130,246,0.18)',
  },
  crimson: {
    bg:'#080205', surface:'#150508', surfaceHover:'rgba(32,16,21,0.35)',
    text:'#f0e0e4', textSecondary:'#c59aa5', textMuted:'#a57f88', textDisabled:'#c07888', textFaint:'#c88b98',
    border:'rgba(239,68,68,0.14)', borderHover:'rgba(239,68,68,0.3)',
    cardBg:'rgba(32,14,20,0.2)', inputBg:'rgba(36,16,22,0.22)',
    navBg:'rgba(8,2,5,0.4)', modalBg:'rgba(21,5,8,0.92)',
    accent:'#ef4444', accentGlow:'rgba(239,68,68,0.18)',
  },
  forest: {
    bg:'#020805', surface:'#050d06', surfaceHover:'rgba(14,26,16,0.35)',
    text:'#e0f0e4', textSecondary:'#95c5a0', textMuted:'#7fa588', textDisabled:'#78c088', textFaint:'#8bc898',
    border:'rgba(16,185,129,0.16)', borderHover:'rgba(16,185,129,0.32)',
    cardBg:'rgba(12,26,18,0.2)', inputBg:'rgba(14,30,20,0.22)',
    navBg:'rgba(2,8,5,0.4)', modalBg:'rgba(5,13,6,0.92)',
    accent:'#10b981', accentGlow:'rgba(16,185,129,0.18)',
  },
  gold: {
    bg:'#080600', surface:'#120e00', surfaceHover:'rgba(30,26,10,0.35)',
    text:'#f0ece0', textSecondary:'#c5b595', textMuted:'#a5987f', textDisabled:'#c0b078', textFaint:'#c8b88b',
    border:'rgba(245,158,11,0.16)', borderHover:'rgba(245,158,11,0.32)',
    cardBg:'rgba(30,26,10,0.2)', inputBg:'rgba(32,28,12,0.22)',
    navBg:'rgba(8,6,0,0.4)', modalBg:'rgba(18,14,0,0.92)',
    accent:'#f59e0b', accentGlow:'rgba(245,158,11,0.18)',
  },
};

// Light-mode overrides — accent stays from theme, everything else flips
export const LIGHT_OVERRIDES = {
  bg:'#f5f3f7', surface:'#ffffff', surfaceHover:'#eee8f4',
  text:'#1a1528', textSecondary:'#5a4f6b', textMuted:'#8578a0', textDisabled:'#a99ec0', textFaint:'#c8c0d8',
  border:'rgba(0,0,0,0.1)', borderHover:'rgba(0,0,0,0.18)',
  cardBg:'rgba(255,255,255,0.85)', inputBg:'rgba(0,0,0,0.04)',
  navBg:'rgba(245,243,247,0.95)', modalBg:'#ffffff',
};

export function getThemePalette(themeKey, isLightMode) {
  const dark = DARK_PALETTES[themeKey] || DARK_PALETTES.default;
  if (!isLightMode) return dark;
  return { ...dark, ...LIGHT_OVERRIDES };
}

export const BACKGROUNDS = ['orbs', 'stars', 'matrix', 'grid', 'none'];
