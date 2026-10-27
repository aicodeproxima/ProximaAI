// After 20261026200000 is applied: proves the cron job's CALL commits per account under pg_cron (a rolled-back test can
// only show the procedure reaching its COMMIT). Queues one probe scrub for a scope no account has, waits for the next
// per-minute run, and checks that a run started after the queueing succeeded ('CALL') and the probe row is gone; then
// removes the probe's restore marker, the only row a drain makes. Prints counts and job statuses only.
// usage: node scripts/tools/drain-job-probe.mjs   (from the deploy checkout; at most about 2.5 minutes)
import { spawnSync } from "node:child_process";
const q = (sql, write) => {
  const r = spawnSync(process.execPath, ["scripts/tools/sb-query.mjs", ...(write ? ["--write"] : []), sql], { encoding: "utf8" });
  if (r.status !== 0) throw new Error((r.stderr || r.stdout).slice(0, 300));
  return JSON.parse(r.stdout);
};
const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const scope = "user:__p4probe_" + Date.now();
const [{ at }] = q(`insert into public.backup_scrub_queue (username) values ('${scope}') returning to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS') as at`, true);
console.log("queued a probe scrub at", at, "UTC");
// The probe row is gone only once a drain of it committed; a failed COMMIT would fail the whole CALL and keep the row.
// A run that began just before the insert committed may not see it, so every finished run since must have succeeded.
let left = null, done = [];
for (let i = 0; i < 15; i++) {
  nap(10000);
  [{ left }] = q(`select count(*)::int as left from public.backup_scrub_queue where username = '${scope}'`);
  done = q(`select status, return_message as msg, to_char(start_time at time zone 'utc', 'HH24:MI:SS') as started
              from cron.job_run_details d join cron.job j on j.jobid = d.jobid
             where j.jobname = 'backup-scrub-drain' and d.start_time > '${at}'::timestamp at time zone 'utc' and d.status <> 'running'
             order by d.start_time`);
  if (left === 0 && done.length) break;
}
const [{ rows }] = q(`with gone as (delete from public.backup_scrub_queue where username = '${scope}' returning 1)
                      select count(*)::int as rows from gone`, true);   // only if it was never drained
const [{ markers }] = q(`with gone as (delete from public.settings where device_id = '${scope}' and key = 'last_restore_at' returning 1)
                         select count(*)::int as markers from gone`, true);
const ok = left === 0 && done.length > 0 && done.every((x) => x.status === "succeeded" && x.msg === "CALL");
console.log(`probe row left: ${left} (removed by hand: ${rows}); runs since: ${done.map((x) => `${x.started} ${x.status} '${x.msg}'`).join(", ") || "none"}; probe markers removed: ${markers}`);
console.log(ok ? "LIVE-DRAIN-OK" : "LIVE-DRAIN-FAIL");
process.exitCode = ok ? 0 : 1;
