/**
 * What happens after the webhook accepts a failed CI run. Runs in the background (after()).
 * Task 5: fetch + parse the failed jobs' logs. Task 6: dedup and start the agent.
 */
import { getInstallationOctokit } from "../github/app";
import { fetchFailedJobLogs } from "../github/logs";
import { parseJestLog } from "./parse-jest";

/** A completed workflow_run for a repo we know, as handed over by the webhook. */
export type WorkflowRunContext = {
  deliveryId: string;
  projectId: string;
  installationId: number;
  owner: string;
  repo: string;
  runId: number;
  runAttempt: number;
  runUrl: string;
  headSha: string;
  headBranch: string | null;
  conclusion: string | null;
  workflowName: string | null;
};

export async function handleFailedRun(ctx: WorkflowRunContext): Promise<void> {
  console.info(`ingest: failed run received ${JSON.stringify(summarize(ctx))}`);
  const octokit = await getInstallationOctokit(ctx.installationId);
  const logs = await fetchFailedJobLogs(octokit, ctx.owner, ctx.repo, ctx.runId, (jobId, err) =>
    console.error(`ingest: job log download failed ${JSON.stringify({ run: ctx.runId, job: jobId })}`, err),
  );
  for (const job of logs) {
    const p = parseJestLog(job.log, ctx.repo);
    // Parsed fields only; never the excerpt or raw log.
    console.info(
      `ingest: parsed job ${JSON.stringify({
        run: ctx.runId,
        job: job.jobId,
        jobName: job.jobName,
        parsed: p.parsed,
        test: p.testName,
        errorType: p.errorType,
        at: p.filePath ? `${p.filePath}:${p.line}` : null,
      })}`,
    );
  }
  // Task 6: fingerprint, upsert errors, start the agent.
}

/** autofix/* branch finished CI. Task 7 maps it to handleAgentCiResult (Role 3). */
export async function handleAutofixRun(ctx: WorkflowRunContext): Promise<void> {
  console.info(`ingest: autofix run received (not handled until Task 7) ${JSON.stringify(summarize(ctx))}`);
}

/** Ids and names only: never log payloads, headers or log contents. */
export function summarize(ctx: WorkflowRunContext) {
  return {
    delivery: ctx.deliveryId,
    project: ctx.projectId,
    repo: `${ctx.owner}/${ctx.repo}`,
    run: ctx.runId,
    attempt: ctx.runAttempt,
    branch: ctx.headBranch,
    sha: ctx.headSha.slice(0, 7),
    conclusion: ctx.conclusion,
    url: ctx.runUrl,
  };
}
