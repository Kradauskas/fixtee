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

export function guardrailReason(item: Item): string | null {
  const fix = item.fix;
  if (!fix) return null;
  if (fix.status === "failed") {
    return fix.confidence !== null && fix.confidence <= 0.3
      ? `Guardrail triggered: low confidence (${Math.round(fix.confidence * 100)}%) — needs human review, ${fix.pr_url ? "PR kept as Draft" : "no PR opened"}`
      : "Reproduction test did not prove the bug — PR kept as Draft";
  }
  return null;
}

export function redProven(fix: DashboardFix | null): boolean {
  if (!fix) return false;
  return fix.status === "fix_pushed" || fix.status === "verified" || Boolean(fix.red_run_url);
}

export function statusLabel(item: Item): string {
  if (guardrailReason(item)) return "Guardrail blocked";
  if (isReady(item.fix)) return "Verified · PR ready";
  return "Fix in progress";
}

export function proofSteps(item: Item): ProofStep[] {
  const fix = item.fix;
  const status = fix?.status ?? "queued";
  const blocked = Boolean(guardrailReason(item));
  const ready = isReady(fix) && !blocked;
  const red = redProven(fix) && !blocked;
  const diagnosed = Boolean(fix?.ai_reasoning) && status !== "queued" && status !== "analyzing";
  const reusesExistingTest = Boolean(fix) && fix?.test_commit_sha === null && redProven(fix);

  return [
    {
      title: "Bug Diagnosed",
      description: diagnosed
        ? `Root cause in ${item.error.file_path ?? "the failing module"}`
        : "Finding the root cause",
      tone: diagnosed ? "diagnosed" : "pending",
      complete: diagnosed,
      running: !blocked && (status === "queued" || status === "analyzing"),
      sha: null,
      shaLabel: null,
      runUrl: null,
    },
    {
      title: "Failing Test Proven 🔴",
      description: blocked
        ? "Needs human review"
        : red
          ? reusesExistingTest
            ? "An existing test already failed"
            : "Test failed as expected"
          : "Waiting for the failing test",
      tone: blocked ? "blocked" : red ? "reproduced" : "pending",
      complete: red,
      running: !blocked && status === "test_pushed",
      sha: fix?.test_commit_sha ?? null,
      shaLabel: reusesExistingTest ? "existing test" : null,
      runUrl: fix?.red_run_url ?? null,
    },
    {
      title: "Fix Passed CI 🟢",
      description: ready
        ? "All checks passed"
        : blocked
          ? "Fix safely blocked"
          : "Waiting for passing checks",
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

export const PENDING_VERIFICATION: FixStatus[] = ["test_pushed", "test_failed", "fix_pushed"];

export function isPendingVerification(status: FixStatus): boolean {
  return PENDING_VERIFICATION.includes(status);
}
