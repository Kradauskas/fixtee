import type { Tables } from "./types";

export type FixStatus = Tables<"fixes">["status"];

/**
 * Ordered fix lifecycle steps (excluding `"failed"`, which is a terminal off-ramp).
 * Shared by the agent (`lib/agent/db.ts`) and verification (`lib/verify/state-machine.ts`)
 * so concurrent writers only move status forward along one timeline.
 */
export const STATUS_ORDER: readonly FixStatus[] = [
  "queued",
  "analyzing",
  "test_pushed",
  "test_failed",
  "fix_pushed",
  "verified",
];

export const SETTLED_STATUSES: ReadonlySet<FixStatus> = new Set<FixStatus>(["verified", "failed"]);

export const NON_TERMINAL_STATUSES: FixStatus[] = STATUS_ORDER.slice(
  0,
  STATUS_ORDER.indexOf("verified"),
);
