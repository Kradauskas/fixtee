"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEMO_ITEMS } from "./demo-data";
import { ErrorCard } from "./error-card";
import {
  ArrowUpRight,
  BrandMark,
  Check,
  ChevronDown,
  CircleDot,
  GitBranch,
  GitPullRequest,
  Github,
  Loader,
  Search,
  Settings,
  ShieldCheck,
  Zap,
} from "./icons";
import { SettingsDialog } from "./settings-dialog";
import { DashboardTheme } from "./theme";
import {
  buildItems,
  isPendingVerification,
  matchesFilter,
  matchesSearch,
  metrics,
  type DashboardData,
  type DashboardFix,
  type FeedFilter,
  type Item,
} from "./types";

const POLL_INTERVAL_MS = 5000;
const SIMULATION_STEP_MS = 2000;
const SIMULATION_STAGES: DashboardFix["status"][] = [
  "analyzing",
  "test_pushed",
  "fix_pushed",
  "verified",
];

type Toast = { id: number; message: string; tone: "info" | "success" | "warning" };

const FILTERS: { id: FeedFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "verified", label: "Verified" },
  { id: "running", label: "Running" },
  { id: "failed", label: "Blocked" },
];

export function DashboardClient({
  initialData,
  signedIn,
  userLabel,
  notice,
  initialLoadError,
}: {
  initialData: DashboardData;
  signedIn: boolean;
  userLabel: string | null;
  notice: string | null;
  initialLoadError: string | null;
}) {
  const [data, setData] = useState(initialData);
  const [projectId, setProjectId] = useState<string | null>(initialData.projects[0]?.id ?? null);
  const [simulations, setSimulations] = useState<Item[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filter, setFilter] = useState<FeedFilter>("all");
  const [query, setQuery] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(initialLoadError);
  const [connection, setConnection] = useState(
    !signedIn ? "Demo · not signed in" : initialLoadError ? "Reconnecting…" : "Live · GitHub Actions",
  );
  const [running, setRunning] = useState(false);
  const [now, setNow] = useState<number | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const inFlight = useRef<Set<string>>(new Set());
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const pushToast = useCallback((message: string, tone: Toast["tone"] = "info") => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, message, tone }]);
    setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 4000);
  }, []);

  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const clock = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(clock);
    };
  }, []);

  useEffect(() => () => (timer.current ? clearInterval(timer.current) : undefined), []);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/dashboard", { cache: "no-store" });
      if (response.status === 401) {
        setLoadError("Your session expired. Reload the page to sign in again.");
        setConnection("Signed out");
        return;
      }
      if (!response.ok) {
        setLoadError("Could not refresh the dashboard.");
        setConnection("Reconnecting…");
        return;
      }
      setData((await response.json()) as DashboardData);
      setLoadError(null);
      setConnection("Live · GitHub Actions");
    } catch {
      setLoadError("Could not reach the server.");
      setConnection("Offline");
    }
  }, []);

  useEffect(() => {
    if (!signedIn) return;
    const poll = setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => clearInterval(poll);
  }, [signedIn, load]);

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
    if (!signedIn) return;
    for (const fix of data.fixes) {
      if (isPendingVerification(fix.status)) void requestVerify(fix.id);
    }
  }, [signedIn, data, requestVerify]);

  const project = useMemo(
    () => data.projects.find((row) => row.id === projectId) ?? data.projects[0] ?? null,
    [data.projects, projectId],
  );

  const liveItems = useMemo(() => buildItems(data, project?.id ?? null), [data, project]);
  const usingDemo = liveItems.length === 0 && simulations.length === 0;
  const items = useMemo(
    () => (usingDemo ? DEMO_ITEMS : [...simulations, ...liveItems]),
    [usingDemo, simulations, liveItems],
  );

  const visible = useMemo(
    () => items.filter((item) => matchesFilter(item, filter) && matchesSearch(item, query)),
    [items, filter, query],
  );

  const totals = useMemo(() => metrics(items), [items]);
  const openId = expanded ?? visible[0]?.error.id ?? null;

  const simulate = useCallback(
    (source: Item = DEMO_ITEMS[0]) => {
      if (running) return;
      const id = `sim_${Date.now()}`;
      const stamp = new Date().toISOString();
      const row: Item = {
        demo: true,
        stepStartedAt: stamp,
        error: { ...source.error, id, commit_sha: "d82a7c1", first_seen: stamp, last_seen: stamp },
        fix: {
          ...(source.fix as DashboardFix),
          id: `fix_${id}`,
          error_id: id,
          status: "queued",
          confidence: 0.9,
          tokens_used: 4900,
          test_commit_sha: null,
          fix_commit_sha: null,
          red_run_url: null,
          green_run_url: null,
          branch_name: `autofix/${id}`,
          pr_number: null,
          pr_url: null,
          created_at: stamp,
          updated_at: stamp,
        },
      };

      setSimulations((previous) => [row, ...previous]);
      setExpanded(id);
      setFilter("all");
      setQuery("");
      setRunning(true);
      pushToast("Simulated CI failure caught. Fixtee is on it.");

      let index = 0;
      timer.current = setInterval(() => {
        const blockedRun = source.fix?.status === "failed";
        const status = blockedRun && index >= 2 ? "failed" : SIMULATION_STAGES[index];
        index += 1;
        if (!status) return;

        const at = new Date().toISOString();
        setSimulations((previous) =>
          previous.map((entry) =>
            entry.error.id === id
              ? {
                  ...entry,
                  stepStartedAt: at,
                  durations: [6, 14, 12],
                  fix: {
                    ...(entry.fix as DashboardFix),
                    status,
                    confidence: status === "failed" ? 0.3 : 0.9,
                    test_commit_sha: index >= 2 ? "cd593f5a1b2c3d4e5f60718293a4b5c6d7e8f901" : null,
                    red_run_url: index >= 3 && status !== "failed" ? entry.error.run_url : null,
                    fix_commit_sha:
                      status === "failed"
                        ? null
                        : index >= 3
                          ? "89ab079c1d2e3f405162738495a6b7c8d9e0f123"
                          : null,
                    updated_at: at,
                  },
                }
              : entry,
          ),
        );

        if (status === "verified" || status === "failed") {
          if (timer.current) clearInterval(timer.current);
          timer.current = null;
          setRunning(false);
          pushToast(
            status === "failed"
              ? "Demo retry blocked again. Human review required."
              : "Demo proof complete. No GitHub changes were made.",
            status === "failed" ? "warning" : "success",
          );
        }
      }, SIMULATION_STEP_MS);
    },
    [running, pushToast],
  );

  return (
    <div className="fx">
      <DashboardTheme />

      <nav className="topbar">
        <div className="brand">
          <BrandMark className="brand-mark" />
          fixtee
          <span className="brand-tag">Zero-SDK GitHub CI healer</span>
        </div>
        <div className="top-actions">
          {data.projects.length > 1 ? (
            <span className="ghost-button repo-selector">
              <Github size={15} />
              <select
                aria-label="Repository"
                value={project?.id ?? ""}
                onChange={(event) => {
                  setProjectId(event.target.value);
                  setExpanded(null);
                }}
              >
                {data.projects.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.repo_owner}/{row.repo_name}
                  </option>
                ))}
              </select>
            </span>
          ) : (
            <span className="ghost-button repo-selector">
              <Github size={15} />
              <span className="repo-owner">{project ? `${project.repo_owner} /` : "no repo /"}</span>
              {project?.repo_name ?? "connect a repository"}
              <span>
                <GitBranch size={11} /> {project?.default_branch ?? "main"}
              </span>
              <ChevronDown size={12} />
            </span>
          )}
          <span className="topbar-divider" />
          <button
            type="button"
            className="ghost-button"
            aria-label="Project and BYOK settings"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings size={16} />
          </button>
          {signedIn && userLabel ? (
            <a className="avatar" href="/api/github/logout" title={userLabel}>
              {userLabel.slice(0, 2).toUpperCase()}
            </a>
          ) : (
            <a className="pr-button" href="/api/github/install">
              <Github size={14} />
              Connect GitHub
            </a>
          )}
        </div>
      </nav>

      <main className="dashboard">
        <div className="page-heading">
          <div>
            <h1>CI command center</h1>
            <p>Your CI failures, caught and verified. Zero guesswork.</p>
          </div>
          <div className="heading-actions">
            <div className="live-status">
              <span className="live-dot" />
              {connection}
            </div>
            <button
              type="button"
              className="simulate-button"
              disabled={running}
              onClick={() => simulate()}
            >
              {running ? <Loader size={14} className="spin" /> : <Zap size={14} />}
              <span className="simulate-label">
                {running ? "Healing CI failure…" : "Simulate live CI failure"}
              </span>
            </button>
          </div>
        </div>

        {notice && <p className="settings-info">{notice}</p>}
        {loadError && <p className="settings-info ci-red">{loadError}</p>}

        <section className="summary-bar" aria-label="CI summary">
          <span className="summary-pill">
            <CircleDot size={14} />
            <strong>{totals.errors}</strong> Errors caught
          </span>
          <span className="summary-pill summary-success">
            <GitPullRequest size={14} />
            <strong>{totals.verified}</strong> Verified PRs ready
          </span>
          <span className="summary-pill summary-blocked">
            <ShieldCheck size={14} />
            <strong>{totals.blocked}</strong> Guardrail blocked
          </span>
          <span className="summary-pill summary-tokens">
            <Zap size={14} />
            <strong>{totals.tokens.toLocaleString("en-US")}</strong> Tokens used
          </span>
        </section>

        <section className="error-list-section" aria-label="Errors">
          <div className="list-toolbar">
            <div className="searchbox">
              <Search size={14} />
              <input
                aria-label="Search failures"
                placeholder="Search errors or files…"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setExpanded(null);
                }}
              />
            </div>
            <div className="feed-filters">
              {FILTERS.map((entry) => (
                <button
                  type="button"
                  key={entry.id}
                  className={`filter ${filter === entry.id ? "active" : ""}`}
                  onClick={() => {
                    setFilter(entry.id);
                    setExpanded(null);
                  }}
                >
                  {entry.id === "verified" && <Check size={12} />}
                  {entry.id === "running" && <Zap size={12} />}
                  {entry.id === "failed" && <ShieldCheck size={12} />}
                  {entry.label}
                </button>
              ))}
            </div>
          </div>

          {usingDemo && (
            <p className="settings-info">
              {signedIn
                ? "No CI failures recorded yet — showing a sample so you can explore the proof view."
                : "Demo data. Connect GitHub to catch and verify failures from your own repositories."}
            </p>
          )}

          <ul className="error-list">
            {visible.map((item) => (
              <ErrorCard
                key={item.error.id}
                item={item}
                open={openId === item.error.id}
                now={now}
                retrying={running}
                onToggle={() => setExpanded(openId === item.error.id ? "" : item.error.id)}
                onRetry={item.demo ? () => simulate(item) : undefined}
              />
            ))}
          </ul>

          {visible.length === 0 && <p className="empty-note">No matching failures.</p>}
        </section>

        <footer className="app-footer">
          <div className="footer-left">
            <span>fixtee v1.0</span>
            <span>Zero SDK. Two commits. One verified fix.</span>
          </div>
          <div className="footer-right">
            <span className="live-dot" />
            {running
              ? "Simulation running"
              : simulations.length
                ? "Simulated proof · no GitHub changes"
                : usingDemo
                  ? "Sample data"
                  : "Live repository"}
            <ArrowUpRight size={10} />
          </div>
        </footer>
      </main>

      {settingsOpen && (
        <SettingsDialog
          project={project}
          signedIn={signedIn}
          onClose={() => setSettingsOpen(false)}
          onSaved={(message, tone) => {
            pushToast(message, tone);
            void load();
          }}
        />
      )}

      <div className="toast-stack">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.tone}`}>
            {toast.message}
          </div>
        ))}
      </div>
    </div>
  );
}
