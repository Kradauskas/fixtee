"use client";

import {
  Check,
  ChevronDown,
  CircleDot,
  FileCode,
  GitBranch,
  Github,
  ShieldCheck,
  Zap,
} from "./icons";
import { Inspector } from "./inspector";
import {
  confidenceLevel,
  errorPreview,
  guardrailReason,
  isReady,
  relativeTime,
  shortSha,
  statusLabel,
  type Item,
} from "./types";

function ErrorMetrics({ item }: { item: Item }) {
  const confidence = item.fix?.confidence ?? null;
  const level = confidenceLevel(confidence);
  const percent = confidence === null ? null : Math.round(confidence * 100);
  const duration = item.durations?.reduce((sum, value) => sum + value, 0);
  const tokens = item.fix?.tokens_used ?? null;

  return (
    <span className="row-metrics">
      <span className={`confidence-meter confidence-${level}`}>
        <span className="confidence-track">
          <svg viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true">
            <rect width={percent ?? 0} height="4" fill="currentColor" />
          </svg>
        </span>
        {percent === null
          ? "Confidence pending"
          : `${percent}% ${level === "high" ? "High confidence" : level === "medium" ? "Medium" : "Low confidence"}`}
      </span>
      {isReady(item.fix) && (
        <span className="fix-metric">
          <Zap size={12} />
          {duration ? `${item.demo ? "Demo · " : ""}Fixed in ${duration}s · ` : ""}
          {tokens === null ? "Tokens pending" : `${(tokens / 1000).toFixed(1)}k tokens`}
        </span>
      )}
    </span>
  );
}

export function ErrorCard({
  item,
  repoLabel,
  open,
  now,
  retrying,
  onToggle,
  onRetry,
}: {
  item: Item;
  repoLabel?: string | null;
  open: boolean;
  now: number | null;
  retrying: boolean;
  onToggle: () => void;
  onRetry?: () => void;
}) {
  const blocked = Boolean(guardrailReason(item));
  const verified = isReady(item.fix) && !blocked;
  const tone = blocked ? "failed" : verified ? "verified" : "running";
  const simulated = item.error.id.startsWith("sim_");

  return (
    <li
      className={`error-card ${simulated ? "new-error-card" : ""}`}
      data-state={open ? "open" : "closed"}
    >
      <button type="button" className="error-row" onClick={onToggle} aria-expanded={open}>
        <span className="error-row-content">
          <span className={`status-badge tone-${tone}`}>
            {verified ? (
              <Check size={12} />
            ) : blocked ? (
              <ShieldCheck size={12} />
            ) : (
              <CircleDot size={12} />
            )}{" "}
            {statusLabel(item)}
          </span>
          <ErrorMetrics item={item} />
          <span className="error-row-title">
            {item.error.error_message ?? item.error.test_name ?? "Unnamed CI failure"}
          </span>
          <span className="error-row-preview">
            <span>{errorPreview(item)}</span>
            {item.error.occurrences > 1 && (
              <span className="occurrences">×{item.error.occurrences}</span>
            )}
          </span>
          <span className="error-row-meta">
            {repoLabel && (
              <span>
                <Github size={13} />
                {repoLabel}
              </span>
            )}
            <span>
              <FileCode size={13} />
              {item.error.file_path ?? "unknown file"}
              {item.error.line === null ? "" : `:${item.error.line}`}
            </span>
            <span>
              <GitBranch size={13} />
              {item.fix?.branch_name ?? shortSha(item.error.commit_sha)}
            </span>
            <time dateTime={item.error.last_seen}>
              {now === null ? "—" : relativeTime(item.error.last_seen, now)}
            </time>
          </span>
        </span>
        <span className="chevron" data-open={open}>
          <ChevronDown size={16} />
        </span>
      </button>
      {open && <Inspector item={item} retrying={retrying} onRetry={onRetry} />}
    </li>
  );
}
