// The simulated NETWORK: every client->server call is a message the scheduler decides about (scripts/sim/sim.mjs).
// A message is sent by one page; the server runs it only when the scheduler delivers it, so calls from different tabs
// and devices interleave at the server in any order. Per message the scheduler can:
//   deliver  - the server runs it and the answer reaches the page (held while the page is frozen);
//   exec     - the server runs it now, the answer is held and delivered LATER (out of order with other answers);
//   lose     - the server runs it, the answer is lost (the page sees a network error);
//   fail     - the request never reaches the server (the page sees a network error).
// A page that was reloaded (or closed) never gets its answers; its sent requests may still run at the server.
export class Net {
  constructor(sim) { this.sim = sim; this.pending = []; this.seq = 0; }
  send(page, name, desc, exec) {
    if (!/^(pull|ids |tombstones|get_)/.test(name)) this.sim.trace(`  ${page.label} sends ${name} ${desc || ""}`);
    return new Promise((resolve, reject) => {
      this.pending.push({ seq: ++this.seq, page, name, desc, exec, state: "sent", result: undefined, error: null, resolve, reject });
    });
  }
  // Runs the request at the server (once). The server's answer is a JSON copy (the page never shares objects with it).
  execute(m) {
    if (m.state !== "sent") return;
    this.sim.clock.now += 1;
    try { const r = m.exec(); m.result = r === undefined ? undefined : JSON.parse(JSON.stringify(r)); }
    catch (e) { m.error = e; }
    m.state = "executed";
    if (!/^(pull|ids |tombstones|get_)/.test(m.name)) this.sim.trace(`  server ran ${m.page.label}:${m.name} ${m.desc || ""}`);
  }
  remove(m) { const i = this.pending.indexOf(m); if (i >= 0) this.pending.splice(i, 1); }
  // Answer an executed message (or fail one never run). Returns the page to settle, or null.
  answer(m, { error = false } = {}) {
    this.remove(m);
    if (!m.page.alive) return null;
    if (error || m.answerError || m.error) m.reject(m.error || new Error("network"));
    else m.resolve(m.result);
    return m.page;
  }
  // Messages whose answer can be handed to a live, unfrozen page or that belong to a dead page (run them, drop the answer).
  deliverable() { return this.pending.filter(m => !m.page.alive || !m.page.frozen); }
}
