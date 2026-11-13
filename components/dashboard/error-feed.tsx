"use client";

import { StatusBadge } from "./status-badge";
import { shortSha, type DashboardError, type DashboardFix } from "./types";

export function matchesSearch(error: DashboardError, query: string): boolean {
  const term = query.trim().toLowerCase();
  if (term.length === 0) return true;
  return [
    error.error_message,
    error.test_name,
    error.error_type,
    error.file_path,
    error.commit_sha,
  ].some((field) => field !== null && field.toLowerCase().includes(term));
}

function location(error: DashboardError): string {
  if (!error.file_path) return "unknown location";
  return error.line === null ? error.file_path : `${error.file_path}:${error.line}`;
}

export function ErrorFeed({
  errors,
  fixByErrorId,
  selectedErrorId,
  search,
  onSearchChange,
  onSelect,
}: {
  errors: DashboardError[];
  fixByErrorId: Map<string, DashboardFix>;
  selectedErrorId: string | null;
  search: string;
  onSearchChange: (value: string) => void;
  onSelect: (errorId: string) => void;
}) {
  return (
    <section className="flex min-h-0 flex-col rounded-xl border border-zinc-800 bg-zinc-900/40">
      <div className="border-b border-zinc-800 p-3">
        <div className="flex items-baseline justify-between gap-2 pb-2">
          <h2 className="text-sm font-semibold text-zinc-200">Error feed</h2>
          <span className="font-mono text-xs text-zinc-500">{errors.length}</span>
        </div>
        <input
          type="search"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Filter by message, test, file or sha"
          className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {errors.length === 0 && (
          <p className="p-4 text-sm text-zinc-500">
            Nothing here yet. Fixtee lists a card for every failing CI run it captures.
          </p>
        )}

        <ul className="flex flex-col gap-2">
          {errors.map((error) => {
            const fix = fixByErrorId.get(error.id) ?? null;
            const selected = error.id === selectedErrorId;
            return (
              <li key={error.id}>
                <button
                  type="button"
                  onClick={() => onSelect(error.id)}
                  aria-current={selected}
                  className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                    selected
                      ? "border-sky-700 bg-sky-950/40"
                      : "border-zinc-800 bg-zinc-950/40 hover:border-zinc-700 hover:bg-zinc-900"
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="line-clamp-2 text-sm font-medium text-zinc-100">
                      {error.error_message ?? error.test_name ?? "Unnamed failure"}
                    </p>
                    <StatusBadge status={fix?.status ?? null} />
                  </div>
                  <p className="mt-1 truncate font-mono text-xs text-zinc-500">{location(error)}</p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-zinc-600">
                    <span>{fix?.branch_name ?? "no branch"}</span>
                    <span>{shortSha(error.commit_sha)}</span>
                    {error.occurrences > 1 && <span>×{error.occurrences}</span>}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
