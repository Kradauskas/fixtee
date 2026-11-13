"use client";

import { DiffView, parsePlannedChanges } from "./diff-view";
import { PipelineStepper } from "./pipeline-stepper";
import { StatusBadge } from "./status-badge";
import { formatConfidence, shortSha, type DashboardError, type DashboardFix } from "./types";

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <h3 className="pb-3 text-sm font-semibold text-zinc-200">{title}</h3>
      {children}
    </section>
  );
}

function CommitProof({
  label,
  sha,
  runUrl,
  tone,
}: {
  label: string;
  sha: string | null;
  runUrl: string | null;
  tone: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2">
      <div className="min-w-0">
        <p className={`text-xs font-semibold ${tone}`}>{label}</p>
        <p className="font-mono text-sm text-zinc-300">{shortSha(sha)}</p>
      </div>
      {runUrl ? (
        <a
          href={runUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="shrink-0 rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:border-zinc-500 hover:text-zinc-100"
        >
          View run
        </a>
      ) : (
        <span className="shrink-0 text-xs text-zinc-600">No run yet</span>
      )}
    </div>
  );
}

export function FixInspector({
  error,
  fix,
  verifying,
  onVerify,
}: {
  error: DashboardError;
  fix: DashboardFix | null;
  verifying: boolean;
  onVerify: () => void;
}) {
  const status = fix?.status ?? null;
  const confidence = fix ? formatConfidence(fix.confidence) : null;
  const changes = parsePlannedChanges(fix?.planned_changes ?? null);

  return (
    <div className="flex min-h-0 flex-col gap-4 overflow-y-auto pr-1">
      <header className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold break-words text-zinc-100">
              {error.error_message ?? error.test_name ?? "Unnamed failure"}
            </h2>
            <p className="mt-1 font-mono text-xs text-zinc-500">
              {error.file_path ?? "unknown file"}
              {error.line === null ? "" : `:${error.line}`} · {shortSha(error.commit_sha)} ·{" "}
              {error.error_type ?? "unknown type"}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <StatusBadge status={status} />
            <button
              type="button"
              onClick={onVerify}
              disabled={verifying || !fix}
              className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:border-zinc-500 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {verifying ? "Checking…" : "Verify CI Status"}
            </button>
          </div>
        </div>
        <a
          href={error.run_url}
          target="_blank"
          rel="noreferrer noopener"
          className="mt-3 inline-block font-mono text-xs text-sky-400 hover:text-sky-300"
        >
          Failing run #{error.workflow_run_id}
        </a>
      </header>

      <PipelineStepper status={status} />

      {fix === null ? (
        <Panel title="Two-commit proof">
          <p className="text-sm text-zinc-500">
            No fix has been opened for this failure yet.
          </p>
        </Panel>
      ) : (
        <>
          <Panel title="Two-commit proof">
            <div className="flex flex-col gap-2">
              <CommitProof
                label="Red CI 🔴 — test without the fix"
                sha={fix.test_commit_sha}
                runUrl={fix.red_run_url}
                tone="text-red-300"
              />
              <CommitProof
                label="Green CI 🟢 — same test with the fix"
                sha={fix.fix_commit_sha}
                runUrl={fix.green_run_url}
                tone="text-emerald-300"
              />
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              {fix.pr_url ? (
                <a
                  href={fix.pr_url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500"
                >
                  Open PR{fix.pr_number === null ? "" : ` #${fix.pr_number}`} on GitHub
                </a>
              ) : (
                <span className="text-sm text-zinc-500">No pull request yet.</span>
              )}
              {fix.pr_url &&
                (status === "verified" ? (
                  <span className="rounded-full border border-emerald-700 bg-emerald-950 px-2 py-0.5 text-xs font-medium text-emerald-300">
                    Ready for Review
                  </span>
                ) : (
                  <span className="rounded-full border border-zinc-700 bg-zinc-800/60 px-2 py-0.5 text-xs font-medium text-zinc-300">
                    Draft PR
                  </span>
                ))}
            </div>
          </Panel>

          <Panel title="AI root cause">
            <div className="flex flex-wrap items-center gap-2 pb-3">
              {confidence && (
                <span className="rounded-full border border-sky-800 bg-sky-950 px-2 py-0.5 text-xs font-medium text-sky-300">
                  Confidence {confidence}
                </span>
              )}
              {fix.tokens_used !== null && (
                <span className="rounded-full border border-zinc-700 bg-zinc-800/60 px-2 py-0.5 font-mono text-xs text-zinc-300">
                  {fix.tokens_used.toLocaleString("en-US")} tokens
                </span>
              )}
            </div>
            {fix.ai_reasoning ? (
              <p className="text-sm leading-relaxed whitespace-pre-wrap text-zinc-300">
                {fix.ai_reasoning}
              </p>
            ) : (
              <p className="text-sm text-zinc-500">The agent has not written its reasoning yet.</p>
            )}
          </Panel>

          <Panel title="Planned change">
            <DiffView changes={changes} />
          </Panel>
        </>
      )}

      <Panel title="Log excerpt">
        {error.log_excerpt ? (
          <pre className="max-h-80 overflow-auto rounded-lg border border-zinc-800 bg-black px-3 py-2 font-mono text-xs leading-relaxed text-zinc-300">
            {error.log_excerpt}
          </pre>
        ) : (
          <p className="text-sm text-zinc-500">No log excerpt was captured for this failure.</p>
        )}
      </Panel>
    </div>
  );
}
