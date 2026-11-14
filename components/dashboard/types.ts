import type { Tables } from "../../lib/db/types";

export type FixStatus = Tables<"fixes">["status"];

export type DashboardProject = {
  id: string;
  repo_owner: string;
  repo_name: string;
  default_branch: string;
  installation_id: number;
  llm_provider: Tables<"projects">["llm_provider"];
  has_llm_key: boolean;
};

export type DashboardError = Tables<"errors">;

export type DashboardFix = Tables<"fixes">;

export type DashboardData = {
  projects: DashboardProject[];
  errors: DashboardError[];
  fixes: DashboardFix[];
};

export const EMPTY_DASHBOARD: DashboardData = { projects: [], errors: [], fixes: [] };

export type Item = {
  error: DashboardError;
  fix: DashboardFix | null;
  demo?: boolean;
  durations?: [number, number, number];
  stepStartedAt?: string;
};

export type ConfidenceLevel = "high" | "medium" | "low" | "unknown";

export type StepTone = "pending" | "diagnosed" | "reproduced" | "resolved" | "blocked";

export type ProofStep = {
  title: string;
  description: string;
  tone: StepTone;
  complete: boolean;
  running: boolean;
  sha: string | null;
  shaLabel: string | null;
  runUrl: string | null;
};

export function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 7) : "—";
}

export function readableLog(value: string): string {
  return value.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\\t/g, "  ");
}

export function confidenceLevel(confidence: number | null | undefined): ConfidenceLevel {
  if (confidence === null || confidence === undefined) return "unknown";
  if (confidence >= 0.9) return "high";
  if (confidence >= 0.6) return "medium";
  return "low";
}

export function isReady(fix: DashboardFix | null): boolean {
  return fix?.status === "verified";
}

export type FailureKind =
  | "agent_error"
  | "low_confidence"
  | "fix_failed_ci"
  | "guardrail_test_passed";

export function isAgentCrash(fix: DashboardFix | null): boolean {
  return Boolean(fix?.ai_reasoning?.trimStart().startsWith("Failed:"));
}

export function failureKind(item: Item): FailureKind | null {
  const fix = item.fix;
  if (!fix || fix.status !== "failed") return null;
  if (isAgentCrash(fix)) return "agent_error";
  if (fix.confidence !== null && fix.confidence <= 0.3) return "low_confidence";
  if (fix.fix_commit_sha !== null) return "fix_failed_ci";
  if (fix.pr_url === null) return "agent_error";
  return "guardrail_test_passed";
}

export function guardrailReason(item: Item): string | null {
  const fix = item.fix;
  const kind = failureKind(item);
  if (!fix || !kind) return null;

  const prOutcome = fix.pr_url ? "PR kept as Draft" : "no PR opened";
  switch (kind) {
    case "low_confidence":
      return `Guardrail triggered: low confidence (${Math.round((fix.confidence ?? 0) * 100)}%) — needs human review, ${prOutcome}`;
    case "fix_failed_ci":
      return `Fix failed CI checks${fix.fix_commit_sha ? ` on ${shortSha(fix.fix_commit_sha)}` : ""} — ${fix.pr_url ? "PR kept as Draft" : "needs human review"}`;
    case "agent_error":
      return `Agent analysis failed — ${prOutcome}`;
    case "guardrail_test_passed":
      return `Guardrail triggered: reproduction test passed without the fix — ${prOutcome}`;
  }
}

export function redProven(fix: DashboardFix | null): boolean {
  if (!fix) return false;
  return (
    fix.status === "test_failed" ||
    fix.status === "fix_pushed" ||
    fix.status === "verified" ||
    Boolean(fix.red_run_url)
  );
}

export function statusLabel(item: Item): string {
  const kind = failureKind(item);
  if (kind === "fix_failed_ci") return "Fix failed CI";
  if (kind === "agent_error") return "Analysis failed";
  if (kind) return "Guardrail blocked";
  if (isReady(item.fix)) return "Verified · PR ready";
  return "Fix in progress";
}

export type FixExplanation = {
  why: string;
  how: string;
  howHeading: string;
};

export function fixExplanation(item: Item): FixExplanation {
  const fix = item.fix;
  const status = fix?.status ?? "queued";
  const kind = failureKind(item);
  const why =
    fix?.ai_reasoning ??
    item.error.error_message ??
    "The automated checks caught a failure on the default branch.";

  if (isReady(fix)) {
    return {
      why,
      howHeading: "How we fixed it",
      how: "A test recreated the bug, then the code change passed every check.",
    };
  }

  if (kind) {
    switch (kind) {
      case "fix_failed_ci":
        return {
          why,
          howHeading: "Why CI failed",
          how: "The reproduction test confirmed the bug and Fixtee pushed a fix commit, but CI checks still failed. The PR remains a draft for human review.",
        };
      case "guardrail_test_passed":
        return {
          why,
          howHeading: "Why we blocked it",
          how: "The reproduction test passed without applying any fix, so Fixtee blocked the change and kept the PR as a draft rather than send an unproven fix for review.",
        };
      case "low_confidence":
        return {
          why,
          howHeading: "Why we blocked it",
          how: fix?.pr_url
            ? "Agent confidence was too low to prove a safe fix, so Fixtee kept the PR as a draft for human review."
            : "No PR was opened. Agent confidence was too low to confirm a safe fix, so Fixtee blocked the change rather than send an unproven fix for review.",
        };
      case "agent_error":
        return {
          why,
          howHeading: "Why analysis failed",
          how: isAgentCrash(fix)
            ? "Fixtee encountered an error while analyzing the failure before opening a pull request, so no code changes were pushed."
            : "Fixtee stopped before opening a pull request, so no code changes were pushed to the repository.",
        };
    }
  }

  if (status === "queued" || status === "analyzing") {
    return {
      why,
      howHeading: "The proposed fix",
      how: "Fixtee is analyzing the failing CI logs and generating a reproduction test.",
    };
  }

  if (status === "test_pushed") {
    return {
      why,
      howHeading: "The proposed fix",
      how: "Fixtee pushed a reproduction test and is waiting for CI to confirm the failure.",
    };
  }

  return {
    why,
    howHeading: "The proposed fix",
    how: "Fixtee is checking the proposed change before sending it for review.",
  };
}

export function githubRepoUrl(item: Item): string | null {
  for (const candidate of [item.fix?.pr_url, item.error.run_url]) {
    if (!candidate) continue;
    const match = candidate.match(/^(https?:\/\/[^/]+\/[^/]+\/[^/]+)(?:\/|$)/);
    if (match) return match[1];
  }
  return null;
}

export type TestPanelLink = { label: string; url: string };

export type TestPanelState = {
  kind: "generating" | "committed" | "existing_test" | "not_generated";
  message: string;
  links: TestPanelLink[];
};

export function testPanelState(item: Item): TestPanelState {
  const fix = item.fix;
  const status = fix?.status ?? "queued";
  const repoUrl = githubRepoUrl(item);

  if (status === "queued" || status === "analyzing") {
    return {
      kind: "generating",
      message: "Generating reproduction test...",
      links: [],
    };
  }

  const sha = fix?.test_commit_sha ?? null;
  if (sha) {
    const links: TestPanelLink[] = [];
    if (repoUrl) {
      links.push({ label: `View commit ${shortSha(sha)}`, url: `${repoUrl}/commit/${sha}` });
    }
    if (fix?.pr_url) {
      links.push({ label: "View PR files", url: `${fix.pr_url}/files` });
    } else if (repoUrl && fix?.branch_name) {
      links.push({ label: "Browse branch", url: `${repoUrl}/tree/${fix.branch_name}` });
    }
    return {
      kind: "committed",
      message: `The reproduction test lives on ${fix?.branch_name ?? "the fix branch"}, commit ${shortSha(sha)}.`,
      links,
    };
  }

  const kind = failureKind(item);
  const reusedExistingTest =
    fix !== null &&
    (fix.fix_commit_sha !== null ||
      status === "fix_pushed" ||
      status === "verified" ||
      (Boolean(fix.red_run_url) && status !== "failed"));

  if (reusedExistingTest) {
    const links: TestPanelLink[] = [];
    if (repoUrl && item.error.file_path) {
      const cleanPath = item.error.file_path.replace(/^\/+/, "");
      const isTestFile = /\.(?:test|spec)\.(m?[jt]sx?)$/.test(cleanPath);
      links.push({
        label: isTestFile ? "View test on GitHub" : "View failing file",
        url: `${repoUrl}/blob/${item.error.commit_sha}/${cleanPath}`,
      });
    }
    if (fix?.pr_url) {
      links.push({ label: "View PR", url: fix.pr_url });
    } else if (repoUrl && fix?.branch_name) {
      links.push({ label: "Browse branch", url: `${repoUrl}/tree/${fix.branch_name}` });
    }
    return {
      kind: "existing_test",
      message:
        "An existing test in the repository already reproduced this failure, so Fixtee did not add one.",
      links,
    };
  }

  if (kind || status === "failed") {
    const links: TestPanelLink[] = [];
    if (fix?.pr_url) links.push({ label: "View draft PR", url: fix.pr_url });
    return {
      kind: "not_generated",
      message: "No reproduction test was pushed because analysis stopped before creating commits.",
      links,
    };
  }

  return {
    kind: "generating",
    message: "Generating reproduction test...",
    links: [],
  };
}

export function proofSteps(item: Item): ProofStep[] {
  const fix = item.fix;
  const status = fix?.status ?? "queued";
  const kind = failureKind(item);
  const blocked = Boolean(kind);
  const ready = isReady(fix) && !blocked;
  const crash = isAgentCrash(fix);
  const failedBeforeDiagnosis = status === "failed" && (crash || !fix?.ai_reasoning);
  const diagnosed =
    Boolean(fix?.ai_reasoning) && !crash && status !== "queued" && status !== "analyzing";

  const red =
    kind === "fix_failed_ci"
      ? true
      : redProven(fix) && !blocked;
  const reusesExistingTest = Boolean(fix) && fix?.test_commit_sha === null && red;

  const step2Description =
    kind === "fix_failed_ci"
      ? reusesExistingTest
        ? "An existing test already failed"
        : "Test failed as expected"
      : blocked
        ? kind === "guardrail_test_passed"
          ? "Passed without fix"
          : kind === "agent_error"
            ? failedBeforeDiagnosis
              ? "Skipped after analysis error"
              : "No reproduction run completed"
            : "Needs human review"
        : red
          ? reusesExistingTest
            ? "An existing test already failed"
            : "Test failed as expected"
          : "Waiting for the failing test";

  const step3Description = ready
    ? "All checks passed"
    : blocked
      ? kind === "fix_failed_ci"
        ? "Fix failed CI checks"
        : kind === "agent_error"
          ? "No PR opened"
          : "Fix safely blocked"
      : "Waiting for passing checks";

  return [
    {
      title: "Bug Diagnosed",
      description: failedBeforeDiagnosis
        ? "Analysis failed before diagnosis"
        : diagnosed
          ? `Root cause in ${item.error.file_path ?? "the failing module"}`
          : "Finding the root cause",
      tone: failedBeforeDiagnosis ? "blocked" : diagnosed ? "diagnosed" : "pending",
      complete: diagnosed,
      running: !blocked && (status === "queued" || status === "analyzing"),
      sha: null,
      shaLabel: null,
      runUrl: null,
    },
    {
      title: "Failing Test Proven 🔴",
      description: step2Description,
      tone: red ? "reproduced" : blocked ? "blocked" : "pending",
      complete: red,
      running: !blocked && status === "test_pushed",
      sha: fix?.test_commit_sha ?? null,
      shaLabel: reusesExistingTest ? "existing test" : null,
      runUrl: fix?.red_run_url ?? null,
    },
    {
      title: "Fix Passed CI 🟢",
      description: step3Description,
      tone: ready ? "resolved" : blocked ? "blocked" : "pending",
      complete: ready,
      running: !blocked && status === "fix_pushed",
      sha: fix?.fix_commit_sha ?? null,
      shaLabel: null,
      runUrl: fix?.green_run_url ?? null,
    },
  ];
}

export type Metrics = { errors: number; verified: number; blocked: number; tokens: number };

export function metrics(items: Item[]): Metrics {
  return {
    errors: items.length,
    verified: items.filter((item) => isReady(item.fix) && !guardrailReason(item)).length,
    blocked: items.filter((item) => Boolean(guardrailReason(item))).length,
    tokens: items.reduce((total, item) => total + (item.fix?.tokens_used ?? 0), 0),
  };
}

export function errorPreview(item: Item): string {
  const log = readableLog(item.error.log_excerpt ?? "");
  const expected = log.match(/Expected:\s*([^\n]+)/)?.[1];
  const received = log.match(/Received:\s*([^\n]+)/)?.[1];
  if (expected && received) return `Expected: ${expected} · Received: ${received}`;
  const lines = log.split("\n");
  return lines.find((line) => /TypeError|GUARDRAIL|Error:/.test(line)) ?? lines[0] ?? "";
}

export function matchesSearch(item: Item, query: string): boolean {
  const term = query.trim().toLowerCase();
  if (term.length === 0) return true;
  return [
    item.error.error_message,
    item.error.test_name,
    item.error.file_path,
    item.error.commit_sha,
    item.fix?.branch_name ?? null,
  ].some((field) => field !== null && field !== undefined && field.toLowerCase().includes(term));
}

export type FeedFilter = "all" | "verified" | "running" | "failed";

export function matchesFilter(item: Item, filter: FeedFilter): boolean {
  const blocked = Boolean(guardrailReason(item));
  if (filter === "all") return true;
  if (filter === "verified") return isReady(item.fix) && !blocked;
  if (filter === "failed") return blocked;
  return !blocked && !isReady(item.fix);
}

export function elapsedSeconds(start: string, now: number): number {
  return Math.max(0, Math.floor((now - new Date(start).getTime()) / 1000));
}

export function runningTime(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function relativeTime(start: string, now: number): string {
  const seconds = elapsedSeconds(start, now);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export type PlannedChange = { path: string; search: string; replace: string };

export function parsePlannedChanges(value: unknown): PlannedChange[] {
  const entries = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
  const changes: PlannedChange[] = [];

  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const path =
      typeof record.path === "string"
        ? record.path
        : typeof record.file_path === "string"
          ? record.file_path
          : null;
    const search = typeof record.search === "string" ? record.search : null;
    const replace = typeof record.replace === "string" ? record.replace : null;
    if (search === null && replace === null) continue;
    changes.push({ path: path ?? "unknown file", search: search ?? "", replace: replace ?? "" });
  }

  return changes;
}

export function buildItems(data: DashboardData, projectId: string | null): Item[] {
  const newest = new Map<string, DashboardFix>();
  for (const fix of data.fixes) if (!newest.has(fix.error_id)) newest.set(fix.error_id, fix);

  return data.errors
    .filter((error) => projectId === null || error.project_id === projectId)
    .map((error) => ({ error, fix: newest.get(error.id) ?? null }));
}

export const ALL_PROJECTS_ID = "all";

export type ProjectSelection = string | null;

export function mostRecentProjectId(data: DashboardData): string | null {
  if (data.projects.length === 0) return null;
  const knownIds = new Set(data.projects.map((project) => project.id));

  let bestId: string | null = null;
  let bestTs = -1;
  for (const error of data.errors) {
    if (!knownIds.has(error.project_id)) continue;
    const ms = Date.parse(error.last_seen);
    const ts = Number.isFinite(ms) ? ms : 0;
    if (bestId === null || ts > bestTs) {
      bestId = error.project_id;
      bestTs = ts;
    }
  }

  return bestId;
}

export function resolveProjectSelection(
  data: DashboardData,
  requestedProject?: string | null,
): ProjectSelection {
  if (data.projects.length === 0) return null;
  if (data.projects.length === 1) return data.projects[0].id;

  const trimmed = requestedProject?.trim();
  if (trimmed) {
    if (trimmed === ALL_PROJECTS_ID) return ALL_PROJECTS_ID;
    const byId = data.projects.find((project) => project.id === trimmed);
    if (byId) return byId.id;
    const lower = trimmed.toLowerCase();
    const bySlug = data.projects.find(
      (project) => `${project.repo_owner}/${project.repo_name}`.toLowerCase() === lower,
    );
    if (bySlug) return bySlug.id;
  }

  return mostRecentProjectId(data) ?? ALL_PROJECTS_ID;
}

export const PENDING_VERIFICATION: FixStatus[] = ["test_pushed", "test_failed", "fix_pushed"];

export function isPendingVerification(status: FixStatus): boolean {
  return PENDING_VERIFICATION.includes(status);
}
