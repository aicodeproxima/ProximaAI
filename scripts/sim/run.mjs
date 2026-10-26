// Long mode of the delete/restore/sync simulator. Runs seeds in persistent worker threads (jobs of `chunk` seeds), groups
// the violations by signature, shrinks the first seed of each group to a minimal operation list and prints it as a
// readable trace (then the same ops run to quiescence, to show whether the damage stays).
//   node scripts/sim/run.mjs --seeds 2000 --steps 200              2000 seeds x 200 ops, network mode fifo
//   node scripts/sim/run.mjs --minutes 10 --steps 200 --net all     as many seeds as fit in 10 minutes, every network mode
//   node scripts/sim/run.mjs --seed 176 --steps 120 --trace         one seed, full trace (no shrinking)
// Options: --start S (first seed, 1) --net fifo|window|any|all (fifo) --workers K (min(12, cpus-1)) --chunk C (seeds per job, 25)
// --shrink N (groups to shrink, 8) --budget B (runs per shrink, 300) --json FILE (the summary as JSON)
// --server v1|v2|v3|v4 (the fake server's rules: v1 = before 20261023500000; v2 = 20261023500000;
// v3 = v2 + 20261024100000 (K2: History uploads lose items a restore removed); v4 = v3 + 20261025900000 (form holds keep the newest; live, the default), see server.mjs).
// Exit code 0 always (it is a search tool); the summary says what was found.
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { cpus } from "node:os";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);

if (!isMainThread) {
  const { runOps, genOps } = await import("./sim.mjs");
  const { shrink, explain } = await import("./shrink.mjs");
  const { setServerRule } = await import("./server.mjs");
  // A persistent worker: it runs jobs until told to stop (one module graph per worker; storage.js instances are pooled,
  // so memory stays bounded however many seeds it runs). A one-off job comes as workerData.
  const handle = async (job) => {
  setServerRule(job.server || "v4");
  if (job.mode === "seeds") {
    const out = [], totals = {};
    for (let s = job.from; s < job.to; s++) {
      const r = await runOps(genOps(s, job.steps), { net: job.net });
      for (const [k, v] of Object.entries(r.stats)) totals[k] = (totals[k] || 0) + v;
      out.push({ seed: s, violations: r.violations.map(v => ({ code: v.code, step: v.step, msg: v.msg })) });
    }
    return { out, totals };
  } else if (job.mode === "shrink") {
    const r = await shrink(genOps(job.seed, job.steps), job.sig, { net: job.net, budget: job.budget });
    return { ...r, ...(await explain(r.ops, { net: job.net })) };
  } else if (job.mode === "trace") {
    const r = await runOps(genOps(job.seed, job.steps), { net: job.net, traceOn: true, stopOnViolation: false });
    return { text: r.lines.join("\n"), violations: r.violations, events: r.server.events };
  }
  };
  if (workerData) parentPort.postMessage(await handle(workerData));
  else parentPort.on("message", async (job) => { if (job === "stop") process.exit(0); parentPort.postMessage(await handle(job)); });
} else {
  const { signature, NET_MODES } = await import("./sim.mjs");
  const { SERVER_RULES } = await import("./server.mjs");
  const args = process.argv.slice(2);
  const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? (args[i + 1] ?? true) : dflt; };
  const steps = Number(opt("steps", 200)), start = Number(opt("start", 1)), chunk = Number(opt("chunk", 25));
  const workers = Number(opt("workers", Math.max(1, Math.min(12, cpus().length - 1))));
  const minutes = opt("minutes", null) ? Number(opt("minutes")) : null;
  const seeds = minutes ? Infinity : Number(opt("seeds", 1000));
  const netOpt = String(opt("net", "fifo"));
  const modes = netOpt === "all" ? NET_MODES : [netOpt];
  const shrinkN = Number(opt("shrink", 8)), budget = Number(opt("budget", 300));
  const server = String(opt("server", "v4"));   // v4 is live (20261025900000, applied 2026-10-26 00:02 UTC)
  if (!SERVER_RULES.includes(server)) { console.error(`unknown --server ${server} (${SERVER_RULES.join("|")})`); process.exit(2); }
  console.log(`server rule ${server}`);
  // Persistent workers for the seed sweep (one per pump); one-off workers for shrink / trace jobs.
  const persistent = () => {
    const w = new Worker(SELF);
    let pending = null;
    w.on("message", (m) => { const p = pending; pending = null; p?.resolve(m); });
    w.on("error", (e) => { const p = pending; pending = null; p?.reject(e); });
    return { run: (data) => new Promise((resolve, reject) => { pending = { resolve, reject }; w.postMessage(data); }), stop: () => w.terminate() };
  };
  const runJob = (data) => new Promise((resolve, reject) => {
    const w = new Worker(SELF, { workerData: data });
    w.once("message", resolve); w.once("error", reject);
    w.once("exit", (c) => { if (c !== 0) reject(new Error(`worker exit ${c}`)); });
  });

  if (opt("trace", false)) {
    const r = await runJob({ mode: "trace", seed: Number(opt("seed", start)), steps, net: modes[0], server });
    console.log(r.text);
    console.log("\n# server log (last 400 events)\n" + r.events.join("\n"));
    process.exit(0);
  }

  const t0 = Date.now();
  const summary = { steps, modes, server, runs: {}, totals: {}, groups: {}, wallMs: 0 };
  for (const [mi, net] of modes.entries()) {
    const modeDeadline = minutes ? t0 + (minutes * 60_000 * (mi + 1)) / modes.length : Infinity;
    let next = start;
    const end = start + seeds;
    summary.runs[net] = 0;
    const pump = async () => {
      const w = persistent();
      try {
      while (next < end && Date.now() < modeDeadline) {
        const from = next, to = Math.min(end, next + chunk);
        next = to;
        const r = await w.run({ mode: "seeds", from, to, steps, net, server });
        summary.runs[net] += r.out.length;
        for (const [k, v] of Object.entries(r.totals)) summary.totals[k] = (summary.totals[k] || 0) + v;
        for (const { seed, violations } of r.out) for (const v of violations) {
          const sig = signature(v), key = `${net} | ${sig}`;
          const g = summary.groups[key] || (summary.groups[key] = { count: 0, seeds: [], code: v.code, net, sig, example: v.msg, seed, step: v.step });
          g.count++; if (g.seeds.length < 12 && !g.seeds.includes(seed)) g.seeds.push(seed);
        }
      }
      } finally { await w.stop(); }
    };
    await Promise.all(Array.from({ length: workers }, pump));
    console.log(`[${((Date.now() - t0) / 1000).toFixed(0)} s] ${net}: ${summary.runs[net]} seeds (${start}..${next - 1})`);
  }
  summary.wallMs = Date.now() - t0;
  const total = Object.values(summary.runs).reduce((a, b) => a + b, 0);
  console.log(`\n${total} runs x ${steps} ops in ${(summary.wallMs / 1000).toFixed(0)} s; coverage: ${JSON.stringify(summary.totals)}`);
  const groups = Object.entries(summary.groups).sort((a, b) => b[1].count - a[1].count);
  console.log(`${groups.length} violation signature(s)`);
  for (const [key, g] of groups) console.log(`  ${String(g.count).padStart(5)}  ${key}\n         seeds ${g.seeds.join(",")}`);
  const picks = groups.filter(([, g]) => !g.code.endsWith("-info")).slice(0, shrinkN);   // I2-info, I7-info: by design, not shrunk
  const shrunk = await Promise.all(picks.map(([key, g]) => runJob({ mode: "shrink", seed: g.seed, steps, net: g.net, sig: g.sig, budget, server })
    .then(r => ({ key, g, r })).catch(e => ({ key, g, err: String(e) }))));
  for (const { key, g, r, err } of shrunk) {
    console.log(`\n════ ${key}\n     seed ${g.seed} (${g.count} hits)`);
    if (err) { console.log(`     shrink failed: ${err}`); continue; }
    console.log(`     minimal: ${r.ops.length} ops after ${r.tests} runs${r.reproduced ? "" : " (NOT reproduced)"}`);
    console.log(r.text.split("\n").map(l => "     " + l).join("\n"));
    console.log(`     ── the same ops run to the end:\n${r.endState.split("\n").map(l => "     " + l).join("\n")}`);
    if (r.endViolations.length) console.log(r.endViolations.map(l => "     end: " + l).join("\n"));
    g.minimal = { ops: r.ops, text: r.text, endState: r.endState, endViolations: r.endViolations };
  }
  if (opt("json", null)) writeFileSync(String(opt("json")), JSON.stringify(summary, null, 2));
}
