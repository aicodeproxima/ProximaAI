import { useState, useEffect, useRef, useCallback, useReducer } from "react";
import { MODELS, TYPE_LABELS, TYPE_ICONS, PROVIDER_COLORS } from "./config/models.js";
import { buildPayload } from "./lib/payloadBuilder.js";
import { submitTask, pollResult, checkBalance, uploadMedia, API_BASE, proxiedFetch } from "./lib/api.js";
import { getSetting, setSetting, addHistoryEntry, getHistory, clearHistory, migrateFromLocalStorage } from "./lib/storage.js";
import { initSupabase, syncHistoryEntry } from "./lib/supabase.js";

// ─── STYLES ───
const font = `'JetBrains Mono', 'Fira Code', monospace`;
const fontBody = `'DM Sans', 'Segoe UI', sans-serif`;

const css = `
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&family=JetBrains+Mono:wght@300;400;500;700&display=swap');

* { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg-deep: #020510; --bg-card: rgba(12,18,35,0.08); --bg-hover: rgba(30,41,59,0.08); --bg-input: rgba(10,20,40,0.1);
  --border: rgba(56,68,100,0.15); --border-focus: #6366f1;
  --text-primary: #e2e8f0; --text-secondary: #94a3b8; --text-muted: #64748b;
  --accent: #6366f1; --accent-glow: rgba(99,102,241,0.15);
  --success: #22c55e; --warning: #f59e0b; --error: #ef4444;
  --amber: #f59e0b; --amber-glow: rgba(245,158,11,0.08);
  --glass: rgba(10,15,30,0.07); --glass-border: rgba(99,102,241,0.08);
}

body { background: var(--bg-deep); color: var(--text-primary); font-family: ${fontBody}; }

/* Space background */
.prism-app { display: flex; height: 100vh; overflow: hidden; position: relative; background:
  radial-gradient(ellipse at 15% 30%, rgba(120,40,200,0.2) 0%, transparent 45%),
  radial-gradient(ellipse at 85% 15%, rgba(59,130,246,0.18) 0%, transparent 40%),
  radial-gradient(ellipse at 50% 85%, rgba(6,182,212,0.12) 0%, transparent 45%),
  radial-gradient(ellipse at 70% 60%, rgba(168,85,247,0.1) 0%, transparent 35%),
  radial-gradient(ellipse at 25% 75%, rgba(236,72,153,0.08) 0%, transparent 40%),
  radial-gradient(ellipse at 90% 80%, rgba(34,211,238,0.06) 0%, transparent 30%),
  radial-gradient(ellipse at 40% 20%, rgba(99,102,241,0.12) 0%, transparent 35%),
  radial-gradient(circle at 60% 40%, rgba(139,92,246,0.06) 0%, transparent 25%),
  #020510; }

/* Star layers */
.prism-app::before, .prism-app::after { content: ''; position: absolute; inset: 0; pointer-events: none; }
.prism-app::before { z-index: 0; background-image:
  radial-gradient(1px 1px at 2% 8%, #fff 50%, transparent 50%), radial-gradient(1px 1px at 5% 22%, rgba(255,255,255,0.6) 50%, transparent 50%),
  radial-gradient(1.5px 1.5px at 8% 45%, rgba(167,139,250,0.9) 50%, transparent 50%), radial-gradient(1px 1px at 11% 67%, #fff 50%, transparent 50%),
  radial-gradient(1px 1px at 14% 88%, rgba(255,255,255,0.5) 50%, transparent 50%), radial-gradient(2px 2px at 17% 12%, rgba(196,181,253,0.8) 50%, transparent 50%),
  radial-gradient(1px 1px at 20% 35%, rgba(255,255,255,0.7) 50%, transparent 50%), radial-gradient(1px 1px at 23% 58%, rgba(255,255,255,0.4) 50%, transparent 50%),
  radial-gradient(1.5px 1.5px at 26% 78%, rgba(129,140,248,0.8) 50%, transparent 50%), radial-gradient(1px 1px at 29% 5%, #fff 50%, transparent 50%),
  radial-gradient(1px 1px at 32% 42%, rgba(255,255,255,0.5) 50%, transparent 50%), radial-gradient(2px 2px at 35% 70%, rgba(167,139,250,0.7) 50%, transparent 50%),
  radial-gradient(1px 1px at 38% 92%, rgba(255,255,255,0.6) 50%, transparent 50%), radial-gradient(1px 1px at 41% 18%, rgba(255,255,255,0.4) 50%, transparent 50%),
  radial-gradient(1.5px 1.5px at 44% 52%, #fff 50%, transparent 50%), radial-gradient(1px 1px at 47% 30%, rgba(165,180,252,0.7) 50%, transparent 50%),
  radial-gradient(1px 1px at 50% 75%, rgba(255,255,255,0.5) 50%, transparent 50%), radial-gradient(2px 2px at 53% 10%, rgba(196,181,253,0.9) 50%, transparent 50%),
  radial-gradient(1px 1px at 56% 48%, rgba(255,255,255,0.6) 50%, transparent 50%), radial-gradient(1px 1px at 59% 85%, #fff 50%, transparent 50%),
  radial-gradient(1.5px 1.5px at 62% 25%, rgba(129,140,248,0.8) 50%, transparent 50%), radial-gradient(1px 1px at 65% 62%, rgba(255,255,255,0.4) 50%, transparent 50%),
  radial-gradient(1px 1px at 68% 3%, rgba(255,255,255,0.7) 50%, transparent 50%), radial-gradient(2px 2px at 71% 38%, rgba(167,139,250,0.7) 50%, transparent 50%),
  radial-gradient(1px 1px at 74% 55%, rgba(255,255,255,0.5) 50%, transparent 50%), radial-gradient(1px 1px at 77% 80%, rgba(255,255,255,0.6) 50%, transparent 50%),
  radial-gradient(1.5px 1.5px at 80% 15%, #fff 50%, transparent 50%), radial-gradient(1px 1px at 83% 95%, rgba(165,180,252,0.6) 50%, transparent 50%),
  radial-gradient(1px 1px at 86% 40%, rgba(255,255,255,0.4) 50%, transparent 50%), radial-gradient(2px 2px at 89% 65%, rgba(196,181,253,0.8) 50%, transparent 50%),
  radial-gradient(1px 1px at 92% 22%, rgba(255,255,255,0.7) 50%, transparent 50%), radial-gradient(1px 1px at 95% 50%, #fff 50%, transparent 50%),
  radial-gradient(1.5px 1.5px at 98% 78%, rgba(129,140,248,0.7) 50%, transparent 50%), radial-gradient(1px 1px at 3% 55%, rgba(255,255,255,0.3) 50%, transparent 50%),
  radial-gradient(1px 1px at 7% 33%, rgba(255,255,255,0.5) 50%, transparent 50%), radial-gradient(1px 1px at 13% 77%, rgba(255,255,255,0.4) 50%, transparent 50%),
  radial-gradient(1.5px 1.5px at 18% 50%, rgba(167,139,250,0.6) 50%, transparent 50%), radial-gradient(1px 1px at 24% 15%, rgba(255,255,255,0.7) 50%, transparent 50%),
  radial-gradient(1px 1px at 31% 60%, rgba(255,255,255,0.3) 50%, transparent 50%), radial-gradient(1px 1px at 37% 28%, rgba(255,255,255,0.5) 50%, transparent 50%),
  radial-gradient(2px 2px at 43% 82%, rgba(165,180,252,0.7) 50%, transparent 50%), radial-gradient(1px 1px at 48% 45%, rgba(255,255,255,0.4) 50%, transparent 50%),
  radial-gradient(1px 1px at 54% 68%, rgba(255,255,255,0.6) 50%, transparent 50%), radial-gradient(1.5px 1.5px at 61% 7%, rgba(196,181,253,0.8) 50%, transparent 50%),
  radial-gradient(1px 1px at 67% 90%, rgba(255,255,255,0.5) 50%, transparent 50%), radial-gradient(1px 1px at 73% 20%, rgba(255,255,255,0.3) 50%, transparent 50%),
  radial-gradient(1px 1px at 79% 48%, rgba(255,255,255,0.6) 50%, transparent 50%), radial-gradient(2px 2px at 84% 72%, rgba(129,140,248,0.7) 50%, transparent 50%),
  radial-gradient(1px 1px at 91% 35%, rgba(255,255,255,0.4) 50%, transparent 50%), radial-gradient(1px 1px at 97% 60%, rgba(255,255,255,0.5) 50%, transparent 50%);
  animation: starTwinkle 8s ease-in-out infinite alternate; }

/* Nebula / galaxy overlay + shooting star */
.prism-app::after { z-index: 0;
  background:
    radial-gradient(ellipse 300px 200px at 75% 25%, rgba(139,92,246,0.12) 0%, transparent 70%),
    radial-gradient(ellipse 250px 150px at 20% 70%, rgba(236,72,153,0.08) 0%, transparent 70%),
    radial-gradient(ellipse 400px 100px at 50% 50%, rgba(99,102,241,0.05) 0%, transparent 70%),
    radial-gradient(circle 3px at 82% 18%, rgba(255,255,255,0.9) 0%, rgba(165,180,252,0.4) 40%, transparent 70%),
    radial-gradient(circle 2px at 15% 35%, rgba(255,200,150,0.8) 0%, rgba(251,146,60,0.3) 50%, transparent 70%),
    radial-gradient(circle 4px at 55% 12%, rgba(56,189,248,0.5) 0%, rgba(56,189,248,0.1) 60%, transparent 70%);
  animation: nebulaShift 20s ease-in-out infinite alternate; }
@keyframes starTwinkle { 0% { opacity: 0.6; } 33% { opacity: 1; } 66% { opacity: 0.8; } 100% { opacity: 0.95; } }
@keyframes nebulaShift { 0% { opacity: 0.8; transform: scale(1); } 50% { opacity: 1; transform: scale(1.02); } 100% { opacity: 0.9; transform: scale(0.99); } }
.prism-app > * { position: relative; z-index: 1; }

.sidebar { width: 56px; background: rgba(5,8,22,0.12); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); border-right: 1px solid var(--glass-border); display: flex; flex-direction: column; align-items: center; padding: 12px 0; gap: 4px; flex-shrink: 0; }
.sidebar-btn { width: 40px; height: 40px; border: none; background: transparent; color: var(--text-muted); border-radius: 10px; cursor: pointer; font-size: 18px; display: flex; align-items: center; justify-content: center; transition: all 0.3s cubic-bezier(0.4,0,0.2,1); }
.sidebar-btn:hover { background: rgba(99,102,241,0.1); color: var(--text-primary); transform: scale(1.1); }
.sidebar-btn:active { transform: scale(0.95); }
.sidebar-btn.active { background: rgba(99,102,241,0.15); color: var(--accent); border: 1px solid rgba(99,102,241,0.3); box-shadow: 0 0 12px rgba(99,102,241,0.2); }
.sidebar-logo { font-size: 22px; margin-bottom: 16px; cursor: default; }

.main { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-width: 0; }
.topbar { height: 48px; border-bottom: 1px solid var(--glass-border); display: flex; align-items: center; justify-content: space-between; padding: 0 20px; flex-shrink: 0; background: rgba(5,8,22,0.1); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); }
.topbar-title { font-family: ${font}; font-size: 13px; font-weight: 600; letter-spacing: 0.5px; color: var(--text-secondary); }
.balance-pill { font-family: ${font}; font-size: 12px; color: var(--success); background: rgba(34,197,94,0.1); border: 1px solid rgba(34,197,94,0.2); padding: 4px 10px; border-radius: 20px; }

.content { flex: 1; overflow-y: auto; padding: 20px; }

/* Cockpit */
.cockpit { display: grid; grid-template-columns: 340px 1fr; gap: 20px; height: 100%; }
.cockpit-left { display: flex; flex-direction: column; gap: 16px; overflow-y: auto; padding-right: 8px; }
.cockpit-right { overflow-y: auto; }

.card { background: rgba(8,12,25,0.45); border: 1px solid var(--glass-border); border-radius: 14px; padding: 16px; transition: border-color 0.3s, box-shadow 0.3s; }
.card:hover { border-color: rgba(99,102,241,0.25); box-shadow: 0 4px 24px rgba(99,102,241,0.06); }
.card-title { font-family: ${font}; font-size: 11px; font-weight: 600; color: var(--text-muted); letter-spacing: 1px; text-transform: uppercase; margin-bottom: 10px; }

.type-tabs { display: flex; gap: 4px; background: rgba(10,20,40,0.08); border: 1px solid var(--glass-border); border-radius: 12px; padding: 3px; }
.type-tab { flex: 1; padding: 8px 6px; border: none; background: transparent; color: var(--text-muted); font-size: 12px; font-family: ${fontBody}; font-weight: 500; border-radius: 9px; cursor: pointer; transition: all 0.3s cubic-bezier(0.4,0,0.2,1); white-space: nowrap; }
.type-tab:hover { color: var(--text-secondary); background: rgba(99,102,241,0.08); }
.type-tab:active { transform: scale(0.97); }
.type-tab.active { background: linear-gradient(135deg, #6366f1, #8b5cf6); color: white; box-shadow: 0 2px 12px rgba(99,102,241,0.3); }

.prompt-area { width: 100%; min-height: 90px; background: rgba(8,12,25,0.4); border: 1px solid var(--glass-border); border-radius: 10px; padding: 12px; color: var(--text-primary); font-family: ${fontBody}; font-size: 14px; resize: vertical; outline: none; transition: border-color 0.3s, box-shadow 0.3s; }
.prompt-area:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(99,102,241,0.1), 0 0 20px rgba(99,102,241,0.08); }
.prompt-area::placeholder { color: var(--text-muted); }

.model-grid { display: flex; flex-direction: column; gap: 4px; max-height: 240px; overflow-y: auto; }
.model-item { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-radius: 8px; cursor: pointer; transition: all 0.25s cubic-bezier(0.4,0,0.2,1); border: 1px solid transparent; }
.model-item:hover { background: rgba(99,102,241,0.06); border-color: rgba(99,102,241,0.1); }
.model-item:active { transform: scale(0.98); }
.model-item.selected { background: rgba(99,102,241,0.1); border-color: rgba(99,102,241,0.25); box-shadow: 0 0 12px rgba(99,102,241,0.08); }
.model-check { width: 16px; height: 16px; border-radius: 4px; border: 2px solid var(--text-muted); display: flex; align-items: center; justify-content: center; flex-shrink: 0; transition: all 0.25s cubic-bezier(0.4,0,0.2,1); font-size: 10px; }
.model-item.selected .model-check { background: linear-gradient(135deg, #6366f1, #8b5cf6); border-color: #6366f1; color: white; box-shadow: 0 0 8px rgba(99,102,241,0.4); }
.model-name { font-size: 13px; font-weight: 500; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-provider { font-size: 10px; font-family: ${font}; padding: 2px 6px; border-radius: 4px; font-weight: 500; }
.hot-badge { font-size: 9px; background: var(--error); color: white; padding: 1px 5px; border-radius: 3px; font-weight: 700; font-family: ${font}; }
.model-price { font-size: 11px; font-family: ${font}; color: var(--text-muted); }
.model-meta { display: contents; }

.settings-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.settings-row label { font-size: 11px; color: var(--text-muted); font-weight: 500; }
.settings-select, .settings-input { background: rgba(8,12,25,0.4); border: 1px solid var(--glass-border); border-radius: 6px; padding: 6px 8px; color: var(--text-primary); font-size: 12px; font-family: ${font}; outline: none; min-width: 70px; transition: border-color 0.3s, box-shadow 0.3s; }
.settings-select:focus, .settings-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(99,102,241,0.1); }

.gen-btn { width: 100%; padding: 12px; border: none; border-radius: 12px; font-family: ${font}; font-size: 14px; font-weight: 700; cursor: pointer; transition: all 0.35s cubic-bezier(0.4,0,0.2,1); letter-spacing: 0.5px; position: relative; overflow: hidden; }
.gen-btn.ready { background: linear-gradient(135deg, #6366f1, #8b5cf6, #a78bfa); color: white; box-shadow: 0 2px 12px rgba(99,102,241,0.25); }
.gen-btn.ready:hover { transform: translateY(-2px); box-shadow: 0 8px 30px rgba(99,102,241,0.4); }
.gen-btn.ready:active { transform: translateY(0) scale(0.98); }
.gen-btn.running { background: rgba(30,41,59,0.3); color: var(--warning); cursor: not-allowed; }
.gen-btn:disabled { opacity: 0.4; cursor: not-allowed; transform: none; box-shadow: none; }

.cost-bar { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: var(--amber-glow); border: 1px solid rgba(245,158,11,0.2); border-radius: 8px; font-size: 12px; }
.cost-bar .cost-amount { font-family: ${font}; color: var(--amber); font-weight: 600; }

/* Progress + Results */
.task-card { background: rgba(8,12,25,0.45); border: 1px solid var(--glass-border); border-radius: 14px; padding: 14px; margin-bottom: 12px; transition: border-color 0.3s; animation: fadeSlideIn 0.4s ease; }
.task-card:hover { border-color: rgba(99,102,241,0.2); }
@keyframes fadeSlideIn { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
.task-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.task-model { font-size: 13px; font-weight: 600; }
.task-status { font-size: 11px; font-family: ${font}; padding: 3px 8px; border-radius: 12px; font-weight: 600; }
.task-status.pending { background: rgba(148,163,184,0.1); color: var(--text-muted); }
.task-status.processing { background: rgba(99,102,241,0.1); color: var(--accent); }
.task-status.completed { background: rgba(34,197,94,0.1); color: var(--success); }
.task-status.failed { background: rgba(239,68,68,0.1); color: var(--error); }
.task-timer { font-family: ${font}; font-size: 12px; color: var(--text-muted); margin-top: 4px; }
.task-progress { height: 3px; background: var(--bg-input); border-radius: 2px; margin-top: 8px; overflow: hidden; }
.task-progress-fill { height: 100%; background: linear-gradient(90deg, #6366f1, #a78bfa); border-radius: 2px; transition: width 0.5s ease; box-shadow: 0 0 8px rgba(99,102,241,0.4); }

.result-img { width: 100%; border-radius: 8px; margin-top: 10px; cursor: pointer; transition: transform 0.2s; max-height: 300px; object-fit: cover; }
.result-img:hover { transform: scale(1.01); }
.result-video { width: 100%; border-radius: 8px; margin-top: 10px; max-height: 300px; }
.result-actions { display: flex; gap: 6px; margin-top: 8px; }
.result-action-btn { padding: 5px 10px; font-size: 11px; border-radius: 6px; border: 1px solid var(--glass-border); background: rgba(8,12,25,0.4); color: var(--text-secondary); cursor: pointer; font-family: ${font}; transition: all 0.25s cubic-bezier(0.4,0,0.2,1); }
.result-action-btn:hover { background: rgba(99,102,241,0.12); color: var(--text-primary); border-color: rgba(99,102,241,0.4); box-shadow: 0 2px 10px rgba(99,102,241,0.15); }
.result-action-btn:active { transform: scale(0.96); }

.results-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }

/* Logs */
.log-row { display: grid; grid-template-columns: 140px 1fr 120px 80px 80px 60px; gap: 8px; padding: 10px 12px; border-bottom: 1px solid rgba(56,68,100,0.2); font-size: 12px; align-items: center; cursor: pointer; transition: all 0.25s; }
.log-row:hover { background: rgba(99,102,241,0.05); }
.log-header { font-weight: 700; color: var(--text-muted); font-family: ${font}; font-size: 10px; letter-spacing: 0.5px; text-transform: uppercase; cursor: default; }
.log-header:hover { background: transparent; }
.log-prompt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-secondary); }
.log-models { font-family: ${font}; color: var(--text-muted); font-size: 11px; }
.log-cost { font-family: ${font}; color: var(--amber); }
.log-replay { padding: 3px 8px; font-size: 10px; border-radius: 4px; border: 1px solid var(--glass-border); background: transparent; color: var(--accent); cursor: pointer; font-family: ${font}; transition: all 0.25s; }
.log-replay:hover { background: rgba(99,102,241,0.12); border-color: rgba(99,102,241,0.3); }

/* Settings */
.setting-group { margin-bottom: 24px; }
.setting-label { font-size: 12px; font-weight: 600; color: var(--text-secondary); margin-bottom: 6px; }
.setting-input { width: 100%; background: rgba(8,12,25,0.4); border: 1px solid var(--glass-border); border-radius: 8px; padding: 10px 12px; color: var(--text-primary); font-family: ${font}; font-size: 13px; outline: none; transition: border-color 0.3s, box-shadow 0.3s; }
.setting-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(99,102,241,0.1), 0 0 20px rgba(99,102,241,0.06); }
.setting-hint { font-size: 11px; color: var(--text-muted); margin-top: 4px; }

.api-test-btn { padding: 8px 16px; background: linear-gradient(135deg, #6366f1, #8b5cf6); color: white; border: none; border-radius: 6px; font-family: ${font}; font-size: 12px; cursor: pointer; margin-top: 8px; transition: all 0.3s cubic-bezier(0.4,0,0.2,1); }
.api-test-btn:hover:not(:disabled) { box-shadow: 0 4px 16px rgba(99,102,241,0.35); transform: translateY(-1px); }
.api-test-btn:active:not(:disabled) { transform: scale(0.97); }
.api-test-btn:disabled { opacity: 0.5; cursor: not-allowed; }

/* Empty State */
.empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 300px; color: var(--text-muted); text-align: center; gap: 12px; }
.empty-state .emoji { font-size: 48px; }
.empty-state .msg { font-size: 14px; max-width: 300px; line-height: 1.5; }

/* Lightbox */
.lightbox { position: fixed; inset: 0; background: rgba(5,8,22,0.95); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); z-index: 1000; display: flex; align-items: center; justify-content: center; cursor: pointer; animation: fadeIn 0.25s ease; }
.lightbox img, .lightbox video { max-width: 92vw; max-height: 92vh; border-radius: 10px; box-shadow: 0 8px 40px rgba(0,0,0,0.5); }

/* Scrollbar */
::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: var(--text-muted); }

/* Animations */
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
@keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
@keyframes glowPulse { 0%,100% { box-shadow: 0 0 12px rgba(99,102,241,0.15); } 50% { box-shadow: 0 0 24px rgba(99,102,241,0.3); } }
.fade-in { animation: fadeIn 0.35s cubic-bezier(0.4,0,0.2,1); }
.pulse { animation: pulse 1.5s ease-in-out infinite; }
.content { animation: fadeIn 0.3s ease; }
.task-status.processing { animation: glowPulse 2s ease-in-out infinite; }

@media (max-width: 768px) {
  .prism-app { flex-direction: column; }
  .sidebar { width: 100%; flex-direction: row; padding: 0 8px; gap: 2px; border-right: none; border-bottom: 1px solid var(--glass-border); overflow-x: auto; flex-shrink: 0; height: 52px; justify-content: center; background: rgba(5,8,22,0.12); }
  .sidebar-logo { margin-bottom: 0; margin-right: 8px; font-size: 18px; }
  .sidebar-btn { width: 44px; height: 44px; font-size: 20px; }

  .topbar { height: 44px; padding: 0 16px; }
  .topbar-title { font-size: 11px; }

  .content { padding: 16px; }

  .cockpit { grid-template-columns: 1fr; gap: 16px; height: auto; }
  .cockpit-left { padding-right: 0; gap: 14px; }

  .type-tabs { gap: 4px; padding: 4px; border-radius: 12px; overflow-x: auto; flex-wrap: nowrap; -webkit-overflow-scrolling: touch; scrollbar-width: none; }
  .type-tabs::-webkit-scrollbar { display: none; }
  .type-tab { padding: 10px 12px; font-size: 13px; border-radius: 10px; flex: 0 0 auto; }

  .card { padding: 18px; border-radius: 14px; }
  .card-title { font-size: 12px; margin-bottom: 12px; }

  .prompt-area { min-height: 100px; padding: 14px; font-size: 16px; border-radius: 12px; }

  .model-grid { max-height: 280px; gap: 6px; }
  .model-item { padding: 14px; border-radius: 12px; gap: 0; flex-wrap: wrap; align-items: flex-start; }
  .model-check { width: 22px; height: 22px; border-radius: 6px; font-size: 13px; margin-right: 12px; margin-top: 1px; }
  .model-name { font-size: 15px; white-space: normal; overflow: visible; text-overflow: unset; flex: 1; min-width: calc(100% - 36px); }
  .model-meta { display: flex; align-items: center; gap: 8px; width: 100%; padding-left: 34px; margin-top: 6px; }
  .model-provider { font-size: 11px; padding: 3px 8px; border-radius: 5px; }
  .hot-badge { font-size: 10px; padding: 2px 6px; border-radius: 4px; }
  .model-price { font-size: 13px; margin-left: auto; }

  .settings-row { gap: 10px; }
  .settings-row label { font-size: 13px; }
  .settings-select, .settings-input { padding: 10px 12px; font-size: 14px; border-radius: 8px; min-width: 80px; }

  .gen-btn { padding: 16px; font-size: 16px; border-radius: 14px; }

  .cost-bar { padding: 12px 16px; font-size: 14px; border-radius: 10px; }

  .task-card { padding: 16px; border-radius: 14px; margin-bottom: 14px; }
  .task-model { font-size: 15px; }
  .task-status { font-size: 12px; padding: 4px 10px; }
  .task-timer { font-size: 13px; }

  .result-img { border-radius: 10px; max-height: 400px; }
  .result-video { border-radius: 10px; max-height: 400px; }
  .result-actions { gap: 8px; margin-top: 12px; flex-wrap: wrap; }
  .result-action-btn { padding: 10px 14px; font-size: 13px; border-radius: 8px; }

  .results-grid { grid-template-columns: 1fr; gap: 14px; }

  .log-row { grid-template-columns: 1fr 60px 50px; gap: 6px; padding: 12px 14px; font-size: 13px; }
  .log-row > :nth-child(1) { display: none; }
  .log-row > :nth-child(5), .log-row > :nth-child(6) { display: none; }
  .log-header > :nth-child(1) { display: none; }

  .setting-group { margin-bottom: 28px; }
  .setting-label { font-size: 14px; margin-bottom: 8px; }
  .setting-input { padding: 14px 16px; font-size: 15px; border-radius: 10px; }
  .setting-hint { font-size: 13px; margin-top: 6px; }
  .api-test-btn { padding: 12px 20px; font-size: 14px; border-radius: 8px; }

  .empty-state { height: 200px; }
  .empty-state .emoji { font-size: 40px; }
  .empty-state .msg { font-size: 15px; }
}
`;

// ─── HELPERS ───
function genId() { return typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }
function formatTime(ms) {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  return s >= 60 ? `${(s / 60).toFixed(1)}m` : `${s.toFixed(1)}s`;
}
function formatCost(c) { return `$${c.toFixed(4)}`; }
function timeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

// ─── API SERVICE ───
// ─── MAIN APP ───
export default function PrismApp() {
  const [page, setPage] = useState("cockpit");
  const [apiKey, setApiKey] = useState("");
  const [balance, setBalance] = useState(null);
  const [genType, setGenType] = useState("image");
  const [selectedModels, setSelectedModels] = useState([]);
  const [prompt, setPrompt] = useState("");
  const [negPrompt, setNegPrompt] = useState("");
  const [resolution, setResolution] = useState("1k");
  const [duration, setDuration] = useState(5);
  const [seed, setSeed] = useState("-1");
  const [aspectRatio, setAspectRatio] = useState("auto");
  const [perModelRes, setPerModelRes] = useState({});
  const [sourceImageUrl, setSourceImageUrl] = useState("");
  const [sourcePreview, setSourcePreview] = useState("");
  const [uploadStatus, setUploadStatus] = useState(""); // "" | "uploading" | "done" | "error"
  const [testStatus, setTestStatus] = useState(null); // null | "testing" | {ok, msg}
  const fileInputRef = useRef(null);
  const [tasks, setTasks] = useState([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [logs, setLogs] = useState([]);
  const [lightbox, setLightbox] = useState(null);
  const [defaultImageRes, setDefaultImageRes] = useState("1k");
  const [defaultVideoDur, setDefaultVideoDur] = useState(5);
  const [activeCount, setActiveCount] = useState(0);
  const pollRefs = useRef({});
  const savedLogIds = useRef(new Set());
  const isGeneratingRef = useRef(false);
  const timerRefs = useRef({});

  // Load state from IndexedDB (with localStorage migration)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await migrateFromLocalStorage();
      await initSupabase();
      if (cancelled) return;
      const key = await getSetting("apiKey");
      if (key && !cancelled) setApiKey(key);
      const logData = await getHistory(500);
      if (logData?.length && !cancelled) setLogs(logData);
      const savedImgRes = await getSetting("defaultImageRes");
      if (savedImgRes && !cancelled) setDefaultImageRes(savedImgRes);
      const savedVidDur = await getSetting("defaultVideoDur");
      if (savedVidDur && !cancelled) setDefaultVideoDur(Number(savedVidDur));
    })();
    return () => { cancelled = true; };
  }, []);

  // Save API key
  useEffect(() => {
    if (apiKey) {
      setSetting("apiKey", apiKey);
      checkBalance(apiKey).then(r => { if (r.balance !== null) setBalance(r.balance); });
    }
  }, [apiKey]);

  // Save NEW logs to IndexedDB (and sync to Supabase) — skip already-saved entries
  useEffect(() => {
    if (logs.length > 0) {
      const latest = logs[0];
      if (latest?.id && !savedLogIds.current.has(latest.id)) {
        savedLogIds.current.add(latest.id);
        addHistoryEntry(latest);
        syncHistoryEntry(latest).catch(() => {});
      }
    }
  }, [logs]);

  // Track active count
  useEffect(() => {
    const active = tasks.filter(t => t.status === "pending" || t.status === "processing").length;
    setActiveCount(active);
  }, [tasks]);

  // Cleanup polling timeouts on unmount
  useEffect(() => {
    return () => { Object.values(pollRefs.current).forEach(id => clearTimeout(id)); };
  }, []);

  const models = MODELS[genType] || [];
  const estCost = selectedModels.reduce((sum, id) => {
    const m = models.find(x => x.id === id);
    return sum + (m?.price || 0);
  }, 0);

  function toggleModel(id) {
    setSelectedModels(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }

  // ─── FILE UPLOAD ───
  async function handleFileSelect(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    // Instant local preview via base64
    const reader = new FileReader();
    reader.onload = (ev) => setSourcePreview(ev.target.result);
    reader.readAsDataURL(file);

    // Upload to WaveSpeed
    if (!apiKey) {
      setUploadStatus("error");
      return;
    }
    setUploadStatus("uploading");
    try {
      const formData = new FormData();
      formData.append("file", file);
      // Use proxiedFetch for the file upload too
      const { res } = await proxiedFetch(`${API_BASE}/media/upload/binary`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${apiKey}` },
        body: formData
      });
      if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
      const data = await res.json();
      const url = data?.data?.download_url || data?.data?.url;
      if (url) {
        setSourceImageUrl(url);
        setUploadStatus("done");
      } else {
        throw new Error("No URL returned");
      }
    } catch (err) {
      console.error("Upload error:", err);
      setUploadStatus("error");
      // Fallback: use base64 data URL (some models may not accept it but preview works)
    }
    // Reset input so same file can be re-selected
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function clearSourceImage() {
    setSourceImageUrl("");
    setSourcePreview("");
    setUploadStatus("");
  }

  // ─── GENERATION ENGINE ───
  async function handleGenerate() {
    if (isGeneratingRef.current) return;
    if (!apiKey || !prompt.trim() || selectedModels.length === 0) return;
    if ((genType === "i2i" || genType === "i2v") && !sourceImageUrl.trim()) {
      alert("Please provide a source image URL for " + (genType === "i2i" ? "image editing" : "image-to-video"));
      return;
    }
    isGeneratingRef.current = true;
    setIsGenerating(true);
    setPage("cockpit");

    const batchId = genId();
    const newTasks = selectedModels.map(modelId => {
      const model = models.find(m => m.id === modelId);
      return {
        id: genId(), batchId, modelId, modelName: model?.name || modelId,
        provider: model?.provider || "Unknown", price: model?.price || 0,
        status: "pending", startTime: Date.now(), endTime: null,
        wallClockMs: 0, inferenceMs: 0, outputs: [], error: null,
        genType, prompt, negPrompt, resolution, duration, seed, aspectRatio, sourceImageUrl,
        perModelResolution: perModelRes
      };
    });

    setTasks(prev => [...newTasks, ...prev]);

    // Fire all in parallel
    for (const task of newTasks) {
      (async () => {
        try {
          // Build per-model payload using model's params config
          const modelConfig = models.find(m => m.id === task.modelId);
          const userSettings = {
            prompt: task.prompt, negPrompt: task.negPrompt,
            resolution: task.resolution, duration: task.duration,
            seed: task.seed, aspectRatio: task.aspectRatio,
            sourceImageUrl: task.sourceImageUrl,
            perModelResolution: task.perModelResolution || {},
          };
          const payload = modelConfig?.params
            ? buildPayload(modelConfig, userSettings, genType)
            : { prompt: task.prompt, resolution: task.resolution };

          const submitRes = await submitTask(apiKey, task.modelId, payload);
          const taskId = submitRes?.data?.id;
          const pollUrl = submitRes?.data?.urls?.get || `${API_BASE}/predictions/${taskId}/result`;

          // Check if sync mode returned outputs directly
          if (submitRes?.data?.outputs?.length > 0) {
            const wallClock = Date.now() - task.startTime;
            setTasks(prev => prev.map(t => t.id === task.id ? {
              ...t, status: "completed", outputs: submitRes.data.outputs,
              endTime: Date.now(), wallClockMs: wallClock,
              inferenceMs: submitRes.data?.timings?.inference || wallClock
            } : t));
            return;
          }

          setTasks(prev => prev.map(t => t.id === task.id ? { ...t, status: "processing", taskId } : t));

          // Polling loop
          const pollInterval = (genType === "image" || genType === "i2i") ? 3000 : 15000;
          const maxTimeout = (genType === "image" || genType === "i2i") ? 300000 : Infinity;
          const startPoll = Date.now();

          const poll = async () => {
            if (maxTimeout !== Infinity && Date.now() - startPoll > maxTimeout) {
              setTasks(prev => prev.map(t => t.id === task.id ? { ...t, status: "failed", error: "Timeout", endTime: Date.now() } : t));
              return;
            }
            try {
              const result = await pollResult(apiKey, pollUrl);
              const data = result?.data || result;
              if (data.status === "completed" && data.outputs?.length > 0) {
                const wallClock = Date.now() - task.startTime;
                setTasks(prev => prev.map(t => t.id === task.id ? {
                  ...t, status: "completed", outputs: data.outputs,
                  endTime: Date.now(), wallClockMs: wallClock,
                  inferenceMs: data?.timings?.inference || wallClock,
                  nsfw: data?.has_nsfw_contents
                } : t));
              } else if (data.status === "failed") {
                setTasks(prev => prev.map(t => t.id === task.id ? {
                  ...t, status: "failed", error: data.error || "Generation failed", endTime: Date.now()
                } : t));
              } else {
                pollRefs.current[task.id] = setTimeout(poll, pollInterval);
              }
            } catch (e) {
              if (e.code === 429) {
                // Rate limited — backoff
                pollRefs.current[task.id] = setTimeout(poll, pollInterval * 2 + Math.random() * 2000);
              } else {
                setTasks(prev => prev.map(t => t.id === task.id ? {
                  ...t, status: "failed", error: e.message || "Poll error", endTime: Date.now()
                } : t));
              }
            }
          };

          pollRefs.current[task.id] = setTimeout(poll, pollInterval);

        } catch (e) {
          let errMsg = e.message || "Submit failed";
          if (e.code === 401) errMsg = "Invalid API key";
          if (e.code === 402) errMsg = "Insufficient balance";
          if (e.code === 429) errMsg = "Rate limited — try fewer models";
          setTasks(prev => prev.map(t => t.id === task.id ? {
            ...t, status: "failed", error: errMsg, endTime: Date.now()
          } : t));
        }
      })();
    }

    // Update timers
    const timerId = setInterval(() => {
      setTasks(prev => {
        const anyActive = prev.some(t => t.batchId === batchId && (t.status === "pending" || t.status === "processing"));
        if (!anyActive) {
          clearInterval(timerId);
          isGeneratingRef.current = false;
          setIsGenerating(false);
          // Log the batch
          const batch = prev.filter(t => t.batchId === batchId);
          if (batch.length > 0) {
            const logEntry = {
              id: batchId, timestamp: Date.now(), prompt, negPrompt, genType,
              models: batch.map(t => t.modelName), resolution, duration, seed,
              tasks: batch.map(t => ({ model: t.modelName, status: t.status, wallClockMs: t.wallClockMs, cost: t.price, outputs: t.outputs, error: t.error })),
              totalCost: batch.reduce((s, t) => s + (t.status === "completed" ? t.price : 0), 0)
            };
            setLogs(prev => [logEntry, ...prev]);
          }
          // Refresh balance
          checkBalance(apiKey).then(r => { if (r.balance !== null) setBalance(r.balance); });
        }
        return prev.map(t => {
          if ((t.status === "pending" || t.status === "processing") && t.batchId === batchId) {
            return { ...t, wallClockMs: Date.now() - t.startTime };
          }
          return t;
        });
      });
    }, 500);
  }

  function cancelTask(taskId) {
    if (pollRefs.current[taskId]) clearTimeout(pollRefs.current[taskId]);
    setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: "failed", error: "Cancelled", endTime: Date.now() } : t));
  }

  // Regenerate — re-submit the same task with a new ID, without disrupting existing results
  function regenerateTask(originalTask) {
    if (!apiKey) return;
    const newTask = {
      ...originalTask,
      id: genId(),
      status: "pending",
      startTime: Date.now(),
      endTime: null,
      wallClockMs: 0,
      inferenceMs: 0,
      outputs: [],
      error: null,
      seed: Math.floor(Math.random() * 999999).toString(),
    };
    setTasks(prev => [newTask, ...prev]);

    // Timer for live wallClock display on regenerated task
    const regenTimer = setInterval(() => {
      setTasks(prev => {
        const t = prev.find(x => x.id === newTask.id);
        if (!t || t.status === "completed" || t.status === "failed") { clearInterval(regenTimer); return prev; }
        return prev.map(x => x.id === newTask.id ? { ...x, wallClockMs: Date.now() - x.startTime } : x);
      });
    }, 500);

    // Fire the regenerated task — use task's own genType, not current UI tab
    (async () => {
      try {
        const taskGenType = newTask.genType || genType;
        const taskModels = MODELS[taskGenType] || [];
        const modelConfig = taskModels.find(m => m.id === newTask.modelId);
        const userSettings = {
          prompt: newTask.prompt, negPrompt: newTask.negPrompt,
          resolution: newTask.resolution, duration: newTask.duration,
          seed: newTask.seed, aspectRatio: newTask.aspectRatio,
          sourceImageUrl: newTask.sourceImageUrl,
          perModelResolution: newTask.perModelResolution || {},
        };
        const payload = modelConfig?.params
          ? buildPayload(modelConfig, userSettings, taskGenType)
          : { prompt: newTask.prompt };

        const submitRes = await submitTask(apiKey, newTask.modelId, payload);
        const taskId = submitRes?.data?.id;
        const pollUrl = submitRes?.data?.urls?.get || `${API_BASE}/predictions/${taskId}/result`;

        if (submitRes?.data?.outputs?.length > 0) {
          const wallClock = Date.now() - newTask.startTime;
          setTasks(prev => prev.map(t => t.id === newTask.id ? {
            ...t, status: "completed", outputs: submitRes.data.outputs,
            endTime: Date.now(), wallClockMs: wallClock,
            inferenceMs: submitRes.data?.timings?.inference || wallClock
          } : t));
          return;
        }

        setTasks(prev => prev.map(t => t.id === newTask.id ? { ...t, status: "processing", taskId } : t));

        const isImageType = taskGenType === "image" || taskGenType === "i2i";
        const pollInterval = isImageType ? 3000 : 15000;
        const maxTimeout = isImageType ? 300000 : Infinity;
        const startPoll = Date.now();

        const poll = async () => {
          if (maxTimeout !== Infinity && Date.now() - startPoll > maxTimeout) {
            setTasks(prev => prev.map(t => t.id === newTask.id ? { ...t, status: "failed", error: "Timeout", endTime: Date.now() } : t));
            return;
          }
          try {
            const result = await pollResult(apiKey, pollUrl);
            const data = result?.data || result;
            if (data.status === "completed" && data.outputs?.length > 0) {
              const wallClock = Date.now() - newTask.startTime;
              setTasks(prev => prev.map(t => t.id === newTask.id ? {
                ...t, status: "completed", outputs: data.outputs,
                endTime: Date.now(), wallClockMs: wallClock,
                inferenceMs: data?.timings?.inference || wallClock,
              } : t));
            } else if (data.status === "failed") {
              setTasks(prev => prev.map(t => t.id === newTask.id ? {
                ...t, status: "failed", error: data.error || "Generation failed", endTime: Date.now()
              } : t));
            } else {
              pollRefs.current[newTask.id] = setTimeout(poll, pollInterval);
            }
          } catch (e) {
            if (e.code === 429) {
              pollRefs.current[newTask.id] = setTimeout(poll, pollInterval * 2 + Math.random() * 2000);
            } else {
              setTasks(prev => prev.map(t => t.id === newTask.id ? {
                ...t, status: "failed", error: e.message || "Poll error", endTime: Date.now()
              } : t));
            }
          }
        };
        pollRefs.current[newTask.id] = setTimeout(poll, pollInterval);
      } catch (e) {
        let errMsg = e.message || "Regenerate failed";
        if (e.code === 401) errMsg = "Invalid API key";
        if (e.code === 402) errMsg = "Insufficient balance";
        setTasks(prev => prev.map(t => t.id === newTask.id ? {
          ...t, status: "failed", error: errMsg, endTime: Date.now()
        } : t));
      }
    })();
  }

  function replayLog(log) {
    setPrompt(log.prompt);
    setNegPrompt(log.negPrompt || "");
    setGenType(log.genType);
    setResolution(log.resolution);
    setDuration(log.duration);
    setSeed(log.seed);
    // Try to reselect models
    const modelIds = (MODELS[log.genType] || []).filter(m => log.models.includes(m.name)).map(m => m.id);
    setSelectedModels(modelIds);
    setPage("cockpit");
  }

  // ─── RENDER ───
  const completedTasks = tasks.filter(t => t.status === "completed");
  const activeTasks = tasks.filter(t => t.status === "pending" || t.status === "processing");
  // resOptions and arOptions are now computed dynamically in the settings panel based on selected models
  const needsImage = genType === "i2i" || genType === "i2v" || genType === "avatar";

  return (
    <>
      <style>{css}</style>
      <div className="prism-app">
        {/* Sidebar */}
        <div className="sidebar">
          <div className="sidebar-logo" title="PRISM">◈</div>
          <button className={`sidebar-btn ${page==="cockpit"?"active":""}`} onClick={() => setPage("cockpit")} title="Cockpit">⚡</button>
          <button className={`sidebar-btn ${page==="gallery"?"active":""}`} onClick={() => setPage("gallery")} title="Gallery">🖼</button>
          <button className={`sidebar-btn ${page==="logs"?"active":""}`} onClick={() => setPage("logs")} title="Logs">📋</button>
          <button className={`sidebar-btn ${page==="settings"?"active":""}`} onClick={() => setPage("settings")} title="Settings">⚙</button>
          {activeCount > 0 && (
            <div style={{ position: "absolute", top: 68, left: 36, background: "var(--accent)", color: "white", fontSize: 9, fontWeight: 700, width: 16, height: 16, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: font }} className="pulse">{activeCount}</div>
          )}
        </div>

        {/* Main */}
        <div className="main">
          <div className="topbar">
            <div className="topbar-title">PRISM — {page === "cockpit" ? "GENERATION COCKPIT" : page === "gallery" ? "SAVED OUTPUTS" : page === "logs" ? "GENERATION LOG" : "SETTINGS"}</div>
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              {balance !== null && <div className="balance-pill">${Number(balance).toFixed(2)}</div>}
              {!apiKey && <span style={{ fontSize: 11, color: "var(--error)" }}>⚠ No API Key</span>}
            </div>
          </div>

          <div className="content">
            {/* ═══ COCKPIT ═══ */}
            {page === "cockpit" && (
              <div className="cockpit">
                <div className="cockpit-left">
                  {/* Type Tabs */}
                  <div className="type-tabs">
                    {Object.entries(TYPE_LABELS).map(([key, label]) => (
                      <button key={key} className={`type-tab ${genType===key?"active":""}`}
                        onClick={() => { setGenType(key); setSelectedModels([]); setPerModelRes({}); setResolution(""); setDuration(5); setAspectRatio("auto"); if (key !== "i2i" && key !== "i2v") { clearSourceImage(); } }}>
                        {TYPE_ICONS[key]} {label}
                      </button>
                    ))}
                  </div>

                  {/* Prompt */}
                  <div className="card">
                    <div className="card-title">{genType === "i2i" ? "Edit Instructions" : "Prompt"}</div>
                    <textarea className="prompt-area" placeholder={
                      genType === "i2i" ? "Describe the edit you want... (e.g., 'Change the background to a sunset beach')" :
                      genType === "i2v" ? "Describe the motion... (e.g., 'Slow camera push-in, subtle movement')" :
                      "Describe what you want to generate..."}
                      value={prompt} onChange={e => setPrompt(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) handleGenerate(); }} />
                    {(genType === "image" || genType === "i2i" || genType === "t2v") && (
                      <input type="text" className="prompt-area" style={{ minHeight: "auto", marginTop: 8, fontSize: 12, padding: 8 }}
                        placeholder="Negative prompt (optional)..." value={negPrompt} onChange={e => setNegPrompt(e.target.value)} />
                    )}
                  </div>

                  {/* Source Image — for i2i and i2v */}
                  {needsImage && (
                    <div className="card">
                      <div className="card-title" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span>Source Image *</span>
                        {uploadStatus === "done" && <span style={{ color: "var(--success)", fontSize: 10, fontWeight: 400 }}>✓ Uploaded to WaveSpeed</span>}
                        {uploadStatus === "uploading" && <span className="pulse" style={{ color: "var(--accent)", fontSize: 10, fontWeight: 400 }}>⏳ Uploading...</span>}
                        {uploadStatus === "error" && <span style={{ color: "var(--error)", fontSize: 10, fontWeight: 400 }}>✗ Upload failed — try URL</span>}
                      </div>

                      {/* Hidden file input — triggers native picker */}
                      <input type="file" ref={fileInputRef} accept="image/*" style={{ display: "none" }}
                        onChange={handleFileSelect} />

                      {/* Upload + URL buttons */}
                      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                        <button onClick={() => fileInputRef.current?.click()}
                          style={{
                            flex: 1, padding: "12px 8px", background: "var(--bg-input)", border: "2px dashed var(--border)",
                            borderRadius: 10, color: "var(--text-secondary)", cursor: "pointer", fontSize: 13,
                            fontFamily: fontBody, fontWeight: 500, transition: "all 0.2s", display: "flex",
                            flexDirection: "column", alignItems: "center", gap: 4
                          }}
                          onMouseOver={e => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.background = "var(--accent-glow)"; }}
                          onMouseOut={e => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.background = "var(--bg-input)"; }}>
                          <span style={{ fontSize: 24 }}>📁</span>
                          <span>Upload from Device</span>
                          <span style={{ fontSize: 10, color: "var(--text-muted)" }}>Gallery · Photos · Files</span>
                        </button>
                      </div>

                      {/* OR divider */}
                      <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "4px 0 10px" }}>
                        <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
                        <span style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: font }}>OR PASTE URL</span>
                        <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
                      </div>

                      {/* URL input */}
                      <input type="text" className="prompt-area" style={{ minHeight: "auto", fontSize: 12, padding: 10 }}
                        placeholder="https://example.com/image.png"
                        value={sourceImageUrl}
                        onChange={e => { setSourceImageUrl(e.target.value); setSourcePreview(e.target.value); setUploadStatus(e.target.value ? "done" : ""); }} />

                      {/* Preview */}
                      {(sourcePreview || sourceImageUrl) && (
                        <div style={{ marginTop: 10, position: "relative" }}>
                          <img src={sourcePreview || sourceImageUrl} alt="Source"
                            style={{ width: "100%", maxHeight: 180, objectFit: "contain", borderRadius: 8, border: "1px solid var(--border)", background: "#000" }}
                            onError={e => { e.target.style.display = "none"; setUploadStatus("error"); }} />
                          <button onClick={clearSourceImage}
                            style={{ position: "absolute", top: 6, right: 6, background: "rgba(0,0,0,0.8)", color: "white", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 6, width: 26, height: 26, cursor: "pointer", fontSize: 13, display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
                          {uploadStatus === "uploading" && (
                            <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.6)", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center" }}>
                              <div className="pulse" style={{ color: "white", fontFamily: font, fontSize: 13 }}>Uploading to WaveSpeed...</div>
                            </div>
                          )}
                        </div>
                      )}

                      <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 6, lineHeight: 1.4 }}>
                        {genType === "i2i" ? "Upload the image you want to edit. Your prompt describes what to change." :
                         "Upload the image to animate into video. Your prompt describes the motion."}
                        {uploadStatus === "done" && sourceImageUrl && (
                          <span style={{ display: "block", marginTop: 2, color: "var(--text-secondary)", fontFamily: font, fontSize: 9, wordBreak: "break-all" }}>
                            {sourceImageUrl.length > 60 ? sourceImageUrl.slice(0, 60) + "..." : sourceImageUrl}
                          </span>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Model Selector */}
                  <div className="card">
                    <div className="card-title">Models — {selectedModels.length} selected</div>
                    <div className="model-grid">
                      {models.map(m => (
                        <div key={m.id} className={`model-item ${selectedModels.includes(m.id)?"selected":""}`} onClick={() => toggleModel(m.id)}>
                          <div className="model-check">{selectedModels.includes(m.id) ? "✓" : ""}</div>
                          <span className="model-name">{m.name}</span>
                          <div className="model-meta">
                            {m.hot && <span className="hot-badge">HOT</span>}
                            {m.flagship && <span className="hot-badge" style={{ background: "var(--accent)" }}>★</span>}
                            <span className="model-provider" style={{ background: (PROVIDER_COLORS[m.provider]||"#666")+"22", color: PROVIDER_COLORS[m.provider]||"#aaa" }}>{m.provider}</span>
                            <span className="model-price">{formatCost(m.price)}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Dynamic Settings — adapts to selected models */}
                  <div className="card">
                    <div className="card-title">Settings {selectedModels.length > 0 ? `(${selectedModels.length} model${selectedModels.length > 1 ? "s" : ""})` : ""}</div>
                    {selectedModels.length === 0 ? (
                      <div style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>Select models to see parameters</div>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                        {/* Per-model resolution dropdowns */}
                        {(() => {
                          const selectedWithRes = selectedModels.map(id => models.find(m => m.id === id)).filter(m => m?.params?.resolution);
                          if (selectedWithRes.length === 0) return null;
                          // Group by param scheme (paramName)
                          const schemes = {};
                          selectedWithRes.forEach(m => {
                            const key = m.params.resolution.paramName;
                            if (!schemes[key]) schemes[key] = [];
                            schemes[key].push(m);
                          });
                          const schemeKeys = Object.keys(schemes);
                          // If all share same scheme, show one dropdown with INTERSECTION of options
                          if (schemeKeys.length === 1) {
                            const modelsInScheme = schemes[schemeKeys[0]];
                            let allOptions = modelsInScheme[0].params.resolution.options;
                            modelsInScheme.slice(1).forEach(m => {
                              const vals = m.params.resolution.options.map(o => o.value);
                              allOptions = allOptions.filter(o => vals.includes(o.value));
                            });
                            if (allOptions.length === 0) allOptions = modelsInScheme[0].params.resolution.options;
                            // Auto-set resolution if current value doesn't match any option
                            const validVals = allOptions.map(o => o.value);
                            if (!validVals.includes(resolution)) {
                              setTimeout(() => setResolution(modelsInScheme[0].params.resolution.default), 0);
                            }
                            return (
                              <div className="settings-row">
                                <label>Resolution</label>
                                <select className="settings-select" value={resolution} onChange={e => setResolution(e.target.value)}>
                                  {allOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                                </select>
                              </div>
                            );
                          }
                          // Different schemes — show per-model dropdowns
                          return selectedWithRes.map(m => (
                            <div className="settings-row" key={m.id}>
                              <label style={{ fontSize: 10, minWidth: 80 }}>{m.name}</label>
                              <select className="settings-select" value={perModelRes[m.id] || m.params.resolution.default}
                                onChange={e => setPerModelRes(prev => ({ ...prev, [m.id]: e.target.value }))}>
                                {m.params.resolution.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                              </select>
                            </div>
                          ));
                        })()}

                        {/* Aspect ratio — if any selected model supports it */}
                        {(() => {
                          const withAR = selectedModels.map(id => models.find(m => m.id === id)).filter(m => m?.params?.aspectRatio);
                          if (withAR.length === 0) return null;
                          // Use intersection of valid options
                          let arOpts = withAR[0].params.aspectRatio.options;
                          withAR.slice(1).forEach(m => {
                            const vals = m.params.aspectRatio.options.map(o => o.value);
                            arOpts = arOpts.filter(o => vals.includes(o.value));
                          });
                          if (arOpts.length === 0) arOpts = withAR[0].params.aspectRatio.options;
                          return (
                            <div className="settings-row">
                              <label>Aspect</label>
                              <select className="settings-select" value={aspectRatio} onChange={e => setAspectRatio(e.target.value)}>
                                <option value="auto">Auto</option>
                                {arOpts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                              </select>
                            </div>
                          );
                        })()}

                        {/* Duration — for video models */}
                        {(genType === "t2v" || genType === "i2v") && (() => {
                          const withDur = selectedModels.map(id => models.find(m => m.id === id)).filter(m => m?.params?.duration);
                          if (withDur.length === 0) return null;
                          // Intersection of valid durations
                          let durOpts = withDur[0].params.duration.options;
                          withDur.slice(1).forEach(m => {
                            durOpts = durOpts.filter(d => m.params.duration.options.includes(d));
                          });
                          if (durOpts.length === 0) durOpts = withDur[0].params.duration.options; // fallback
                          // Auto-correct if current duration is invalid for selection
                          if (!durOpts.includes(Number(duration))) {
                            setTimeout(() => setDuration(durOpts[0]), 0);
                          }
                          return (
                            <div className="settings-row">
                              <label>Duration</label>
                              <select className="settings-select" value={duration} onChange={e => setDuration(Number(e.target.value))}>
                                {durOpts.map(d => <option key={d} value={d}>{d}s</option>)}
                              </select>
                            </div>
                          );
                        })()}

                        <div className="settings-row">
                          <label>Seed</label>
                          <input type="text" className="settings-input" style={{ width: 72 }} value={seed} onChange={e => setSeed(e.target.value)} />
                          <button onClick={() => setSeed(Math.floor(Math.random() * 999999).toString())} style={{ background: "transparent", border: "1px solid var(--border)", borderRadius: 6, padding: "5px 8px", cursor: "pointer", fontSize: 14 }} title="Random seed">🎲</button>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Cost + Generate */}
                  {selectedModels.length > 0 && (
                    <div className="cost-bar">
                      <span style={{ color: "var(--text-secondary)", fontSize: 11 }}>Est. cost ({selectedModels.length} model{selectedModels.length > 1 ? "s" : ""})</span>
                      <span className="cost-amount">{formatCost(estCost)}</span>
                    </div>
                  )}

                  <button className={`gen-btn ${isGenerating ? "running" : "ready"}`}
                    disabled={!apiKey || (!prompt.trim() && genType !== "avatar") || selectedModels.length === 0 || isGenerating || (needsImage && !sourceImageUrl.trim())}
                    onClick={handleGenerate}>
                    {isGenerating ? `⏳ GENERATING (${activeCount} active)...` :
                     !apiKey ? "⚠ SET API KEY IN SETTINGS" :
                     needsImage && !sourceImageUrl.trim() ? "⚠ ADD SOURCE IMAGE ABOVE" :
                     `⚡ ${genType === "i2i" ? "EDIT" : "GENERATE"}${selectedModels.length > 0 ? ` ACROSS ${selectedModels.length} MODELS` : ""}`}
                  </button>
                  <div style={{ fontSize: 10, color: "var(--text-muted)", textAlign: "center" }}>Ctrl+Enter to generate</div>
                </div>

                {/* Results */}
                <div className="cockpit-right">
                  {tasks.length === 0 ? (
                    <div className="empty-state">
                      <div className="emoji">◈</div>
                      <div className="msg">Select models, write a prompt, and hit Generate to fire parallel requests across all selected models simultaneously.</div>
                    </div>
                  ) : (
                    <div className="results-grid">
                      {tasks.map(task => (
                        <div key={task.id} className="task-card fade-in">
                          <div className="task-header">
                            <div>
                              <span className="task-model">{task.modelName}</span>
                              <span style={{ fontSize: 10, color: PROVIDER_COLORS[task.provider] || "#aaa", marginLeft: 6 }}>{task.provider}</span>
                            </div>
                            <span className={`task-status ${task.status}`}>
                              {task.status === "pending" ? "PENDING" : task.status === "processing" ? "PROCESSING" : task.status === "completed" ? "DONE" : "FAILED"}
                            </span>
                          </div>

                          <div className="task-timer">
                            {task.status === "completed" ? `✓ ${formatTime(task.wallClockMs)}` :
                             task.status === "failed" ? `✗ ${task.error}` :
                             <span className="pulse">⏱ {formatTime(task.wallClockMs)}</span>}
                            {task.status === "completed" && <span style={{ marginLeft: 8, color: "var(--amber)" }}>{formatCost(task.price)}</span>}
                          </div>

                          {(task.status === "pending" || task.status === "processing") && (
                            <>
                              <div className="task-progress">
                                <div className="task-progress-fill" style={{
                                  width: `${Math.min(95, (task.wallClockMs / (genType === "image" ? 10000 : 180000)) * 100)}%`
                                }} />
                              </div>
                              <button className="result-action-btn" style={{ marginTop: 6, fontSize: 10 }} onClick={() => cancelTask(task.id)}>✕ Cancel</button>
                            </>
                          )}

                          {task.status === "completed" && task.outputs?.map((url, i) => {
                            const tType = task.genType || genType;
                            const isVideo = url.includes(".mp4") || url.includes("video") || tType === "t2v" || tType === "i2v" || tType === "avatar";
                            return isVideo ? (
                              <video key={i} className="result-video" src={url} controls autoPlay muted loop playsInline />
                            ) : (
                              <img key={i} className="result-img" src={url} alt={task.modelName}
                                onClick={() => setLightbox(url)} loading="lazy" />
                            );
                          })}

                          {(task.status === "completed" || task.status === "failed") && (
                            <div className="result-actions">
                              <button className="result-action-btn" style={{ color: "var(--accent)", borderColor: "rgba(99,102,241,0.3)" }}
                                onClick={() => regenerateTask(task)}>🔄 Regenerate</button>
                              {task.status === "completed" && <>
                                <button className="result-action-btn" onClick={async () => {
                                  try {
                                    const url = task.outputs?.[0];
                                    if (!url) return;
                                    const resp = await fetch(url);
                                    const blob = await resp.blob();
                                    const tgt = task.genType || genType;
                                    const ext = (tgt === "t2v" || tgt === "i2v" || tgt === "avatar" || blob.type.startsWith("video")) ? "mp4" : "png";
                                    const fname = `${task.modelName.replace(/\s+/g, "_")}_${Date.now()}.${ext}`;
                                    const a = document.createElement("a");
                                    a.href = URL.createObjectURL(blob);
                                    a.download = fname;
                                    document.body.appendChild(a);
                                    a.click();
                                    a.remove();
                                    URL.revokeObjectURL(a.href);
                                  } catch (e) { console.log("Direct download blocked, opening in new tab"); window.open(task.outputs?.[0], "_blank"); }
                                }}>↓ Save</button>
                                <button className="result-action-btn" onClick={() => { navigator.clipboard?.writeText(task.outputs?.[0] || ""); }}>📋 URL</button>
                                {(genType === "image" || genType === "i2i") && (
                                  <button className="result-action-btn" style={{ color: "#a78bfa", borderColor: "rgba(167,139,250,0.3)" }}
                                    onClick={() => { setSourceImageUrl(task.outputs?.[0] || ""); setSourcePreview(task.outputs?.[0] || ""); setUploadStatus("done"); setGenType("i2i"); setSelectedModels([]); setPrompt(""); }}>
                                    ✏️ Edit
                                  </button>
                                )}
                                {(genType === "image" || genType === "i2i") && (
                                  <button className="result-action-btn" style={{ color: "var(--warning)", borderColor: "rgba(245,158,11,0.3)" }}
                                    onClick={() => { setSourceImageUrl(task.outputs?.[0] || ""); setSourcePreview(task.outputs?.[0] || ""); setUploadStatus("done"); setGenType("i2v"); setSelectedModels([]); setPrompt(""); }}>
                                    🎬 Animate
                                  </button>
                                )}
                              </>}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ═══ GALLERY ═══ */}
            {page === "gallery" && (
              <div>
                <h2 style={{ fontFamily: font, fontSize: 16, marginBottom: 16, color: "var(--text-secondary)" }}>Completed Outputs ({completedTasks.length})</h2>
                {completedTasks.length === 0 ? (
                  <div className="empty-state"><div className="emoji">🖼️</div><div className="msg">Your generated outputs will appear here after generation.</div></div>
                ) : (
                  <div className="results-grid">
                    {completedTasks.map(task => (
                      <div key={task.id} className="task-card">
                        <div style={{ fontSize: 12, fontWeight: 600 }}>{task.modelName}</div>
                        <div style={{ fontSize: 11, color: "var(--text-muted)", margin: "4px 0" }}>{task.prompt?.slice(0, 60)}...</div>
                        {task.outputs?.map((url, i) => {
                          const gType = task.genType || "";
                          const isVideo = url.includes(".mp4") || url.includes("video") || gType === "t2v" || gType === "i2v" || gType === "avatar";
                          return isVideo
                            ? <video key={i} className="result-video" src={url} controls muted playsInline onClick={() => setLightbox(url)} />
                            : <img key={i} className="result-img" src={url} alt="" onClick={() => setLightbox(url)} />;
                        })}
                        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: 11, color: "var(--text-muted)", fontFamily: font }}>
                          <span>{formatTime(task.wallClockMs)}</span>
                          <span>{formatCost(task.price)}</span>
                          <span>{timeAgo(task.endTime)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ═══ LOGS ═══ */}
            {page === "logs" && (
              <div>
                <h2 style={{ fontFamily: font, fontSize: 16, marginBottom: 16, color: "var(--text-secondary)" }}>Generation Log ({logs.length} entries)</h2>
                {logs.length === 0 ? (
                  <div className="empty-state"><div className="emoji">📋</div><div className="msg">Your generation history will appear here. Each entry can be replayed with one click.</div></div>
                ) : (
                  <div style={{ border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
                    <div className="log-row log-header">
                      <span>Time</span><span>Prompt</span><span>Models</span><span>Type</span><span>Cost</span><span></span>
                    </div>
                    {logs.map(log => (
                      <div key={log.id} className="log-row" onClick={() => replayLog(log)}>
                        <span style={{ fontFamily: font, fontSize: 11, color: "var(--text-muted)" }}>{timeAgo(log.timestamp)}</span>
                        <span className="log-prompt">{log.prompt}</span>
                        <span className="log-models">{log.models.length} model{log.models.length > 1 ? "s" : ""}</span>
                        <span style={{ fontSize: 11 }}>{TYPE_ICONS[log.genType]}</span>
                        <span className="log-cost">{formatCost(log.totalCost)}</span>
                        <button className="log-replay" onClick={e => { e.stopPropagation(); replayLog(log); }}>▶</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ═══ SETTINGS ═══ */}
            {page === "settings" && (
              <div style={{ maxWidth: 500 }}>
                <h2 style={{ fontFamily: font, fontSize: 16, marginBottom: 24, color: "var(--text-secondary)" }}>Settings</h2>
                <div className="setting-group">
                  <div className="setting-label">WaveSpeed API Key</div>
                  <input type="password" className="setting-input" placeholder="Enter your WaveSpeed API key..."
                    value={apiKey} onChange={e => { setApiKey(e.target.value); setTestStatus(null); }} />
                  <div className="setting-hint">Get your key at <span style={{ color: "var(--accent)" }}>wavespeed.ai/settings</span>. Stored locally in your browser. Requests are forwarded to WaveSpeed through Vite's dev server proxy on your machine — no third-party services involved, your API key never leaves your computer.</div>
                  {apiKey && (
                    <button className="api-test-btn"
                      disabled={testStatus === "testing"}
                      onClick={async () => {
                        setTestStatus("testing");
                        const r = await checkBalance(apiKey);
                        if (r.balance !== null) {
                          setBalance(r.balance);
                          setTestStatus({ ok: true, msg: `Connected! Balance: $${Number(r.balance).toFixed(4)}` });
                        } else {
                          setTestStatus({ ok: false, msg: r.error ? r.error : "Could not verify key. Check if it's correct." });
                        }
                      }}>
                      {testStatus === "testing" ? "Testing..." : "Test Connection"}
                    </button>
                  )}
                  {testStatus && testStatus !== "testing" && (
                    <div style={{
                      marginTop: 10, padding: "10px 12px", borderRadius: 8, fontSize: 12,
                      fontFamily: font, fontWeight: 500,
                      background: testStatus.ok ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
                      border: `1px solid ${testStatus.ok ? "rgba(34,197,94,0.3)" : "rgba(239,68,68,0.3)"}`,
                      color: testStatus.ok ? "var(--success)" : "var(--error)"
                    }}>
                      {testStatus.ok ? "✓ " : "✗ "}{testStatus.msg}
                    </div>
                  )}
                  {testStatus === "testing" && (
                    <div className="pulse" style={{ marginTop: 10, fontSize: 12, color: "var(--accent)", fontFamily: font }}>
                      ⏳ Contacting WaveSpeed API...
                    </div>
                  )}
                  {balance !== null && testStatus !== "testing" && !testStatus && <div style={{ marginTop: 8, fontFamily: font, fontSize: 13, color: "var(--success)" }}>Balance: ${Number(balance).toFixed(4)}</div>}
                </div>

                <div className="setting-group">
                  <div className="setting-label">Default Settings</div>
                  <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
                    <div>
                      <label style={{ fontSize: 11, color: "var(--text-muted)" }}>Image Resolution</label>
                      <select className="settings-select" style={{ display: "block", marginTop: 4 }}
                        value={defaultImageRes} onChange={e => { setDefaultImageRes(e.target.value); setSetting("defaultImageRes", e.target.value); }}>
                        <option value="1k">1K</option><option value="2k">2K</option><option value="4k">4K</option>
                      </select>
                    </div>
                    <div>
                      <label style={{ fontSize: 11, color: "var(--text-muted)" }}>Video Duration</label>
                      <select className="settings-select" style={{ display: "block", marginTop: 4 }}
                        value={defaultVideoDur} onChange={e => { setDefaultVideoDur(Number(e.target.value)); setSetting("defaultVideoDur", e.target.value); }}>
                        <option value={5}>5s</option><option value={10}>10s</option><option value={15}>15s</option>
                      </select>
                    </div>
                  </div>
                </div>

                <div className="setting-group">
                  <div className="setting-label">About</div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>
                    <strong style={{ color: "var(--text-primary)" }}>PRISM v1.0</strong> — Parallel Rendering & Inference Studio for Media<br />
                    {Object.values(MODELS).flat().length} models registered across {Object.keys(MODELS).length} categories<br />
                    Powered by WaveSpeed.ai unified API
                  </div>
                </div>

                {logs.length > 0 && (
                  <div className="setting-group">
                    <div className="setting-label">Data</div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button className="api-test-btn" style={{ background: "var(--error)" }} onClick={() => { if (confirm("Clear all generation logs?")) { setLogs([]); clearHistory(); } }}>Clear Logs ({logs.length})</button>
                      <button className="api-test-btn" onClick={() => { setTasks([]); }}>Clear Active Tasks</button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Lightbox */}
        {lightbox && (
          <div className="lightbox" onClick={() => setLightbox(null)}>
            {lightbox.includes(".mp4") || lightbox.includes("video")
              ? <video src={lightbox} controls autoPlay muted style={{ maxWidth: "92vw", maxHeight: "92vh", borderRadius: 10 }} onClick={e => e.stopPropagation()} />
              : <img src={lightbox} alt="Full resolution" />}
          </div>
        )}
      </div>
    </>
  );
}
