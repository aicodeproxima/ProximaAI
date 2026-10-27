// Paste into the ProximaAI page (Claude in Chrome javascript_tool, or cdp.mjs eval) to install helpers on window.__px.
// Measured selectors: docs/page-map.md. Long work never blocks a single tool call (45 s limit): start it, then poll.
window.__px = (() => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = s => [...document.querySelectorAll(s)].find(b => b.offsetParent !== null) || document.querySelector(s);
  const toggle = el => (el.querySelector('input,button,[role=checkbox]') || el.firstElementChild).click();
  const idb = (store, fn) => new Promise(res => { const r = indexedDB.open("proximaai");
    r.onsuccess = () => { const q = fn(r.result.transaction(store).objectStore(store)); q.onsuccess = () => { r.result.close(); res(q.result); }; }; });
  const setReact = (el, proto, value, event) => { Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value); el.dispatchEvent(new Event(event, { bubbles: true })); };
  const api = {
    page: async name => { (name === "cockpit" ? document.querySelector("button.sidebar-btn") : vis(`button[title="${name}"]`)).click(); await sleep(700); },
    tab: async label => { [...document.querySelectorAll(".type-tab")].find(t => t.textContent.includes(label) && (label !== "Image" || !/Edit|→/.test(t.textContent)))?.click(); await sleep(500); },
    // Select exactly one model by its visible name; returns the selected names.
    selectOnly: async name => {
      for (const s of [...document.querySelectorAll(".model-item.selected")]) { toggle(s); await sleep(200); }
      const item = [...document.querySelectorAll(".model-item")].find(i => i.querySelector(".model-name")?.textContent.trim() === name);
      if (item) { toggle(item); await sleep(400); }
      return [...document.querySelectorAll(".model-item.selected .model-name")].map(e => e.textContent.trim());
    },
    prompt: async text => { setReact(document.querySelector('textarea[placeholder^="Describe"]'), HTMLTextAreaElement.prototype, text, "input"); await sleep(300); },
    batch: async n => { const sel = [...document.querySelectorAll(".settings-row")].find(r => r.querySelector("label")?.textContent.trim() === "Batch")?.querySelector("select");
      if (sel) { setReact(sel, HTMLSelectElement.prototype, String(n), "change"); await sleep(300); } return sel?.value; },
    // Start a generation and return at once; poll api.result() afterwards.
    start: () => { const b = document.querySelector(".gen-btn"); if (!b || b.disabled) return false; window.__pxRun = { at: Date.now(), done: false };
      b.click(); (async () => { await sleep(1500); while (document.querySelector(".task-progress-fill")) await sleep(700); window.__pxRun.done = true; window.__pxRun.ms = Date.now() - window.__pxRun.at; })(); return true; },
    result: () => window.__pxRun,
    // WaveSpeed balance through the proxy (the key has been server-only since 2026-10-20; a kie.ai-only account gets 400).
    rawBalance: async () => { const token = JSON.parse(localStorage["proximaai-session"]).token;
      const j = await (await fetch("/api/wavespeed-v2/api/v3/balance", { headers: { "X-Proxima-Session": token } })).json();
      return j?.data?.balance ?? j?.balance; },
    snapshot: async () => { const tasks = await idb("tasks", s => s.getAll()); const history = await idb("history", s => s.count());
      return { bundle: [...document.scripts].map(s => s.src).find(s => s.includes("/assets/index-"))?.split("/").pop(),
        tasks: tasks.length, finished: tasks.filter(t => t.status === "completed" || t.status === "failed").length, history,
        queue: JSON.parse(localStorage.getItem("proximaai-failed-syncs") || "[]").length }; },
    // Delete ONLY rows whose prompt is in `prompts` (Gallery cards and Logs rows); aborts on any foreign selection.
    deleteByPrompt: async prompts => {
      const mine = el => prompts.some(p => el.textContent.includes(p)); const out = {};
      const realConfirm = window.confirm; window.confirm = () => true;
      try {
        for (const [page, item, selected, label] of [["Gallery", ".task-card", ".task-card.card-selected", "tasks"], ["Logs", ".log-row:not(.log-header)", ".log-row.log-row-selected", "logs"]]) {
          await api.page(page); vis(".sel-launch")?.click(); await sleep(400);
          const targets = [...document.querySelectorAll(item)].filter(mine);
          for (const t of targets) { t.click(); await sleep(200); }
          const sel = [...document.querySelectorAll(selected)];
          if (targets.length && sel.length === targets.length && sel.every(mine)) { vis(".sel-del").click(); await sleep(4000); out[label] = targets.length; }
          else { vis(".sel-cancel")?.click(); out[label] = "skipped (" + sel.length + " selected, " + targets.length + " mine)"; }
        }
      } finally { window.confirm = realConfirm; }
      return out;
    },
  };
  return api;
})();
"window.__px ready";
