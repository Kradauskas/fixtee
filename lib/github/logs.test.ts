import { describe, expect, it } from "vitest";
import { type LogsOctokit, fetchFailedJobLogs, tailBytes } from "./logs";

function fakeOctokit(jobs: { id: number; name: string; conclusion: string | null }[], logs: Record<number, unknown>) {
  const calls: string[] = [];
  const octokit: LogsOctokit = {
    async request(route, params) {
      calls.push(route.includes("/logs") ? `logs ${params.job_id}` : `jobs page ${params.page}`);
      if (route.endsWith("/jobs")) return { data: { total_count: jobs.length, jobs } };
      const log = logs[params.job_id as number];
      if (log instanceof Error) throw log;
      return { data: log };
    },
  };
  return { octokit, calls };
}

describe("fetchFailedJobLogs", () => {
  it("downloads only failed jobs, via the job-level endpoint", async () => {
    const { octokit, calls } = fakeOctokit(
      [
        { id: 1, name: "lint", conclusion: "success" },
        { id: 2, name: "test", conclusion: "failure" },
        { id: 3, name: "build", conclusion: "cancelled" },
      ],
      { 2: "the log" },
    );
    expect(await fetchFailedJobLogs(octokit, "o", "r", 9)).toEqual([{ jobId: 2, jobName: "test", log: "the log" }]);
    expect(calls).toEqual(["jobs page 1", "logs 2"]);
  });

  it("decodes binary responses and skips jobs whose log download fails", async () => {
    const errors: number[] = [];
    const { octokit } = fakeOctokit(
      [
        { id: 1, name: "a", conclusion: "failure" },
        { id: 2, name: "b", conclusion: "failure" },
      ],
      { 1: new Error("410 gone"), 2: new TextEncoder().encode("bytes").buffer },
    );
    const out = await fetchFailedJobLogs(octokit, "o", "r", 9, (id) => errors.push(id));
    expect(out).toEqual([{ jobId: 2, jobName: "b", log: "bytes" }]);
    expect(errors).toEqual([1]);
  });
});

describe("tailBytes", () => {
  it("keeps the end of the log, starting at a line boundary", () => {
    expect(tailBytes("aaaa\nbbbb\ncccc", 7)).toBe("cccc");
    expect(tailBytes("short", 100)).toBe("short");
  });
});
