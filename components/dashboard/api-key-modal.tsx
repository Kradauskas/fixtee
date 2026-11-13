"use client";

import { useEffect, useState } from "react";
import type { DashboardProject } from "./types";

export function ApiKeyModal({
  project,
  onClose,
  onSaved,
}: {
  project: DashboardProject;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [value, setValue] = useState("");
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
    if (value.trim().length === 0) {
      setError("Enter a key first.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${project.id}/keys`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ llmApiKey: value }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        setError(body?.message ?? "Could not save the key.");
        return;
      }
      setValue("");
      onSaved();
      onClose();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="LLM API key"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
    >
      <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-900 p-5 shadow-xl">
        <h2 className="text-base font-semibold text-zinc-100">LLM API key</h2>
        <p className="mt-1 text-sm text-zinc-400">
          Used by the fixing agent for {project.repo_owner}/{project.repo_name}. It is stored
          encrypted in Supabase Vault and never sent back to this page.
        </p>

        <label htmlFor="llm-api-key" className="mt-4 block text-xs font-medium text-zinc-400">
          {project.has_llm_key ? "Replace the stored key" : "Add a key"}
        </label>
        <input
          id="llm-api-key"
          type="password"
          autoComplete="off"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="sk-…"
          className="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none"
        />

        {error && <p className="mt-2 text-sm text-red-400">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:border-zinc-500 hover:text-zinc-100"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save key"}
          </button>
        </div>
      </div>
    </div>
  );
}
