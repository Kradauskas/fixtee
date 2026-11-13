import { z } from "zod";
import { getServiceClient, type Db } from "../db/supabase";
import { Constants, type Tables, type TablesUpdate } from "../db/types";
import { getInstallationOctokit } from "../github/app";

export type FixStatus = Tables<"fixes">["status"];

export type CiConclusion = "success" | "failure" | null;

export type CiRun = { conclusion: CiConclusion; runUrl: string | null };

export const NO_CI_RUN: CiRun = { conclusion: null, runUrl: null };

export type FixVerificationContext = {
  fixId: string;
  status: FixStatus;
  confidence: number | null;
  branchName: string | null;
  prNumber: number | null;
  prUrl: string | null;
  testCommitSha: string | null;
  fixCommitSha: string | null;
  owner: string;
  repo: string;
  installationId: number;
};

export type VerificationOutcome =
  | "pending"
  | "test_reproduced"
  | "guardrail_test_passed"
  | "fix_failed_ci"
  | "verified";

export type AgentCiResult = {
  fixId: string;
  testConclusion: CiConclusion;
  fixConclusion: CiConclusion;
  testRunUrl?: string | null;
  fixRunUrl?: string | null;
};

export type VerificationResult = {
  status: FixStatus;
  outcome: VerificationOutcome;
  testRunUrl: string | null;
  fixRunUrl: string | null;
  commented: boolean;
  markedReadyForReview: boolean;
};

export type FixRunUrls = { redRunUrl?: string; greenRunUrl?: string };

export type FixBranchRef = { projectId: string; branchName: string };

export type VerifyDeps = {
  loadFix(fixId: string): Promise<FixVerificationContext | null>;
  findFixIdByBranch(projectId: string, branchName: string): Promise<string | null>;
  saveStatus(fixId: string, status: FixStatus, runUrls: FixRunUrls): Promise<void>;
  postPrComment(fix: FixVerificationContext, body: string): Promise<void>;
  markReadyForReview(fix: FixVerificationContext): Promise<void>;
  findCompletedRun(fix: FixVerificationContext, sha: string): Promise<CiRun>;
  log(message: string, details?: Record<string, unknown>): void;
};

const STATUS_BY_OUTCOME: Record<VerificationOutcome, FixStatus | null> = {
  pending: null,
  test_reproduced: "fix_pushed",
  guardrail_test_passed: "failed",
  fix_failed_ci: "failed",
  verified: "verified",
};

const SETTLED_STATUSES: ReadonlySet<FixStatus> = new Set<FixStatus>(["verified", "failed"]);

export const NON_TERMINAL_STATUSES: FixStatus[] = Constants.public.Enums.fix_status.filter(
  (status) => !SETTLED_STATUSES.has(status),
);

export function decideOutcome(
  testConclusion: CiConclusion,
  fixConclusion: CiConclusion,
): VerificationOutcome {
  if (testConclusion === "success") return "guardrail_test_passed";
  if (testConclusion !== "failure") return "pending";
  if (fixConclusion === "success") return "verified";
  if (fixConclusion === "failure") return "fix_failed_ci";
  return "test_reproduced";
}

export async function handleAgentCiResult(
  { fixId, testConclusion, fixConclusion, testRunUrl = null, fixRunUrl = null }: AgentCiResult,
  deps: VerifyDeps = createVerifyDeps(),
): Promise<VerificationResult> {
  const fix = await deps.loadFix(fixId);
  if (!fix) throw new Error(`verify: fix ${fixId} not found`);

  const outcome = decideOutcome(testConclusion, fixConclusion);
  const noChange = (status: FixStatus): VerificationResult => ({
    status,
    outcome,
    testRunUrl,
    fixRunUrl,
    commented: false,
    markedReadyForReview: false,
  });

  const target = STATUS_BY_OUTCOME[outcome];
  if (target === null) {
    deps.log("verify: CI result is not conclusive yet", {
      fix: fixId,
      test: testConclusion,
      fixCommit: fixConclusion,
    });
    return noChange(fix.status);
  }
  if (SETTLED_STATUSES.has(fix.status)) {
    deps.log("verify: fix already settled, skipping", { fix: fixId, status: fix.status, outcome });
    return noChange(fix.status);
  }

  const runUrls: FixRunUrls = {};
  if (testRunUrl) runUrls.redRunUrl = testRunUrl;
  if (outcome === "verified" && fixRunUrl) runUrls.greenRunUrl = fixRunUrl;
  await deps.saveStatus(fixId, target, runUrls);

  const body = buildComment(outcome, fix, testRunUrl, fixRunUrl);
  const hasPr = fix.prNumber !== null;
  if (body && !hasPr) {
    deps.log("verify: no pull request recorded, skipping comment", { fix: fixId, outcome });
  }

  const commented = Boolean(body) && hasPr;
  if (body && hasPr) await deps.postPrComment(fix, body);

  const markedReadyForReview = outcome === "verified" && hasPr;
  if (markedReadyForReview) await deps.markReadyForReview(fix);

  deps.log("verify: fix updated", {
    fix: fixId,
    outcome,
    status: target,
    commented,
    readyForReview: markedReadyForReview,
  });

  return { status: target, outcome, testRunUrl, fixRunUrl, commented, markedReadyForReview };
}

export async function syncFixVerification(
  fixId: string,
  deps: VerifyDeps = createVerifyDeps(),
): Promise<VerificationResult> {
  const fix = await deps.loadFix(fixId);
  if (!fix) throw new Error(`verify: fix ${fixId} not found`);

  const testRun = fix.testCommitSha ? await deps.findCompletedRun(fix, fix.testCommitSha) : NO_CI_RUN;
  const fixRun = fix.fixCommitSha ? await deps.findCompletedRun(fix, fix.fixCommitSha) : NO_CI_RUN;

  return handleAgentCiResult(
    {
      fixId,
      testConclusion: testRun.conclusion,
      fixConclusion: fixRun.conclusion,
      testRunUrl: testRun.runUrl,
      fixRunUrl: fixRun.runUrl,
    },
    { ...deps, loadFix: async () => fix },
  );
}

export async function verifyFixByBranch(
  { projectId, branchName }: FixBranchRef,
  deps: VerifyDeps = createVerifyDeps(),
): Promise<VerificationResult | null> {
  const fixId = await deps.findFixIdByBranch(projectId, branchName);
  if (!fixId) {
    deps.log("verify: no fix awaiting verification for this branch", {
      project: projectId,
      branch: branchName,
    });
    return null;
  }
  return syncFixVerification(fixId, deps);
}

function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 7) : "unknown";
}

function formatConfidence(confidence: number | null): string {
  return confidence === null ? "not recorded" : `${Math.round(confidence * 100)}%`;
}

function runLink(label: string, url: string | null): string {
  return url ? `[${label}](${url})` : label;
}

export function buildComment(
  outcome: VerificationOutcome,
  fix: FixVerificationContext,
  testRunUrl: string | null,
  fixRunUrl: string | null,
): string | null {
  const testSha = shortSha(fix.testCommitSha);
  const fixSha = shortSha(fix.fixCommitSha);

  switch (outcome) {
    case "verified":
      return [
        "## 🟢 Fixtee verified this fix",
        "",
        "| Commit | What it proves | CI |",
        "| --- | --- | --- |",
        `| \`${testSha}\` | 🔴 reproduction test, without the fix | ${runLink("failed as expected", testRunUrl)} |`,
        `| \`${fixSha}\` | 🟢 the same test, with the fix | ${runLink("passed", fixRunUrl)} |`,
        "",
        "The test fails before the change and passes after it, so this change is what turns CI green.",
        "",
        `Agent confidence: ${formatConfidence(fix.confidence)}.`,
        "",
        "Marking this pull request ready for review.",
      ].join("\n");

    case "guardrail_test_passed":
      return [
        "## ⚠️ Fixtee could not verify this fix",
        "",
        `The reproduction test on \`${testSha}\` ${runLink("passed without the fix", testRunUrl)}.`,
        "",
        "A test that already passes before the fix does not reproduce the reported bug, so nothing here shows the change is needed or that it works.",
        "",
        "This pull request stays a draft for a human to look at.",
      ].join("\n");

    case "fix_failed_ci":
      return [
        "## ❌ Fixtee could not verify this fix",
        "",
        `🔴 The reproduction test on \`${testSha}\` ${runLink("failed as expected", testRunUrl)}, so the bug is reproduced.`,
        `❌ But CI still ${runLink("fails on the fix commit", fixRunUrl)} \`${fixSha}\`.`,
        "",
        "The change does not make the failing test pass. This pull request stays a draft for a human to look at.",
        "",
        `Agent confidence: ${formatConfidence(fix.confidence)}.`,
      ].join("\n");

    default:
      return null;
  }
}

export type GithubClient = {
  request(route: string, params: Record<string, unknown>): Promise<{ data: unknown }>;
  graphql(query: string, variables: Record<string, unknown>): Promise<unknown>;
};

export type VerifyDepsOptions = {
  db?: Db;
  getClient?: (installationId: number) => Promise<GithubClient>;
};

const workflowRunsSchema = z.object({
  workflow_runs: z.array(
    z.object({
      conclusion: z.string().nullable(),
      html_url: z.string(),
    }),
  ),
});

const pullRequestSchema = z.object({ node_id: z.string() });

function embedded<T extends z.ZodTypeAny>(schema: T) {
  return z.union([
    schema,
    z
      .array(schema)
      .min(1)
      .transform((rows) => rows[0]),
  ]);
}

const projectSchema = z.object({
  repo_owner: z.string(),
  repo_name: z.string(),
  installation_id: z.number(),
});

const errorSchema = z.object({ projects: embedded(projectSchema) });

const fixRowSchema = z.object({
  id: z.string(),
  status: z.string(),
  confidence: z.number().nullable(),
  branch_name: z.string().nullable(),
  pr_number: z.number().nullable(),
  pr_url: z.string().nullable(),
  test_commit_sha: z.string().nullable(),
  fix_commit_sha: z.string().nullable(),
  errors: embedded(errorSchema),
});

const READY_FOR_REVIEW_MUTATION = `
  mutation MarkReady($pullRequestId: ID!) {
    markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
      pullRequest {
        number
        isDraft
      }
    }
  }
`;

export function pickRun(runs: { conclusion: string | null; html_url: string }[]): CiRun {
  const failed = runs.find((run) => run.conclusion === "failure");
  if (failed) return { conclusion: "failure", runUrl: failed.html_url };

  const passed = runs.find((run) => run.conclusion === "success");
  if (passed) return { conclusion: "success", runUrl: passed.html_url };

  return { conclusion: null, runUrl: runs[0]?.html_url ?? null };
}

export function toVerificationContext(row: unknown): FixVerificationContext {
  const fix = fixRowSchema.parse(row);
  const project = fix.errors.projects;
  return {
    fixId: fix.id,
    status: fix.status as FixStatus,
    confidence: fix.confidence,
    branchName: fix.branch_name,
    prNumber: fix.pr_number,
    prUrl: fix.pr_url,
    testCommitSha: fix.test_commit_sha,
    fixCommitSha: fix.fix_commit_sha,
    owner: project.repo_owner,
    repo: project.repo_name,
    installationId: project.installation_id,
  };
}

async function installationClient(installationId: number): Promise<GithubClient> {
  const octokit = await getInstallationOctokit(installationId);
  return {
    request: (route, params) => octokit.request(route, params),
    graphql: (query, variables) => octokit.graphql(query, variables),
  };
}

export function createVerifyDeps(options: VerifyDepsOptions = {}): VerifyDeps {
  const db = options.db ?? getServiceClient();
  const getClient = options.getClient ?? installationClient;

  return {
    async loadFix(fixId) {
      const { data, error } = await db
        .from("fixes")
        .select(
          "id, status, confidence, branch_name, pr_number, pr_url, test_commit_sha, fix_commit_sha, errors(projects(repo_owner, repo_name, installation_id))",
        )
        .eq("id", fixId)
        .maybeSingle();
      if (error) throw new Error(`verify: loading fix ${fixId} failed: ${error.message}`);
      if (!data) return null;
      return toVerificationContext(data);
    },

    async findFixIdByBranch(projectId, branchName) {
      const { data, error } = await db
        .from("fixes")
        .select("id, created_at, errors!inner(project_id)")
        .eq("errors.project_id", projectId)
        .eq("branch_name", branchName)
        .in("status", NON_TERMINAL_STATUSES)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) {
        throw new Error(`verify: looking up a fix for ${branchName} failed: ${error.message}`);
      }
      return data?.id ?? null;
    },

    async saveStatus(fixId, status, runUrls) {
      const patch: TablesUpdate<"fixes"> = { status };
      if (runUrls.redRunUrl) patch.red_run_url = runUrls.redRunUrl;
      if (runUrls.greenRunUrl) patch.green_run_url = runUrls.greenRunUrl;

      const { error } = await db.from("fixes").update(patch).eq("id", fixId);
      if (error) throw new Error(`verify: updating fix ${fixId} failed: ${error.message}`);
    },

    async postPrComment(fix, body) {
      if (fix.prNumber === null) return;
      const client = await getClient(fix.installationId);
      await client.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
        owner: fix.owner,
        repo: fix.repo,
        issue_number: fix.prNumber,
        body,
      });
    },

    async markReadyForReview(fix) {
      if (fix.prNumber === null) return;
      const client = await getClient(fix.installationId);
      const pull = await client.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner: fix.owner,
        repo: fix.repo,
        pull_number: fix.prNumber,
      });
      const { node_id } = pullRequestSchema.parse(pull.data);
      await client.graphql(READY_FOR_REVIEW_MUTATION, { pullRequestId: node_id });
    },

    async findCompletedRun(fix, sha) {
      const client = await getClient(fix.installationId);
      const response = await client.request("GET /repos/{owner}/{repo}/actions/runs", {
        owner: fix.owner,
        repo: fix.repo,
        head_sha: sha,
        status: "completed",
        per_page: 100,
      });
      return pickRun(workflowRunsSchema.parse(response.data).workflow_runs);
    },

    log: (message, details) =>
      console.info(details ? `${message} ${JSON.stringify(details)}` : message),
  };
}
