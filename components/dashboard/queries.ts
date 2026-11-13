import type { Db } from "../../lib/db/supabase";
import type { DashboardData, DashboardProject } from "./types";

export async function fetchDashboardData(db: Db): Promise<DashboardData> {
  const { data: projectRows, error: projectError } = await db
    .from("projects")
    .select(
      "id, repo_owner, repo_name, default_branch, installation_id, llm_provider, llm_key_secret_id",
    )
    .order("repo_owner")
    .order("repo_name");
  if (projectError) throw new Error(`dashboard: loading projects failed: ${projectError.message}`);

  const projects: DashboardProject[] = (projectRows ?? []).map((row) => ({
    id: row.id,
    repo_owner: row.repo_owner,
    repo_name: row.repo_name,
    default_branch: row.default_branch,
    installation_id: row.installation_id,
    llm_provider: row.llm_provider,
    has_llm_key: row.llm_key_secret_id !== null,
  }));
  if (projects.length === 0) return { projects, errors: [], fixes: [] };

  const { data: errorRows, error: errorsError } = await db
    .from("errors")
    .select("*")
    .in(
      "project_id",
      projects.map((project) => project.id),
    )
    .order("last_seen", { ascending: false });
  if (errorsError) throw new Error(`dashboard: loading errors failed: ${errorsError.message}`);

  const errors = errorRows ?? [];
  if (errors.length === 0) return { projects, errors, fixes: [] };

  const { data: fixRows, error: fixesError } = await db
    .from("fixes")
    .select("*")
    .in(
      "error_id",
      errors.map((row) => row.id),
    )
    .order("created_at", { ascending: false });
  if (fixesError) throw new Error(`dashboard: loading fixes failed: ${fixesError.message}`);

  return { projects, errors, fixes: fixRows ?? [] };
}
