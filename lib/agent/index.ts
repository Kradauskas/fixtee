import Anthropic from "@anthropic-ai/sdk";
import { AgentError, runAgent as runAgentLoop } from "@/lib/agent/agent";
import {
  changesToPlannedJson,
  confidenceToNumber,
  createFix,
  findQueuedFix,
  getProjectLlmKey,
  loadError,
  updateFix,
  type ErrorWithProject,
  type FixPatch,
} from "@/lib/agent/db";
import { GithubFixError, openFixPr } from "@/lib/agent/github";
import { checkoutRepo, RepoCheckoutError, type RepoCheckout } from "@/lib/agent/repo";
import type { AgentOutput, ErrorInput } from "@/lib/agent/types";

export type RunAgentOptions = {
  /** When true (default), nothing is written to GitHub or the DB; planned writes are only logged. */
  dryRun?: boolean;
};

function describeError(err: unknown): string {
  if (err instanceof AgentError) return `[${err.code}] ${err.message}`;
  if (err instanceof GithubFixError || err instanceof RepoCheckoutError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

/** Map an errors row to the agent's input. Throws if there is nothing to analyse. */
function toErrorInput(row: ErrorWithProject): ErrorInput {
  if (!row.error_message && !row.log_excerpt) {
    throw new Error(`error ${row.id} has neither error_message nor log_excerpt; nothing to analyse.`);
  }
  return {
    error_id: row.id,
    error_message: row.error_message ?? row.test_name ?? "(no error message)",
    log_excerpt: row.log_excerpt ?? "(no log excerpt)",
    file_path: row.file_path ?? "unknown",
    line: row.line ?? 0,
    commit_sha: row.commit_sha,
  };
}

/**
 * The Anthropic API key for a project: its own key (get_project_llm_key) if set, else ANTHROPIC_API_KEY.
 * The agent only speaks Anthropic, so projects configured for another provider fail here.
 */
async function resolveLlmKey(project: ErrorWithProject["projects"]): Promise<string> {
  if (project.llm_provider && project.llm_provider !== "anthropic") {
    throw new Error(
      `project ${project.id} uses LLM provider "${project.llm_provider}", but the agent only supports "anthropic". ` +
        "Switch the project to anthropic or remove its provider setting.",
    );
  }
  const projectKey = await getProjectLlmKey(project.id);
  if (projectKey) return projectKey;
  const envKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!envKey) throw new Error(`project ${project.id} has no LLM key and ANTHROPIC_API_KEY is not set.`);
  return envKey;
}

function buildReasoning(output: AgentOutput): string {
  return `${output.explanation}\n\nRoot cause:\n${output.root_cause}`;
}

/**
 * Run the fixing agent for one stored error and record progress in `fixes`:
 * queued -> analyzing -> test_pushed -> fix_pushed, or failed on any error.
 *
 * The agent reads the project's real repo (projects.repo_owner/repo_name) at errors.commit_sha,
 * downloaded via the project's GitHub App installation into a temp dir that is deleted afterwards.
 *
 * With dryRun (default true) the error row is still read, the repo is still downloaded (read only)
 * and the agent still runs, but no fixes row is created/updated and nothing is pushed to GitHub.
 *
 * Never throws: every failure is logged (and, when not a dry run, stored as status 'failed').
 */
export async function runAgent(errorId: string, { dryRun = true }: RunAgentOptions = {}): Promise<void> {
  const tag = `[agent] ${errorId}${dryRun ? " (dry run)" : ""}`;
  let fixId: string | null = null;
  let reasoningSaved = false;
  let checkout: RepoCheckout | undefined;

  /** Write a patch to the fix row, or just log it in dry-run mode. */
  const writeFix = async (patch: FixPatch): Promise<void> => {
    if (dryRun) {
      console.log(`${tag}: would update fix:`, JSON.stringify(patch, null, 2));
      return;
    }
    if (!fixId) return; // failed before the fix row was created; nothing to update
    const row = await updateFix(fixId, patch);
    if (patch.status && row.status !== patch.status) {
      console.log(`${tag}: fix ${fixId} stays ${row.status} (not moving back to ${patch.status})`);
    } else {
      console.log(`${tag}: fix ${fixId} -> ${row.status}`);
    }
  };

  try {
    const row = await loadError(errorId);
    const input = toErrorInput(row);
    const project = row.projects;

    if (dryRun) {
      console.log(`${tag}: would create fix (status queued) for error ${errorId}`);
    } else {
      // Reuse the newest queued fix for this error (branch autofix/<fix.id>); otherwise create one.
      const queued = await findQueuedFix(errorId);
      if (queued) {
        fixId = queued.id;
        console.log(`${tag}: reusing queued fix ${fixId}`);
      } else {
        fixId = (await createFix(errorId)).id;
        console.log(`${tag}: created fix ${fixId} (queued)`);
      }
    }

    await writeFix({ status: "analyzing" });

    const apiKey = await resolveLlmKey(project);

    // Every project has a GitHub App installation; it is used both to read the repo and to open the PR.
    const installation = { installationId: project.installation_id, owner: project.repo_owner, repo: project.repo_name };
    const repoLabel = `${project.repo_owner}/${project.repo_name}@${input.commit_sha.slice(0, 7)}`;

    console.log(`${tag}: downloading ${repoLabel}`);
    checkout = await checkoutRepo({ ...installation, ref: input.commit_sha });

    console.log(`${tag}: running agent for ${repoLabel}`);
    const result = await runAgentLoop({
      client: new Anthropic({ apiKey }),
      repoRoot: checkout.root,
      input,
      onStep: ({ step, tools }) => console.log(`${tag}: step ${step}: ${tools.join(", ") || "(no tool call)"}`),
    });
    const output = result.output;
    console.log(
      `${tag}: agent done in ${result.steps} steps ` +
        `(${result.usage.input_tokens} in / ${result.usage.output_tokens} out tokens), confidence ${output.confidence}`,
    );

    await writeFix({
      ai_reasoning: buildReasoning(output),
      confidence: confidenceToNumber(output.confidence),
      tokens_used: result.usage.input_tokens + result.usage.output_tokens,
      planned_changes: changesToPlannedJson(output.changes),
    });
    reasoningSaved = true;

    if (output.confidence === "low") {
      throw new Error("agent confidence is low; PR not opened.");
    }

    if (dryRun) {
      console.log(
        `${tag}: would open PR on ${project.repo_owner}/${project.repo_name} via GitHub App installation ${installation.installationId}`,
      );
      console.log(`${tag}: would push test commit (${output.test.file_path}) -> status test_pushed`);
      console.log(`${tag}: would push fix commit and open draft PR -> status fix_pushed`);
      console.log(`${tag}: agent output:`, JSON.stringify(output, null, 2));
      return;
    }

    const pr = await openFixPr(output, errorId, fixId!, {
      installation,
      // Check the edits against, and branch from, the commit the agent actually read.
      commitSha: input.commit_sha,
      failingRunUrl: row.run_url,
      // branch_name is stored before anything is pushed, so a crash mid-push still leaves a trace.
      onBranchReady: ({ branch }) => writeFix({ branch_name: branch }),
      onTestCommitted: ({ testCommitSha }) => writeFix({ status: "test_pushed", test_commit_sha: testCommitSha }),
    });
    if (!pr) throw new Error("openFixPr returned no PR.");

    if (pr.testCommitSha === null) {
      // No test commit (existing test already reproduces the error): the failing CI run is the red run.
      console.log(`${tag}: ${output.test.file_path} unchanged; no test commit, red run = ${row.run_url}`);
      await writeFix({ test_commit_sha: null, red_run_url: row.run_url });
    }

    // Only the PR columns; status only moves forward (verification may already be further along).
    await writeFix({
      status: "fix_pushed",
      fix_commit_sha: pr.fixCommitSha,
      pr_number: pr.prNumber,
      pr_url: pr.prUrl,
    });
    console.log(`${tag}: PR #${pr.prNumber} opened: ${pr.prUrl}`);
  } catch (err) {
    const detail = describeError(err);
    console.error(`${tag}: failed: ${detail}`);
    try {
      await writeFix(reasoningSaved ? { status: "failed" } : { status: "failed", ai_reasoning: `Failed: ${detail}` });
    } catch (updateErr) {
      console.error(`${tag}: could not mark fix ${fixId} as failed: ${describeError(updateErr)}`);
    }
  } finally {
    await checkout?.cleanup();
  }
}
