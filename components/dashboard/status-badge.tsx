import type { FixStatus } from "./types";

const STATUS_STYLES: Record<FixStatus, string> = {
  queued: "border-zinc-700 bg-zinc-800/60 text-zinc-300",
  analyzing: "border-sky-800 bg-sky-950 text-sky-300",
  test_pushed: "border-amber-800 bg-amber-950 text-amber-300",
  test_failed: "border-orange-800 bg-orange-950 text-orange-300",
  fix_pushed: "border-violet-800 bg-violet-950 text-violet-300",
  verified: "border-emerald-700 bg-emerald-950 text-emerald-300",
  failed: "border-red-800 bg-red-950 text-red-300",
};

const STATUS_LABELS: Record<FixStatus, string> = {
  queued: "Queued",
  analyzing: "Analyzing",
  test_pushed: "Test pushed",
  test_failed: "Red CI 🔴",
  fix_pushed: "Fix pushed",
  verified: "Verified 🟢",
  failed: "Failed",
};

export function statusLabel(status: FixStatus): string {
  return STATUS_LABELS[status];
}

export function StatusBadge({ status }: { status: FixStatus | null }) {
  if (status === null) {
    return (
      <span className="inline-flex shrink-0 items-center rounded-full border border-zinc-800 bg-zinc-900 px-2 py-0.5 text-xs font-medium text-zinc-500">
        No fix yet
      </span>
    );
  }

  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[status]}`}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}
