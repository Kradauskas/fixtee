/**
 * Download the logs of a workflow run's failed jobs, as plain text.
 * Job-level endpoint only: the run-level logs endpoint returns a zip.
 * Logs go to our DB and nowhere else; never log their contents.
 */

/** Keep at most this much of each log (the tail: Jest's failures and summary are at the end). */
export const MAX_LOG_BYTES = 2 * 1024 * 1024;

export type FailedJobLog = { jobId: number; jobName: string; log: string };

/** The slice of Octokit this module uses, so tests can pass a fake. */
export type LogsOctokit = {
  request(route: string, params: Record<string, unknown>): Promise<{ data: unknown }>;
};

type JobsPage = { total_count: number; jobs: { id: number; name: string; conclusion: string | null }[] };

export async function fetchFailedJobLogs(
  octokit: LogsOctokit,
  owner: string,
  repo: string,
  runId: number,
  onJobError: (jobId: number, err: unknown) => void = () => {},
): Promise<FailedJobLog[]> {
  const failed: JobsPage["jobs"] = [];
  for (let page = 1; ; page++) {
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs", {
      owner, repo, run_id: runId, per_page: 100, page,
    });
    const { jobs, total_count } = data as JobsPage;
    failed.push(...jobs.filter((j) => j.conclusion === "failure"));
    if (jobs.length < 100 || page * 100 >= total_count) break;
  }

  const out: FailedJobLog[] = [];
  for (const job of failed) {
    try {
      const { data } = await octokit.request("GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs", {
        owner, repo, job_id: job.id,
      });
      out.push({ jobId: job.id, jobName: job.name, log: tailBytes(toText(data), MAX_LOG_BYTES) });
    } catch (err) {
      onJobError(job.id, err);
    }
  }
  return out;
}

function toText(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  return String(data ?? "");
}

/** Last `max` bytes of `text`, starting at a line boundary. */
export function tailBytes(text: string, max: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= max) return text;
  const tail = buf.subarray(buf.length - max).toString("utf8");
  const nl = tail.indexOf("\n");
  return nl >= 0 ? tail.slice(nl + 1) : tail;
}
