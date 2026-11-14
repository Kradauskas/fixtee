/**
 * What happens after the webhook accepts a failed CI run. Runs in the background (after()).
 * Task 5: fetch + parse the failed jobs' logs. Task 6: dedup and start the agent.
 * Task 7: CI on the agent's own autofix/<fix_id> branches goes to Role 3's verification instead.
 */
import { getServiceClient } from "../db/supabase";
import { getInstallationOctokit } from "../github/app";
import {
  type FixBranchRef,
  normalizeConclusion,
  type VerificationResult,
  verifyFixByBranch,
} from "../verify/state-machine";
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

/** autofix/<fix uuid>: the branch name the agent pushes to (fix id = fixes.id). */
const AUTOFIX_BRANCH = /^autofix\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function fixIdFromBranch(branch: string | null): string | null {
  return branch?.match(AUTOFIX_BRANCH)?.[1]?.toLowerCase() ?? null;
}

export type VerifyByBranch = (ref: FixBranchRef) => Promise<VerificationResult | null>;

/**
 * GitHub's run list (status=completed) can lag the workflow_run.completed webhook by a few
 * seconds, so verification may not see the run that just finished yet. If this run ended with a
 * final conclusion but the fix isn't settled, look again after these delays.
 */
export const VERIFY_RETRY_DELAYS_MS = [5_000, 15_000];
const SETTLED = new Set(["verified", "failed"]);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * CI finished on an autofix/<fix_id> branch (any conclusion). Never creates an `errors` row.
 * Role 3's verifyFixByBranch looks the fix up within this project, fetches the CI result of both
 * the fix's test commit and fix commit from GitHub, and runs the red/green state machine. That
 * makes it independent of which run's webhook arrives first, a no-op once the fix is settled, and
 * it ignores unrelated runs on the branch (e.g. the one GitHub starts when the branch is created).
 */
export async function handleAutofixRun(
  ctx: WorkflowRunContext,
  verify: VerifyByBranch = verifyFixByBranch,
  retryDelaysMs: number[] = VERIFY_RETRY_DELAYS_MS,
): Promise<void> {
  const fixId = fixIdFromBranch(ctx.headBranch);
  if (!fixId || !ctx.headBranch) {
    console.info(`ingest: autofix run on a malformed branch, ignored ${JSON.stringify(summarize(ctx))}`);
    return;
  }
  try {
    const ref: FixBranchRef = {
      projectId: ctx.projectId,
      branchName: ctx.headBranch,
      headSha: ctx.headSha,
      conclusion: ctx.conclusion,
      runUrl: ctx.runUrl,
    };
    let result = await verify(ref);
    const final = normalizeConclusion(ctx.conclusion) !== null;
    for (const delay of final ? retryDelaysMs : []) {
      if (!result || SETTLED.has(result.status)) break;
      await sleep(delay);
      result = await verify(ref);
    }
    if (!result) {
      console.info(`ingest: autofix run for unknown or settled fix ${JSON.stringify({ fix: fixId, run: ctx.runId })}`);
      return;
    }
    console.info(
      `ingest: fix verification ${JSON.stringify({
        fix: fixId,
        run: ctx.runId,
        conclusion: ctx.conclusion,
        outcome: result.outcome,
        status: result.status,
        commented: result.commented,
        readyForReview: result.markedReadyForReview,
      })}`,
    );
  } catch (err) {
    console.error(`ingest: fix verification failed ${JSON.stringify({ fix: fixId, run: ctx.runId })}`, err);
  }
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
