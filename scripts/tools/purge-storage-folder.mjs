// Permanently deletes every file under one folder of the `generations` Storage bucket, through the Storage API (the
// only path that removes the stored bytes, not just the table row). Prints counts and sizes only, never file names.
//
//   node scripts/tools/purge-storage-folder.mjs                       count only: uploads/user_StephJr101
//   node scripts/tools/purge-storage-folder.mjs --delete              delete them, then prove the folder is empty
//   node scripts/tools/purge-storage-folder.mjs <folder> [--delete]   another folder (at least two levels deep)
//
// Keys: the owner's access token fetches the project's server key at run time (supabase-admin.mjs; kept in memory,
// never printed), so the row policies neither hide files from the list nor refuse the delete. The database's own count
// (storage.objects) is the ground truth: a Storage list that disagrees with it stops the run, and success means that
// count is 0 afterwards, so an empty answer can never read as "deleted" (RLS review wf_3a0b5642-729).
import { removedPaths } from "../../src/lib/storageRemove.js";
import { PROJECT_URL, sql, serverKey } from "./supabase-admin.mjs";

const BUCKET = "generations";
const CHUNK = 100;

const args = process.argv.slice(2);
const doDelete = args.includes("--delete");
const folder = (args.find(a => !a.startsWith("--")) || "uploads/user_StephJr101").replace(/^\/+|\/+$/g, "");
if (!/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/.test(folder)) {
  console.error(`Refusing "${folder}": give a folder at least two levels deep (e.g. uploads/user_X), letters, digits, _ . - only.`);
  process.exit(2);
}

const key = await serverKey();
const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

// What the database holds under the folder (the folder name is validated above, so it is safe inside the literal).
async function truth() {
  const [row] = await sql(`select count(*)::int as n, coalesce(sum((metadata->>'size')::bigint), 0)::bigint as bytes
    from storage.objects where bucket_id = '${BUCKET}' and starts_with(name, '${folder}/')`);
  return { n: row.n, bytes: Number(row.bytes) };
}

// Every file under `prefix` per the Storage API, walking subfolders (folders come back with id null).
async function listAll(prefix) {
  const files = [];
  for (let offset = 0; ; offset += 1000) {
    const r = await fetch(`${PROJECT_URL}/storage/v1/object/list/${BUCKET}`, {
      method: "POST", headers,
      body: JSON.stringify({ prefix, limit: 1000, offset, sortBy: { column: "name", order: "asc" } }),
    });
    if (!r.ok) throw new Error(`list ${prefix}: HTTP ${r.status} ${await r.text()}`);
    const page = await r.json();
    for (const o of page) {
      if (o.id === null) files.push(...await listAll(`${prefix}/${o.name}`));
      else files.push(`${prefix}/${o.name}`);
    }
    if (page.length < 1000) return files;
  }
}

const mb = n => (n / 1048576).toFixed(1) + " MB";
const before = await truth();
const listed = await listAll(folder);
console.log(`${BUCKET}/${folder}: ${before.n} files, ${mb(before.bytes)}`);
if (listed.length !== before.n) {
  console.error(`Stopped: the Storage API lists ${listed.length} files but the database holds ${before.n}. Nothing was deleted.`);
  process.exit(4);
}
if (!doDelete) { console.log("Count only. Add --delete to delete them permanently."); process.exit(0); }
if (!before.n) { console.log("Nothing to delete (the database confirms the folder is empty)."); process.exit(0); }

let deleted = 0;
for (let i = 0; i < listed.length; i += CHUNK) {
  const paths = listed.slice(i, i + CHUNK);
  const r = await fetch(`${PROJECT_URL}/storage/v1/object/${BUCKET}`, { method: "DELETE", headers, body: JSON.stringify({ prefixes: paths }) });
  if (!r.ok) throw new Error(`delete: HTTP ${r.status} ${await r.text()}`);
  deleted += removedPaths(paths, await r.json()).size;
}
const after = await truth();
console.log(`Deleted ${deleted} of ${before.n}. The database now holds ${after.n} files in ${folder}.`);
process.exit(after.n ? 1 : 0);
