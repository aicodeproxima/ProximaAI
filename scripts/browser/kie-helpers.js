// Paste into a signed-in ProximaAI page (Playwright browser_evaluate, Claude in Chrome javascript_tool, or cdp.mjs eval)
// to install window.__kt: a budget-guarded driver for paid kie.ai test generations. Measured live 2026-10-27 (bundle
// ac35aaf, DJI account, 21 kie.ai models): see "kie.ai" in docs/page-map.md. Every call returns within ~40 s; start
// work, then poll.
//   await __kt.run({ models: ["Flux 3 Klein · kie.ai"], settings: { Resolution: "1K" }, prompt: "[TEST_...] ...", maxUsd: 0.009 })
//   await __kt.poll(9)   // the newest 9 cards until DONE/FAILED or ~36 s
window.__kt = (() => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const token = () => JSON.parse(localStorage["proximaai-session"]).token;
  const toggle = el => (el.querySelector("input,button,[role=checkbox]") || el.firstElementChild).click();
  const setReact = (el, proto, value, ev) => { Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value); el.dispatchEvent(new Event(ev, { bubbles: true })); };
  const USD_PER_CREDIT = 0.005;
  const api = {
    // kie.ai credits (2 decimals) through the app's proxy; the key never reaches the browser.
    credits: async () => (await (await fetch("/api/kie/api/v1/chat/credit", { headers: { "X-Proxima-Session": token() } })).json()).data,
    // Tab labels carry an icon and a short form ("🎬Text → VideoT→V"): match by the long name.
    tab: async name => { const t = [...document.querySelectorAll(".type-tab")].find(t => t.textContent.includes(name)); t?.click(); await sleep(700); return !!t; },
    select: async names => {
      for (const s of [...document.querySelectorAll(".model-item.selected")]) { toggle(s); await sleep(120); }
      const missing = [];
      for (const n of names) {
        const it = [...document.querySelectorAll(".model-item")].find(i => i.querySelector(".model-name")?.textContent.trim() === n);
        if (it) { toggle(it); await sleep(250); } else missing.push(n);
      }
      return { selected: [...document.querySelectorAll(".model-item.selected .model-name")].map(e => e.textContent.trim()), missing };
    },
    prompt: async text => { setReact(document.querySelector('textarea[placeholder^="Describe"]'), HTMLTextAreaElement.prototype, text, "input"); await sleep(300); },
    // Visible settings rows. With several models selected, Resolution rows are labelled by model name; with one, "Resolution".
    // Aspect, Duration, Batch and Seed are shared by every selected model.
    settings: () => [...document.querySelectorAll(".settings-row")].filter(r => r.offsetParent !== null).map(r => {
      const s = r.querySelector("select"), i = r.querySelector("input");
      return { label: r.querySelector("label")?.textContent.trim(), value: s ? s.value : i ? (i.type === "checkbox" ? i.checked : i.value) : null, options: s ? [...s.options].map(o => o.value) : undefined };
    }),
    set: async (label, value) => {
      const r = [...document.querySelectorAll(".settings-row")].find(r => r.offsetParent !== null && r.querySelector("label")?.textContent.trim() === label);
      const s = r?.querySelector("select");
      if (!s) return "no row " + label;
      if (![...s.options].some(o => o.value === String(value))) return "no option " + value + " in " + [...s.options].map(o => o.value);
      setReact(s, HTMLSelectElement.prototype, String(value), "change"); await sleep(350); return s.value;
    },
    estimate: () => { const c = document.querySelector(".cost-amount"); return c ? { text: c.textContent.trim(), usd: Number(c.textContent.replace(/[^0-9.]/g, "")) } : null; },
    // Select, set, check the estimate against maxUsd and the credit floor, submit, and report the charge 6 s later.
    // Most kie.ai models charge at submit; Wan 3.0 charged at completion (measured 2026-10-27), so re-read credits after poll().
    run: async ({ models, settings = {}, prompt, maxUsd, floor = 0 }) => {
      const sel = await api.select(models);
      if (sel.missing.length) return { error: "missing " + sel.missing };
      const applied = {};
      for (const [k, v] of Object.entries(settings)) applied[k] = await api.set(k, v);
      if (prompt) await api.prompt(prompt);
      await sleep(600);
      const est = api.estimate(), before = await api.credits();
      const out = { applied, estimate: est?.text, estCredits: est && +(est.usd / USD_PER_CREDIT).toFixed(2), before };
      if (!(est?.usd > 0) || est.usd > maxUsd) return { ...out, error: `estimate ${est?.usd} over cap ${maxUsd}: NOT submitted` };
      if (before - est.usd / USD_PER_CREDIT < floor) return { ...out, error: `would cross floor ${floor}: NOT submitted` };
      const btn = document.querySelector(".gen-btn");
      if (btn.disabled) return { ...out, error: "generate disabled" };
      btn.click(); await sleep(6000);
      out.after = await api.credits(); out.charged = +(out.before - out.after).toFixed(2);
      return out;
    },
    // The newest n cards until all are DONE/FAILED or ~36 s pass.
    poll: async n => {
      const read = () => [...document.querySelectorAll(".task-card")].slice(0, n).map(c => ({
        model: c.querySelector(".task-model")?.textContent.trim(), status: c.querySelector(".task-status")?.textContent.trim(),
        timer: c.querySelector(".task-timer")?.textContent.trim().slice(0, 24), bar: c.querySelector(".task-progress-fill")?.style.width,
        error: c.querySelector(".task-error")?.textContent.trim().slice(0, 200),
        media: !!c.querySelector('img[src^="http"], video[src^="http"], video source[src^="http"]') }));
      const t0 = Date.now();
      while (Date.now() - t0 < 36000) { if (read().every(x => x.status === "DONE" || x.status === "FAILED")) break; await sleep(3000); }
      return { cards: read(), credits: await api.credits() };
    },
    // Real duration and size of each of the newest n cards' videos (a DONE card with a dead URL fails here).
    probeVideos: async n => {
      const probe = url => new Promise(res => {
        const v = document.createElement("video"); v.preload = "metadata"; v.muted = true;
        const done = r => { v.removeAttribute("src"); v.load(); res(r); };
        v.onloadedmetadata = () => done({ seconds: +v.duration.toFixed(2), w: v.videoWidth, h: v.videoHeight });
        v.onerror = () => done({ error: v.error?.code }); setTimeout(() => done({ error: "timeout" }), 15000); v.src = url;
      });
      const out = [];
      for (const c of [...document.querySelectorAll(".task-card")].slice(0, n)) {
        const el = c.querySelector("video"); const url = el?.currentSrc || el?.src || el?.querySelector("source")?.src;
        out.push({ model: c.querySelector(".task-model")?.textContent.trim(), ...(url ? await probe(url) : { error: "no video" }) });
      }
      return out;
    },
  };
  return api;
})();
"window.__kt ready";
