import { describe, expect, it } from "vitest";
import type { Db } from "../db/supabase";
import {
  createVerifyDeps,
  decideOutcome,
  handleAgentCiResult,
  NON_TERMINAL_STATUSES,
  normalizeConclusion,
  pickRun,
  syncFixVerification,
  verifyFixByBranch,
  type GithubClient,
  type VerificationResult,
} from "./state-machine";
import { handleVerifyRequest } from "../../app/api/verify/route";

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
  red_run_url: string | null;
  green_run_url: string | null;
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
    red_run_url: null,
    green_run_url: null,
    errors: { projects: { repo_owner: "octo", repo_name: "demo", installation_id: 7 } },
    ...overrides,
  };
}

const run = (conclusion: string | null, html_url: string): WorkflowRun => ({ conclusion, html_url });

type Filter = [string, unknown];

type SelectBuilder = {
  eq: (column: string, value: unknown) => SelectBuilder;
  in: (column: string, values: unknown) => SelectBuilder;
  order: () => SelectBuilder;
  limit: () => SelectBuilder;
  maybeSingle: () => Promise<{ data: unknown; error: null }>;
};

function selectBuilder(data: unknown, filters: Filter[]): SelectBuilder {
  const builder: SelectBuilder = {
    eq: (column, value) => {
      filters.push([column, value]);
      return builder;
    },
    in: (column, values) => {
      filters.push([column, values]);
      return builder;
    },
    order: () => builder,
    limit: () => builder,
    maybeSingle: async () => ({ data, error: null }),
  };
  return builder;
}

type UpdateBuilder = {
  in: (column: string, values: unknown) => UpdateBuilder;
  select: (columns: string) => Promise<{ data: { id: string }[]; error: null }>;
};

function updateBuilder(
  patch: Record<string, unknown>,
  patches: Record<string, unknown>[],
  filters: Filter[],
  guardLoses: boolean,
): UpdateBuilder {
  let guarded = false;
  const self: UpdateBuilder = {
    in: (column, values) => {
      guarded = true;
      filters.push([column, values]);
      return self;
    },
    select: async () => {
      if (guarded && guardLoses) return { data: [], error: null };
      patches.push(patch);
      return { data: [{ id: "fix-1" }], error: null };
    },
  };
  return self;
}

function harness(
  row: FixRow | null,
  runsBySha: Record<string, WorkflowRun[]> = {},
  branchMatch: { id: string } | null | undefined = undefined,
  guardLoses = false,
) {
  const matchedFix = branchMatch === undefined ? (row ? { id: row.id } : null) : branchMatch;

  const updateFilters: Filter[] = [];
  const patches: Record<string, unknown>[] = [];
  const comments: { issue_number: number; body: string }[] = [];
  const graphqlCalls: { query: string; variables: Record<string, unknown> }[] = [];
  const routes: string[] = [];
  const runLookups: string[] = [];
  const lookupFilters: Filter[] = [];
  const loadFilters: Filter[] = [];

  const db = {
    from: () => ({
      select: (columns: string) =>
        columns.includes("errors!inner")
          ? selectBuilder(matchedFix, lookupFilters)
          : selectBuilder(row, loadFilters),
      update: (patch: Record<string, unknown>) => ({
        eq: () => updateBuilder(patch, patches, updateFilters, guardLoses),
      }),
    }),
  } as unknown as Db;

  const github: GithubClient = {
    async request(route, params) {
      routes.push(route);
      if (route.endsWith("/actions/runs")) {
        const sha = String(params.head_sha);
        runLookups.push(sha);
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

  return {
    deps,
    patches,
    comments,
    graphqlCalls,
    routes,
    runLookups,
    lookupFilters,
    loadFilters,
    updateFilters,
  };
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

describe("syncFixVerification without a test commit", () => {
  const ORIGINAL_RED = "https://github.com/octo/demo/actions/runs/7";

  const singleCommitFix = (overrides: Partial<FixRow> = {}) =>
    fixRow({
      status: "fix_pushed",
      test_commit_sha: null,
      red_run_url: ORIGINAL_RED,
      ...overrides,
    });

  it("verifies on the fix commit alone, preserving the existing red run", async () => {
    const h = harness(singleCommitFix(), { [FIX_SHA]: [run("success", GREEN_RUN)] });

    const result = await syncFixVerification("fix-1", h.deps);

    expect(result).toMatchObject({
      status: "verified",
      outcome: "verified",
      testRunUrl: ORIGINAL_RED,
      fixRunUrl: GREEN_RUN,
      commented: true,
      markedReadyForReview: true,
    });
    expect(h.patches).toEqual([{ status: "verified", green_run_url: GREEN_RUN }]);
    expect(h.runLookups).toEqual([FIX_SHA]);
  });

  it("links the original failing run and the fix commit in the comment", async () => {
    const h = harness(singleCommitFix(), { [FIX_SHA]: [run("success", GREEN_RUN)] });

    await syncFixVerification("fix-1", h.deps);

    expect(h.comments).toHaveLength(1);
    const body = h.comments[0].body;
    expect(body).toContain("Fixtee verified this fix");
    expect(body).toContain("already reproduced this failure");
    expect(body).toContain(ORIGINAL_RED);
    expect(body).toContain(GREEN_RUN);
    expect(body).toContain("bbbbbbb");
    expect(body).not.toContain("aaaaaaa");

    expect(h.graphqlCalls).toHaveLength(1);
    expect(h.graphqlCalls[0].query).toContain("markPullRequestReadyForReview");
    expect(h.graphqlCalls[0].variables).toEqual({ pullRequestId: "PR_node_42" });
  });

  it("fails and leaves the PR a draft when the fix commit is red", async () => {
    const h = harness(singleCommitFix(), { [FIX_SHA]: [run("failure", GREEN_RUN)] });

    const result = await syncFixVerification("fix-1", h.deps);

    expect(result).toMatchObject({
      status: "failed",
      outcome: "fix_failed_ci",
      testRunUrl: ORIGINAL_RED,
      commented: true,
      markedReadyForReview: false,
    });
    expect(h.patches).toEqual([{ status: "failed" }]);
    expect(h.comments[0].body).toContain("could not verify this fix");
    expect(h.comments[0].body).toContain("stays a draft");
    expect(h.graphqlCalls).toEqual([]);
  });

  it("stays at fix_pushed while the fix commit has no finished run", async () => {
    const h = harness(singleCommitFix());

    const result = await syncFixVerification("fix-1", h.deps);

    expect(result).toMatchObject({
      status: "fix_pushed",
      outcome: "test_reproduced",
      testRunUrl: ORIGINAL_RED,
      commented: false,
      markedReadyForReview: false,
    });
    expect(h.patches).toEqual([]);
    expect(h.comments).toEqual([]);
    expect(h.graphqlCalls).toEqual([]);
    expect(h.runLookups).toEqual([FIX_SHA]);
  });

  it("stays put while the agent is still analyzing and no fix commit exists", async () => {
    const h = harness(
      singleCommitFix({ status: "analyzing", fix_commit_sha: null, red_run_url: ORIGINAL_RED }),
      { [FIX_SHA]: [run("success", GREEN_RUN)] },
    );

    const result = await syncFixVerification("fix-1", h.deps);

    expect(result).toMatchObject({ status: "analyzing", outcome: "pending" });
    expect(h.patches).toEqual([]);
    expect(h.comments).toEqual([]);
    expect(h.graphqlCalls).toEqual([]);
    expect(h.runLookups).toEqual([]);
  });

  it("verifies through verifyFixByBranch, the path ingest uses", async () => {
    const h = harness(singleCommitFix(), { [FIX_SHA]: [run("success", GREEN_RUN)] });

    const result = await verifyFixByBranch(
      { projectId: "project-1", branchName: "autofix/error-1" },
      h.deps,
    );

    expect(result).toMatchObject({
      status: "verified",
      outcome: "verified",
      testRunUrl: ORIGINAL_RED,
      fixRunUrl: GREEN_RUN,
      markedReadyForReview: true,
    });
    expect(h.patches).toEqual([{ status: "verified", green_run_url: GREEN_RUN }]);
    expect(h.runLookups).toEqual([FIX_SHA]);
    expect(h.comments[0].body).toContain(ORIGINAL_RED);
    expect(h.comments[0].body).toContain(GREEN_RUN);
  });

  it("never treats a missing test commit as a guardrail failure", async () => {
    const h = harness(singleCommitFix({ red_run_url: null }), {
      [FIX_SHA]: [run("success", GREEN_RUN)],
    });

    const result = await syncFixVerification("fix-1", h.deps);

    expect(result.status).toBe("verified");
    expect(result.outcome).toBe("verified");
  });
});

describe("settling a fix exactly once", () => {
  it("guards a terminal write with the non-terminal status filter", async () => {
    const h = harness(fixRow(), {
      [TEST_SHA]: [run("failure", RED_RUN)],
      [FIX_SHA]: [run("success", GREEN_RUN)],
    });

    await syncFixVerification("fix-1", h.deps);

    expect(h.updateFilters).toContainEqual(["status", NON_TERMINAL_STATUSES]);
  });

  it("writes a non-terminal status without the guard", async () => {
    const h = harness(fixRow({ status: "test_pushed" }), { [TEST_SHA]: [run("failure", RED_RUN)] });

    await syncFixVerification("fix-1", h.deps);

    expect(h.patches).toEqual([{ status: "fix_pushed", red_run_url: RED_RUN }]);
    expect(h.updateFilters).toEqual([]);
  });

  it("does not comment or mark ready when another run settled the fix first", async () => {
    const h = harness(
      fixRow(),
      { [TEST_SHA]: [run("failure", RED_RUN)], [FIX_SHA]: [run("success", GREEN_RUN)] },
      undefined,
      true,
    );

    const result = await syncFixVerification("fix-1", h.deps);

    expect(result).toMatchObject({
      status: "verified",
      outcome: "verified",
      commented: false,
      markedReadyForReview: false,
    });
    expect(h.patches).toEqual([]);
    expect(h.comments).toEqual([]);
    expect(h.graphqlCalls).toEqual([]);
  });

  it("does not comment twice when a failure races to settle the fix", async () => {
    const h = harness(
      fixRow(),
      { [TEST_SHA]: [run("failure", RED_RUN)], [FIX_SHA]: [run("failure", GREEN_RUN)] },
      undefined,
      true,
    );

    const result = await syncFixVerification("fix-1", h.deps);

    expect(result).toMatchObject({ status: "failed", commented: false });
    expect(h.comments).toEqual([]);
  });
});

describe("webhook run hint", () => {
  it("uses the hint when GitHub has not listed the run yet", async () => {
    const h = harness(fixRow(), { [TEST_SHA]: [run("failure", RED_RUN)] });

    const result = await syncFixVerification("fix-1", h.deps, {
      headSha: FIX_SHA,
      conclusion: "success",
      runUrl: GREEN_RUN,
    });

    expect(result).toMatchObject({
      status: "verified",
      outcome: "verified",
      fixRunUrl: GREEN_RUN,
      markedReadyForReview: true,
    });
    expect(h.patches).toEqual([
      { status: "verified", red_run_url: RED_RUN, green_run_url: GREEN_RUN },
    ]);
  });

  it("prefers what GitHub reports over the hint", async () => {
    const h = harness(fixRow(), {
      [TEST_SHA]: [run("failure", RED_RUN)],
      [FIX_SHA]: [run("failure", GREEN_RUN)],
    });

    const result = await syncFixVerification("fix-1", h.deps, {
      headSha: FIX_SHA,
      conclusion: "success",
      runUrl: GREEN_RUN,
    });

    expect(result.status).toBe("failed");
  });

  it("ignores a hint for a different commit, or one with no usable conclusion", async () => {
    const other = harness(fixRow(), { [TEST_SHA]: [run("failure", RED_RUN)] });
    const ignored = await syncFixVerification("fix-1", other.deps, {
      headSha: "ccccccc3333333333333333333333333333333333",
      conclusion: "success",
      runUrl: GREEN_RUN,
    });
    expect(ignored).toMatchObject({ status: "fix_pushed", outcome: "test_reproduced" });

    const cancelled = harness(fixRow(), { [TEST_SHA]: [run("failure", RED_RUN)] });
    const result = await syncFixVerification("fix-1", cancelled.deps, {
      headSha: FIX_SHA,
      conclusion: "cancelled",
      runUrl: GREEN_RUN,
    });
    expect(result).toMatchObject({ status: "fix_pushed", outcome: "test_reproduced" });
  });

  it("passes the hint through verifyFixByBranch", async () => {
    const h = harness(fixRow(), { [TEST_SHA]: [run("failure", RED_RUN)] });

    const result = await verifyFixByBranch(
      {
        projectId: "project-1",
        branchName: "autofix/error-1",
        headSha: FIX_SHA,
        conclusion: "success",
        runUrl: GREEN_RUN,
      },
      h.deps,
    );

    expect(result).toMatchObject({ status: "verified", markedReadyForReview: true });
  });
});

describe("normalizeConclusion", () => {
  it("accepts only the two conclusions the state machine acts on", () => {
    expect(normalizeConclusion("success")).toBe("success");
    expect(normalizeConclusion("failure")).toBe("failure");
    expect(normalizeConclusion("cancelled")).toBeNull();
    expect(normalizeConclusion("timed_out")).toBeNull();
    expect(normalizeConclusion(null)).toBeNull();
    expect(normalizeConclusion(undefined)).toBeNull();
  });
});

describe("verifyFixByBranch", () => {
  it("verifies the fix that owns the branch", async () => {
    const h = harness(fixRow(), {
      [TEST_SHA]: [run("failure", RED_RUN)],
      [FIX_SHA]: [run("success", GREEN_RUN)],
    });

    const result = await verifyFixByBranch(
      { projectId: "project-1", branchName: "autofix/error-1" },
      h.deps,
    );

    expect(result).toMatchObject({
      status: "verified",
      outcome: "verified",
      markedReadyForReview: true,
    });
    expect(h.patches).toEqual([
      { status: "verified", red_run_url: RED_RUN, green_run_url: GREEN_RUN },
    ]);
    expect(h.comments).toHaveLength(1);
    expect(h.graphqlCalls).toHaveLength(1);
  });

  it("looks the fix up by project and branch, and only among non-terminal statuses", async () => {
    const h = harness(fixRow(), { [TEST_SHA]: [run("failure", RED_RUN)] });

    await verifyFixByBranch({ projectId: "project-1", branchName: "autofix/error-1" }, h.deps);

    expect(h.lookupFilters).toContainEqual(["errors.project_id", "project-1"]);
    expect(h.lookupFilters).toContainEqual(["branch_name", "autofix/error-1"]);

    const statusFilter = h.lookupFilters.find(([column]) => column === "status");
    expect(statusFilter).toBeDefined();
    expect(statusFilter?.[1]).toEqual(NON_TERMINAL_STATUSES);
    expect(NON_TERMINAL_STATUSES).not.toContain("verified");
    expect(NON_TERMINAL_STATUSES).not.toContain("failed");
    expect(NON_TERMINAL_STATUSES).toContain("fix_pushed");
  });

  it("returns null when no fix on that branch is awaiting verification", async () => {
    const h = harness(fixRow(), { [TEST_SHA]: [run("failure", RED_RUN)] }, null);

    const result = await verifyFixByBranch(
      { projectId: "project-1", branchName: "autofix/already-done" },
      h.deps,
    );

    expect(result).toBeNull();
    expect(h.patches).toEqual([]);
    expect(h.comments).toEqual([]);
    expect(h.graphqlCalls).toEqual([]);
    expect(h.routes).toEqual([]);
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

const FIX_UUID = "55555555-5555-4555-8555-555555555555";
const PROJECT_UUID = "66666666-6666-4666-8666-666666666666";

const verifiedResult: VerificationResult = {
  status: "verified",
  outcome: "verified",
  testRunUrl: RED_RUN,
  fixRunUrl: GREEN_RUN,
  commented: true,
  markedReadyForReview: true,
};

function routeHarness(user: { id: string } | null, visible: boolean) {
  const queried: string[] = [];
  const syncCalls: string[] = [];
  const branchCalls: unknown[] = [];

  const supabase = {
    auth: { getUser: async () => ({ data: { user }, error: null }) },
    from: (table: string) => {
      queried.push(table);
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: visible ? { id: "row" } : null, error: null }),
          }),
        }),
      };
    },
  } as unknown as Db;

  return {
    queried,
    syncCalls,
    branchCalls,
    deps: {
      getUserClient: async () => supabase,
      syncFix: async (fixId: string) => {
        syncCalls.push(fixId);
        return verifiedResult;
      },
      verifyBranch: async (ref: unknown) => {
        branchCalls.push(ref);
        return verifiedResult;
      },
    },
  };
}

const jsonBody = (value: unknown) => ({ json: async () => value });

describe("POST /api/verify", () => {
  it("refuses an anonymous caller before doing anything", async () => {
    const h = routeHarness(null, true);

    const response = await handleVerifyRequest(h.deps, jsonBody({ fixId: FIX_UUID }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ message: "not signed in" });
    expect(h.queried).toEqual([]);
    expect(h.syncCalls).toEqual([]);
  });

  it("verifies a fix the caller can see", async () => {
    const h = routeHarness({ id: "user-1" }, true);

    const response = await handleVerifyRequest(h.deps, jsonBody({ fixId: FIX_UUID }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "verified",
      testRunUrl: RED_RUN,
      fixRunUrl: GREEN_RUN,
    });
    expect(h.queried).toEqual(["fixes"]);
    expect(h.syncCalls).toEqual([FIX_UUID]);
  });

  it("hides a fix belonging to someone else behind a 404", async () => {
    const h = routeHarness({ id: "user-1" }, false);

    const response = await handleVerifyRequest(h.deps, jsonBody({ fixId: FIX_UUID }));

    expect(response.status).toBe(404);
    expect(h.syncCalls).toEqual([]);
  });

  it("checks the project before verifying by branch, and forwards the hint", async () => {
    const h = routeHarness({ id: "user-1" }, true);

    const response = await handleVerifyRequest(
      h.deps,
      jsonBody({
        projectId: PROJECT_UUID,
        branchName: "autofix/error-1",
        headSha: FIX_SHA,
        conclusion: "success",
        runUrl: GREEN_RUN,
      }),
    );

    expect(response.status).toBe(200);
    expect(h.queried).toEqual(["projects"]);
    expect(h.branchCalls).toEqual([
      {
        projectId: PROJECT_UUID,
        branchName: "autofix/error-1",
        headSha: FIX_SHA,
        conclusion: "success",
        runUrl: GREEN_RUN,
      },
    ]);
  });

  it("hides a project belonging to someone else behind a 404", async () => {
    const h = routeHarness({ id: "user-1" }, false);

    const response = await handleVerifyRequest(
      h.deps,
      jsonBody({ projectId: PROJECT_UUID, branchName: "autofix/error-1" }),
    );

    expect(response.status).toBe(404);
    expect(h.branchCalls).toEqual([]);
  });

  it("answers 404 for an id that is not a uuid, without querying", async () => {
    const h = routeHarness({ id: "user-1" }, true);

    const response = await handleVerifyRequest(h.deps, jsonBody({ fixId: "not-a-uuid" }));

    expect(response.status).toBe(404);
    expect(h.queried).toEqual([]);
    expect(h.syncCalls).toEqual([]);
  });

  it("rejects a body that names neither a fix nor a branch", async () => {
    const h = routeHarness({ id: "user-1" }, true);

    const response = await handleVerifyRequest(h.deps, jsonBody({ nope: true }));

    expect(response.status).toBe(400);
    expect(h.queried).toEqual([]);
  });
});
