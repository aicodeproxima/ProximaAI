// Static check for the per-account id keys (P4, docs/MULTI-USER-PLAN.md; step (a) 20261025450000 made (device_id, id)
// unique on tasks, history and favorites): the browser's upserts must name a conflict target that survives step (c),
// the key swap from (id) to (device_id, id). An explicit onConflict "id" stops working once id alone is no longer unique
// (PostgREST: no unique or exclusion constraint matching the ON CONFLICT specification), so step (c) waits 24 h after
// this ships. Checked: no onConflict "id" anywhere in src/; the tasks and history upserts (two each) name
// "device_id,id"; the favorites upsert names no target (PostgREST then uses the primary key, which step (c) makes
// (device_id, id)) or that one.
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
const sb = (src.find(([f]) => f === "src/lib/supabase.js") || [null, ""])[1];
const upserts = (table) => [...sb.matchAll(new RegExp(`from\\("${table}"\\)\\.upsert\\(([^;]*?)\\);`, "gs"))].map((m) => m[1]);
const named = (x) => /onConflict\s*:\s*"device_id,id"/.test(x);
for (const t of ["tasks", "history"]) {
  const u = upserts(t);
  check(u.length === 2 && u.every(named), `${t}: both upserts name "device_id,id" (${u.filter(named).length} of ${u.length})`);
}
const fav = upserts("favorites");
check(fav.length >= 1 && fav.every((x) => !/onConflict/.test(x) || named(x)),
      `favorites: its upsert names no target (the primary key) or "device_id,id" (${fav.length})`);
console.log(`${fail === 0 ? "ok" : "FAIL"}: ${fail} failed`);
process.exit(fail ? 1 : 0);
