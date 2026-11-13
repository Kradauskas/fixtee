/**
 * Task 6: record a parsed CI failure in `errors` (dedup by fingerprint) and decide whether to start
 * the agent. Database access goes through ErrorStore so the logic is unit-testable.
 */
import type { Db } from "../db/supabase";

/** Fix statuses that mean "work in progress": don't start another agent for the same error. */
export const ACTIVE_FIX_STATUSES = ["queued", "analyzing", "test_pushed", "test_failed", "fix_pushed"] as const;

const UNIQUE_VIOLATION = "23505";

export type ErrorRecord = {
  projectId: string;
  fingerprint: string;
  testName: string | null;
  errorType: string | null;
  errorMessage: string | null;
  logExcerpt: string;
  filePath: string | null;
  line: number | null;
  commitSha: string;
  workflowRunId: number;
  runUrl: string;
  parsed: boolean;
};

export type ErrorStore = {
  /** Insert a new error. Returns its id, or null if (project_id, fingerprint) already exists. */
  insertError(e: ErrorRecord): Promise<string | null>;
  /** Bump an existing error (occurrences + 1, latest run details). Returns its id. */
  bumpError(e: ErrorRecord): Promise<string>;
  hasActiveFix(errorId: string): Promise<boolean>;
  /** Insert the `queued` fixes row that the agent picks up. */
  queueFix(errorId: string): Promise<string>;
};

export type RecordResult = { errorId: string; isNew: boolean; fixId: string | null };

/**
 * Upsert the error, then queue a fix if the error is new or has no fix in progress.
 * Returns fixId when a fix was queued (caller then starts the agent).
 */
export async function recordError(store: ErrorStore, e: ErrorRecord): Promise<RecordResult> {
  const insertedId = await store.insertError(e);
  const isNew = insertedId !== null;
  const errorId = insertedId ?? (await store.bumpError(e));

  if (!isNew && (await store.hasActiveFix(errorId))) return { errorId, isNew, fixId: null };
  const fixId = await store.queueFix(errorId);
  return { errorId, isNew, fixId };
}

export function createErrorStore(db: Db): ErrorStore {
  return {
    async insertError(e) {
      const { data, error } = await db
        .from("errors")
        .insert({
          project_id: e.projectId,
          fingerprint: e.fingerprint,
          test_name: e.testName,
          error_type: e.errorType,
          error_message: e.errorMessage,
          log_excerpt: e.logExcerpt,
          file_path: e.filePath,
          line: e.line,
          commit_sha: e.commitSha,
          workflow_run_id: e.workflowRunId,
          run_url: e.runUrl,
          parsed: e.parsed,
        })
        .select("id")
        .single();
      if (error?.code === UNIQUE_VIOLATION) return null;
      if (error) throw new Error(`insert error failed: ${error.message}`);
      return data.id;
    },

    async bumpError(e) {
      const { data: row, error: readErr } = await db
        .from("errors")
        .select("id, occurrences")
        .eq("project_id", e.projectId)
        .eq("fingerprint", e.fingerprint)
        .single();
      if (readErr) throw new Error(`read error failed: ${readErr.message}`);
      // Read-modify-write: two simultaneous bumps can undercount by one. Fine for a counter.
      const { error } = await db
        .from("errors")
        .update({
          occurrences: row.occurrences + 1,
          last_seen: new Date().toISOString(),
          commit_sha: e.commitSha,
          workflow_run_id: e.workflowRunId,
          run_url: e.runUrl,
          log_excerpt: e.logExcerpt,
          line: e.line,
          error_message: e.errorMessage,
        })
        .eq("id", row.id);
      if (error) throw new Error(`bump error failed: ${error.message}`);
      return row.id;
    },

    async hasActiveFix(errorId) {
      const { count, error } = await db
        .from("fixes")
        .select("id", { count: "exact", head: true })
        .eq("error_id", errorId)
        .in("status", [...ACTIVE_FIX_STATUSES]);
      if (error) throw new Error(`fix lookup failed: ${error.message}`);
      return (count ?? 0) > 0;
    },

    async queueFix(errorId) {
      const { data, error } = await db
        .from("fixes")
        .insert({ error_id: errorId, status: "queued" })
        .select("id")
        .single();
      if (error) throw new Error(`queue fix failed: ${error.message}`);
      return data.id;
    },
  };
}
