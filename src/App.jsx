import { useState, useEffect, useRef, useCallback, useReducer } from "react";
import { MODELS, TYPE_LABELS, TYPE_ICONS, PROVIDER_COLORS } from "./config/models.js";
import { buildPayload } from "./lib/payloadBuilder.js";
import { submitTask, pollResult, checkBalance, uploadMedia, API_BASE, proxiedFetch } from "./lib/api.js";
import { getSetting, setSetting, addHistoryEntry, getHistory, clearHistory, migrateFromLocalStorage, saveTask, saveTasks, getCompletedTasks, clearTasks as clearTasksDB } from "./lib/storage.js";
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

/* Void background */
.proxima-app { display: flex; height: 100vh; overflow: hidden; position: relative; background: url('/void.jpg') calc(50% + 0.24cm) center / cover no-repeat fixed; background-color: #020510; }

.proxima-app > * { position: relative; z-index: 1; }

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
  .proxima-app { flex-direction: column; }
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
  return formatTimestamp(ts);
}
function formatTimestamp(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", hour12: true, month: "short", day: "numeric" });
}

// ─── API SERVICE ───
// ─── MAIN APP ───
export default function ProximaApp() {
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
  const [sourceImageUrls, setSourceImageUrls] = useState([]); // multi-image support
  const [sourcePreview, setSourcePreview] = useState("");
  const [uploadStatus, setUploadStatus] = useState(""); // "" | "uploading" | "done" | "error"
  const [testStatus, setTestStatus] = useState(null); // null | "testing" | {ok, msg}
  const fileInputRef = useRef(null);
  const multiImageInputRef = useRef(null);
  const [tasks, setTasks] = useState([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [logs, setLogs] = useState([]);
  const [lightbox, setLightbox] = useState(null);
  const [defaultImageRes, setDefaultImageRes] = useState("1k");
  const [defaultVideoDur, setDefaultVideoDur] = useState(5);
  const [galleryTabState, setGalleryTabState] = useState("completed");
  const [galleryView, setGalleryView] = useState("masonry");
  const [numImages, setNumImages] = useState(1);
  const multiImageFileRef = useRef(null);
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
      const savedTasks = await getCompletedTasks(200);
      if (savedTasks?.length && !cancelled) {
        for (const t of savedTasks) savedTaskIds.current.add(t.id);
        setTasks(savedTasks);
      }
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

  // Persist completed/failed tasks to IndexedDB
  const savedTaskIds = useRef(new Set());
  useEffect(() => {
    const toSave = tasks.filter(t =>
      (t.status === "completed" || t.status === "failed") && !savedTaskIds.current.has(t.id)
    );
    for (const t of toSave) {
      savedTaskIds.current.add(t.id);
      saveTask(t);
    }
  }, [tasks]);

  // Cleanup polling timeouts on unmount
  useEffect(() => {
    return () => { Object.values(pollRefs.current).forEach(id => clearTimeout(id)); };
  }, []);

  const models = MODELS[genType] || [];
  const estCost = selectedModels.reduce((sum, id) => {
    const m = models.find(x => x.id === id);
    return sum + (m?.price || 0) * (numImages || 1);
  }, 0);

  function toggleModel(id) {
    setSelectedModels(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }

  // ─── FILE UPLOAD ───
  async function uploadSingleFile(file) {
    const formData = new FormData();
    formData.append("file", file);
    const { res } = await proxiedFetch(`${API_BASE}/media/upload/binary`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}` },
      body: formData
    });
    if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
    const data = await res.json();
    return data?.data?.download_url || data?.data?.url || null;
  }

  async function handleFileSelect(e) {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    // Preview first image
    const reader = new FileReader();
    reader.onload = (ev) => setSourcePreview(ev.target.result);
    reader.readAsDataURL(files[0]);

    if (!apiKey) { setUploadStatus("error"); return; }
    setUploadStatus("uploading");

    try {
      // Upload all files in parallel
      const uploadPromises = files.map(f => uploadSingleFile(f));
      const urls = (await Promise.all(uploadPromises)).filter(Boolean);

      if (urls.length === 0) throw new Error("No URLs returned");

      // First image goes to primary sourceImageUrl
      setSourceImageUrl(urls[0]);

      // Additional images go to sourceImageUrls (for multi-image models)
      if (urls.length > 1) {
        setSourceImageUrls(prev => [...prev, ...urls.slice(1)]);
      }

      setUploadStatus("done");
    } catch (err) {
      console.error("Upload error:", err);
      setUploadStatus("error");
    }
    // Reset input so same files can be re-selected
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  // Upload additional reference images from gallery picker
  async function handleAdditionalFileSelect(e) {
    const files = Array.from(e.target.files || []);
    if (files.length === 0 || !apiKey) return;
    try {
      const uploadPromises = files.map(f => uploadSingleFile(f));
      const urls = (await Promise.all(uploadPromises)).filter(Boolean);
      if (urls.length > 0) {
        setSourceImageUrls(prev => [...prev, ...urls]);
      }
    } catch (err) {
      console.error("Additional image upload error:", err);
    }
    if (multiImageFileRef.current) multiImageFileRef.current.value = "";
  }

  function clearSourceImage() {
    setSourceImageUrl("");
    setSourceImageUrls([]);
    setSourcePreview("");
    setUploadStatus("");
  }

  // Compute max images allowed — use min across selected models (most restrictive)
  const maxImagesAllowed = (() => {
    if (genType !== "i2i" || selectedModels.length === 0) return 1;
    const caps = selectedModels.map(id => {
      const m = models.find(x => x.id === id);
      return m?.params?.maxImages || 1;
    }).filter(v => v > 1);
    return caps.length > 0 ? Math.min(...caps) : 1;
  })();

  // ─── GENERATION ENGINE ───
  async function handleGenerate() {
    if (!apiKey || (!prompt.trim() && genType !== "avatar") || selectedModels.length === 0) return;
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
        sourceImageUrls: sourceImageUrls.length > 0 ? sourceImageUrls : (sourceImageUrl ? [sourceImageUrl] : []),
        perModelResolution: perModelRes, numImages
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
            sourceImageUrls: task.sourceImageUrls || [],
            perModelResolution: task.perModelResolution || {},
            numImages: task.numImages || 1,
          };
          const payload = modelConfig?.params
            ? buildPayload(modelConfig, userSettings, task.genType || genType)
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
          // Check if ANY tasks across ALL batches are still active
          const anyGlobalActive = prev.some(t => t.status === "pending" || t.status === "processing");
          if (!anyGlobalActive) {
            isGeneratingRef.current = false;
            setIsGenerating(false);
          }
          // Log the batch
          const batch = prev.filter(t => t.batchId === batchId);
          if (batch.length > 0) {
            const logEntry = {
              id: batchId, timestamp: Date.now(), prompt, negPrompt, genType,
              models: batch.map(t => t.modelName), resolution, duration, seed, aspectRatio, sourceImageUrl, sourceImageUrls: sourceImageUrls.length > 0 ? [...sourceImageUrls] : [], numImages,
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
          sourceImageUrls: newTask.sourceImageUrls || [],
          perModelResolution: newTask.perModelResolution || {},
          numImages: newTask.numImages || 1,
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
    setAspectRatio(log.aspectRatio || "auto");
    setSourceImageUrls(log.sourceImageUrls?.length > 0 ? [...log.sourceImageUrls] : []);
    if (log.sourceImageUrl) { setSourceImageUrl(log.sourceImageUrl); setSourcePreview(log.sourceImageUrl); setUploadStatus("done"); }
    if (log.numImages) setNumImages(log.numImages);
    // Try to reselect models
    const modelIds = (MODELS[log.genType] || []).filter(m => log.models.includes(m.name)).map(m => m.id);
    setSelectedModels(modelIds);
    setPerModelRes({});
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
      <div className="proxima-app">
        {/* Sidebar */}
        <div className="sidebar">
          <div className="sidebar-logo" title="ProximaAI">◈</div>
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
            <div className="topbar-title">ProximaAI — {page === "cockpit" ? "GENERATION COCKPIT" : page === "gallery" ? "SAVED OUTPUTS" : page === "logs" ? "GENERATION LOG" : "SETTINGS"}</div>
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
                        onClick={() => { setGenType(key); setSelectedModels([]); setPerModelRes({}); setResolution(""); setDuration(5); setAspectRatio("auto"); setSourceImageUrls([]); if (key !== "i2i" && key !== "i2v" && key !== "avatar") { clearSourceImage(); } }}>
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
                    {(genType === "image" || genType === "i2i" || genType === "t2v" || genType === "i2v") && (
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

                      {/* Hidden file input — triggers native picker, multiple when multi-image models selected */}
                      <input type="file" ref={fileInputRef} accept="image/*"
                        multiple={genType === "i2i" && maxImagesAllowed > 1}
                        style={{ display: "none" }} onChange={handleFileSelect} />

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
                          <span>{genType === "i2i" && maxImagesAllowed > 1 ? "Upload Images" : "Upload from Device"}</span>
                          <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{genType === "i2i" && maxImagesAllowed > 1 ? `Select up to ${maxImagesAllowed} images` : "Gallery · Photos · Files"}</span>
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
                          {genType === "i2i" && maxImagesAllowed > 1 && (
                            <div style={{ position: "absolute", bottom: 6, left: 6, background: "rgba(0,0,0,0.7)", color: "#a78bfa", fontSize: 10, padding: "2px 6px", borderRadius: 4, fontFamily: font, fontWeight: 600 }}>Ref 1</div>
                          )}
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

                      {/* Multi-image — only shown for i2i models that support maxImages > 1 */}
                      {genType === "i2i" && maxImagesAllowed > 1 && uploadStatus === "done" && (
                        <div style={{ marginTop: 10, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
                          <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 6, fontFamily: font }}>
                            Additional Reference Images ({sourceImageUrls.length}/{maxImagesAllowed} max)
                          </div>
                          {/* Thumbnails of additional images */}
                          {sourceImageUrls.length > 0 && (
                            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
                              {sourceImageUrls.map((url, i) => (
                                <div key={i} style={{ position: "relative", width: 60, height: 60 }}>
                                  <img src={url} alt={`Ref ${i+2}`} style={{ width: 60, height: 60, objectFit: "cover", borderRadius: 6, border: "1px solid var(--border)" }} />
                                  <div style={{ position: "absolute", bottom: 2, left: 2, background: "rgba(0,0,0,0.7)", color: "#a78bfa", fontSize: 8, padding: "1px 4px", borderRadius: 3, fontFamily: font }}>Ref {i+2}</div>
                                  <button onClick={() => setSourceImageUrls(prev => prev.filter((_, j) => j !== i))}
                                    style={{ position: "absolute", top: -4, right: -4, background: "var(--error)", color: "white", border: "none", borderRadius: "50%", width: 18, height: 18, cursor: "pointer", fontSize: 10, display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
                                </div>
                              ))}
                            </div>
                          )}
                          {sourceImageUrls.length < maxImagesAllowed - 1 && (
                            <>
                              {/* Hidden file input for gallery picker */}
                              <input type="file" ref={multiImageFileRef} accept="image/*" multiple style={{ display: "none" }}
                                onChange={handleAdditionalFileSelect} />
                              <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
                                <button onClick={() => multiImageFileRef.current?.click()}
                                  style={{ flex: 1, padding: "10px 8px", background: "var(--bg-input)", border: "2px dashed var(--border)", borderRadius: 8, color: "var(--text-secondary)", cursor: "pointer", fontSize: 12, fontFamily: fontBody, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, transition: "all 0.2s" }}
                                  onMouseOver={e => { e.currentTarget.style.borderColor = "var(--accent)"; }}
                                  onMouseOut={e => { e.currentTarget.style.borderColor = "var(--border)"; }}>
                                  📁 Upload More from Gallery
                                </button>
                              </div>
                              <div style={{ display: "flex", gap: 6 }}>
                                <input ref={multiImageInputRef} type="text" className="prompt-area" style={{ minHeight: "auto", fontSize: 11, padding: 8, flex: 1 }}
                                  placeholder="Or paste image URL..."
                                  onKeyDown={e => {
                                    if (e.key === "Enter" && e.target.value.trim()) {
                                      e.preventDefault();
                                      setSourceImageUrls(prev => [...prev, e.target.value.trim()]);
                                      e.target.value = "";
                                    }
                                  }} />
                                <button onClick={() => {
                                  const input = multiImageInputRef.current;
                                  if (input?.value?.trim()) { setSourceImageUrls(prev => [...prev, input.value.trim()]); input.value = ""; }
                                }} style={{ padding: "8px 12px", background: "var(--accent)", color: "white", border: "none", borderRadius: 8, cursor: "pointer", fontSize: 11, fontFamily: font, whiteSpace: "nowrap" }}>+ Add</button>
                              </div>
                            </>
                          )}
                          <div style={{ fontSize: 9, color: "var(--text-muted)", marginTop: 4 }}>
                            Reference images as "Figure 1", "Figure 2" etc. in your prompt
                          </div>
                        </div>
                      )}
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

                  {/* Dynamic Settings — adapts to selected models (UNION-based) */}
                  <div className="card">
                    <div className="card-title">Settings {selectedModels.length > 0 ? `(${selectedModels.length} model${selectedModels.length > 1 ? "s" : ""})` : ""}</div>
                    {selectedModels.length === 0 ? (
                      <div style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>Select models to see parameters</div>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                        {/* Resolution — UNION of all selected models' options */}
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
                          // If all share same scheme, show one dropdown with UNION of options
                          if (schemeKeys.length === 1) {
                            const modelsInScheme = schemes[schemeKeys[0]];
                            // Build UNION: deduplicate by value, track which models support each
                            const optMap = new Map();
                            modelsInScheme.forEach(m => {
                              m.params.resolution.options.forEach(o => {
                                if (!optMap.has(o.value)) optMap.set(o.value, { label: o.label, value: o.value, models: [] });
                                optMap.get(o.value).models.push(m.name);
                              });
                            });
                            const unionOptions = [...optMap.values()];
                            const totalModels = modelsInScheme.length;
                            // Auto-set resolution if current value is not in union
                            const validVals = unionOptions.map(o => o.value);
                            if (!validVals.includes(resolution)) {
                              setTimeout(() => setResolution(modelsInScheme[0].params.resolution.default), 0);
                            }
                            return (
                              <div className="settings-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                  <label>Resolution</label>
                                  <select className="settings-select" value={resolution} onChange={e => setResolution(e.target.value)}>
                                    {unionOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                                  </select>
                                </div>
                                {totalModels > 1 && (() => {
                                  const current = optMap.get(resolution);
                                  if (current && current.models.length < totalModels) {
                                    const unsupported = modelsInScheme.filter(m => !current.models.includes(m.name));
                                    return (
                                      <div style={{ fontSize: 9, color: "var(--text-muted)", lineHeight: 1.3 }}>
                                        {current.models.length === totalModels ? "All models" : current.models.join(", ")}
                                        {unsupported.length > 0 && <span style={{ color: "var(--amber)" }}> — {unsupported.map(m => m.name).join(", ")} will use nearest valid</span>}
                                      </div>
                                    );
                                  }
                                  return null;
                                })()}
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

                        {/* Aspect ratio — UNION with support indicators */}
                        {(() => {
                          const withAR = selectedModels.map(id => models.find(m => m.id === id)).filter(m => m?.params?.aspectRatio);
                          if (withAR.length === 0) return null;
                          // Build UNION of all aspect ratio options, track supporters
                          const arMap = new Map();
                          withAR.forEach(m => {
                            m.params.aspectRatio.options.forEach(o => {
                              if (!arMap.has(o.value)) arMap.set(o.value, { label: o.label, value: o.value, models: [] });
                              arMap.get(o.value).models.push(m.name);
                            });
                          });
                          const unionAR = [...arMap.values()];
                          const totalAR = withAR.length;
                          return (
                            <div className="settings-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                <label>Aspect</label>
                                <select className="settings-select" value={aspectRatio} onChange={e => setAspectRatio(e.target.value)}>
                                  <option value="auto">Auto</option>
                                  {unionAR.map(o => <option key={o.value} value={o.value}>{o.label}{totalAR > 1 && o.models.length < totalAR ? ` (${o.models.length}/${totalAR})` : ""}</option>)}
                                </select>
                              </div>
                              {totalAR > 1 && aspectRatio !== "auto" && (() => {
                                const current = arMap.get(aspectRatio);
                                if (current && current.models.length < totalAR) {
                                  const unsupported = withAR.filter(m => !current.models.includes(m.name));
                                  return (
                                    <div style={{ fontSize: 9, color: "var(--text-muted)", lineHeight: 1.3 }}>
                                      {current.models.join(", ")}
                                      {unsupported.length > 0 && <span style={{ color: "var(--amber)" }}> — {unsupported.map(m => m.name).join(", ")} will use their default</span>}
                                    </div>
                                  );
                                }
                                return null;
                              })()}
                            </div>
                          );
                        })()}

                        {/* Duration — UNION for video models with per-model fallback */}
                        {(genType === "t2v" || genType === "i2v") && (() => {
                          const withDur = selectedModels.map(id => models.find(m => m.id === id)).filter(m => m?.params?.duration);
                          if (withDur.length === 0) return null;
                          // Build UNION of all duration options, track which models support each
                          const durMap = new Map();
                          withDur.forEach(m => {
                            m.params.duration.options.forEach(d => {
                              if (!durMap.has(d)) durMap.set(d, []);
                              durMap.get(d).push(m.name);
                            });
                          });
                          const unionDurs = [...durMap.keys()].sort((a, b) => a - b);
                          const totalDur = withDur.length;
                          // Auto-correct if current duration is not in union at all
                          if (!unionDurs.includes(Number(duration))) {
                            setTimeout(() => setDuration(unionDurs[0]), 0);
                          }
                          return (
                            <div className="settings-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                <label>Duration</label>
                                <select className="settings-select" value={duration} onChange={e => setDuration(Number(e.target.value))}>
                                  {unionDurs.map(d => {
                                    const supporters = durMap.get(d);
                                    const suffix = totalDur > 1 && supporters.length < totalDur ? ` (${supporters.length}/${totalDur})` : "";
                                    return <option key={d} value={d}>{d}s{suffix}</option>;
                                  })}
                                </select>
                              </div>
                              {totalDur > 1 && (() => {
                                const currentDur = Number(duration);
                                const supporters = durMap.get(currentDur) || [];
                                if (supporters.length < totalDur) {
                                  const unsupported = withDur.filter(m => !m.params.duration.options.includes(currentDur));
                                  // Show what fallback each unsupported model gets
                                  const fallbackInfo = unsupported.map(m => {
                                    const opts = m.params.duration.options;
                                    const closest = opts.reduce((prev, curr) => Math.abs(curr - currentDur) < Math.abs(prev - currentDur) ? curr : prev);
                                    return `${m.name} -> ${closest}s`;
                                  });
                                  return (
                                    <div style={{ fontSize: 9, color: "var(--text-muted)", lineHeight: 1.3 }}>
                                      <span>{supporters.length === totalDur ? "All models" : supporters.join(", ")}</span>
                                      {fallbackInfo.length > 0 && <span style={{ color: "var(--amber)" }}> — {fallbackInfo.join(", ")}</span>}
                                    </div>
                                  );
                                }
                                return null;
                              })()}
                            </div>
                          );
                        })()}

                        {(genType === "image" || genType === "i2i") && (
                          <div className="settings-row">
                            <label>Batch</label>
                            <select className="settings-select" value={numImages} onChange={e => setNumImages(Number(e.target.value))}>
                              {[1,2,3,4,8,12,16].map(n => <option key={n} value={n}>{n} image{n > 1 ? "s" : ""}</option>)}
                            </select>
                          </div>
                        )}

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
                    disabled={!apiKey || (!prompt.trim() && genType !== "avatar") || selectedModels.length === 0 || (needsImage && !sourceImageUrl.trim())}
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
                                {((task.genType || genType) === "image" || (task.genType || genType) === "i2i") && (
                                  <button className="result-action-btn" style={{ color: "#a78bfa", borderColor: "rgba(167,139,250,0.3)" }}
                                    onClick={() => {
                                      setSourceImageUrl(task.outputs?.[0] || ""); setSourcePreview(task.outputs?.[0] || ""); setUploadStatus("done");
                                      setGenType("i2i"); setPrompt(task.prompt || "");
                                      // Auto-select the edit variant of the same model if available
                                      const editModels = MODELS["i2i"] || [];
                                      const sameProviderEdit = editModels.find(m => m.provider === task.provider);
                                      setSelectedModels(sameProviderEdit ? [sameProviderEdit.id] : []);
                                      setPage("cockpit");
                                    }}>
                                    ✏️ Edit
                                  </button>
                                )}
                                {((task.genType || genType) === "image" || (task.genType || genType) === "i2i") && (
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
            {page === "gallery" && (() => {
              const galleryCompleted = tasks.filter(t => t.status === "completed");
              const galleryProcessing = tasks.filter(t => t.status === "pending" || t.status === "processing");
              const galleryFailed = tasks.filter(t => t.status === "failed");
              const [galleryTab, setGalleryTab] = [galleryTabState, setGalleryTabState];
              const tabCounts = { completed: galleryCompleted.length, processing: galleryProcessing.length, failed: galleryFailed.length };
              return (
              <div>
                {/* Gallery Tabs */}
                <div style={{ display: "flex", gap: 4, marginBottom: 16, background: "rgba(10,20,40,0.3)", borderRadius: 10, padding: 3 }}>
                  {[["completed","Completed"],["processing","Processing"],["failed","Failed"]].map(([key,label]) => (
                    <button key={key} onClick={() => setGalleryTabState(key)}
                      style={{ flex: 1, padding: "8px 6px", border: "none", borderRadius: 8, cursor: "pointer", fontSize: 12, fontFamily: fontBody, fontWeight: 500, transition: "all 0.2s",
                        background: galleryTab === key ? "linear-gradient(135deg, #6366f1, #8b5cf6)" : "transparent",
                        color: galleryTab === key ? "white" : "var(--text-muted)",
                        boxShadow: galleryTab === key ? "0 2px 8px rgba(99,102,241,0.3)" : "none" }}>
                      {label} ({tabCounts[key]})
                    </button>
                  ))}
                </div>

                {/* View Toggle — only for completed tab */}
                {galleryTab === "completed" && galleryCompleted.length > 0 && (
                  <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10, gap: 4 }}>
                    <button onClick={() => setGalleryView("masonry")}
                      style={{ padding: "6px 10px", border: "1px solid var(--glass-border)", borderRadius: 6, cursor: "pointer", fontSize: 14, background: galleryView === "masonry" ? "rgba(99,102,241,0.15)" : "transparent", color: galleryView === "masonry" ? "var(--accent)" : "var(--text-muted)" }}
                      title="Masonry grid view">⊞</button>
                    <button onClick={() => setGalleryView("vertical")}
                      style={{ padding: "6px 10px", border: "1px solid var(--glass-border)", borderRadius: 6, cursor: "pointer", fontSize: 14, background: galleryView === "vertical" ? "rgba(99,102,241,0.15)" : "transparent", color: galleryView === "vertical" ? "var(--accent)" : "var(--text-muted)" }}
                      title="Vertical list view">☰</button>
                  </div>
                )}

                {/* Completed outputs */}
                {galleryTab === "completed" && (
                  galleryCompleted.length === 0 ? (
                    <div className="empty-state"><div className="emoji">🖼️</div><div className="msg">Completed outputs will appear here.</div></div>
                  ) : galleryView === "masonry" ? (
                    /* 3-column thumbnail grid — tap to lightbox, long-press for info */
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 4 }}>
                      {galleryCompleted.flatMap(task =>
                        (task.outputs || []).map((url, i) => {
                          const gType = task.genType || "";
                          const isVideo = url.includes(".mp4") || url.includes("video") || gType === "t2v" || gType === "i2v" || gType === "avatar";
                          return (
                            <div key={`${task.id}-${i}`} style={{ position: "relative", aspectRatio: "1", overflow: "hidden", borderRadius: 6, cursor: "pointer", background: "#111" }}
                              onClick={() => setLightbox(url)}
                              onContextMenu={e => { e.preventDefault(); setLightbox({ url, task }); }}>
                              {isVideo
                                ? <video src={url} muted playsInline style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                                : <img src={url} alt="" loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />}
                              {isVideo && <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", fontSize: 24, color: "white", textShadow: "0 1px 4px rgba(0,0,0,0.6)", pointerEvents: "none" }}>▶</div>}
                              <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, padding: "16px 4px 3px", background: "linear-gradient(transparent, rgba(0,0,0,0.7))", fontSize: 8, color: "rgba(255,255,255,0.8)", fontFamily: font, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {task.modelName}
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  ) : (
                    /* Vertical list — full-width previews with detailed info */
                    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                      {galleryCompleted.map(task => (
                        <div key={task.id} className="task-card">
                          <div className="task-header">
                            <span className="task-model">{task.modelName}</span>
                            <span className="task-status completed">COMPLETED</span>
                          </div>
                          <div style={{ fontSize: 12, color: "var(--text-secondary)", margin: "4px 0" }}>{task.prompt}</div>
                          {task.outputs?.map((url, i) => {
                            const gType = task.genType || "";
                            const isVideo = url.includes(".mp4") || url.includes("video") || gType === "t2v" || gType === "i2v" || gType === "avatar";
                            return isVideo
                              ? <video key={i} className="result-video" src={url} controls muted playsInline onClick={() => setLightbox(url)} />
                              : <img key={i} className="result-img" src={url} alt="" onClick={() => setLightbox(url)} />;
                          })}
                          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: 11, color: "var(--text-muted)", fontFamily: font }}>
                            <span>{task.provider}</span>
                            <span>{formatTime(task.wallClockMs)}</span>
                            <span>{formatCost(task.price)}</span>
                            <span>{task.endTime ? formatTimestamp(task.endTime) : timeAgo(task.endTime)}</span>
                          </div>
                          {task.sourceImageUrl && (
                            <div style={{ marginTop: 6, fontSize: 10, color: "var(--text-muted)" }}>
                              Source: <a href={task.sourceImageUrl} target="_blank" rel="noopener" style={{ color: "var(--accent)" }}>{task.sourceImageUrl.slice(0, 50)}...</a>
                              {task.sourceImageUrls?.length > 0 && ` + ${task.sourceImageUrls.length} ref(s)`}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )
                )}

                {/* Processing — Live status cards */}
                {galleryTab === "processing" && (
                  galleryProcessing.length === 0 ? (
                    <div className="empty-state"><div className="emoji">⏳</div><div className="msg">No generations currently processing.</div></div>
                  ) : (
                    <div className="results-grid">
                      {galleryProcessing.map(task => (
                        <div key={task.id} className="task-card">
                          <div className="task-header">
                            <span className="task-model">{task.modelName}</span>
                            <span className={`task-status ${task.status}`}>{task.status.toUpperCase()}</span>
                          </div>
                          <div style={{ fontSize: 11, color: "var(--text-muted)", margin: "4px 0" }}>{task.prompt?.slice(0, 80)}</div>
                          <div className="task-timer">{formatTime(task.wallClockMs || (Date.now() - task.startTime))}</div>
                          <div className="task-progress"><div className="task-progress-fill" style={{ width: `${Math.min(95, ((Date.now() - task.startTime) / 60000) * 100)}%` }} /></div>
                          <div style={{ marginTop: 8 }}>
                            <button className="result-action-btn" onClick={() => cancelTask(task.id)}>✕ Cancel</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )
                )}

                {/* Failed — Full debug info */}
                {galleryTab === "failed" && (
                  galleryFailed.length === 0 ? (
                    <div className="empty-state"><div className="emoji">✓</div><div className="msg">No failed generations. Looking good!</div></div>
                  ) : (
                    <div className="results-grid">
                      {galleryFailed.map(task => (
                        <div key={task.id} className="task-card" style={{ borderColor: "rgba(239,68,68,0.2)" }}>
                          <div className="task-header">
                            <span className="task-model">{task.modelName}</span>
                            <span className="task-status failed">FAILED</span>
                          </div>
                          <div style={{ fontSize: 12, color: "var(--error)", margin: "6px 0", fontFamily: font, background: "rgba(239,68,68,0.08)", padding: "8px 10px", borderRadius: 6, wordBreak: "break-word" }}>
                            {task.error || "Unknown error"}
                          </div>
                          <div style={{ fontSize: 10, color: "var(--text-muted)", lineHeight: 1.6, fontFamily: font }}>
                            <div><strong>Model ID:</strong> {task.modelId}</div>
                            <div><strong>Provider:</strong> {task.provider}</div>
                            <div><strong>Gen Type:</strong> {task.genType || "unknown"}</div>
                            <div><strong>Resolution:</strong> {task.resolution || "default"}</div>
                            <div><strong>Duration:</strong> {task.duration || "N/A"}</div>
                            <div><strong>Seed:</strong> {task.seed || "-1"}</div>
                            <div><strong>Aspect:</strong> {task.aspectRatio || "auto"}</div>
                            <div><strong>Prompt:</strong> <span style={{ color: "var(--text-secondary)" }}>{task.prompt?.slice(0, 120)}</span></div>
                            <div><strong>Time:</strong> {task.startTime ? formatTimestamp(task.startTime) : "unknown"}</div>
                          </div>
                          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                            <button className="result-action-btn" style={{ color: "var(--accent)" }} onClick={() => regenerateTask(task)}>🔄 Retry</button>
                            <button className="result-action-btn" onClick={() => { navigator.clipboard?.writeText(JSON.stringify({ modelId: task.modelId, error: task.error, prompt: task.prompt, resolution: task.resolution, duration: task.duration, seed: task.seed, genType: task.genType }, null, 2)); }}>📋 Copy Debug</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )
                )}
              </div>
              );
            })()}

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
                    <strong style={{ color: "var(--text-primary)" }}>ProximaAI v1.0</strong> — Parallel AI Generation Cockpit<br />
                    {Object.values(MODELS).flat().length} models registered across {Object.keys(MODELS).length} categories<br />
                    Powered by WaveSpeed.ai unified API
                  </div>
                </div>

                {logs.length > 0 && (
                  <div className="setting-group">
                    <div className="setting-label">Data</div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button className="api-test-btn" style={{ background: "var(--error)" }} onClick={() => { if (confirm("Clear all generation logs?")) { setLogs([]); clearHistory(); } }}>Clear Logs ({logs.length})</button>
                      <button className="api-test-btn" onClick={() => { if (confirm("Clear all generation outputs?")) { setTasks([]); clearTasksDB(); savedTaskIds.current.clear(); } }}>Clear All Outputs</button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Lightbox */}
        {lightbox && (() => {
          const lbUrl = typeof lightbox === "string" ? lightbox : lightbox.url;
          const lbTask = typeof lightbox === "object" ? lightbox.task : null;
          const isVid = lbUrl?.includes(".mp4") || lbUrl?.includes("video");
          return (
            <div className="lightbox" onClick={() => setLightbox(null)}>
              <div onClick={e => e.stopPropagation()} style={{ display: "flex", flexDirection: "column", alignItems: "center", maxWidth: "94vw", maxHeight: "94vh" }}>
                {isVid
                  ? <video src={lbUrl} controls autoPlay muted style={{ maxWidth: "92vw", maxHeight: lbTask ? "70vh" : "92vh", borderRadius: 10 }} />
                  : <img src={lbUrl} alt="Full resolution" style={{ maxWidth: "92vw", maxHeight: lbTask ? "70vh" : "92vh", borderRadius: 10, objectFit: "contain" }} />}
                {lbTask && (
                  <div style={{ marginTop: 10, padding: "12px 16px", background: "rgba(8,12,25,0.85)", borderRadius: 10, width: "92vw", maxHeight: "22vh", overflowY: "auto", border: "1px solid var(--glass-border)" }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>{lbTask.modelName}</div>
                    <div style={{ fontSize: 12, color: "var(--text-secondary)", margin: "4px 0" }}>{lbTask.prompt}</div>
                    <div style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: font, display: "flex", flexWrap: "wrap", gap: "6px 16px", marginTop: 6 }}>
                      <span>Provider: {lbTask.provider}</span>
                      <span>Time: {formatTime(lbTask.wallClockMs)}</span>
                      <span>Cost: {formatCost(lbTask.price)}</span>
                      <span>Seed: {lbTask.seed || "-1"}</span>
                      <span>{lbTask.endTime ? formatTimestamp(lbTask.endTime) : ""}</span>
                    </div>
                    <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                      <button className="result-action-btn" onClick={async () => {
                        try { const r = await fetch(lbUrl); const b = await r.blob(); const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = `${lbTask.modelName.replace(/\s+/g,"_")}_${Date.now()}.${isVid?"mp4":"png"}`; a.click(); URL.revokeObjectURL(a.href); } catch { window.open(lbUrl,"_blank"); }
                      }}>↓ Save</button>
                      <button className="result-action-btn" onClick={() => { navigator.clipboard?.writeText(lbUrl); }}>📋 URL</button>
                      <button className="result-action-btn" onClick={() => setLightbox(null)}>✕ Close</button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })()}
      </div>
    </>
  );
}
