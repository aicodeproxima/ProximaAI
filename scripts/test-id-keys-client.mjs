// Static check for the per-account id keys (P4, docs/MULTI-USER-PLAN.md; step (a) 20261025450000 made (device_id, id)
// unique on tasks, history and favorites): the browser's upserts must name a conflict target that survives step (c),
// the key swap from (id) to (device_id, id). An explicit onConflict "id" stops working once id alone is no longer unique
// (PostgREST: no unique or exclusion constraint matching the ON CONFLICT specification), so step (c) waits 24 h after
// this ships. An upsert that names no target is not safe either: PostgREST then uses the primary key from its schema
// cache, which is still (id) between the swap and PostgREST's reload, so the write fails with 42P10 in that window
// (step (c) review, the other session's Low 1). Checked: no onConflict "id" anywhere in src/; every upsert of tasks,
// history or favorites anywhere in src/ names "device_id,id"; src/lib/supabase.js holds the known ones (tasks and
// history two each, favorites one), so a pattern that matches nothing cannot pass.
// Pure: reads src/. Run: node scripts/test-id-keys-client.mjs [checkout] (part of npm test).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.argv[2] || path.join(here, ".."));
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(d, e.name)) : /\.(js|jsx|mjs|ts|tsx)$/.test(e.name) ? [path.join(d, e.name)] : []);
const src = walk(path.join(root, "src")).map((f) => [path.relative(root, f).replace(/\\/g, "/"), fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n")]);
let fail = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fail++; };

const idOnly = src.flatMap(([f, s]) => [...s.matchAll(/onConflict\s*:\s*["'`]id["'`]/g)].map(() => f));
check(idOnly.length === 0, `no upsert names onConflict "id" (${idOnly.length}${idOnly.length ? ": " + [...new Set(idOnly)].join(", ") : ""})`);
const named = (x) => /onConflict\s*:\s*"device_id,id"/.test(x);
const all = src.flatMap(([f, s]) => [...s.matchAll(/from\(\s*["'`](tasks|history|favorites)["'`]\s*\)\s*\.upsert\(([^;]*?)\);/gs)]
  .map((m) => ({ f, table: m[1], args: m[2] })));
for (const [t, want] of [["tasks", 2], ["history", 2], ["favorites", 1]]) {
  const u = all.filter((x) => x.table === t), inSb = u.filter((x) => x.f === "src/lib/supabase.js").length;
  check(inSb === want && u.every((x) => named(x.args)),
        `${t}: every upsert names "device_id,id" (${u.filter((x) => named(x.args)).length} of ${u.length}; ${inSb} in supabase.js, want ${want})`);
}
console.log(`${fail === 0 ? "ok" : "FAIL"}: ${fail} failed`);
process.exit(fail ? 1 : 0);
