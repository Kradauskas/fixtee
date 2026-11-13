"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiKeyModal } from "./api-key-modal";
import { ErrorFeed, matchesSearch } from "./error-feed";
import { FixInspector } from "./fix-inspector";
import { computeKpis, KpiCards } from "./kpi-cards";
import { isPendingVerification, type DashboardData, type DashboardFix } from "./types";

const POLL_INTERVAL_MS = 5000;

export function DashboardClient({
  initialData,
  userLabel,
  notice,
  initialLoadError,
}: {
  initialData: DashboardData;
  userLabel: string;
  notice: string | null;
  initialLoadError: string | null;
}) {
  const [data, setData] = useState(initialData);
  const [projectId, setProjectId] = useState<string | null>(initialData.projects[0]?.id ?? null);
  const [selectedErrorId, setSelectedErrorId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [loadError, setLoadError] = useState<string | null>(initialLoadError);
  const [keyModalOpen, setKeyModalOpen] = useState(false);
  const [keySaved, setKeySaved] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const inFlight = useRef<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/dashboard", { cache: "no-store" });
      if (response.status === 401) {
        setLoadError("Your session expired. Reload the page to sign in again.");
        return;
      }
      if (!response.ok) {
        setLoadError("Could not refresh the dashboard.");
        return;
      }
      setData((await response.json()) as DashboardData);
      setLoadError(null);
      setSyncedAt(new Date().toLocaleTimeString("en-US", { hour12: false }));
    } catch {
      setLoadError("Could not reach the server.");
    }
  }, []);

  useEffect(() => {
    const timer = setInterval(load, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const requestVerify = useCallback(async (fixId: string) => {
    if (inFlight.current.has(fixId)) return;
    inFlight.current.add(fixId);
    try {
      await fetch("/api/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fixId }),
      });
    } catch {
      return;
    } finally {
      inFlight.current.delete(fixId);
    }
  }, []);

  useEffect(() => {
    for (const fix of data.fixes) {
      if (isPendingVerification(fix.status)) void requestVerify(fix.id);
    }
  }, [data, requestVerify]);

  const project = useMemo(
    () => data.projects.find((row) => row.id === projectId) ?? data.projects[0] ?? null,
    [data.projects, projectId],
  );

  const projectErrors = useMemo(
    () => data.errors.filter((error) => error.project_id === project?.id),
    [data.errors, project],
  );

  const fixByErrorId = useMemo(() => {
    const newest = new Map<string, DashboardFix>();
    for (const fix of data.fixes) if (!newest.has(fix.error_id)) newest.set(fix.error_id, fix);
    return newest;
  }, [data.fixes]);

  const projectFixes = useMemo(
    () =>
      projectErrors
        .map((error) => fixByErrorId.get(error.id))
        .filter((fix): fix is DashboardFix => fix !== undefined),
    [projectErrors, fixByErrorId],
  );

  const visibleErrors = useMemo(
    () => projectErrors.filter((error) => matchesSearch(error, search)),
    [projectErrors, search],
  );

  const selectedError =
    visibleErrors.find((error) => error.id === selectedErrorId) ?? visibleErrors[0] ?? null;
  const selectedFix = selectedError ? (fixByErrorId.get(selectedError.id) ?? null) : null;

  const kpis = useMemo(() => computeKpis(projectErrors, projectFixes), [projectErrors, projectFixes]);

  const verifySelected = async () => {
    if (!selectedFix) return;
    setVerifying(true);
    try {
      await requestVerify(selectedFix.id);
      await load();
    } finally {
      setVerifying(false);
    }
  };

  return (
    <main className="flex min-h-full flex-col gap-4 bg-zinc-950 p-4 font-sans text-zinc-100 lg:h-screen lg:overflow-hidden lg:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold tracking-tight">Fixtee</h1>
          {data.projects.length > 0 && (
            <select
              value={project?.id ?? ""}
              onChange={(event) => {
                setProjectId(event.target.value);
                setSelectedErrorId(null);
              }}
              aria-label="Project"
              className="rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 font-mono text-sm text-zinc-200 focus:border-zinc-600 focus:outline-none"
            >
              {data.projects.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.repo_owner}/{row.repo_name}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-mono text-xs text-zinc-600">
            {syncedAt ? `synced ${syncedAt}` : "live"}
          </span>
          <button
            type="button"
            onClick={() => setKeyModalOpen(true)}
            disabled={!project}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-zinc-300 hover:border-zinc-500 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
          >
            LLM API Key
            {project?.has_llm_key && <span className="ml-1.5 text-emerald-400">●</span>}
          </button>
          <a
            href="/api/github/install"
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-zinc-300 hover:border-zinc-500 hover:text-zinc-100"
          >
            Add repos
          </a>
          <a
            href="/api/github/logout"
            className="font-mono text-xs text-zinc-600 hover:text-zinc-400"
          >
            {userLabel}
          </a>
        </div>
      </header>

      {notice && (
        <p className="rounded-lg border border-sky-900 bg-sky-950/50 px-3 py-2 text-sm text-sky-200">
          {notice}
        </p>
      )}
      {keySaved && (
        <p className="rounded-lg border border-emerald-900 bg-emerald-950/50 px-3 py-2 text-sm text-emerald-200">
          API key saved.
        </p>
      )}
      {loadError && (
        <p className="rounded-lg border border-red-900 bg-red-950/50 px-3 py-2 text-sm text-red-200">
          {loadError}
        </p>
      )}

      <KpiCards kpis={kpis} />

      {data.projects.length === 0 ? (
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-8 text-center">
          <h2 className="text-base font-semibold text-zinc-200">No repositories yet</h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-zinc-400">
            Install the Fixtee GitHub App on a repository. Every failing CI run on its default
            branch then shows up here.
          </p>
          <a
            href="/api/github/install"
            className="mt-4 inline-block rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500"
          >
            Install the GitHub App
          </a>
        </section>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[minmax(320px,380px)_1fr]">
          <ErrorFeed
            errors={visibleErrors}
            fixByErrorId={fixByErrorId}
            selectedErrorId={selectedError?.id ?? null}
            search={search}
            onSearchChange={setSearch}
            onSelect={setSelectedErrorId}
          />

          {selectedError ? (
            <FixInspector
              error={selectedError}
              fix={selectedFix}
              verifying={verifying}
              onVerify={verifySelected}
            />
          ) : (
            <section className="flex items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900/40 p-8">
              <p className="text-sm text-zinc-500">
                {projectErrors.length === 0
                  ? "No CI failures captured for this repository yet."
                  : "No failure matches that filter."}
              </p>
            </section>
          )}
        </div>
      )}

      {keyModalOpen && project && (
        <ApiKeyModal
          project={project}
          onClose={() => setKeyModalOpen(false)}
          onSaved={() => {
            setKeySaved(true);
            void load();
          }}
        />
      )}
    </main>
  );
}
