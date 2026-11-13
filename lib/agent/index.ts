import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { AgentError, runAgent as runAgentLoop } from "@/lib/agent/agent";
import {
  changesToPlannedJson,
  confidenceToNumber,
  createFix,
  loadError,
  updateFix,
  type ErrorWithProject,
  type FixPatch,
} from "@/lib/agent/db";
import { getGithubConfig, GithubFixError, openFixPr } from "@/lib/agent/github";
import type { AgentOutput, ErrorInput } from "@/lib/agent/types";

// TODO: check out the project's real repo instead of the demo repo.
const DEMO_REPO_ROOT = path.join(process.cwd(), "fixtures", "agent", "demo-repo");

export type RunAgentOptions = {
  /** When true (default), nothing is written to GitHub or the DB; planned writes are only logged. */
  dryRun?: boolean;
};

function describeError(err: unknown): string {
  if (err instanceof AgentError) return `[${err.code}] ${err.message}`;
  if (err instanceof GithubFixError) return err.message;
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

function buildReasoning(output: AgentOutput): string {
  return `${output.explanation}\n\nRoot cause:\n${output.root_cause}`;
}

/**
 * Run the fixing agent for one stored error and record progress in `fixes`:
 * queued -> analyzing -> test_pushed -> fix_pushed, or failed on any error.
 *
 * With dryRun (default true) the error row is still read, and the agent still runs,
 * but no fixes row is created/updated and nothing is pushed to GitHub.
 *
 * Never throws: every failure is logged (and, when not a dry run, stored as status 'failed').
 */
export async function runAgent(errorId: string, { dryRun = true }: RunAgentOptions = {}): Promise<void> {
  const tag = `[agent] ${errorId}${dryRun ? " (dry run)" : ""}`;
  let fixId: string | null = null;
  let reasoningSaved = false;

  /** Write a patch to the fix row, or just log it in dry-run mode. */
  const writeFix = async (patch: FixPatch): Promise<void> => {
    if (dryRun) {
      console.log(`${tag}: would update fix:`, JSON.stringify(patch, null, 2));
      return;
    }
    if (!fixId) return; // failed before the fix row was created; nothing to update
    await updateFix(fixId, patch);
    console.log(`${tag}: fix ${fixId} -> ${patch.status ?? "(status unchanged)"}`);
  };

  try {
    const row = await loadError(errorId);
    const input = toErrorInput(row);
    const project = row.projects;

    if (dryRun) {
      console.log(`${tag}: would create fix (status queued) for error ${errorId}`);
    } else {
      fixId = (await createFix(errorId)).id;
      console.log(`${tag}: created fix ${fixId} (queued)`);
    }

    await writeFix({ status: "analyzing" });

    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set.");

    // With a GitHub App installation, the PR goes to the project's own repo (owner/name from projects).
    // Without one we fall back to GITHUB_TOKEN + GITHUB_REPO and refuse to push to a different repo.
    const installation = project.installation_id
      ? { installationId: project.installation_id, owner: project.repo_owner, repo: project.repo_name }
      : undefined;
    if (!dryRun && !installation) {
      const gh = getGithubConfig();
      const same =
        gh.owner.toLowerCase() === project.repo_owner.toLowerCase() &&
        gh.repo.toLowerCase() === project.repo_name.toLowerCase();
      if (!same) {
        throw new Error(
          `GITHUB_REPO is ${gh.owner}/${gh.repo}, but error ${errorId} belongs to ${project.repo_owner}/${project.repo_name}.`,
        );
      }
    }

    console.log(`${tag}: running agent for ${project.repo_owner}/${project.repo_name} (demo repo checkout)`);
    const result = await runAgentLoop({
      client: new Anthropic({ apiKey }),
      repoRoot: DEMO_REPO_ROOT,
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
        `${tag}: would open PR on ${project.repo_owner}/${project.repo_name} via ` +
          (installation ? `GitHub App installation ${installation.installationId}` : "GITHUB_TOKEN (PAT fallback)"),
      );
      console.log(`${tag}: would push test commit (${output.test.file_path}) -> status test_pushed`);
      console.log(`${tag}: would push fix commit and open draft PR -> status fix_pushed`);
      console.log(`${tag}: agent output:`, JSON.stringify(output, null, 2));
      return;
    }

    const pr = await openFixPr(output, errorId, fixId!, {
      installation,
      onTestCommitted: ({ branch, testCommitSha }) =>
        writeFix({ status: "test_pushed", branch_name: branch, test_commit_sha: testCommitSha }),
    });
    if (!pr) throw new Error("openFixPr returned no PR.");

    await writeFix({
      status: "fix_pushed",
      branch_name: pr.branch,
      test_commit_sha: pr.testCommitSha,
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
  }
}
