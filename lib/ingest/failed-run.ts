/**
 * What happens after the webhook accepts a failed CI run. Runs in the background (after()).
 * Task 5: fetch + parse the failed jobs' logs. Task 6: dedup and start the agent.
 */
import { getServiceClient } from "../db/supabase";
import { getInstallationOctokit } from "../github/app";
import { fetchFailedJobLogs } from "../github/logs";
import { fingerprint } from "./fingerprint";
import { parseJestLog } from "./parse-jest";
import { type ErrorRecord, createErrorStore, recordError } from "./record-error";

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
  // One error per distinct fingerprint: matrix jobs failing the same test count once per run.
  const records = new Map<string, ErrorRecord>();
  for (const job of logs) {
    const p = parseJestLog(job.log, ctx.repo);
    const fp = fingerprint(ctx.projectId, p, ctx.workflowName, job.jobName);
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
        fingerprint: fp.slice(0, 12),
      })}`,
    );
    if (records.has(fp)) continue;
    records.set(fp, {
      projectId: ctx.projectId,
      fingerprint: fp,
      testName: p.testName,
      errorType: p.errorType,
      errorMessage: p.errorMessage,
      logExcerpt: p.logExcerpt,
      filePath: p.filePath,
      line: p.line,
      commitSha: ctx.headSha,
      workflowRunId: ctx.runId,
      runUrl: ctx.runUrl,
      parsed: p.parsed,
    });
  }

  const store = createErrorStore(getServiceClient());
  for (const record of records.values()) {
    try {
      const r = await recordError(store, record);
      console.info(`ingest: error recorded ${JSON.stringify({ run: ctx.runId, ...r })}`);
      if (r.fixId) await startAgent(r.errorId);
    } catch (err) {
      console.error(`ingest: recording error failed ${JSON.stringify({ run: ctx.runId })}`, err);
    }
  }
}

/**
 * Role 2's agent. Contract: recordError() has already inserted a `queued` fix for this error; the
 * agent looks it up by error_id and moves it along. runAgent never throws, but guard anyway so the
 * agent can't crash ingestion.
 */
async function startAgent(errorId: string): Promise<void> {
  try {
    // Loaded on demand: keeps the agent (Anthropic SDK etc.) out of webhook requests that don't
    // start it, and out of tests that import this module.
    const { runAgent } = await import("../agent");
    await runAgent(errorId, { dryRun: false });
  } catch (err) {
    console.error(`ingest: runAgent failed ${JSON.stringify({ errorId })}`, err);
  }
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
