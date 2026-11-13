import type { Json, Tables, TablesUpdate } from "@/lib/db/types";
import { getServiceClient } from "@/lib/db/supabase";
import type { AgentOutput } from "@/lib/agent/types";

/** Service-role client (bypasses RLS). Server-side only. */
const db = getServiceClient;

export type ErrorRow = Tables<"errors">;
export type FixRow = Tables<"fixes">;
export type ErrorProject = Pick<
  Tables<"projects">,
  "id" | "repo_owner" | "repo_name" | "installation_id" | "default_branch" | "llm_provider"
>;
export type ErrorWithProject = ErrorRow & { projects: ErrorProject };

export type FixPatch = Pick<
  TablesUpdate<"fixes">,
  | "status"
  | "branch_name"
  | "pr_number"
  | "pr_url"
  | "test_commit_sha"
  | "fix_commit_sha"
  | "ai_reasoning"
  | "confidence"
  | "tokens_used"
  | "planned_changes"
>;

export type PlannedChange = { path: string; search: string; replace: string };

/** Loads an errors row together with the owning project's repo info. */
export async function loadError(errorId: string): Promise<ErrorWithProject> {
  const { data, error } = await db()
    .from("errors")
    .select("*, projects(id, repo_owner, repo_name, installation_id, default_branch, llm_provider)")
    .eq("id", errorId)
    .maybeSingle();
  if (error) throw new Error(`loadError(${errorId}): ${error.message}`);
  if (!data) throw new Error(`loadError(${errorId}): error not found`);
  if (!data.projects) throw new Error(`loadError(${errorId}): project not found`);
  return data as ErrorWithProject;
}

/** Inserts a new fixes row with status 'queued'. */
export async function createFix(errorId: string): Promise<FixRow> {
  const { data, error } = await db()
    .from("fixes")
    .insert({ error_id: errorId, status: "queued" })
    .select()
    .single();
  if (error) throw new Error(`createFix(${errorId}): ${error.message}`);
  return data;
}

/** Returns the newest fixes row for the error with status 'queued', or null if there is none. */
export async function findQueuedFix(errorId: string): Promise<FixRow | null> {
  const { data, error } = await db()
    .from("fixes")
    .select()
    .eq("error_id", errorId)
    .eq("status", "queued")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`findQueuedFix(${errorId}): ${error.message}`);
  return data;
}

/** Updates selected columns of a fixes row and returns the updated row. */
export async function updateFix(fixId: string, patch: FixPatch): Promise<FixRow> {
  const { data, error } = await db()
    .from("fixes")
    .update(patch)
    .eq("id", fixId)
    .select()
    .maybeSingle();
  if (error) throw new Error(`updateFix(${fixId}): ${error.message}`);
  if (!data) throw new Error(`updateFix(${fixId}): fix not found`);
  return data;
}

const CONFIDENCE: Record<AgentOutput["confidence"], number> = {
  low: 0.3,
  medium: 0.6,
  high: 0.9,
};

export function confidenceToNumber(confidence: AgentOutput["confidence"]): number {
  return CONFIDENCE[confidence];
}

/** Decrypts the project's LLM API key via the get_project_llm_key RPC. Null when the project has no key. */
export async function getProjectLlmKey(projectId: string): Promise<string | null> {
  const { data, error } = await db().rpc("get_project_llm_key", { p_project_id: projectId });
  if (error) throw new Error(`getProjectLlmKey(${projectId}): ${error.message}`);
  // The generated type says string, but the function returns null when no key is set.
  const key = (data as string | null)?.trim();
  return key ? key : null;
}

export function changesToPlanned(changes: AgentOutput["changes"]): PlannedChange[] {
  return changes.map(({ file_path, search, replace }) => ({ path: file_path, search, replace }));
}

/** Same as changesToPlanned, typed for the fixes.planned_changes Json column. */
export function changesToPlannedJson(changes: AgentOutput["changes"]): Json {
  return changesToPlanned(changes);
}
