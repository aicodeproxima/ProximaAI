// Rotates ProximaAI's Supabase server key. Owner ruling 2026-10-22, relayed by the lockdown session: "coordinate with
// your partner on which of you should do it depending on what you both have to do next and work in parallel without
// collision" (the RLS session owns it). The legacy service_role JWT and the default secret key may have reached a local
// agent (Hermes's .env held a service-role key that worked on 2026-10-21); either one bypasses every row policy. In the
// app only Vercel SUPABASE_SERVICE_ROLE_KEY holds one: api/ws-proxy.ts and api/ws-webhook.ts send it as `apikey` and
// `Authorization: Bearer`. The browser uses the publishable key (edge logs, the 24 h before this was written: no browser
// sent a legacy key). No key or token is ever printed or written to disk.
//
//   node scripts/tools/rotate-service-key.mjs            preflight: changes nothing, proves every assumption, prints the plan
//   node scripts/tools/rotate-service-key.mjs --rotate   does it (first tell the lockdown session "pausing pushes for rotation")
//   node scripts/tools/rotate-service-key.mjs --verify   read-only: the final proofs again (e.g. after a slow key revocation)
//
// Overlap order, so every step leaves a working app (review: one critic, 2026-10-23, 7 findings fixed):
//   1) Supabase: a new secret key, proven on a row count with the functions' exact headers.
//   2) Vercel: every SUPABASE_SERVICE_ROLE_KEY row = the new key, then a production redeploy of the live deployment
//      (only if production is still what preflight saw: a redeploy would otherwise roll back someone's push).
//   3) Proof: the live proxy reaches the database for a minted session, and the edge logs show the functions sending the
//      new key. On failure Vercel goes back to the legacy key; the new key is deleted only once that restore is proven.
//   4) Supabase: legacy JWT keys (anon + service_role) disabled. Reversible: any failure in this step turns them back on.
//   5) Supabase: every older secret key deleted, marked compromised. Irreversible: the point of the rotation.
//   6) Proof: the legacy keys and the old secret are refused, then the new key, the publishable key and the proxy work.
import fs from "node:fs";
import path from "node:path";
import { sql, REF, PROJECT_URL, accessToken } from "./supabase-admin.mjs";

const SITE = "https://proxima-ai-seven.vercel.app";
const ALIAS = "proxima-ai-seven.vercel.app";
const PROJECT = "prj_sF9ANOmJleWmAN9EBRIXqY5ZA9GM";
const TEAM = "team_vILmEnHlW1iEzWxhM3UJhzim";
const ENV_KEY = "SUPABASE_SERVICE_ROLE_KEY";
const KEY_RE = "eyJhbGciOi|sb_secret_";   // a legacy JWT or a new secret key, as a regex (SQL and JS)
const NEW_RE = /^server_\d{8}_\d{6}$/;    // names this script gives its keys
const NEW_NAME = "server_" + new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "_");   // server_20261023_033512
const mode = process.argv.includes("--rotate") ? "rotate" : process.argv.includes("--verify") ? "verify" : "preflight";
let stage = "preflight: nothing changed";   // what is true right now; printed if the run stops unexpectedly

const secrets = [];   // every key and token held in memory; clean() blanks them out of anything printed
const clean = (e) => {
  let s = String(e?.message ?? e).split("\nLINE")[0];
  for (const k of secrets) if (k) s = s.split(k).join("[key]");
  return s.replace(/eyJ[\w-]{8,}\.[\w-]+\.[\w-]+/g, "[jwt]").replace(/sb_secret_[\w-]+/g, "[secret]")
    .replace(/[A-Za-z0-9_:-]+\.\d{9,}\.[0-9a-f]{64}/g, "[token]").slice(0, 300);
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const retry = async (fn, n = 4) => { for (let i = 1; ; i++) { try { return await fn(); } catch (e) { if (i >= n) throw e; await sleep(2000 * i); } } };
// Polls fn until it returns something truthy or the time is up; an error in fn counts as "not yet".
const until = async (fn, ms = 60000, every = 5000) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn().catch(() => false); if (v || Date.now() > end) return v; await sleep(every); }
};
const is2xx = (s) => s >= 200 && s < 300;

// ── Supabase Management API (the owner's access token) ──
async function mgmt(method, p, body) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}${p}`, {
    method, headers: { Authorization: `Bearer ${accessToken()}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw Object.assign(new Error(`Supabase ${method} ${p.split("?")[0]}: HTTP ${r.status} ${clean(text).slice(0, 200)}`), { status: r.status });
  return text ? JSON.parse(text) : {};
}
async function listKeys() {
  const keys = await retry(() => mgmt("GET", "/api-keys?reveal=true"));
  for (const k of keys) if (k.api_key) secrets.push(k.api_key);
  return keys;
}
const legacyEnabled = async () => (await retry(() => mgmt("GET", "/api-keys/legacy"))).enabled;
// Deletes a key; a query parameter the API refuses (400/422) is dropped rather than leaving the key in place.
async function deleteKey(id, query) {
  for (const q of [query, ""].filter((x, i, a) => a.indexOf(x) === i)) {
    try { await retry(() => mgmt("DELETE", `/api-keys/${id}${q ? "?" + q : ""}`), 3); return true; }
    catch (e) { if (!q || ![400, 422].includes(e.status)) throw e; }
  }
  return false;
}
async function logs(query) {   // edge logs of the last 24 h (the API's cap); metadata only
  const end = new Date(), start = new Date(end.getTime() - 24 * 3600e3 + 60e3);
  const u = new URL(`https://api.supabase.com/v1/projects/${REF}/analytics/endpoints/logs`);
  u.searchParams.set("sql", query);
  u.searchParams.set("iso_timestamp_start", start.toISOString());
  u.searchParams.set("iso_timestamp_end", end.toISOString());
  const r = await retry(() => fetch(u, { headers: { Authorization: `Bearer ${accessToken()}` } }));
  const text = await r.text();
  if (!r.ok) throw new Error(`logs HTTP ${r.status} ${text.slice(0, 200)}`);
  return JSON.parse(text).result || [];
}
// Requests the Vercel functions sent with this key prefix in the last 24 h (the API's `prefix` field is exactly what the
// edge logs record; checked 2026-10-23). The prefix is validated before it goes into the query.
async function functionsUsing(prefix) {
  if (!/^[\w-]{8,}$/.test(prefix || "")) throw new Error("unusable key prefix");
  const [r] = await logs(`select count(*) as n from logs where source = 'edge_logs'
      and log_attributes['request.headers.user_agent'] = 'Vercel Edge Functions'
      and log_attributes['request.sb.apikey.apikey.prefix'] = '${prefix}'`);
  return +(r?.n || 0);
}

// A row count shaped like the functions' requests (apikey + Authorization: Bearer; HEAD, so no row is returned). It must
// scan rows: with limit=0 or a filter that matches nothing, Postgres never evaluates the policy, and a browser key with
// no session gets 200 instead of the policy's refusal (measured 2026-10-23).
//   server:   accepted as the server role (2xx).
//   accepted: the gateway took the key at all; a browser key with no session gets 403 ('session token missing').
//   refused:  any other 4xx, from the gateway itself, so a passing outage (5xx) never counts as a refusal.
async function keyAnswer(key) {
  const r = await retry(() => fetch(`${PROJECT_URL}/rest/v1/tasks?select=id`,
    { method: "HEAD", headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: "count=exact" } }));
  const server = is2xx(r.status), accepted = server || r.status === 403;
  return { status: r.status, server, accepted, refused: !accepted && r.status >= 400 && r.status < 500 };
}

// ── Vercel (the CLI's token) ──
const vercelToken = () => {
  const f = path.join(process.env.APPDATA || "", "com.vercel.cli", "Data", "auth.json");
  const t = JSON.parse(fs.readFileSync(f, "utf8")).token;
  if (!t) throw new Error("no Vercel CLI token in " + f + " (run: vercel login)");
  return t;
};
async function vercel(method, url, body) {
  const r = await fetch("https://api.vercel.com" + url + (url.includes("?") ? "&" : "?") + "teamId=" + TEAM, {
    method, headers: { Authorization: `Bearer ${vercelToken()}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Vercel ${method} ${url.split("?")[0]}: HTTP ${r.status} ${clean(text).slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}
const liveDeployment = async () => (await retry(() => vercel("GET", `/v4/aliases/${ALIAS}`))).deploymentId;
const productionBusy = async () => ((await retry(() => vercel("GET", `/v6/deployments?projectId=${PROJECT}&target=production&state=BUILDING,QUEUED,INITIALIZING&limit=5`))).deployments || []).length > 0;
async function redeployProduction(fromUid) {
  const d = await vercel("POST", "/v13/deployments?forceNew=1", { name: "proxima-ai", deploymentId: fromUid, target: "production" });
  for (let i = 0; ; i++) {
    const s = await retry(() => vercel("GET", `/v13/deployments/${d.id}`));
    if (s.readyState === "READY") break;
    if (["ERROR", "CANCELED", "BLOCKED", "DELETED"].includes(s.readyState)) throw new Error("redeploy " + s.readyState);
    if (i >= 60) { await vercel("PATCH", `/v12/deployments/${d.id}/cancel`).catch(() => {}); throw new Error("redeploy not READY after 5 minutes (cancelled)"); }
    await sleep(5000);
  }
  for (let i = 0; i < 12; i++) { if ((await liveDeployment()) === d.id) return d.id; await sleep(5000); }
  throw new Error("redeploy READY but not serving " + ALIAS + " (production pinned by a rollback?)");
}
// Keeps each row's type (a Sensitive row stays Sensitive; Vercel allows Sensitive only for production and preview).
const setEnv = (env, value) => vercel("PATCH", `/v9/projects/${PROJECT}/env/${env.id}`, { value, type: env.type === "plain" ? "encrypted" : env.type, target: env.target });

// ── The live proxy, for a session minted by the database (12 h + 2 min, like a real sign-in) ──
async function mintSession() {
  const [m] = await retry(() => sql("select public._sign_session_token('admin:' || (select value->>'username' from public.app_secrets where key = 'admin_username'), now() + interval '12 hours 2 minutes') as t"));
  if (!m?.t) throw new Error("could not mint a session");
  secrets.push(m.t);
  return m.t;
}
// 'ok' only when the proxy provably reached the database with its server key: 200, or 400 'no-key' (the lookup worked,
// no WaveSpeed key saved). 'server-key': 503, what a refused server key gives. 'session': 401 'session'. Anything else
// (a 429, a 5xx from Vercel or WaveSpeed) is 'unknown' and proves nothing.
// The latest proxyCheck result, so a caller can tell a refused server key from a WaveSpeed hiccup. sawServerKey: any of
// its attempts got the 503 a refused server key gives (a later 5xx from Vercel must not hide it).
let lastProxy = null;
async function proxyCheck() {
  const token = await mintSession();
  let last, sawServerKey = false;
  for (let i = 0; i < 4; i++) {
    const r = await retry(() => fetch(`${SITE}/api/wavespeed-v2/api/v3/balance?v=${Date.now()}`, { headers: { "X-Proxima-Session": token }, cache: "no-store" }));
    await r.text().catch(() => "");
    const auth = r.headers.get("x-proxima-auth");
    const verdict = r.status === 200 || (r.status === 400 && auth === "no-key") ? "ok"
      : r.status === 503 ? "server-key" : r.status === 401 && auth === "session" ? "session" : "unknown";
    sawServerKey ||= verdict === "server-key";
    lastProxy = last = { status: r.status, verdict, sawServerKey };
    if (verdict === "ok") return last;
    await sleep(5000);   // a fresh deployment's first calls can be cold
  }
  return last;
}

// The final proofs (step 6 and --verify); returns the checks by name. oldKeys[0] is the key the functions sent before
// the rotation: once the gateway refuses it, the proxy must still work, so an outage shows within minutes rather than
// after every other refusal (each can take up to 5 minutes to reach the gateway).
async function finalProofs({ newKey, newPrefix, oldKeys, publishable }) {
  const refused = async (key) => !!(await until(async () => (await keyAnswer(key)).refused, 300000, 15000));
  const proof = {};
  for (const [i, [label, key]] of oldKeys.entries()) {
    proof[`${label}Refused`] = await refused(key);
    if (i === 0 && !(proof.proxyWorks = (await proxyCheck()).verdict === "ok")) break;
  }
  if (!("proxyWorks" in proof)) proof.proxyWorks = (await proxyCheck()).verdict === "ok";
  proof.newKeyAccepted = (await keyAnswer(newKey)).server;
  proof.publishableAccepted = (await keyAnswer(publishable)).accepted;
  proof.functionsSendNewKey = (await functionsUsing(newPrefix).catch(() => 0)) > 0;
  console.log(Object.entries(proof).map(([k, v]) => `    ${v ? "ok  " : "FAIL"} ${k}`).join("\n"));
  return proof;
}
const allOk = (proof) => Object.values(proof).every(Boolean);

async function verify() {
  const keys = await listKeys();
  const legacyOn = await legacyEnabled();
  const secretKeys = keys.filter(k => k.type === "secret" && k.api_key);
  const newest = secretKeys.filter(k => NEW_RE.test(k.name)).sort((a, b) => b.name.localeCompare(a.name))[0];
  const publishable = keys.find(k => k.type === "publishable")?.api_key;
  console.log(`Keys: legacy ${legacyOn ? "ENABLED" : "disabled"}; secret: ${secretKeys.map(k => k.name).join(", ") || "none"}; newest rotated: ${newest?.name || "none"}.`);
  if (!newest || !publishable) { console.error("Nothing to verify: no rotated key or no publishable key."); return 1; }
  // Enabled legacy keys can never be refused: skip them instead of waiting 5 minutes each.
  if (legacyOn) console.log("    Legacy keys are enabled, so their refusal is not checked.");
  const legacy = legacyOn ? [] : ["service_role", "anon"].map(n => keys.find(k => k.type === "legacy" && k.name === n && k.api_key)).filter(Boolean);
  const oldKeys = legacy.map(k => [`legacy_${k.name}`, k.api_key])
    .concat(secretKeys.filter(k => k.id !== newest.id).map(k => [`secret_${k.name}`, k.api_key]));
  const ok = allOk(await finalProofs({ newKey: newest.api_key, newPrefix: newest.prefix, oldKeys, publishable })) && !legacyOn && secretKeys.length === 1;
  console.log(ok ? "Verified: only the rotated key works." : `Not fully rotated yet${legacyOn ? " (legacy keys still enabled)" : ""}${secretKeys.length > 1 ? " (older secret keys still exist)" : ""}.`);
  return ok ? 0 : 2;
}

async function main() {
  if (mode === "verify") return verify();

  // ── Preflight ──
  const problems = [], notes = [];
  const keys = await listKeys();
  const legacyAnon = keys.find(k => k.type === "legacy" && k.name === "anon")?.api_key;
  const legacySvc = keys.find(k => k.type === "legacy" && k.name === "service_role")?.api_key;
  const publishable = keys.find(k => k.type === "publishable")?.api_key;
  const oldSecrets = keys.filter(k => k.type === "secret" && k.api_key);
  const legacyOn = await legacyEnabled();
  console.log(`Keys: legacy ${legacyOn ? "enabled" : "DISABLED"} (anon ${legacyAnon ? "present" : "absent"}, service_role ${legacySvc ? "present" : "absent"}); secret: ${oldSecrets.map(k => k.name).join(", ") || "none"}; publishable ${publishable ? "present" : "absent"}.`);
  if (!legacyOn || !legacySvc) problems.push("this run starts from Vercel on the legacy service_role key (the rollback target): legacy keys are off or missing (use --verify, or finish by hand)");
  if (!publishable) problems.push("no publishable key (the browser needs one)");

  // (a) A secret key must work with the functions' exact headers (apikey + Authorization: Bearer), or api/* must change.
  const svc = legacySvc ? await keyAnswer(legacySvc) : null;
  const secs = await Promise.all(oldSecrets.map(k => keyAnswer(k.api_key)));
  const pub = publishable ? await keyAnswer(publishable) : null;
  console.log(`(a) apikey + Bearer: legacy service_role ${svc?.status ?? "-"}; ` + oldSecrets.map((k, i) => `secret "${k.name}" ${secs[i].status}`).join("; ") +
    ` (expect 200); publishable ${pub?.status ?? "-"} (expect 403 session token missing).`);
  if (!oldSecrets.length) problems.push("no secret key exists to prove the header pattern with");
  else if (!secs.some(s => s.server)) problems.push("a secret key is NOT accepted with apikey + Authorization: Bearer: api/* would need to change first (webhook session's files)");
  if (!pub?.accepted || pub.server) problems.push("the publishable key is not answered the way the app expects");

  // (b) Nothing in the database embeds a key (it would break silently). Counts only.
  const [db] = await retry(() => sql(`select
      (select count(*) from cron.job where command ~ '${KEY_RE}')::int as cron_hits,
      (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname not in ('pg_catalog', 'information_schema') and p.prosrc ~ '${KEY_RE}')::int as function_hits,
      (select count(*) from pg_trigger t where not t.tgisinternal and encode(t.tgargs, 'escape') ~ '${KEY_RE}')::int as trigger_hits`, { readOnly: true }));
  const vault = await sql("select count(*)::int as n from vault.secrets", { readOnly: true }).then(r => r[0].n).catch(() => "unreadable");
  const fns = await retry(() => mgmt("GET", "/functions")).catch(e => { problems.push("could not list Edge Functions: " + clean(e)); return []; });
  console.log(`(b) Keys embedded in the database: cron ${db.cron_hits}, functions ${db.function_hits}, triggers ${db.trigger_hits} (expect 0 each); Vault secrets ${vault}; Edge Functions ${fns.length}${fns.length ? " (" + fns.map(f => f.slug).join(", ") + ")" : ""}.`);
  if (db.cron_hits || db.function_hits || db.trigger_hits) problems.push("a key is embedded in the database (cron job, function or trigger): look before rotating");
  if (fns.length) problems.push("Edge Functions exist: check which key they use before disabling the legacy keys");
  if (vault !== 0) notes.push(`Vault holds ${vault} secret(s): if one is a Supabase key, it stops working at step 4 or 5`);

  // (c) The live bundle uses only the publishable key.
  const html = await (await retry(() => fetch(`${SITE}/?v=${Date.now()}`, { cache: "no-store" }))).text();
  const seen = new Set(), queue = [...html.matchAll(/\/assets\/[\w.-]+\.js/g)].map(m => m[0]);
  let hasPublishable = false, hasServerKey = false;
  while (queue.length && seen.size < 40) {
    const a = queue.shift();
    if (seen.has(a)) continue;
    seen.add(a);
    const js = await (await retry(() => fetch(SITE + a))).text();
    if (js.includes("sb_publishable_")) hasPublishable = true;
    if (new RegExp(KEY_RE).test(js)) hasServerKey = true;
    for (const m of js.matchAll(/assets\/[\w.-]+\.js/g)) queue.push("/" + m[0]);
  }
  console.log(`(c) Live bundle (${seen.size} script files): publishable key ${hasPublishable ? "present" : "ABSENT"}; legacy JWT or secret key ${hasServerKey ? "PRESENT" : "absent"}.`);
  if (!hasPublishable || hasServerKey) problems.push("the live bundle does not use only the publishable key");

  // Who sent a legacy key in the last 24 h (a browser would mean a stale bundle that step 4 breaks).
  const used = await logs(`select log_attributes['request.sb.jwt.apikey.payload.role'] as role,
      multiIf(log_attributes['request.headers.user_agent'] = 'Vercel Edge Functions', 'vercel-functions',
              log_attributes['request.headers.user_agent'] like 'curl%', 'curl',
              log_attributes['request.headers.user_agent'] = 'node', 'node-scripts (this preflight, admin tools)',
              log_attributes['request.headers.user_agent'] like '%Mozilla%', 'browser', 'other') as client, count(*) as n
      from logs where source = 'edge_logs' and log_attributes['request.sb.jwt.apikey.payload.role'] != ''
     group by role, client order by n desc`);
  console.log("    Legacy keys sent in the last 24 h: " + (used.map(u => `${u.role} by ${u.client} x${u.n}`).join(", ") || "none") + ".");
  if (used.some(u => u.client === "browser")) problems.push("a browser sent a legacy key in the last 24 h (stale bundle?): step 4 would break it");
  if (used.some(u => u.client === "other")) notes.push("an unknown client sent a legacy key in the last 24 h: it stops working at step 4");

  // Vercel: one production row, production quiet, the live proxy working end to end.
  const envs = (await retry(() => vercel("GET", `/v9/projects/${PROJECT}/env`))).envs || [];
  const rows = envs.filter(e => e.key === ENV_KEY && !e.gitBranch);
  const prodRows = rows.filter(e => (e.target || []).includes("production"));
  const branchRows = envs.filter(e => e.key === ENV_KEY && e.gitBranch).length;
  console.log(`Vercel: ${ENV_KEY} rows ${rows.map(e => `${e.target}:${e.type}`).join("; ") || "none"}${branchRows ? `; ${branchRows} branch row(s) left alone` : ""}.`);
  if (prodRows.length !== 1) problems.push(`expected exactly one ${ENV_KEY} row for production, found ${prodRows.length}`);
  if (await productionBusy()) problems.push("a production build is in flight; wait for it");
  const liveUid = await liveDeployment();
  if (!liveUid) problems.push(`${ALIAS} has no deployment`);
  const base = await proxyCheck();
  console.log(`Live proxy, minted session: HTTP ${base.status} (${base.verdict}; expect ok). ${ALIAS} serves ${String(liveUid).slice(0, 12)}…`);
  if (base.verdict !== "ok") problems.push(`the live proxy does not work end to end right now (${base.verdict}, HTTP ${base.status})`);

  for (const n of notes) console.log("Note: " + n);
  if (problems.length) { console.error("Not ready:\n" + problems.map(p => "  - " + p).join("\n")); return 1; }
  if (mode === "preflight") {
    console.log(`Plan (the app works at every step): 1) new secret key "${NEW_NAME}", proven; 2) Vercel ${ENV_KEY} = new key,\n` +
      `      production redeploy; 3) proof through the live proxy and the edge logs (on failure: back to the legacy key);\n` +
      `      4) legacy JWT keys off (any failure turns them back on); 5) ${oldSecrets.map(k => `"${k.name}"`).join(", ")} deleted, marked compromised\n` +
      `      (irreversible); 6) proof. Afterwards anything holding an old key (Hermes's .env, saved copies) stops working.\n` +
      `      Run with --rotate.`);
    return 0;
  }

  // ── 1) New secret key ──
  console.log(`1/6 Supabase: new secret key "${NEW_NAME}"… (started ${new Date().toISOString()})`);
  const created = await mgmt("POST", "/api-keys?reveal=true", { type: "secret", name: NEW_NAME, description: "Vercel proxy + webhook (rotated 2026-10-22 after a possible exposure)" });
  const newKey = created.api_key, newId = created.id;
  if (newKey) secrets.push(newKey);
  stage = `step 1: new key "${NEW_NAME}" exists; Vercel untouched, the app runs on the legacy key`;
  const dropNew = async () => {
    try { await deleteKey(newId, ""); console.error(`    New key "${NEW_NAME}" deleted.`); }
    catch (e) { console.error(`    Could not delete the new key "${NEW_NAME}" (unused; delete it in Supabase → API Keys):`, clean(e)); }
  };
  if (!newKey || !newId) { console.error("    The new key was not returned. Nothing else changed."); if (newId) await dropNew(); return 1; }
  if (!(await until(async () => (await keyAnswer(newKey)).server, 90000))) {
    console.error("    The new key is not accepted with the functions' headers after 90 s. Nothing else changed.");
    await dropNew();
    return 1;
  }
  const newPrefix = created.prefix || (await listKeys()).find(k => k.id === newId)?.prefix;
  if (!/^[\w-]{8,}$/.test(newPrefix || "") || oldSecrets.some(k => k.prefix === newPrefix)) {
    console.error("    The new key's prefix is unknown or not unique, so the edge logs could not prove which key the functions send.\n    Nothing else changed.");
    await dropNew();
    return 1;
  }

  // ── 2) Vercel uses it ──
  // Production must still be what preflight saw: redeploying an older deployment would roll back someone's push.
  if ((await liveDeployment()) !== liveUid || await productionBusy()) {
    console.error("    Production changed since preflight (another deploy?). Nothing else changed; rerun when production is quiet.");
    await dropNew();
    return 1;
  }
  console.log(`2/6 Vercel: ${ENV_KEY} = new key; production redeploy…`);
  // Back to the legacy key. The new key is deleted only once the live proxy is proven to work on a deployment built
  // with the legacy key; otherwise production may still run on the new key, so it stays.
  const restoreVercel = async (why) => {
    console.error(`    ${why} Putting ${ENV_KEY} back to the legacy key and redeploying…`);
    let restored = false;
    try {
      for (const r of rows) await setEnv(r, legacySvc);
      const uid = await redeployProduction(await liveDeployment());
      const back = await proxyCheck();
      restored = back.verdict === "ok" && (await liveDeployment()) === uid;
      if (!restored) console.error(`    Redeployed, but the proxy answers ${back.status} (${back.verdict}).`);
    } catch (e) { console.error("    Restore failed:", clean(e)); }
    if (restored) { console.error("    Restored: the live proxy works on the legacy key."); await dropNew(); }
    else console.error(`    Kept the new key "${NEW_NAME}" (production may still run on it; both keys work).\n` +
      `    Check that ${ENV_KEY} in Vercel and the live deployment agree, then rerun.`);
    return 1;
  };
  let newUid;
  stage = `step 2: Vercel switching to "${NEW_NAME}"; both keys work`;
  try {
    for (const r of rows) await setEnv(r, newKey);
    newUid = await redeployProduction(liveUid);
  } catch (e) { return restoreVercel("Step 2 failed: " + clean(e)); }
  stage = `step 2 done: production runs on "${NEW_NAME}"; legacy keys still enabled (both keys work)`;

  // ── 3) Proof: the live proxy works, and the functions send the new key ──
  console.log("3/6 Proof: the live proxy reaches the database, and the edge logs show the new key…");
  const p3 = await proxyCheck();
  if (p3.verdict !== "ok") return restoreVercel(`The live proxy answers ${p3.status} (${p3.verdict}).`);
  // A build started before the variable changed would still carry the legacy key, and step 4 would break it.
  if ((await liveDeployment()) !== newUid || await productionBusy()) {
    console.error(`    Production changed since the redeploy (another deploy?). Vercel holds "${NEW_NAME}" and the legacy key still\n    works, so the app works; nothing disabled or deleted. Rerun --rotate when production is quiet (it replaces this key).`);
    return 1;
  }
  // A 200 proves the functions hold a working key, not that it is the new one (logs arrive within a few minutes).
  if (!(await until(async () => (await functionsUsing(newPrefix)) > 0, 240000, 15000))) {
    console.error("    The edge logs do not show the functions sending the new key after 4 minutes. The app works and the legacy\n    key still works; nothing disabled or deleted. Rerun --rotate later (it replaces this key too).");
    return 1;
  }
  console.log("    Edge logs: the Vercel functions send the new key.");

  // ── 4) Legacy keys off ── (any failure in this step turns them back on: availability first)
  console.log("4/6 Supabase: legacy JWT keys (anon + service_role) disabled…");
  stage = `step 4: legacy keys being disabled; the app runs on "${NEW_NAME}"`;
  let disableSent = false;   // the disable call went through at least once (otherwise the keys probably never went off)
  const reenable = async (why) => {
    console.error(`    ${why} Turning the legacy keys back on…`);
    const back = await until(async () => { await mgmt("PUT", "/api-keys/legacy?enabled=true"); return (await legacyEnabled()) === true; }, 60000, 10000);
    if (back) { console.error(`    Legacy keys back on. Before this: ${stage}. Rerun later.`); return 1; }
    // Not confirmed back on: say what is actually true (a disable whose replies were all lost may still have worked).
    const now = await legacyEnabled().catch(() => null);
    console.error(now === true ? `    The legacy keys are on${disableSent ? " now (the re-enable took effect late)" : " (the disable never took effect)"}.`
      : `    COULD NOT turn the legacy keys back on (${now === false ? "they are OFF" : disableSent ? "state unknown: Supabase is not answering" : "state unknown: Supabase is not answering, and the disable call failed too"}):\n` +
        `    Supabase → Project Settings → API Keys → Legacy API keys → enable. The app runs on "${NEW_NAME}".`);
    return 1;
  };
  let legacyRefused = false;
  try {
    await retry(() => mgmt("PUT", "/api-keys/legacy?enabled=false"), 3);
    disableSent = true;
    if (!(await until(async () => (await legacyEnabled()) === false, 60000))) return reenable("The API still reports the legacy keys enabled after 60 s.");
    // The gateway can lag the API; wait for the refusal so the proxy check below means "works without the legacy key".
    legacyRefused = !!(await until(async () => (await keyAnswer(legacySvc)).refused, 180000, 15000));
    const p4 = await proxyCheck();
    if (p4.verdict !== "ok") return reenable(`With the legacy keys off the live proxy answers ${p4.status} (${p4.verdict}).`);
  } catch (e) { return reenable("Step 4 failed: " + clean(e)); }
  console.log(legacyRefused ? "    Legacy service_role refused by the gateway; the live proxy still works."
    : "    The API says disabled but the gateway still accepts the legacy key (propagating); the edge logs already prove the\n    functions send the new key. Step 6 waits for the refusal.");
  stage = `step 4 done: legacy keys off; the app runs on "${NEW_NAME}"; the old secret still exists`;

  // ── 5) Older secret keys deleted ──
  console.log(`5/6 Supabase: deleting ${oldSecrets.map(k => `"${k.name}"`).join(", ")} (marked compromised)…`);
  stage = `step 5: deleting old secret keys; legacy keys off; the app runs on "${NEW_NAME}" (finish with --verify)`;
  for (const k of oldSecrets) {
    try { await deleteKey(k.id, "was_compromised=true&reason=rotating_key"); }
    catch (e) { console.error(`    could not delete "${k.name}":`, clean(e)); }
  }
  const leftOver = (await listKeys()).filter(k => k.type === "secret" && k.id !== newId).map(k => k.name);
  stage = `step 5 done: legacy keys off; old secrets ${leftOver.length ? "LEFT: " + leftOver.join(", ") : "deleted"}; the app runs on "${NEW_NAME}"`;

  // ── 6) Proof ──
  console.log("6/6 Proof (refusals can take a few minutes to reach the gateway)…");
  const proof = await finalProofs({
    newKey, newPrefix, publishable,
    oldKeys: [["legacyServiceRole", legacySvc], ...oldSecrets.map(k => [`oldSecret_${k.name}`, k.api_key]), ["legacyAnon", legacyAnon]].filter(([, v]) => v),
  });
  // Availability first: a refused server key (503) once the legacy key is refused means something still depended on it.
  // Any other failure (a WaveSpeed or Vercel hiccup) proves nothing, so the exposed keys stay off.
  if (!proof.proxyWorks && lastProxy?.sawServerKey) return reenable("At step 6 the live proxy cannot reach the database with the legacy keys refused.");
  if (!proof.proxyWorks) {
    console.error(`Rotation ran, but the live proxy answered ${lastProxy?.status} (${lastProxy?.verdict}), which proves nothing either way.\n` +
      "The legacy keys stay off. Rerun the proofs with --verify (read-only) once the app answers again.");
    return 2;
  }
  if (!allOk(proof) || leftOver.length) {
    console.error(`Rotation ran, but a check failed (see above)${leftOver.length ? `; still present: ${leftOver.join(", ")}` : ""}.\n` +
      "Rerun the proofs later with --verify (read-only).");
    return 2;
  }
  console.log(`Rotated: Vercel uses "${NEW_NAME}"; legacy keys off; ${oldSecrets.map(k => `"${k.name}"`).join(", ")} deleted.\n` +
    "Anything still holding an old key (Hermes's .env, copies in notes) is now refused.");
  return 0;
}

main().then(code => process.exit(code), e => { console.error("Stopped:", clean(e), "\nState:", stage); process.exit(1); });
