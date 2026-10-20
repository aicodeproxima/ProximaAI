// cdp.mjs (ProximaAI copy; phone: GC_PORT=9333 after `adb forward tcp:9333 localabstract:chrome_devtools_remote`) - drive ONE page tab over CDP (Node global WebSocket, no deps).
// Scope rule: only a tab whose URL contains GC_HOST is ever touched; owner tabs are never listed as targets.
//   node cdp.mjs eval  '<js expression, may be async>'      -> prints JSON of the awaited value
//   node cdp.mjs nav   'https://www.gospelcentral.app/path' -> navigates, waits for load, prints final URL
//   node cdp.mjs url                                         -> prints the tab's current URL
//   node cdp.mjs front                                       -> brings the tab to front (rAF throttling otherwise)
//   node cdp.mjs emulate 384x741                             -> phone-width layout on the rig (mobile UA + touch)
//   node cdp.mjs emulate off                                 -> clears the emulation
// Exit 7 on any transport failure so a caller can tell "probe broke" from "assertion failed".
const PORT = process.env.GC_PORT || '9223';
const GC_HOST = 'proxima-ai-seven.vercel.app';
const [cmd, arg] = process.argv.slice(2);
// No answer within CDP_TIMEOUT_MS (default 20s) = transport failure, exit 7. A Runtime.evaluate whose
// page context is destroyed by a navigation never resolves; without this a caller hangs forever
// (the phone watchdog did, 2026-09-19). unref(): a normal completion is not delayed by the timer.
const CDP_TIMEOUT_MS = Number(process.env.CDP_TIMEOUT_MS || 20000);
setTimeout(() => { console.error('CDP-TRANSPORT-FAILURE: no answer in ' + CDP_TIMEOUT_MS + 'ms'); process.exit(7); }, CDP_TIMEOUT_MS).unref();

async function target() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const pages = list.filter((t) => t.type === 'page' && t.url.includes(GC_HOST));
  // GC_TARGET pins ONE tab, so several drivers can work in parallel without touching each other's tab
  // (and never an owner tab: the host filter still applies). Without it the single-tab rule stands.
  if (process.env.GC_TARGET) {
    const hit = pages.find((t) => t.id === process.env.GC_TARGET);
    if (!hit) throw new Error(`GC_TARGET ${process.env.GC_TARGET} is not one of the ${pages.length} ${GC_HOST} tabs`);
    return hit;
  }
  // GC_ANY: for callers that only need SOME app tab (the phone watchdog's wake lock works from any
  // page). Without it the single-tab rule stands, so a drive can never touch the wrong tab.
  if (pages.length !== 1 && !process.env.GC_ANY) throw new Error(`expected exactly one ${GC_HOST} page tab, found ${pages.length} (set GC_TARGET to pick one, or GC_ANY=1 if any will do)`);
  if (!pages.length) throw new Error(`no ${GC_HOST} page tab open`);
  return pages[0];
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const events = [];
    ws.onopen = () => resolve({ ws, send, events });
    ws.onerror = (e) => reject(new Error('ws error ' + (e.message || '')));
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
      else if (d.method) events.push(d);
    };
    function send(method, params = {}) {
      return new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    }
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  // Tab management runs BEFORE any target is resolved: there may be none or many, which is the point.
  if (cmd === 'tabs' || cmd === 'open' || cmd === 'close') {
    if (cmd === 'tabs') {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      console.log(JSON.stringify(list.filter((t) => t.type === 'page' && t.url.includes(GC_HOST)).map((t) => ({ id: t.id, url: t.url }))));
    } else if (cmd === 'open') {
      if (!arg || !arg.includes(GC_HOST)) throw new Error('open takes a ' + GC_HOST + ' url');
      const t2 = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(arg)}`, { method: 'PUT' })).json();
      console.log(JSON.stringify({ id: t2.id, url: t2.url }));
    } else {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const hit = list.find((t) => t.id === arg && t.type === 'page' && t.url.includes(GC_HOST));
      if (!hit) throw new Error('close: ' + arg + ' is not a ' + GC_HOST + ' tab');  // never an owner tab
      await fetch(`http://127.0.0.1:${PORT}/json/close/${arg}`);
      console.log('closed ' + arg);
    }
    process.exit(0);
  }
  const t = await target();
  const { ws, send, events } = await connect(t.webSocketDebuggerUrl);
  await send('Page.enable');
  await send('Runtime.enable');
  if (cmd === 'front') {
    // A background tab throttles rAF, so framer-motion exit animations never finish and
    // AnimatePresence mode="wait" never mounts the next wizard step. Front + focus first.
    await send('Page.bringToFront');
    await send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await sleep(1500);
    const r = await send('Runtime.evaluate', { expression: 'JSON.stringify({visible: document.visibilityState, focus: document.hasFocus()})', returnByValue: true });
    console.log(r.result.result.value);
  } else if (cmd === 'emulate') {
    // Phone-width layout on the desktop rig: the app's md: breakpoints follow the EMULATED width, so the
    // <md agenda and the compact toolbar render. Not a substitute for the owner's phone (different
    // engine build, DPR, IME) - a way to drive the phone layout with a zz seat, which the phone (the
    // owner's real session) must never do.
    if (arg === 'off') {
      // Measured 2026-09-19: clearDeviceMetricsOverride ALONE left the tab at the emulated width on this
      // Chrome. Overriding with zeroes first (CDP's "use the defaults" form) and then clearing releases
      // it, and the reload settles the layout.
      await send('Emulation.setDeviceMetricsOverride', { width: 0, height: 0, deviceScaleFactor: 0, mobile: false });
      await send('Emulation.clearDeviceMetricsOverride');
      await send('Emulation.setTouchEmulationEnabled', { enabled: false });
      await send('Emulation.setUserAgentOverride', { userAgent: '' });
      await send('Page.reload');
      await sleep(2500);
      const r = await send('Runtime.evaluate', { expression: 'innerWidth + "x" + innerHeight + " dpr=" + devicePixelRatio', returnByValue: true });
      console.log('emulation cleared -> ' + r.result.result.value);
    } else {
      const [w, h] = String(arg || '384x741').split('x').map(Number);
      await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 3.75, mobile: true });
      await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      await send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 16; SM-S928U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36' });
      await sleep(400);
      const r = await send('Runtime.evaluate', { expression: 'innerWidth + "x" + innerHeight + " dpr=" + devicePixelRatio', returnByValue: true });
      console.log('emulating ' + r.result.result.value);
    }
  } else if (cmd === 'url') {
    const r = await send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
    console.log(r.result.result.value);
  } else if (cmd === 'nav') {
    await send('Page.navigate', { url: arg });
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      if (events.some((e) => e.method === 'Page.loadEventFired')) break;
      await sleep(150);
    }
    await sleep(600);
    const r = await send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
    console.log(r.result.result.value);
  } else if (cmd === 'eval') {
    // EVERY eval fronts + focus-emulates FIRST, in THIS session. Measured 2026-09-19: a CDP session's
    // Emulation overrides are reverted when that session detaches, and cdp.mjs opens one session per
    // command - so a `front` from an earlier call is already gone. Without focus the tab is throttled,
    // framer-motion's exit never completes and AnimatePresence mode="wait" never mounts the next wizard
    // step: the drive reads a stale panel while the step counter has already moved (it did, twice).
    // GC_EMULATE=WxH re-applies a phone viewport in this same session for the same reason.
    // Keep THIS tab live without stealing the foreground: with several drivers running, a bringToFront
    // per call would have them fighting and the losers throttled. Focus emulation + an 'active' web
    // lifecycle keeps rAF running in a background tab, which is what framer-motion's AnimatePresence
    // needs to finish an exit (measured 2026-09-19: a throttled tab froze the wizard mid-step).
    // GC_FRONT=1 when a human should actually watch.
    if (process.env.GC_FRONT) await send('Page.bringToFront');
    await send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await send('Page.setWebLifecycleState', { state: 'active' });
    if (process.env.GC_EMULATE) {
      const [w, h] = String(process.env.GC_EMULATE).split('x').map(Number);
      await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 3.75, mobile: true });
      await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      await sleep(350);
    }
    const r = await send('Runtime.evaluate', { expression: `(async () => (${arg}))()`, awaitPromise: true, returnByValue: true });
    if (!r.result) throw new Error('no result (context destroyed by a navigation?): ' + JSON.stringify(r.error || r).slice(0, 160));
    if (r.result.exceptionDetails) { console.log(JSON.stringify({ EXCEPTION: r.result.exceptionDetails.text, detail: r.result.exceptionDetails.exception?.description?.slice(0, 300) })); }
    else console.log(JSON.stringify(r.result.result.value));
  } else {
    throw new Error('usage: cdp.mjs url | nav <url> | front | emulate <WxH>|off | tabs | open <url> | close <id> | eval <js>   (GC_TARGET pins a tab)');
  }
  ws.close();
} catch (e) {
  console.error('CDP-TRANSPORT-FAILURE:', e.message);
  process.exit(7);
}
