// Rotates the session signing key (owner "go", 2026-10-22): the old key may have reached a third party, and anyone
// holding it can mint working sign-ins. One key lives in two places: the database (app_secrets session_signing_key,
// which signs every session and checks it on every call: the proxy re-checks tokens there through
// get_my_wavespeed_key, and the RLS policies use the same check) and Vercel (SESSION_SIGNING_KEY, the proxy's first
// check). Every device is signed out; sign in again afterwards. No key or token is ever printed or written to disk.
//
//   node scripts/tools/rotate-signing-key.mjs            preflight only: checks access, proves the current key, prints the plan
//   node scripts/tools/rotate-signing-key.mjs --rotate   does it (both devices idle: a running generation would stop polling)
//   node scripts/tools/rotate-signing-key.mjs --finish   only step 3, if a run stopped after the database switched
//
// Overlap order (review wf_fafdd019-f3c), so a failure at any step leaves a working app:
//   1) Vercel: SESSION_SIGNING_KEY = new, SESSION_SIGNING_KEY_PREVIOUS = old, production redeploy (the proxy accepts both).
//   2) Database: new key, no previous. From here the old key is refused everywhere (the database is the authority).
//   3) Vercel: remove SESSION_SIGNING_KEY_PREVIOUS, production redeploy (clean-up).
//   4) Proof: the database and the live proxy refuse the old key and accept the new one.
import { createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sql } from "./supabase-admin.mjs";

const SITE = "https://proxima-ai-seven.vercel.app";
const ALIAS = "proxima-ai-seven.vercel.app";
const PROJECT = "prj_sF9ANOmJleWmAN9EBRIXqY5ZA9GM";
const TEAM = "team_vILmEnHlW1iEzWxhM3UJhzim";
const ENV_KEY = "SESSION_SIGNING_KEY", ENV_PREV = "SESSION_SIGNING_KEY_PREVIOUS";
const mode = process.argv.includes("--rotate") ? "rotate" : process.argv.includes("--finish") ? "finish" : "preflight";

const secrets = [];   // every key held in memory; clean() blanks them out of anything printed
const clean = (e) => {
  let s = String(e?.message ?? e).split("\nLINE")[0];
  for (const k of secrets) if (k) s = s.split(k).join("[key]");
  return s.replace(/[A-Za-z0-9_:-]+\.\d{9,}\.[0-9a-f]{64}/g, "[token]").slice(0, 300);
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const retry = async (fn, n = 4) => { for (let i = 1; ; i++) { try { return await fn(); } catch (e) { if (i >= n) throw e; await sleep(2000 * i); } } };
const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";

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
  if (!r.ok) throw new Error(`Vercel ${method} ${url.split("?")[0]}: HTTP ${r.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}
const liveDeployment = async () => (await retry(() => vercel("GET", `/v4/aliases/${ALIAS}`))).deploymentId;
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
const setEnv = (env, value) => vercel("PATCH", `/v9/projects/${PROJECT}/env/${env.id}`, { value, type: "sensitive", target: env.target });
const findEnv = async (key) => ((await retry(() => vercel("GET", `/v9/projects/${PROJECT}/env`))).envs || []).find(e => e.key === key);

// A session token exactly as the database signs one (subject.exp.hex-hmac). 12 h + 2 min, like a real sign-in, so the
// 12-hour revocation rule treats it as fresh.
const tokenWith = (key, subject) => { const exp = Math.floor(Date.now() / 1000) + 43200 + 120; return `${subject}.${exp}.${createHmac("sha256", key).update(`${subject}.${exp}`).digest("hex")}`; };
async function proxyBalance(token) {
  const r = await retry(() => fetch(`${SITE}/api/wavespeed-v2/api/v3/balance?v=${Date.now()}`, { headers: { "X-Proxima-Session": token }, cache: "no-store" }));
  return r.status;
}
// true / false (refused for its signature: the key is wrong); anything else throws.
async function dbAccepts(token) {
  try { const [row] = await sql(`select public._verify_session_token(${lit(token)}) as s`); return !!row?.s; }
  catch (e) { if (/invalid signature/i.test(e.message)) return false; throw new Error(clean(e)); }
}
const dbHas = async (k) => !!(await retry(() => sql("select (value->>'key') = " + lit(k) + " as ok from public.app_secrets where key = 'session_signing_key'")))[0]?.ok;

async function main() {
  // ── Preflight ──
  const [acct] = await retry(() => sql("select (select value->>'username' from public.app_secrets where key = 'admin_username') as u, (select value->>'key' from public.app_secrets where key = 'session_signing_key') as k, exists (select 1 from public.app_secrets where key = 'session_signing_key_previous') as has_prev, (select (value->>'at')::bigint from public.app_secrets where key = 'admin_sessions_valid_after') as after"));
  if (!acct?.u || !acct?.k || acct.k.length < 32) throw new Error("database: admin_username or session_signing_key missing");
  const subject = "admin:" + acct.u, curKey = acct.k;
  secrets.push(curKey);
  const envs = (await retry(() => vercel("GET", `/v9/projects/${PROJECT}/env`))).envs || [];
  const keyEnv = envs.find(e => e.key === ENV_KEY);
  let prevEnv = envs.find(e => e.key === ENV_PREV);
  if (!keyEnv) throw new Error(`Vercel: ${ENV_KEY} not found`);
  const busy = (await retry(() => vercel("GET", `/v6/deployments?projectId=${PROJECT}&target=production&state=BUILDING,QUEUED,INITIALIZING&limit=5`))).deployments || [];
  if (busy.length) throw new Error("a production build is in flight; wait for it and rerun");
  const liveUid = await liveDeployment();
  if (!liveUid) throw new Error(`Vercel: ${ALIAS} has no deployment`);

  if (mode === "finish") {
    console.log("Finish: removing SESSION_SIGNING_KEY_PREVIOUS and redeploying…");
    if (prevEnv) await vercel("DELETE", `/v9/projects/${PROJECT}/env/${prevEnv.id}`);
    if (await findEnv(ENV_PREV)) throw new Error(`${ENV_PREV} is still there`);
    await redeployProduction(liveUid);
    console.log("Done: Vercel holds only the database's key.");
    return 0;
  }

  const before = await proxyBalance(tokenWith(curKey, subject));
  console.log(`Preflight: database key present (previous ${acct.has_prev ? "present, will be removed" : "absent"}); Vercel ${ENV_KEY} ${keyEnv.type} ${keyEnv.target}; ${ENV_PREV} ${prevEnv ? "present" : "absent"}; ${ALIAS} serves ${liveUid.slice(0, 12)}…`);
  console.log(`Preflight: live proxy with a current-key token answers ${before} (expect 200).`);
  if (before !== 200) {
    const recent = acct.after && Date.now() / 1000 - acct.after < 43200;
    throw new Error("the current key does not work end to end; not rotating" + (recent ? " (a password change or unlock in the last 12 h revokes such tokens)" : ""));
  }
  if (mode === "preflight") {
    console.log("Plan (overlap, the app works at every step): 1) Vercel accepts new + old, redeploy; 2) database switches (old key dead);\n      3) Vercel drops the old key, redeploy; 4) proof. Then sign in again on PC and phone. Run with --rotate.");
    return 0;
  }

  // ── 1) Vercel accepts both ──
  const oldKey = curKey, newKey = randomBytes(32).toString("hex");
  secrets.push(newKey);
  console.log("1/4 Vercel: new key, old key kept as previous; production redeploy…");
  try {
    await setEnv(keyEnv, newKey);
    if (prevEnv) await setEnv(prevEnv, oldKey);
    else await vercel("POST", `/v10/projects/${PROJECT}/env`, { key: ENV_PREV, value: oldKey, type: "sensitive", target: keyEnv.target });
    if (!(await findEnv(ENV_PREV))) throw new Error(`${ENV_PREV} was not created`);
    await redeployProduction(liveUid);
    if ((await proxyBalance(tokenWith(oldKey, subject))) !== 200) throw new Error("after the redeploy the proxy no longer accepts the current key");
  } catch (e) {
    console.error("    step 1 failed:", clean(e));
    console.error("    The database is untouched, so the app keeps working on the old key. Putting the Vercel variables back…");
    try {
      await setEnv(keyEnv, oldKey);
      const pe = await findEnv(ENV_PREV);
      if (pe) await vercel("DELETE", `/v9/projects/${PROJECT}/env/${pe.id}`);
      console.error(`    Restored: ${ENV_KEY} = old key, ${ENV_PREV} removed. Live deployment: ${(await liveDeployment())?.slice(0, 12)}… Nothing else changed.`);
    } catch (e2) {
      console.error("    Could not restore the Vercel variables:", clean(e2), `\n    Safe anyway: whatever deployment is live accepts the old key (as ${ENV_KEY} or ${ENV_PREV}). Rerun later.`);
    }
    return 1;
  }

  // ── 2) Database switches ──
  console.log("2/4 Database: new key (the old one stops working everywhere)…");
  try {
    await sql(`update public.app_secrets set value = jsonb_set(value, '{key}', to_jsonb(${lit(newKey)}::text)), updated_at = now() where key = 'session_signing_key';
               delete from public.app_secrets where key = 'session_signing_key_previous';`);
  } catch (e) { console.warn("    update failed or its reply was lost:", clean(e)); }
  let state;
  try { state = (await dbHas(newKey)) ? "new" : (await dbHas(oldKey)) ? "old" : "other"; } catch (e) { state = "unknown"; console.warn("    could not read it back:", clean(e)); }
  if (state !== "new") {
    console.error(`    Database key is ${state}. Vercel accepts both keys, so the app keeps working.` +
      (state === "old" ? " Rerun --rotate later." : " Do NOT change Vercel; check app_secrets.session_signing_key, then rerun."));
    return 1;
  }

  // ── 3) Vercel drops the old key ──
  console.log("3/4 Vercel: old key removed; production redeploy…");
  let finished = true;
  try {
    const pe = await findEnv(ENV_PREV);
    if (pe) await vercel("DELETE", `/v9/projects/${PROJECT}/env/${pe.id}`);
    await redeployProduction(await liveDeployment());
  } catch (e) {
    finished = false;
    console.error("    clean-up failed:", clean(e), "\n    The old key is already refused (the database rejects it). Run --finish later to remove it from Vercel.");
  }

  // ── 4) Proof ──
  console.log("4/4 Proof…");
  const [m] = await retry(() => sql(`select public._sign_session_token(${lit(subject)}, now() + interval '12 hours 2 minutes') as t`));
  const proof = {
    dbRefusesOld: !(await dbAccepts(tokenWith(oldKey, subject))),
    dbAcceptsNew: await dbAccepts(m.t),
    proxyRefusesOld: (await proxyBalance(tokenWith(oldKey, subject))) === 401,
    proxyAcceptsNew: (await proxyBalance(m.t)) === 200,
  };
  console.log(Object.entries(proof).map(([k, v]) => `    ${v ? "ok  " : "FAIL"} ${k}`).join("\n"));
  if (!Object.values(proof).every(Boolean)) { console.error("Rotation done but a proof failed: see above."); return 1; }
  console.log(finished ? "Rotated. Sign in again on PC and phone." : "Rotated (old key refused everywhere). Sign in again on PC and phone, and run --finish.");
  return finished ? 0 : 2;
}

main().then(code => process.exit(code), e => { console.error("Stopped:", clean(e)); process.exit(1); });
