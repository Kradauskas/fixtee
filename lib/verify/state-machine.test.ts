import { describe, expect, it } from "vitest";
import type { Db } from "../db/supabase";
import {
  createVerifyDeps,
  decideOutcome,
  handleAgentCiResult,
  pickRun,
  syncFixVerification,
  type GithubClient,
} from "./state-machine";

const TEST_SHA = "aaaaaaa1111111111111111111111111111111111";
const FIX_SHA = "bbbbbbb2222222222222222222222222222222222";
const RED_RUN = "https://github.com/octo/demo/actions/runs/1";
const GREEN_RUN = "https://github.com/octo/demo/actions/runs/2";

type WorkflowRun = { conclusion: string | null; html_url: string };

type FixRow = {
  id: string;
  status: string;
  confidence: number | null;
  branch_name: string | null;
  pr_number: number | null;
  pr_url: string | null;
  test_commit_sha: string | null;
  fix_commit_sha: string | null;
  errors: { projects: { repo_owner: string; repo_name: string; installation_id: number } };
};

function fixRow(overrides: Partial<FixRow> = {}): FixRow {
  return {
    id: "fix-1",
    status: "fix_pushed",
    confidence: 0.9,
    branch_name: "autofix/error-1",
    pr_number: 42,
    pr_url: "https://github.com/octo/demo/pull/42",
    test_commit_sha: TEST_SHA,
    fix_commit_sha: FIX_SHA,
    errors: { projects: { repo_owner: "octo", repo_name: "demo", installation_id: 7 } },
    ...overrides,
  };
}

const run = (conclusion: string | null, html_url: string): WorkflowRun => ({ conclusion, html_url });

function harness(row: FixRow, runsBySha: Record<string, WorkflowRun[]> = {}) {
  const patches: Record<string, unknown>[] = [];
  const comments: { issue_number: number; body: string }[] = [];
  const graphqlCalls: { query: string; variables: Record<string, unknown> }[] = [];
  const routes: string[] = [];

  const db = {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }),
      }),
      update: (patch: Record<string, unknown>) => ({
        eq: async () => {
          patches.push(patch);
          return { error: null };
        },
      }),
    }),
  } as unknown as Db;

  const github: GithubClient = {
    async request(route, params) {
      routes.push(route);
      if (route.endsWith("/actions/runs")) {
        const sha = String(params.head_sha);
        return { data: { workflow_runs: runsBySha[sha] ?? [] } };
      }
      if (route.startsWith("POST") && route.endsWith("/comments")) {
        comments.push({ issue_number: Number(params.issue_number), body: String(params.body) });
        return { data: { id: 1 } };
      }
      if (route.startsWith("GET /repos/{owner}/{repo}/pulls/")) {
        return { data: { node_id: "PR_node_42" } };
      }
      throw new Error(`unexpected route ${route}`);
    },
    async graphql(query, variables) {
      graphqlCalls.push({ query, variables });
      return {};
    },
  };

  const deps = createVerifyDeps({ db, getClient: async () => github });
  deps.log = () => {};

  return { deps, patches, comments, graphqlCalls, routes };
}

describe("decideOutcome", () => {
  it("maps CI conclusions to outcomes", () => {
    expect(decideOutcome("success", null)).toBe("guardrail_test_passed");
    expect(decideOutcome("success", "success")).toBe("guardrail_test_passed");
    expect(decideOutcome("failure", null)).toBe("test_reproduced");
    expect(decideOutcome("failure", "failure")).toBe("fix_failed_ci");
    expect(decideOutcome("failure", "success")).toBe("verified");
    expect(decideOutcome(null, null)).toBe("pending");
    expect(decideOutcome(null, "success")).toBe("pending");
  });
});

describe("pickRun", () => {
  it("prefers a failing run over a passing one for the same commit", () => {
    expect(pickRun([run("success", GREEN_RUN), run("failure", RED_RUN)])).toEqual({
      conclusion: "failure",
      runUrl: RED_RUN,
    });
  });

  it("treats anything that is neither success nor failure as inconclusive", () => {
    expect(pickRun([run("cancelled", RED_RUN)])).toEqual({ conclusion: null, runUrl: RED_RUN });
    expect(pickRun([])).toEqual({ conclusion: null, runUrl: null });
  });
});

describe("syncFixVerification", () => {
  it("verifies a red test and a green fix, comments and marks the PR ready for review", async () => {
    const h = harness(fixRow(), {
      [TEST_SHA]: [run("failure", RED_RUN)],
      [FIX_SHA]: [run("success", GREEN_RUN)],
    });

    const result = await syncFixVerification("fix-1", h.deps);

    expect(result).toMatchObject({
      status: "verified",
      outcome: "verified",
      testRunUrl: RED_RUN,
      fixRunUrl: GREEN_RUN,
      commented: true,
      markedReadyForReview: true,
    });
    expect(h.patches).toEqual([
      { status: "verified", red_run_url: RED_RUN, green_run_url: GREEN_RUN },
    ]);

    expect(h.comments).toHaveLength(1);
    expect(h.comments[0].issue_number).toBe(42);
    expect(h.comments[0].body).toContain("Fixtee verified this fix");
    expect(h.comments[0].body).toContain(RED_RUN);
    expect(h.comments[0].body).toContain(GREEN_RUN);
    expect(h.comments[0].body).toContain("aaaaaaa");
    expect(h.comments[0].body).toContain("bbbbbbb");
    expect(h.comments[0].body).toContain("90%");

    expect(h.graphqlCalls).toHaveLength(1);
    expect(h.graphqlCalls[0].query).toContain("markPullRequestReadyForReview");
    expect(h.graphqlCalls[0].variables).toEqual({ pullRequestId: "PR_node_42" });
  });

  it("fails the fix when the reproduction test passes without it, and keeps the PR a draft", async () => {
    const h = harness(fixRow(), {
      [TEST_SHA]: [run("success", RED_RUN)],
      [FIX_SHA]: [run("success", GREEN_RUN)],
    });

    const result = await syncFixVerification("fix-1", h.deps);

    expect(result).toMatchObject({
      status: "failed",
      outcome: "guardrail_test_passed",
      commented: true,
      markedReadyForReview: false,
    });
    expect(h.patches).toEqual([{ status: "failed", red_run_url: RED_RUN }]);
    expect(h.comments[0].body).toContain("could not verify this fix");
    expect(h.comments[0].body).toContain("passed without the fix");
    expect(h.comments[0].body).toContain("stays a draft");
    expect(h.graphqlCalls).toEqual([]);
  });

  it("fails the fix when the test is red but CI is still red on the fix commit", async () => {
    const h = harness(fixRow(), {
      [TEST_SHA]: [run("failure", RED_RUN)],
      [FIX_SHA]: [run("failure", GREEN_RUN)],
    });

    const result = await syncFixVerification("fix-1", h.deps);

    expect(result).toMatchObject({
      status: "failed",
      outcome: "fix_failed_ci",
      commented: true,
      markedReadyForReview: false,
    });
    expect(h.patches).toEqual([{ status: "failed", red_run_url: RED_RUN }]);
    expect(h.comments[0].body).toContain("could not verify this fix");
    expect(h.comments[0].body).toContain("stays a draft");
    expect(h.graphqlCalls).toEqual([]);
  });

  it("keeps the fix at fix_pushed while the fix commit has no finished run", async () => {
    const h = harness(fixRow({ status: "test_pushed" }), { [TEST_SHA]: [run("failure", RED_RUN)] });

    const result = await syncFixVerification("fix-1", h.deps);

    expect(result).toMatchObject({
      status: "fix_pushed",
      outcome: "test_reproduced",
      commented: false,
    });
    expect(h.patches).toEqual([{ status: "fix_pushed", red_run_url: RED_RUN }]);
    expect(h.comments).toEqual([]);
    expect(h.graphqlCalls).toEqual([]);
  });

  it("writes nothing while no run has finished yet", async () => {
    const h = harness(fixRow());

    const result = await syncFixVerification("fix-1", h.deps);

    expect(result).toMatchObject({ status: "fix_pushed", outcome: "pending", commented: false });
    expect(h.patches).toEqual([]);
    expect(h.comments).toEqual([]);
  });

  it("does not comment twice when the fix is already settled", async () => {
    const h = harness(fixRow({ status: "verified" }), {
      [TEST_SHA]: [run("failure", RED_RUN)],
      [FIX_SHA]: [run("success", GREEN_RUN)],
    });

    const result = await syncFixVerification("fix-1", h.deps);

    expect(result).toMatchObject({
      status: "verified",
      commented: false,
      markedReadyForReview: false,
    });
    expect(h.patches).toEqual([]);
    expect(h.comments).toEqual([]);
    expect(h.graphqlCalls).toEqual([]);
  });
});

describe("handleAgentCiResult", () => {
  it("accepts conclusions straight from a workflow_run webhook", async () => {
    const h = harness(fixRow());

    const result = await handleAgentCiResult(
      {
        fixId: "fix-1",
        testConclusion: "failure",
        fixConclusion: "success",
        testRunUrl: RED_RUN,
        fixRunUrl: GREEN_RUN,
      },
      h.deps,
    );

    expect(result.status).toBe("verified");
    expect(h.routes).not.toContain("GET /repos/{owner}/{repo}/actions/runs");
    expect(h.graphqlCalls).toHaveLength(1);
  });

  it("still records the status when the fix has no pull request yet", async () => {
    const h = harness(fixRow({ pr_number: null, pr_url: null }));

    const result = await handleAgentCiResult(
      {
        fixId: "fix-1",
        testConclusion: "failure",
        fixConclusion: "success",
        testRunUrl: RED_RUN,
        fixRunUrl: GREEN_RUN,
      },
      h.deps,
    );

    expect(result).toMatchObject({
      status: "verified",
      commented: false,
      markedReadyForReview: false,
    });
    expect(h.patches).toEqual([
      { status: "verified", red_run_url: RED_RUN, green_run_url: GREEN_RUN },
    ]);
    expect(h.comments).toEqual([]);
    expect(h.graphqlCalls).toEqual([]);
  });

  it("reads the embedded error and project whether they arrive as objects or arrays", async () => {
    const nested = fixRow();
    const asArrays = {
      ...nested,
      errors: [{ projects: [nested.errors.projects] }],
    } as unknown as FixRow;
    const h = harness(asArrays);

    const result = await handleAgentCiResult(
      {
        fixId: "fix-1",
        testConclusion: "failure",
        fixConclusion: "success",
        testRunUrl: RED_RUN,
        fixRunUrl: GREEN_RUN,
      },
      h.deps,
    );

    expect(result.status).toBe("verified");
    expect(h.comments).toHaveLength(1);
  });

  it("throws when the fix does not exist", async () => {
    const deps = createVerifyDeps({
      db: {
        from: () => ({
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
        }),
      } as unknown as Db,
      getClient: async () => {
        throw new Error("should not be called");
      },
    });

    await expect(
      handleAgentCiResult(
        { fixId: "missing", testConclusion: "failure", fixConclusion: "success" },
        deps,
      ),
    ).rejects.toThrow("fix missing not found");
  });
});
