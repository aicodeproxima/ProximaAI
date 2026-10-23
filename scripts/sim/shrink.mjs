// Delta debugging (ddmin) of a failing operation list down to a minimal reproduction: a violation with the SAME
// signature (sim.mjs signature: code + message shape) must still occur, so the shrinker never slides to another bug.
// Every op is data resolved at run time (sim.mjs), so every sub-list is a valid run. After ddmin, a one-at-a-time pass
// removes each remaining op that is not needed. `budget`: the maximum number of runs.
import { runOps, fmtOp, signature } from "./sim.mjs";

export async function shrink(ops, sig, { net = "fifo", budget = 300, log = () => {} } = {}) {
  let tests = 0;
  const hit = (r) => r.violations.find(v => signature(v) === sig);
  const fails = async (cand) => { tests++; return !!hit(await runOps(cand, { net })); };
  // A violation found during the run stops it at its step: everything after that step is irrelevant.
  let cur = ops.slice();
  {
    const v = hit(await runOps(cur, { net })); tests++;
    if (!v) return { ops: cur, tests, reproduced: false };
    if (v.step < cur.length) cur = cur.slice(0, v.step + 1);
  }
  let n = 2;
  while (cur.length >= 2 && tests < budget) {
    const chunk = Math.ceil(cur.length / n);
    let reduced = false;
    for (let i = 0; i < n && tests < budget; i++) {
      const comp = [...cur.slice(0, i * chunk), ...cur.slice((i + 1) * chunk)];
      if (comp.length && comp.length < cur.length && await fails(comp)) { cur = comp; n = Math.max(n - 1, 2); reduced = true; log(`  ddmin: ${cur.length} ops (${tests} runs)`); break; }
    }
    if (!reduced) { if (n >= cur.length) break; n = Math.min(cur.length, n * 2); }
  }
  for (let i = cur.length - 1; i >= 0 && tests < budget; i--) {
    const cand = [...cur.slice(0, i), ...cur.slice(i + 1)];
    if (cand.length && await fails(cand)) cur = cand;
  }
  return { ops: cur, tests, reproduced: true };
}

// The minimal run, replayed with the trace on: every op, every write it sent and the server ran, the violation, and the
// end state; then the same ops run to quiescence, to show whether the damage stays.
export async function explain(ops, { net = "fifo" } = {}) {
  const r = await runOps(ops, { net, traceOn: true });
  const cont = await runOps(ops, { net, traceOn: true, stopOnViolation: false });
  return { text: [`ops (${ops.length}): ${ops.map(fmtOp).join(" ; ")}`, ...r.lines].join("\n"), violations: r.violations,
    endState: cont.lines.filter(l => l.startsWith("# ")).join("\n"), endViolations: cont.violations.map(v => `${v.code}: ${v.msg}`) };
}
