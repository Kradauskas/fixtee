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

export const PIPELINE_STEPS: { status: FixStatus; label: string; hint: string }[] = [
  { status: "queued", label: "Queued", hint: "Failure captured" },
  { status: "analyzing", label: "Analyzing", hint: "Agent reading logs" },
  { status: "test_pushed", label: "Test pushed", hint: "Reproduction committed" },
  { status: "test_failed", label: "Red CI 🔴", hint: "Test reproduces the bug" },
  { status: "fix_pushed", label: "Fix pushed", hint: "Fix committed" },
  { status: "verified", label: "Green CI 🟢", hint: "Verified, PR ready" },
];

export const PENDING_VERIFICATION: FixStatus[] = ["test_pushed", "test_failed", "fix_pushed"];

export function isPendingVerification(status: FixStatus): boolean {
  return PENDING_VERIFICATION.includes(status);
}

export function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 7) : "—";
}

export function formatConfidence(confidence: number | null): string | null {
  return confidence === null ? null : `${Math.round(confidence * 100)}%`;
}
