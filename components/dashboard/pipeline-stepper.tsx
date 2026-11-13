import { PIPELINE_STEPS, type FixStatus } from "./types";

export function stepIndex(status: FixStatus | null): number {
  if (status === null || status === "failed") return -1;
  return PIPELINE_STEPS.findIndex((step) => step.status === status);
}

export function PipelineStepper({ status }: { status: FixStatus | null }) {
  const failed = status === "failed";
  const current = stepIndex(status);

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="flex items-center justify-between gap-2 pb-3">
        <h3 className="text-sm font-semibold text-zinc-200">Verification pipeline</h3>
        {failed && (
          <span className="rounded-full border border-red-800 bg-red-950 px-2 py-0.5 text-xs font-medium text-red-300">
            Stopped — PR stays a draft
          </span>
        )}
      </div>

      <ol className="flex flex-col gap-1 sm:flex-row sm:items-stretch sm:gap-0">
        {PIPELINE_STEPS.map((step, index) => {
          const done = current > index;
          const active = current === index;
          const tone = failed
            ? "border-red-900/60 bg-red-950/30 text-red-300/80"
            : active
              ? "border-sky-700 bg-sky-950/60 text-sky-200"
              : done
                ? "border-emerald-900 bg-emerald-950/40 text-emerald-300"
                : "border-zinc-800 bg-zinc-950/60 text-zinc-600";

          return (
            <li key={step.status} className="flex-1">
              <div className={`h-full rounded-lg border px-2.5 py-2 ${tone}`}>
                <p className="flex items-center gap-1.5 text-xs font-semibold">
                  <span className="font-mono opacity-60">{index + 1}</span>
                  {step.label}
                </p>
                <p className="mt-0.5 text-[11px] leading-tight opacity-70">{step.hint}</p>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
