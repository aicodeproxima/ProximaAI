// Permanently deletes every file under one folder of the `generations` Storage bucket, through the Storage API (the
// only path that removes the stored bytes, not just the table row). Prints counts and sizes only, never file names.
//
//   node scripts/tools/purge-storage-folder.mjs                       count only: uploads/user_StephJr101
//   node scripts/tools/purge-storage-folder.mjs --delete              delete them, then re-list and report what is left
//   node scripts/tools/purge-storage-folder.mjs <folder> [--delete]   another folder (at least two levels deep)
//
// Key: the public anon key, read from the live bundle (the same one every visitor's browser gets), or env
// SUPABASE_ANON_KEY. It works only while the bucket's anon DELETE policy stands; the remove answer is checked per path
// (src/lib/storageRemove.js), so a refused delete reports "not deleted" instead of success.
import { removedPaths } from "../../src/lib/storageRemove.js";

const SITE = "https://proxima-ai-seven.vercel.app";
const URL_ = "https://vhznmpxlcjbdzntmfvvy.supabase.co";
const BUCKET = "generations";
const CHUNK = 100;

const args = process.argv.slice(2);
const doDelete = args.includes("--delete");
const folder = (args.find(a => !a.startsWith("--")) || "uploads/user_StephJr101").replace(/^\/+|\/+$/g, "");
if (folder.split("/").filter(Boolean).length < 2) {
  console.error(`Refusing "${folder}": give a folder at least two levels deep (e.g. uploads/user_X), never the bucket root.`);
  process.exit(2);
}

async function anonKey() {
  if (process.env.SUPABASE_ANON_KEY) return process.env.SUPABASE_ANON_KEY;
  const html = await (await fetch(SITE, { cache: "no-store" })).text();
  const js = html.match(/assets\/index-[^"]*\.js/)?.[0];
  if (!js) throw new Error("live bundle not found on " + SITE);
  const src = await (await fetch(`${SITE}/${js}`)).text();
  const pub = src.match(/sb_publishable_[A-Za-z0-9_-]+/)?.[0];
  if (pub) return pub;
  for (const jwt of src.match(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g) || []) {
    const claims = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
    if (claims.role === "anon" && claims.ref === "vhznmpxlcjbdzntmfvvy") return jwt; // never any other role
  }
  throw new Error("anon key not found in the live bundle");
}

const key = await anonKey();
const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

// Every file under `prefix`, walking subfolders (folders come back with id null).
async function listAll(prefix) {
  const files = [];
  for (let offset = 0; ; offset += 1000) {
    const r = await fetch(`${URL_}/storage/v1/object/list/${BUCKET}`, {
      method: "POST", headers,
      body: JSON.stringify({ prefix, limit: 1000, offset, sortBy: { column: "name", order: "asc" } }),
    });
    if (!r.ok) throw new Error(`list ${prefix}: HTTP ${r.status} ${await r.text()}`);
    const page = await r.json();
    for (const o of page) {
      const path = `${prefix}/${o.name}`;
      if (o.id === null) files.push(...await listAll(path));
      else files.push({ path, size: Number(o.metadata?.size) || 0 });
    }
    if (page.length < 1000) return files;
  }
}

const mb = n => (n / 1048576).toFixed(1) + " MB";
const before = await listAll(folder);
console.log(`${BUCKET}/${folder}: ${before.length} files, ${mb(before.reduce((s, f) => s + f.size, 0))}`);
if (!doDelete) { console.log("Count only. Add --delete to delete them permanently."); process.exit(0); }
if (!before.length) { console.log("Nothing to delete."); process.exit(0); }

let deleted = 0, refused = 0;
for (let i = 0; i < before.length; i += CHUNK) {
  const paths = before.slice(i, i + CHUNK).map(f => f.path);
  const r = await fetch(`${URL_}/storage/v1/object/${BUCKET}`, { method: "DELETE", headers, body: JSON.stringify({ prefixes: paths }) });
  if (!r.ok) throw new Error(`delete: HTTP ${r.status} ${await r.text()}`);
  const ok = removedPaths(paths, await r.json()).size;
  deleted += ok; refused += paths.length - ok;
}
const after = await listAll(folder);
console.log(`Deleted ${deleted}, not deleted ${refused}. Left in ${folder}: ${after.length} files.`);
process.exit(after.length ? 1 : 0);
