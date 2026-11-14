import { z } from "zod";
import {
  NON_TERMINAL_STATUSES,
  SETTLED_STATUSES,
  STATUS_ORDER,
  type FixStatus,
} from "../db/fix-status";
import { getServiceClient, type Db } from "../db/supabase";
import { type TablesUpdate } from "../db/types";
import { getInstallationOctokit } from "../github/app";

export { NON_TERMINAL_STATUSES, SETTLED_STATUSES, STATUS_ORDER, type FixStatus };

export const VERIFICATION_COMMENT_MARKER = "<!-- fixtee:verification -->";
export const PR_DESCRIPTION_MARKER_START = "<!-- fixtee-verification -->";
export const PR_DESCRIPTION_MARKER_END = "<!-- /fixtee-verification -->";
const RED_RUN_PLACEHOLDER = "(it is linked here once verification records it)";
const GREEN_RUN_PLACEHOLDER = "passes (green run).";
const EXISTING_RED_UNAVAILABLE = "- **Red run (existing test failing):** _(run URL not available)_";

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
  redRunUrl: string | null;
  greenRunUrl: string | null;
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

export type RunHint = {
  headSha?: string | null;
  conclusion?: string | null;
  runUrl?: string | null;
};

export type FixBranchRef = { projectId: string; branchName: string } & RunHint;

export type PrDescriptionUpdate = {
  outcome: VerificationOutcome;
  status: FixStatus;
  testRunUrl: string | null;
  fixRunUrl: string | null;
};

export type VerifyDeps = {
  loadFix(fixId: string): Promise<FixVerificationContext | null>;
  findFixIdByBranch(projectId: string, branchName: string): Promise<string | null>;
  saveStatus(fixId: string, status: FixStatus, runUrls: FixRunUrls): Promise<boolean>;
  revertStatus?(fixId: string, fromStatus: FixStatus, toStatus: FixStatus): Promise<void>;
  updatePrDescription?(fix: FixVerificationContext, info: PrDescriptionUpdate): Promise<void>;
  postPrComment(fix: FixVerificationContext, body: string): Promise<void>;
  markReadyForReview(fix: FixVerificationContext): Promise<boolean | void>;
  findCompletedRun(fix: FixVerificationContext, sha: string): Promise<CiRun>;
  log(message: string, details?: Record<string, unknown>): void;
};

type StatusResolver = FixStatus | ((fix: Pick<FixVerificationContext, "fixCommitSha">) => FixStatus);

export const STATUS_BY_OUTCOME: Record<VerificationOutcome, StatusResolver | null> = {
  pending: null,
  test_reproduced: (fix) => (fix.fixCommitSha === null ? "test_failed" : "fix_pushed"),
  guardrail_test_passed: "failed",
  fix_failed_ci: "failed",
  verified: "verified",
};

const FAILURE_CONCLUSIONS: ReadonlySet<string> = new Set([
  "failure",
  "timed_out",
  "startup_failure",
  "action_required",
]);

function resolveTargetStatus(
  outcome: VerificationOutcome,
  fix: Pick<FixVerificationContext, "fixCommitSha">,
): FixStatus | null {
  const entry = STATUS_BY_OUTCOME[outcome];
  return typeof entry === "function" ? entry(fix) : entry;
}

export function allowedSourceStatuses(target: FixStatus): FixStatus[] {
  if (SETTLED_STATUSES.has(target)) return NON_TERMINAL_STATUSES;
  const index = STATUS_ORDER.indexOf(target);
  return index === -1 ? [] : STATUS_ORDER.slice(0, index + 1);
}

export function normalizeConclusion(value: string | null | undefined): CiConclusion {
  if (value === "success") return "success";
  if (value && FAILURE_CONCLUSIONS.has(value)) return "failure";
  return null;
}

export function withRunHint(run: CiRun, sha: string | null, hint: RunHint): CiRun {
  if (run.conclusion !== null) return run;
  if (!sha || !hint.headSha || hint.headSha !== sha) return run;

  const conclusion = normalizeConclusion(hint.conclusion);
  if (conclusion === null) return run;
  return { conclusion, runUrl: hint.runUrl ?? run.runUrl };
}

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

function upsertVerificationSection(body: string, section: string): string {
  const start = PR_DESCRIPTION_MARKER_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const end = PR_DESCRIPTION_MARKER_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const closedPattern = new RegExp(`${start}[\\s\\S]*?${end}`);
  if (closedPattern.test(body)) return body.replace(closedPattern, section);
  if (body.includes(PR_DESCRIPTION_MARKER_START)) {
    const before = body.slice(0, body.indexOf(PR_DESCRIPTION_MARKER_START)).trimEnd();
    return before.length > 0 ? `${before}\n\n${section}` : section;
  }
  const trimmed = body.trimEnd();
  return trimmed.length > 0 ? `${trimmed}\n\n${section}` : section;
}

function buildVerificationSection(
  fix: Pick<FixVerificationContext, "testCommitSha" | "fixCommitSha">,
  info: PrDescriptionUpdate,
): string {
  const redCommit = fix.testCommitSha
    ? `commit \`${shortSha(fix.testCommitSha)}\``
    : "existing test";
  const fixCommit = fix.fixCommitSha
    ? `commit \`${shortSha(fix.fixCommitSha)}\``
    : "fix commit";
  const lines = [PR_DESCRIPTION_MARKER_START, "### Verification status"];

  switch (info.outcome) {
    case "verified":
      lines.push(
        `- **Status:** 🟢 Verified (\`${info.status}\`) — test fails before the fix and passes after it`,
      );
      lines.push(`- **Red CI run:** ${runLink("failed as expected", info.testRunUrl)} (${redCommit})`);
      lines.push(`- **Green CI run:** ${runLink("passed", info.fixRunUrl)} (${fixCommit})`);
      break;
    case "guardrail_test_passed":
      lines.push(
        `- **Status:** ⚠️ Could not verify (\`${info.status}\`) — reproduction test passed without the fix (PR kept as draft)`,
      );
      lines.push(`- **Red CI run:** ${runLink("passed without the fix", info.testRunUrl)} (${redCommit})`);
      break;
    case "fix_failed_ci":
      lines.push(
        `- **Status:** ❌ Could not verify (\`${info.status}\`) — CI still fails on the fix commit (PR kept as draft)`,
      );
      lines.push(`- **Red CI run:** ${runLink("failed as expected", info.testRunUrl)} (${redCommit})`);
      lines.push(`- **Green CI run:** ${runLink("failed in CI", info.fixRunUrl)} (${fixCommit})`);
      break;
    case "test_reproduced":
      lines.push(
        `- **Status:** 🟡 Red CI reproduced (\`${info.status}\`) — awaiting fix commit CI`,
      );
      lines.push(`- **Red CI run:** ${runLink("failed as expected", info.testRunUrl)} (${redCommit})`);
      break;
    default:
      break;
  }

  lines.push(PR_DESCRIPTION_MARKER_END);
  return lines.join("\n");
}

export function buildUpdatedPrDescription(
  body: string,
  fix: Pick<FixVerificationContext, "testCommitSha" | "fixCommitSha">,
  info: PrDescriptionUpdate,
): string {
  let updated = body;

  if (info.testRunUrl) {
    const redReplacement =
      info.outcome === "guardrail_test_passed"
        ? `([passed without the fix](${info.testRunUrl}))`
        : `([red run](${info.testRunUrl}))`;
    updated = updated.replace(RED_RUN_PLACEHOLDER, redReplacement);

    if (info.outcome !== "guardrail_test_passed" && updated.includes(EXISTING_RED_UNAVAILABLE)) {
      updated = updated.replace(
        EXISTING_RED_UNAVAILABLE,
        `- **Red run (existing test failing):** [red run](${info.testRunUrl})`,
      );
    }
  }

  if (info.fixRunUrl && info.outcome === "verified") {
    updated = updated.replace(GREEN_RUN_PLACEHOLDER, `passes ([green run](${info.fixRunUrl})).`);
  }

  if (info.outcome === "pending") return updated;
  return upsertVerificationSection(updated, buildVerificationSection(fix, info));
}

export async function handleAgentCiResult(
  { fixId, testConclusion, fixConclusion, testRunUrl = null, fixRunUrl = null }: AgentCiResult,
  deps: VerifyDeps = createVerifyDeps(),
): Promise<VerificationResult> {
  const fix = await deps.loadFix(fixId);
  if (!fix) throw new Error(`verify: fix ${fixId} not found`);

  const reusesExistingTest = fix.testCommitSha === null && fix.fixCommitSha !== null;
  const effectiveTestConclusion: CiConclusion = reusesExistingTest ? "failure" : testConclusion;
  const effectiveTestRunUrl =
    reusesExistingTest || effectiveTestConclusion === "failure"
      ? (testRunUrl ?? fix.redRunUrl)
      : testRunUrl;

  const outcome = decideOutcome(effectiveTestConclusion, fixConclusion);
  const noChange = (status: FixStatus): VerificationResult => ({
    status,
    outcome,
    testRunUrl: effectiveTestRunUrl,
    fixRunUrl,
    commented: false,
    markedReadyForReview: false,
  });

  const rawTarget = resolveTargetStatus(outcome, fix);
  if (rawTarget === null) {
    deps.log("verify: CI result is not conclusive yet", {
      fix: fixId,
      test: effectiveTestConclusion,
      fixCommit: fixConclusion,
    });
    return noChange(fix.status);
  }
  if (SETTLED_STATUSES.has(fix.status)) {
    deps.log("verify: fix already settled, skipping", { fix: fixId, status: fix.status, outcome });
    return noChange(fix.status);
  }

  const currentOrder = STATUS_ORDER.indexOf(fix.status);
  const targetOrder = STATUS_ORDER.indexOf(rawTarget);
  const target: FixStatus =
    !SETTLED_STATUSES.has(rawTarget) && targetOrder !== -1 && currentOrder > targetOrder
      ? fix.status
      : rawTarget;

  const runUrls: FixRunUrls = {};
  if (effectiveTestRunUrl && effectiveTestRunUrl !== fix.redRunUrl) {
    runUrls.redRunUrl = effectiveTestRunUrl;
  }
  if (outcome === "verified" && fixRunUrl && fixRunUrl !== fix.greenRunUrl) {
    runUrls.greenRunUrl = fixRunUrl;
  }

  const recordsNewUrl = runUrls.redRunUrl !== undefined || runUrls.greenRunUrl !== undefined;
  let wroteStatus = false;
  if (target !== fix.status || recordsNewUrl) {
    const saved = await deps.saveStatus(fixId, target, runUrls);
    if (!saved) {
      deps.log("verify: another run already advanced or settled this fix", {
        fix: fixId,
        outcome,
        status: target,
      });
      return {
        status: target,
        outcome,
        testRunUrl: effectiveTestRunUrl,
        fixRunUrl,
        commented: false,
        markedReadyForReview: false,
      };
    }
    wroteStatus = target !== fix.status;
  }

  const body = buildComment(outcome, fix, effectiveTestRunUrl, fixRunUrl);
  const hasPr = fix.prNumber !== null;
  if (body && !hasPr) {
    deps.log("verify: no pull request recorded, skipping comment", { fix: fixId, outcome });
  }

  const shouldUpdatePrDescription =
    hasPr && (SETTLED_STATUSES.has(target) || runUrls.redRunUrl !== undefined);
  const commented = Boolean(body) && hasPr;
  let markedReadyForReview = false;

  // Claim status atomically first, perform idempotent GitHub writes, and roll back non-terminal
  // source status on failure so transient GitHub errors never lock out retries.
  try {
    if (shouldUpdatePrDescription) {
      await deps.updatePrDescription?.(fix, {
        outcome,
        status: target,
        testRunUrl: effectiveTestRunUrl,
        fixRunUrl,
      });
    }
    if (outcome === "verified" && hasPr) {
      markedReadyForReview = (await deps.markReadyForReview(fix)) !== false;
    }
    if (body && hasPr) await deps.postPrComment(fix, body);
  } catch (err) {
    if (wroteStatus) {
      try {
        await deps.revertStatus?.(fixId, target, fix.status);
      } catch (revertErr) {
        deps.log("verify: failed to revert status after GitHub error", {
          fix: fixId,
          target,
          previous: fix.status,
          error: revertErr instanceof Error ? revertErr.message : String(revertErr),
        });
      }
    }
    throw err;
  }

  deps.log("verify: fix updated", {
    fix: fixId,
    outcome,
    status: target,
    commented,
    readyForReview: markedReadyForReview,
  });

  return {
    status: target,
    outcome,
    testRunUrl: effectiveTestRunUrl,
    fixRunUrl,
    commented,
    markedReadyForReview,
  };
}

export async function syncFixVerification(
  fixId: string,
  deps: VerifyDeps = createVerifyDeps(),
  hint: RunHint = {},
): Promise<VerificationResult> {
  const fix = await deps.loadFix(fixId);
  if (!fix) throw new Error(`verify: fix ${fixId} not found`);

  const reusesExistingTest = fix.testCommitSha === null && fix.fixCommitSha !== null;

  let testRun: CiRun = NO_CI_RUN;
  if (reusesExistingTest) {
    testRun = { conclusion: "failure", runUrl: fix.redRunUrl };
  } else if (fix.testCommitSha) {
    testRun = withRunHint(
      await deps.findCompletedRun(fix, fix.testCommitSha),
      fix.testCommitSha,
      hint,
    );
  }

  const fixRun = fix.fixCommitSha
    ? withRunHint(await deps.findCompletedRun(fix, fix.fixCommitSha), fix.fixCommitSha, hint)
    : NO_CI_RUN;

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
  { projectId, branchName, ...hint }: FixBranchRef,
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
  return syncFixVerification(fixId, deps, hint);
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
  const reusesExistingTest = fix.testCommitSha === null;

  const redCell = reusesExistingTest ? "existing test" : `\`${testSha}\``;
  const redProof = reusesExistingTest
    ? "🔴 the failing run this fix answers"
    : "🔴 reproduction test, without the fix";
  const greenProof = reusesExistingTest
    ? "🟢 that test, with the fix"
    : "🟢 the same test, with the fix";
  const preamble = reusesExistingTest
    ? "A test in the repository already reproduced this failure, so Fixtee did not add one."
    : null;

  switch (outcome) {
    case "verified":
      return [
        "## 🟢 Fixtee verified this fix",
        "",
        ...(preamble ? [preamble, ""] : []),
        "| Evidence | What it proves | CI |",
        "| --- | --- | --- |",
        `| ${redCell} | ${redProof} | ${runLink("failed as expected", testRunUrl)} |`,
        `| \`${fixSha}\` | ${greenProof} | ${runLink("passed", fixRunUrl)} |`,
        "",
        "The test fails before the change and passes after it, so this change is what turns CI green.",
        "",
        `Agent confidence: ${formatConfidence(fix.confidence)}.`,
        "",
        "Marking this pull request ready for review.",
        "",
        VERIFICATION_COMMENT_MARKER,
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
        "",
        VERIFICATION_COMMENT_MARKER,
      ].join("\n");

    case "fix_failed_ci":
      return [
        "## ❌ Fixtee could not verify this fix",
        "",
        reusesExistingTest
          ? `🔴 An existing test ${runLink("already reproduced this failure", testRunUrl)}.`
          : `🔴 The reproduction test on \`${testSha}\` ${runLink("failed as expected", testRunUrl)}, so the bug is reproduced.`,
        `❌ But CI still ${runLink("fails on the fix commit", fixRunUrl)} \`${fixSha}\`.`,
        "",
        "The change does not make the failing test pass. This pull request stays a draft for a human to look at.",
        "",
        `Agent confidence: ${formatConfidence(fix.confidence)}.`,
        "",
        VERIFICATION_COMMENT_MARKER,
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

export type WorkflowRunEntry = {
  id?: number;
  workflow_id?: number;
  run_attempt?: number;
  created_at?: string;
  updated_at?: string;
  conclusion: string | null;
  html_url: string;
};

const workflowRunsSchema = z.object({
  workflow_runs: z.array(
    z.object({
      id: z.number().optional(),
      workflow_id: z.number().optional(),
      run_attempt: z.number().optional(),
      created_at: z.string().optional(),
      updated_at: z.string().optional(),
      conclusion: z.string().nullable(),
      html_url: z.string(),
    }),
  ),
});

const pullRequestSchema = z.object({
  node_id: z.string(),
  state: z.string().optional(),
  draft: z.boolean().optional(),
  body: z.string().nullable().optional(),
});

const issueCommentsSchema = z.array(
  z.object({
    body: z.string().nullable().optional(),
  }),
);

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
  red_run_url: z.string().nullable(),
  green_run_url: z.string().nullable(),
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

function timestampMs(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isNewerRun(candidate: WorkflowRunEntry, current: WorkflowRunEntry): boolean {
  if (candidate.id !== undefined && current.id !== undefined && candidate.id === current.id) {
    const candAttempt = candidate.run_attempt ?? 0;
    const currAttempt = current.run_attempt ?? 0;
    if (candAttempt !== currAttempt) return candAttempt > currAttempt;
  }

  const candCreated = timestampMs(candidate.created_at);
  const currCreated = timestampMs(current.created_at);
  if (candCreated !== null && currCreated !== null && candCreated !== currCreated) {
    return candCreated > currCreated;
  }

  if (candidate.id !== undefined && current.id !== undefined && candidate.id !== current.id) {
    return candidate.id > current.id;
  }

  if (
    candidate.run_attempt !== undefined &&
    current.run_attempt !== undefined &&
    candidate.run_attempt !== current.run_attempt
  ) {
    return candidate.run_attempt > current.run_attempt;
  }

  const candUpdated = timestampMs(candidate.updated_at);
  const currUpdated = timestampMs(current.updated_at);
  if (candUpdated !== null && currUpdated !== null && candUpdated !== currUpdated) {
    return candUpdated > currUpdated;
  }

  return false;
}

export function latestRunsPerWorkflow(runs: WorkflowRunEntry[]): WorkflowRunEntry[] {
  const latest = new Map<string, WorkflowRunEntry>();
  for (let index = 0; index < runs.length; index += 1) {
    const entry = runs[index];
    const key =
      entry.workflow_id !== undefined
        ? `wf:${entry.workflow_id}`
        : entry.id !== undefined
          ? `run:${entry.id}`
          : `idx:${index}`;
    const existing = latest.get(key);
    if (!existing || isNewerRun(entry, existing)) {
      latest.set(key, entry);
    }
  }
  return Array.from(latest.values());
}

export function pickRun(runs: WorkflowRunEntry[]): CiRun {
  const latest = latestRunsPerWorkflow(runs);
  const failed = latest.find((run) => normalizeConclusion(run.conclusion) === "failure");
  if (failed) return { conclusion: "failure", runUrl: failed.html_url };

  const passed = latest.find((run) => normalizeConclusion(run.conclusion) === "success");
  if (passed) return { conclusion: "success", runUrl: passed.html_url };

  return { conclusion: null, runUrl: latest[0]?.html_url ?? null };
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
    redRunUrl: fix.red_run_url,
    greenRunUrl: fix.green_run_url,
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
          "id, status, confidence, branch_name, pr_number, pr_url, test_commit_sha, fix_commit_sha, red_run_url, green_run_url, errors(projects(repo_owner, repo_name, installation_id))",
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
      const allowed = allowedSourceStatuses(status);
      if (allowed.length === 0) return false;

      const patch: TablesUpdate<"fixes"> = { status };
      if (runUrls.redRunUrl) patch.red_run_url = runUrls.redRunUrl;
      if (runUrls.greenRunUrl) patch.green_run_url = runUrls.greenRunUrl;

      const { data, error } = await db
        .from("fixes")
        .update(patch)
        .eq("id", fixId)
        .in("status", allowed)
        .select("id");
      if (error) throw new Error(`verify: updating fix ${fixId} failed: ${error.message}`);
      return data.length > 0;
    },

    async revertStatus(fixId, fromStatus, toStatus) {
      const { error } = await db
        .from("fixes")
        .update({ status: toStatus })
        .eq("id", fixId)
        .eq("status", fromStatus)
        .select("id");
      if (error) throw new Error(`verify: reverting fix ${fixId} failed: ${error.message}`);
    },

    async updatePrDescription(fix, info) {
      if (fix.prNumber === null) return;
      const client = await getClient(fix.installationId);
      const pull = await client.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner: fix.owner,
        repo: fix.repo,
        pull_number: fix.prNumber,
      });
      const { body } = pullRequestSchema.parse(pull.data);
      if (body === undefined) return;
      const currentBody = body ?? "";
      const nextBody = buildUpdatedPrDescription(currentBody, fix, info);
      if (nextBody === currentBody) return;
      await client.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner: fix.owner,
        repo: fix.repo,
        pull_number: fix.prNumber,
        body: nextBody,
      });
    },

    async postPrComment(fix, body) {
      if (fix.prNumber === null) return;
      const client = await getClient(fix.installationId);
      const existing = await client.request(
        "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
        {
          owner: fix.owner,
          repo: fix.repo,
          issue_number: fix.prNumber,
          per_page: 100,
        },
      );
      const existingComments = issueCommentsSchema.parse(existing.data);
      if (existingComments.some((comment) => comment.body?.includes(VERIFICATION_COMMENT_MARKER))) {
        return;
      }
      const markedBody = body.includes(VERIFICATION_COMMENT_MARKER)
        ? body
        : `${body}\n\n${VERIFICATION_COMMENT_MARKER}`;
      await client.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
        owner: fix.owner,
        repo: fix.repo,
        issue_number: fix.prNumber,
        body: markedBody,
      });
    },

    async markReadyForReview(fix) {
      if (fix.prNumber === null) return false;
      const client = await getClient(fix.installationId);
      const pull = await client.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner: fix.owner,
        repo: fix.repo,
        pull_number: fix.prNumber,
      });
      const { node_id, state, draft } = pullRequestSchema.parse(pull.data);
      if (state !== "open") return false;
      if (draft !== true) return draft === false;
      await client.graphql(READY_FOR_REVIEW_MUTATION, { pullRequestId: node_id });
      return true;
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
