"use client";

import { useEffect, useState } from "react";
import { reproductionFor, testFileName } from "./demo-data";
import {
  ArrowUpRight,
  Check,
  Clock,
  FileCode,
  Rotate,
  ShieldCheck,
  Sparkles,
  TestTube,
} from "./icons";
import {
  elapsedSeconds,
  failureKind,
  fixExplanation,
  githubRepoUrl,
  guardrailReason,
  isReady,
  parsePlannedChanges,
  proofSteps,
  readableLog,
  runningTime,
  shortSha,
  testPanelState,
  type Item,
} from "./types";

const STEP_ICONS = [Sparkles, TestTube, ShieldCheck];

function DiffPanel({ item }: { item: Item }) {
  const changes = parsePlannedChanges(item.fix?.planned_changes ?? null);
  const fix = item.fix;
  const status = fix?.status ?? "queued";

  if (changes.length === 0) {
    if (fix?.fix_commit_sha) {
      const repoUrl = githubRepoUrl(item);
      const linkUrl = repoUrl
        ? `${repoUrl}/commit/${fix.fix_commit_sha}`
        : fix.pr_url
          ? `${fix.pr_url}/files`
          : null;
      return (
        <div className="blocked-explanation" style={{ flexWrap: "wrap", justifyContent: "space-between" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <FileCode size={15} /> Fix commit {shortSha(fix.fix_commit_sha)} is on{" "}
            {fix.branch_name ?? "the fix branch"}.
          </span>
          {linkUrl && (
            <a
              className="pr-button-outline"
              href={linkUrl}
              target="_blank"
              rel="noreferrer noopener"
            >
              View fix commit <ArrowUpRight size={13} />
            </a>
          )}
        </div>
      );
    }

    if (status === "queued" || status === "analyzing") {
      return (
        <p className="blocked-explanation">
          <Sparkles size={15} /> Generating fix diff...
        </p>
      );
    }

    return (
      <p className="blocked-explanation">
        <ShieldCheck size={15} /> No code change was pushed. Your repository is unchanged.
      </p>
    );
  }

  return (
    <>
      {changes.map((change, changeIndex) => {
        const removed = readableLog(change.search).split("\n");
        const added = readableLog(change.replace).split("\n");
        return (
          <div className="editor-code" key={`${change.path}-${changeIndex}`}>
            {removed.map((line, index) => (
              <div className="editor-row editor-removed" key={`old-${index}`}>
                <span className="diff-marker">−</span>
                <span className="editor-line-number">{index + 1}</span>
                <code>{line || " "}</code>
              </div>
            ))}
            {added.map((line, index) => (
              <div className="editor-row editor-added" key={`new-${index}`}>
                <span className="diff-marker">+</span>
                <span className="editor-line-number">{removed.length + index + 1}</span>
                <code>{line || " "}</code>
              </div>
            ))}
          </div>
        );
      })}
    </>
  );
}

function TestPanel({ item }: { item: Item }) {
  const source = reproductionFor(item);

  if (!source) {
    const state = testPanelState(item);
    return (
      <div className="blocked-explanation" style={{ flexWrap: "wrap", justifyContent: "space-between" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <TestTube size={15} />
          {state.message}
        </span>
        {state.links.length > 0 && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {state.links.map((link) => (
              <a
                key={link.url}
                className="pr-button-outline"
                href={link.url}
                target="_blank"
                rel="noreferrer noopener"
              >
                {link.label} <ArrowUpRight size={13} />
              </a>
            ))}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="editor-code generated-test">
      {readableLog(source)
        .split("\n")
        .map((line, index) => (
          <div className="editor-row" key={index}>
            <span className="diff-marker" />
            <span className="editor-line-number">{index + 1}</span>
            <code>{line || " "}</code>
          </div>
        ))}
    </div>
  );
}

export function Inspector({
  item,
  onRetry,
  retrying = false,
}: {
  item: Item;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const [now, setNow] = useState<number | null>(null);
  const [tab, setTab] = useState<"fix" | "test">("fix");
  const [logOpen, setLogOpen] = useState(false);

  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, []);

  const fix = item.fix;
  const kind = failureKind(item);
  const reason = guardrailReason(item);
  const blocked = Boolean(reason);
  const ready = isReady(fix) && !blocked;
  const steps = proofSteps(item);
  const summary = fixExplanation(item);

  return (
    <article className="inspector">
      <header className="inspector-actions">
        {ready && fix?.pr_url ? (
          <a className="pr-button" href={fix.pr_url} target="_blank" rel="noreferrer noopener">
            Open Ready PR on GitHub <ArrowUpRight size={14} />
          </a>
        ) : fix?.pr_url ? (
          <a
            className="pr-button-outline"
            href={fix.pr_url}
            target="_blank"
            rel="noreferrer noopener"
          >
            View draft on GitHub <ArrowUpRight size={14} />
          </a>
        ) : (
          <span className="run-unavailable">
            {blocked ? "No PR opened" : "Checks in progress"}
          </span>
        )}
      </header>

      <div className="simple-body">
        {reason && (
          <div className="guardrail-banner" role="alert">
            <ShieldCheck size={20} />
            <div>
              <strong>{reason}</strong>
              <p>
                {item.demo
                  ? "Retry creates a separate demo analysis. GitHub stays unchanged."
                  : kind === "agent_error"
                    ? "Check the failure details and logs below before re-running CI."
                    : "Human review is required before another analysis."}
              </p>
            </div>
            {onRetry && (
              <button
                type="button"
                className="pr-button-outline"
                disabled={retrying}
                onClick={onRetry}
              >
                <Rotate size={14} />
                Retry Analysis
              </button>
            )}
          </div>
        )}

        <section className="simple-proof" aria-label="Fix verification">
          {steps.map((step, index) => {
            const Icon = STEP_ICONS[index];
            return (
              <div
                className={`proof-step proof-${step.tone} ${step.complete ? "proof-complete" : ""}`}
                key={step.title}
                aria-busy={step.running}
              >
                <div className="proof-node">
                  <Icon size={21} />
                  {step.running && <span className="border-spinner" />}
                  {step.complete && (
                    <span className="proof-check" aria-label="Completed">
                      <Check size={11} />
                    </span>
                  )}
                </div>
                <h3>
                  {index + 1}. {step.title}
                </h3>
                <p>{step.description}</p>
                <div className="step-evidence">
                  {step.sha && <span className="sha-pill">{shortSha(step.sha)}</span>}
                  {!step.sha && step.shaLabel && <span className="sha-pill">{step.shaLabel}</span>}
                  {step.complete && item.durations && (
                    <span className="duration-pill">
                      <Clock size={11} />
                      {item.durations[index]}s{item.demo ? " demo" : ""}
                    </span>
                  )}
                  {step.running && (
                    <span className="running-timer">
                      <span className="timer-pulse" />
                      running{" "}
                      {runningTime(
                        now === null
                          ? 0
                          : elapsedSeconds(
                              item.stepStartedAt ?? fix?.updated_at ?? item.error.last_seen,
                              now,
                            ),
                      )}
                    </span>
                  )}
                </div>
                {index > 0 &&
                  step.complete &&
                  (step.runUrl ? (
                    <a
                      className={`ci-run-link ci-${index === 1 ? "red" : "green"}`}
                      href={step.runUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      View {index === 1 ? "Red" : "Green"} CI Run <ArrowUpRight size={12} />
                    </a>
                  ) : (
                    <span className="run-unavailable">
                      {item.error.id.startsWith("sim_")
                        ? "Simulated CI · no GitHub run"
                        : "CI run link unavailable"}
                    </span>
                  ))}
              </div>
            );
          })}
        </section>

        <section className="plain-summary">
          <h3>Why it broke &amp; how we fixed it</h3>
          <div className="explanation-grid">
            <div>
              <h4>Why it broke</h4>
              <p>{summary.why}</p>
            </div>
            <div>
              <h4>{summary.howHeading}</h4>
              <p>{summary.how}</p>
            </div>
          </div>
        </section>

        <section>
          <div className="diff-heading">
            <h3>
              {ready
                ? "The code change"
                : kind === "fix_failed_ci"
                  ? "Proposed code change (CI failed)"
                  : blocked
                    ? "No code change pushed"
                    : "Proposed code change"}
            </h3>
            {ready && (
              <span>
                <ShieldCheck size={12} /> All checks passed
              </span>
            )}
          </div>

          <div className="unified-editor">
            <div className="editor-tabs" role="tablist" aria-label="Code files">
              <button
                type="button"
                role="tab"
                aria-selected={tab === "fix"}
                data-state={tab === "fix" ? "active" : "inactive"}
                className="editor-file-tab"
                onClick={() => setTab("fix")}
              >
                <FileCode size={14} />
                {item.error.file_path ?? "source"} (Fix diff)
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "test"}
                data-state={tab === "test" ? "active" : "inactive"}
                className="editor-file-tab"
                onClick={() => setTab("test")}
              >
                <TestTube size={14} />
                {testFileName(item)} (Reproduction test)
              </button>
            </div>
            {tab === "fix" ? <DiffPanel item={item} /> : <TestPanel item={item} />}
          </div>
        </section>

        <section className="evidence-accordion">
          <button type="button" onClick={() => setLogOpen((open) => !open)} aria-expanded={logOpen}>
            Raw CI log
            <span>{logOpen ? "Hide" : "Show"}</span>
          </button>
          {logOpen && <pre>{readableLog(item.error.log_excerpt ?? "No log captured yet.")}</pre>}
        </section>
      </div>
    </article>
  );
}
