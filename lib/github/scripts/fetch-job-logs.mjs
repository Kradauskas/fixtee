// Saves the raw logs of a run's failed jobs as parser fixtures: fixtures/ci-logs/<name>.log
// (one job: <name>.log; several: <name>.<job_id>.log). Uses the app's installation on the repo.
//
// Usage (from the repo root, Node >= 23.6 for .ts imports):
//   node --no-warnings --env-file=.env.local lib/github/scripts/fetch-job-logs.mjs <owner/repo> <run_id> <name>
import { mkdirSync, writeFileSync } from "node:fs";
import { getGitHubApp, getInstallationOctokit } from "../app.ts";
import { fetchFailedJobLogs } from "../logs.ts";

const [full, runId, name] = process.argv.slice(2);
if (!full?.includes("/") || !runId || !name) {
  console.error("usage: fetch-job-logs.mjs <owner/repo> <run_id> <name>");
  process.exit(1);
}
const [owner, repo] = full.split("/");
const { data: inst } = await getGitHubApp().octokit.request("GET /repos/{owner}/{repo}/installation", { owner, repo });
const octokit = await getInstallationOctokit(inst.id);
const logs = await fetchFailedJobLogs(octokit, owner, repo, Number(runId), (id, e) =>
  console.error(`job ${id}: ${e.message}`),
);
if (logs.length === 0) console.error("no failed jobs in that run");
mkdirSync("fixtures/ci-logs", { recursive: true });
for (const { jobId, jobName, log } of logs) {
  const file = `fixtures/ci-logs/${logs.length === 1 ? name : `${name}.${jobId}`}.log`;
  writeFileSync(file, log);
  console.log(`${file}  (job ${jobId} "${jobName}", ${log.length} chars)`);
}
