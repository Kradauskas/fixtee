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

export type FixStatus = FixRow["status"];

export type FixPatch = Pick<
  TablesUpdate<"fixes">,
  | "status"
  | "red_run_url"
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

/**
 * Order of the fix lifecycle. Other writers (verification) move a fix forward too, so the agent
 * only ever moves the status to a later step, never back. "failed" is terminal and is only
 * allowed before the fix is pushed; it never replaces fix_pushed/verified.
 */
const STATUS_ORDER: readonly FixStatus[] = ["queued", "analyzing", "test_pushed", "test_failed", "fix_pushed", "verified"];

/** Statuses from which a fix may move to `target` (strictly earlier steps; "failed" is never left). */
export function statusesBefore(target: FixStatus): FixStatus[] {
  if (target === "failed") return STATUS_ORDER.slice(0, STATUS_ORDER.indexOf("fix_pushed"));
  return STATUS_ORDER.slice(0, STATUS_ORDER.indexOf(target));
}

/** True if a fix currently in `current` may be moved to `next`. */
export function canAdvanceStatus(current: FixStatus, next: FixStatus): boolean {
  return statusesBefore(next).includes(current);
}

/**
 * Updates selected columns of a fixes row and returns the row as it is afterwards.
 *
 * Plain columns are written as given. The columns other writers also own are guarded,
 * with the condition in the UPDATE itself so a concurrent writer cannot be overwritten:
 * - status only moves forward (see statusesBefore); otherwise it is left as is,
 * - red_run_url is only set while it is still empty.
 * green_run_url is never written by the agent.
 */
export async function updateFix(fixId: string, patch: FixPatch): Promise<FixRow> {
  const { status, red_run_url, ...plain } = patch;
  const fail = (msg: string) => new Error(`updateFix(${fixId}): ${msg}`);

  if (Object.keys(plain).length > 0) {
    const { data, error } = await db().from("fixes").update(plain).eq("id", fixId).select().maybeSingle();
    if (error) throw fail(error.message);
    if (!data) throw fail("fix not found");
  }

  if (red_run_url !== undefined) {
    const { error } = await db()
      .from("fixes")
      .update({ red_run_url })
      .eq("id", fixId)
      .is("red_run_url", null)
      .select()
      .maybeSingle();
    if (error) throw fail(error.message);
  }

  if (status !== undefined) {
    const { error } = await db()
      .from("fixes")
      .update({ status })
      .eq("id", fixId)
      .in("status", statusesBefore(status))
      .select()
      .maybeSingle();
    if (error) throw fail(error.message);
  }

  const { data, error } = await db().from("fixes").select().eq("id", fixId).maybeSingle();
  if (error) throw fail(error.message);
  if (!data) throw fail("fix not found");
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
