// After 20261027200000 is applied: checks the 2-day job's command and, only while no account is due a 2-day backup (so
// the run writes nothing), calls the procedure once as a top-level statement, the way pg_cron sends the job: a CALL that
// commits must succeed there (a rolled-back test can only show it reaching its COMMIT). An account due skips the call:
// the scheduled run is then the proof (its cron.job_run_details row must read 'succeeded' / 'CALL'). Counts and job
// statuses only. usage: node scripts/tools/backup-job-probe.mjs   (from the deploy checkout)
import { spawnSync } from "node:child_process";
const q = (sql, write) => {
  const r = spawnSync(process.execPath, ["scripts/tools/sb-query.mjs", ...(write ? ["--write"] : []), sql], { encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout || "") + (r.stderr || "") };
};
const due = `select count(*) from proxima_auth.users u where u.auto_backups and u.disabled_at is null and u.deleted_at is null
               and exists (select 1 from public.tasks t where t.device_id = u.scope)`;
const job = q(`select command, schedule, active from cron.job where jobname = 'auto-backup-2day'`);
const cmdOk = job.ok && /"command":"call public\._auto_backup_job\(\)"/.test(job.out) && /"active":true/.test(job.out);
console.log(`job: ${cmdOk ? "calls public._auto_backup_job(), active" : "NOT the procedure call: " + job.out.slice(0, 200)}`);
const [{ n }] = JSON.parse(q(`select (${due})::int as n`).out);
let verdict;
if (!cmdOk) verdict = "LIVE-JOB-FAIL";
else if (n > 0) { console.log(`${n} account(s) due a 2-day backup: no call (it would write their backups); the next scheduled run is the proof`); verdict = "LIVE-JOB-SKIPPED"; }
else {
  // The count is taken again inside the same statement, right before the call.
  const r = q(`do $p$ begin if (${due}) = 0 then call public._auto_backup_job(); else raise exception 'an account became due: no call'; end if; end $p$`, true);
  if (r.ok) { console.log("the top-level call ran and committed (no account due: no backup written)"); verdict = "LIVE-JOB-CALL-OK"; }
  else if (/2D000|invalid transaction termination/.test(r.out)) { console.log("the Management API ran it inside a transaction (2D000): inconclusive here; the next scheduled run is the proof"); verdict = "LIVE-JOB-INCONCLUSIVE"; }
  else if (/an account became due/.test(r.out)) { console.log("an account became due meanwhile: no call"); verdict = "LIVE-JOB-SKIPPED"; }
  else { console.log("the call failed: " + r.out.slice(0, 300)); verdict = "LIVE-JOB-FAIL"; }
}
const last = q(`select status, return_message as msg, to_char(start_time at time zone 'utc', 'YYYY-MM-DD HH24:MI') as started
                  from cron.job_run_details d join cron.job j on j.jobid = d.jobid
                 where j.jobname = 'auto-backup-2day' order by d.start_time desc limit 1`);
console.log(`last scheduled run: ${last.out.trim().slice(0, 160)}`);
console.log(verdict);
process.exitCode = verdict === "LIVE-JOB-FAIL" ? 1 : 0;
