import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenFixPrHooks } from "./github";
import type { FixPatch } from "./db";

const h = vi.hoisted(() => ({
  events: [] as string[],
  patches: [] as Record<string, unknown>[],
  testUnchanged: false,
}));

const RUN_URL = "https://github.com/o/r/actions/runs/99";

vi.mock("@/lib/agent/db", () => {
  return {
    confidenceToNumber: () => 0.9,
    changesToPlannedJson: () => [],
    loadError: async (id: string) => ({
      id,
      error_message: "expected 3, got 4",
      log_excerpt: "FAIL src/sum.test.ts",
      test_name: null,
      file_path: "src/sum.ts",
      line: 1,
      commit_sha: "c0ffee0000",
      run_url: RUN_URL,
      projects: { id: "p1", repo_owner: "o", repo_name: "r", installation_id: 1, default_branch: "main", llm_provider: "anthropic" },
    }),
    findQueuedFix: async () => ({ id: "fix-1" }),
    createFix: async () => ({ id: "fix-1" }),
    getProjectLlmKey: async () => "sk-test",
    updateFix: async (_id: string, patch: FixPatch) => {
      h.patches.push(patch);
      h.events.push(`db:${Object.keys(patch).sort().join(",")}`);
      return { id: "fix-1", status: patch.status ?? "analyzing" };
    },
  };
});

vi.mock("@/lib/agent/repo", () => ({
  RepoCheckoutError: class extends Error {},
  checkoutRepo: async () => ({ root: "/tmp/x", cleanup: async () => {} }),
}));

vi.mock("@/lib/agent/agent", () => ({
  AgentError: class extends Error {},
  runAgent: async () => ({
    steps: 1,
    usage: { input_tokens: 1, output_tokens: 1 },
    output: {
      title: "Fix sum",
      explanation: "e",
      root_cause: "r",
      test: { file_path: "src/sum.test.ts", content: "t" },
      changes: [{ file_path: "src/sum.ts", search: "a", replace: "b" }],
      confidence: "high",
    },
  }),
}));

vi.mock("@/lib/agent/github", () => ({
  GithubFixError: class extends Error {},
  openFixPr: async (_o: unknown, _e: string, fixId: string, hooks: OpenFixPrHooks) => {
    const branch = `autofix/${fixId}`;
    await hooks.onBranchReady?.({ branch });
    h.events.push("push:branch");
    let testCommitSha: string | null = null;
    if (!h.testUnchanged) {
      h.events.push("push:test");
      testCommitSha = "t1";
      await hooks.onTestCommitted?.({ branch, testCommitSha });
    }
    h.events.push("push:fix");
    return { branch, prNumber: 7, prUrl: "https://github.com/o/r/pull/7", testCommitSha, fixCommitSha: "f1" };
  },
}));

const { runAgent } = await import("./index");

beforeEach(() => {
  h.events.length = 0;
  h.patches.length = 0;
  h.testUnchanged = false;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("runAgent (real run, mocked IO)", () => {
  it("stores branch_name before the first push", async () => {
    await runAgent("err-1", { dryRun: false });
    const branchWrite = h.events.indexOf("db:branch_name");
    expect(branchWrite).toBeGreaterThanOrEqual(0);
    expect(branchWrite).toBeLessThan(h.events.indexOf("push:branch"));
    expect(h.patches).toContainEqual({ branch_name: "autofix/fix-1" });
  });

  it("after pushing only writes the PR columns and asks for a forward status", async () => {
    await runAgent("err-1", { dryRun: false });
    const last = h.patches.at(-1);
    expect(last).toEqual({ status: "fix_pushed", fix_commit_sha: "f1", pr_number: 7, pr_url: "https://github.com/o/r/pull/7" });
    expect(h.patches.some((p) => "green_run_url" in p)).toBe(false);
    expect(h.patches.some((p) => p.status === "failed")).toBe(false);
  });

  it("without a test commit: no test_pushed, test_commit_sha null, red_run_url = errors.run_url", async () => {
    h.testUnchanged = true;
    await runAgent("err-1", { dryRun: false });
    expect(h.events).not.toContain("push:test");
    expect(h.patches.some((p) => p.status === "test_pushed")).toBe(false);
    expect(h.patches).toContainEqual({ test_commit_sha: null, red_run_url: RUN_URL });
  });
});
