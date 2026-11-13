/**
 * What happens after the webhook accepts a failed CI run. Runs in the background (after()).
 * Task 4: log it. Task 5 fetches + parses the logs here, Task 6 dedups and starts the agent.
 */

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
  console.info("ingest: failed run received", summarize(ctx));
}

/** autofix/* branch finished CI. Task 7 maps it to handleAgentCiResult (Role 3). */
export async function handleAutofixRun(ctx: WorkflowRunContext): Promise<void> {
  console.info("ingest: autofix run received (not handled until Task 7)", summarize(ctx));
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
