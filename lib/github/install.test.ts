import { describe, expect, it } from "vitest";
import {
  type InstallDeps,
  type InstallationRepo,
  type ProjectRef,
  parseSetupQuery,
  safeNextPath,
  syncInstallation,
} from "./install";

// In-memory fake of GitHub + the projects table.
function fakeDeps(repos: InstallationRepo[], projects: (ProjectRef & { installationId: number })[]) {
  const rows = [...projects];
  let nextId = 1;
  const deps: InstallDeps = {
    listRepos: async () => repos,
    listProjects: async (installationId) =>
      rows.filter((r) => r.installationId === installationId),
    upsertProjects: async (userId, installationId, list) => {
      for (const repo of list) {
        const hit = rows.find(
          (r) => r.installationId === installationId && r.owner === repo.owner && r.name === repo.name,
        );
        if (hit) hit.userId = userId;
        else rows.push({ id: `new-${nextId++}`, userId, installationId, owner: repo.owner, name: repo.name });
      }
    },
    deleteProjects: async (ids) => {
      for (const id of ids) rows.splice(rows.findIndex((r) => r.id === id), 1);
    },
  };
  return { deps, rows };
}

const repo = (name: string): InstallationRepo => ({ owner: "octo", name, defaultBranch: "main" });

describe("syncInstallation", () => {
  it("creates a project per repo for a fresh install", async () => {
    const { deps, rows } = fakeDeps([repo("a"), repo("b")], []);
    const result = await syncInstallation(deps, "user-1", 42);
    expect(result).toEqual({ ok: true, repoCount: 2, removedCount: 0 });
    expect(rows.map((r) => [r.userId, r.installationId, r.name])).toEqual([
      ["user-1", 42, "a"],
      ["user-1", 42, "b"],
    ]);
  });

  it("is idempotent when the same user installs again", async () => {
    const { deps, rows } = fakeDeps([repo("a")], []);
    await syncInstallation(deps, "user-1", 42);
    await syncInstallation(deps, "user-1", 42);
    expect(rows).toHaveLength(1);
  });

  it("removes projects for repos the installation no longer covers", async () => {
    const { deps, rows } = fakeDeps(
      [repo("a")],
      [
        { id: "p1", userId: "user-1", installationId: 42, owner: "octo", name: "a" },
        { id: "p2", userId: "user-1", installationId: 42, owner: "octo", name: "gone" },
        { id: "p3", userId: "user-1", installationId: 7, owner: "octo", name: "other-install" },
      ],
    );
    const result = await syncInstallation(deps, "user-1", 42);
    expect(result).toEqual({ ok: true, repoCount: 1, removedCount: 1 });
    expect(rows.map((r) => r.id).sort()).toEqual(["p1", "p3"]);
  });

  it("refuses an installation another user already claimed, and changes nothing", async () => {
    const { deps, rows } = fakeDeps(
      [repo("a"), repo("b")],
      [{ id: "p1", userId: "owner", installationId: 42, owner: "octo", name: "a" }],
    );
    const result = await syncInstallation(deps, "intruder", 42);
    expect(result).toEqual({ ok: false, reason: "claimed_by_other_user" });
    expect(rows).toEqual([{ id: "p1", userId: "owner", installationId: 42, owner: "octo", name: "a" }]);
  });
});

describe("parseSetupQuery", () => {
  const q = (s: string) => parseSetupQuery(new URLSearchParams(s));

  it("accepts install and update with a numeric installation id", () => {
    expect(q("installation_id=123&setup_action=install")).toEqual({
      setup_action: "install",
      installation_id: 123,
    });
    expect(q("installation_id=5&setup_action=update")?.setup_action).toBe("update");
  });

  it("accepts request without an installation id", () => {
    expect(q("setup_action=request")).toEqual({ setup_action: "request" });
  });

  it("rejects missing, non-numeric or unknown values", () => {
    expect(q("")).toBeNull();
    expect(q("setup_action=install")).toBeNull();
    expect(q("installation_id=abc&setup_action=install")).toBeNull();
    expect(q("installation_id=-1&setup_action=install")).toBeNull();
    expect(q("installation_id=1&setup_action=hack")).toBeNull();
  });
});

describe("safeNextPath", () => {
  it("keeps same-site paths", () => {
    expect(safeNextPath("/api/github/setup?installation_id=1&setup_action=install")).toBe(
      "/api/github/setup?installation_id=1&setup_action=install",
    );
  });

  it("falls back for anything that could leave the site", () => {
    for (const bad of [null, "", "https://evil.com", "//evil.com", "/\\evil.com", "evil.com"]) {
      expect(safeNextPath(bad)).toBe("/dashboard");
    }
  });
});
