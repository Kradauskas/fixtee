"use client";

import { useEffect, useState } from "react";
import { Github, KeyRound, Loader, ShieldCheck } from "./icons";
import type { DashboardProject } from "./types";

export function SettingsDialog({
  project,
  signedIn,
  onClose,
  onSaved,
}: {
  project: DashboardProject | null;
  signedIn: boolean;
  onClose: () => void;
  onSaved: (message: string, tone: "success" | "warning") => void;
}) {
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const save = async () => {
    if (!project) {
      onSaved("Connect a repository before saving a key.", "warning");
      onClose();
      return;
    }
    if (key.trim().length === 0) {
      setError("Enter a key first.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${project.id}/keys`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ llmApiKey: key }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        setError(body?.message ?? "Could not save the key.");
        return;
      }
      setKey("");
      onSaved("API key securely saved.", "success");
      onClose();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fx-overlay" role="dialog" aria-modal="true" aria-label="Project settings">
      <div className="fx-dialog">
        <header>
          <h2>Project &amp; BYOK settings</h2>
          <p>
            {project ? `${project.repo_owner}/${project.repo_name}` : "No repository connected"} ·
            project configuration
          </p>
        </header>

        <section className="settings-section">
          <h3>
            <Github size={15} /> GitHub App installation
          </h3>
          <div className="settings-row">
            <code>
              {project ? `${project.repo_owner}/${project.repo_name}` : "not connected"}
            </code>
            {project && <span className="status-badge tone-verified">Connected</span>}
          </div>
          <div className="settings-info">
            {project
              ? `Installation ${project.installation_id} · ${project.default_branch} branch`
              : signedIn
                ? "Install the Fixtee GitHub App to start catching CI failures."
                : "Sign in and install the Fixtee GitHub App to catch failures from your own repositories."}
          </div>
          {!project && (
            <a className="pr-button" href="/api/github/install">
              <Github size={14} />
              {signedIn ? "Install the GitHub App" : "Connect GitHub / Sign in"}
            </a>
          )}
        </section>

        <section className="settings-section">
          <h3>
            <KeyRound size={15} /> Bring your own LLM key
          </h3>
          <label htmlFor="llm-key">
            {project?.has_llm_key ? "Replace the stored key" : "Anthropic Claude API key"}
          </label>
          <input
            id="llm-key"
            type="password"
            autoComplete="off"
            placeholder="Enter API key"
            value={key}
            onChange={(event) => setKey(event.target.value)}
          />
          <div className="settings-info">
            <ShieldCheck size={12} /> Encrypted Vault storage · project owners only · never read
            back into this page
          </div>
          {error && <p className="settings-info ci-red">{error}</p>}
        </section>

        <div className="dialog-actions">
          <button type="button" className="pr-button-outline" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="pr-button" onClick={save} disabled={saving || !project}>
            {saving ? <Loader size={14} className="spin" /> : <ShieldCheck size={14} />}
            Save settings
          </button>
        </div>
      </div>
    </div>
  );
}
