/**
 * Install flow logic: turn a GitHub App installation into `projects` rows for a user.
 * Route handlers in app/api/github/{install,setup} stay thin and call into here.
 *
 * Server-only (uses the secret-key Supabase client and the GitHub App client).
 */
import { z } from "zod";
import type { Db } from "@/lib/db/supabase";
import { getInstallationOctokit } from "./app";

// ---------------------------------------------------------------------------
// Query parsing
// ---------------------------------------------------------------------------

const setupQuerySchema = z.discriminatedUnion("setup_action", [
  z.object({
    setup_action: z.enum(["install", "update"]),
    installation_id: z.coerce.number().int().positive(),
  }),
  // An org member without admin rights asked an admin to install. No installation yet.
  z.object({ setup_action: z.literal("request") }),
]);

export type SetupQuery = z.infer<typeof setupQuerySchema>;

export function parseSetupQuery(params: URLSearchParams): SetupQuery | null {
  const result = setupQuerySchema.safeParse(Object.fromEntries(params));
  return result.success ? result.data : null;
}

/** Only allow redirects to paths on this site ("/x"), never "//evil.com" or absolute URLs. */
export function safeNextPath(next: string | null | undefined, fallback = "/dashboard"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) {
    return fallback;
  }
  return next;
}

export function loginPath(next: string): string {
  return `/api/github/login?next=${encodeURIComponent(next)}`;
}

// ---------------------------------------------------------------------------
// Sync an installation into projects
// ---------------------------------------------------------------------------

export type InstallationRepo = { owner: string; name: string; defaultBranch: string };

export type ProjectRef = { id: string; userId: string; owner: string; name: string };

/** Everything syncInstallation needs from the outside world; faked in tests. */
export type InstallDeps = {
  listRepos(installationId: number): Promise<InstallationRepo[]>;
  listProjects(installationId: number): Promise<ProjectRef[]>;
  upsertProjects(userId: string, installationId: number, repos: InstallationRepo[]): Promise<void>;
  deleteProjects(ids: string[]): Promise<void>;
};

export type SyncResult =
  | { ok: true; repoCount: number; removedCount: number }
  | { ok: false; reason: "claimed_by_other_user" };

/**
 * Make `projects` match what the installation can access, for this user:
 * upsert a row per accessible repo, delete rows for repos the installation lost.
 *
 * Guard: if another user already has projects on this installation, refuse.
 * Otherwise anyone logged in could visit /api/github/setup?installation_id=<someone else's>
 * and take over their projects. (Full fix, not built: check with the user's GitHub OAuth
 * token that they can actually see this installation.)
 */
export async function syncInstallation(
  deps: InstallDeps,
  userId: string,
  installationId: number,
): Promise<SyncResult> {
  const existing = await deps.listProjects(installationId);
  if (existing.some((p) => p.userId !== userId)) {
    return { ok: false, reason: "claimed_by_other_user" };
  }

  const repos = await deps.listRepos(installationId);
  if (repos.length > 0) await deps.upsertProjects(userId, installationId, repos);

  const keep = new Set(repos.map((r) => repoKey(r.owner, r.name)));
  const stale = existing.filter((p) => !keep.has(repoKey(p.owner, p.name))).map((p) => p.id);
  if (stale.length > 0) await deps.deleteProjects(stale);

  return { ok: true, repoCount: repos.length, removedCount: stale.length };
}

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`.toLowerCase();
}

// ---------------------------------------------------------------------------
// Real dependencies: GitHub App + Supabase (secret key)
// ---------------------------------------------------------------------------

type RepoListResponse = {
  total_count: number;
  repositories: { name: string; default_branch: string; owner: { login: string } }[];
};

export async function listInstallationRepos(installationId: number): Promise<InstallationRepo[]> {
  const octokit = await getInstallationOctokit(installationId);
  const repos: InstallationRepo[] = [];
  for (let page = 1; ; page++) {
    const { data } = await octokit.request("GET /installation/repositories", {
      per_page: 100,
      page,
    });
    const body = data as RepoListResponse;
    for (const r of body.repositories) {
      repos.push({ owner: r.owner.login, name: r.name, defaultBranch: r.default_branch });
    }
    if (body.repositories.length < 100 || repos.length >= body.total_count) return repos;
  }
}

export function createInstallDeps(db: Db): InstallDeps {
  return {
    listRepos: listInstallationRepos,

    async listProjects(installationId) {
      const { data, error } = await db
        .from("projects")
        .select("id, user_id, repo_owner, repo_name")
        .eq("installation_id", installationId);
      if (error) throw new Error(`listing projects failed: ${error.message}`);
      return data.map((p) => ({ id: p.id, userId: p.user_id, owner: p.repo_owner, name: p.repo_name }));
    },

    async upsertProjects(userId, installationId, repos) {
      const rows = repos.map((r) => ({
        user_id: userId,
        installation_id: installationId,
        repo_owner: r.owner,
        repo_name: r.name,
        default_branch: r.defaultBranch,
      }));
      const { error } = await db
        .from("projects")
        .upsert(rows, { onConflict: "installation_id,repo_owner,repo_name" });
      if (error) throw new Error(`upserting projects failed: ${error.message}`);
    },

    async deleteProjects(ids) {
      const { error } = await db.from("projects").delete().in("id", ids);
      if (error) throw new Error(`deleting projects failed: ${error.message}`);
    },
  };
}
