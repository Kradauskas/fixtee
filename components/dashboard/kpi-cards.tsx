import type { DashboardError, DashboardFix } from "./types";

export type Kpis = {
  failuresCaught: number;
  verified: number;
  failed: number;
  tokensUsed: number;
};

export function computeKpis(errors: DashboardError[], fixes: DashboardFix[]): Kpis {
  return {
    failuresCaught: errors.length,
    verified: fixes.filter((fix) => fix.status === "verified").length,
    failed: fixes.filter((fix) => fix.status === "failed").length,
    tokensUsed: fixes.reduce((total, fix) => total + (fix.tokens_used ?? 0), 0),
  };
}

function Card({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3">
      <p className="text-xs font-medium tracking-wide text-zinc-500 uppercase">{label}</p>
      <p className={`mt-1 font-mono text-2xl font-semibold tabular-nums ${accent}`}>{value}</p>
    </div>
  );
}

export function KpiCards({ kpis }: { kpis: Kpis }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Card
        label="CI failures caught"
        value={String(kpis.failuresCaught)}
        accent="text-zinc-100"
      />
      <Card label="Verified PRs ready" value={String(kpis.verified)} accent="text-emerald-400" />
      <Card label="Guardrail / failed" value={String(kpis.failed)} accent="text-red-400" />
      <Card
        label="Total tokens used"
        value={kpis.tokensUsed.toLocaleString("en-US")}
        accent="text-sky-400"
      />
    </div>
  );
}
