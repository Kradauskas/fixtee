import { createHash } from "node:crypto";
import type { ParsedFailure } from "./parse-jest";

/**
 * Stable identity of a CI failure within a project, used to dedupe `errors` rows.
 * Excludes the line number (shifts with unrelated edits) and the message (may contain ids/timestamps).
 * Parts are joined with a separator so ("ab", "c") and ("a", "bc") can't collide.
 */
export function fingerprint(
  projectId: string,
  failure: Pick<ParsedFailure, "parsed" | "filePath" | "testName" | "errorType">,
  workflowName: string | null,
  jobName: string,
): string {
  const parts = failure.parsed
    ? [projectId, failure.filePath, failure.testName, failure.errorType]
    : [projectId, workflowName, jobName, "unparsed"];
  return createHash("sha256")
    .update(parts.map((p) => p ?? "").join("\u0000"))
    .digest("hex");
}
