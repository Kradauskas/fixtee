import { describe, expect, it } from "vitest";
import type { Db } from "../../../lib/db/supabase";
import { testFileName } from "../../../components/dashboard/demo-data";
import {
  failureKind,
  fixExplanation,
  githubRepoUrl,
  guardrailReason,
  matchesFilter,
  matchesSearch,
  metrics,
  parsePlannedChanges,
  proofSteps,
  redProven,
  statusLabel,
  testPanelState,
  type DashboardError,
  type DashboardFix,
  type Item,
} from "../../../components/dashboard/types";
import { handleDashboardRequest } from "./route";
import { handleSetProjectKey } from "../projects/[id]/keys/route";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const ERROR_ID = "22222222-2222-4222-8222-222222222222";
const FIX_ID = "33333333-3333-4333-8333-333333333333";

type Result = { data: unknown; error: { message: string } | null };

const ok = (data: unknown): Result => ({ data, error: null });
const fails = (message: string): Result => ({ data: null, error: { message } });

type Builder = {
  select: () => Builder;
  eq: () => Builder;
  in: () => Builder;
  order: () => Builder;
  maybeSingle: () => Promise<Result>;
  then: (
    resolve: (value: Result) => unknown,
    reject?: (reason: unknown) => unknown,
  ) => Promise<unknown>;
};

function builder(result: Result): Builder {
  const self: Builder = {
    select: () => self,
    eq: () => self,
    in: () => self,
    order: () => self,
    maybeSingle: async () => result,
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return self;
}

type TableResults = Partial<Record<string, Result>>;

function fakeClient(user: { id: string } | null, tables: TableResults = {}) {
  const queried: string[] = [];
  const client = {
    auth: { getUser: async () => ({ data: { user }, error: null }) },
    from: (table: string) => {
      queried.push(table);
      return builder(tables[table] ?? ok([]));
    },
  } as unknown as Db;
  return { client, queried };
}

const projectRow = {
  id: PROJECT_ID,
  repo_owner: "octo",
  repo_name: "demo",
  default_branch: "main",
  installation_id: 7,
  llm_provider: "anthropic",
  llm_key_secret_id: "44444444-4444-4444-8444-444444444444",
};

const errorRow = { id: ERROR_ID, project_id: PROJECT_ID, error_message: "boom" };

const fixRow = { id: FIX_ID, error_id: ERROR_ID, status: "verified" };

describe("GET /api/dashboard", () => {
  it("returns 401 when nobody is signed in", async () => {
    const { client, queried } = fakeClient(null);

    const response = await handleDashboardRequest({ getUserClient: async () => client });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ message: "not signed in" });
    expect(queried).toEqual([]);
  });

  it("returns the projects, errors and fixes the user can see", async () => {
    const { client, queried } = fakeClient(
      { id: "user-1" },
      {
        projects: ok([projectRow]),
        errors: ok([errorRow]),
        fixes: ok([fixRow]),
      },
    );

    const response = await handleDashboardRequest({ getUserClient: async () => client });

    expect(response.status).toBe(200);
    expect(queried).toEqual(["projects", "errors", "fixes"]);
    await expect(response.json()).resolves.toEqual({
      projects: [
        {
          id: PROJECT_ID,
          repo_owner: "octo",
          repo_name: "demo",
          default_branch: "main",
          installation_id: 7,
          llm_provider: "anthropic",
          has_llm_key: true,
        },
      ],
      errors: [errorRow],
      fixes: [fixRow],
    });
  });

  it("never exposes the vault secret id", async () => {
    const { client } = fakeClient({ id: "user-1" }, { projects: ok([projectRow]) });

    const response = await handleDashboardRequest({ getUserClient: async () => client });
    const body = await response.text();

    expect(body).not.toContain("llm_key_secret_id");
    expect(body).not.toContain(projectRow.llm_key_secret_id);
    expect(body).toContain('"has_llm_key":true');
  });

  it("reports has_llm_key false when the project has no key yet", async () => {
    const { client } = fakeClient(
      { id: "user-1" },
      { projects: ok([{ ...projectRow, llm_key_secret_id: null }]) },
    );

    const response = await handleDashboardRequest({ getUserClient: async () => client });
    const body = (await response.json()) as { projects: { has_llm_key: boolean }[] };

    expect(body.projects[0].has_llm_key).toBe(false);
  });

  it("skips the follow-up queries when the user has no projects", async () => {
    const { client, queried } = fakeClient({ id: "user-1" }, { projects: ok([]) });

    const response = await handleDashboardRequest({ getUserClient: async () => client });

    expect(response.status).toBe(200);
    expect(queried).toEqual(["projects"]);
    await expect(response.json()).resolves.toEqual({ projects: [], errors: [], fixes: [] });
  });

  it("answers 500 when a query fails", async () => {
    const { client } = fakeClient({ id: "user-1" }, { projects: fails("connection reset") });

    const response = await handleDashboardRequest({ getUserClient: async () => client });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ message: "could not load dashboard" });
  });
});

type RpcCall = { name: string; args: Record<string, unknown> };

function fakeAdminClient(rpcResult: { error: { message: string } | null } = { error: null }) {
  const calls: RpcCall[] = [];
  const client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return rpcResult;
    },
  } as unknown as Db;
  return { client, calls };
}

const body = (value: unknown) => ({ json: async () => value });

describe("POST /api/projects/[id]/keys", () => {
  it("stores the key through the service-role RPC", async () => {
    const { client } = fakeClient({ id: "user-1" }, { projects: ok({ id: PROJECT_ID }) });
    const admin = fakeAdminClient();

    const response = await handleSetProjectKey(
      { getUserClient: async () => client, getAdminClient: () => admin.client },
      body({ llmApiKey: "sk-ant-secret" }),
      PROJECT_ID,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(admin.calls).toEqual([
      {
        name: "set_project_llm_key",
        args: { p_project_id: PROJECT_ID, p_key: "sk-ant-secret" },
      },
    ]);
  });

  it("returns 401 when nobody is signed in", async () => {
    const { client } = fakeClient(null);
    const admin = fakeAdminClient();

    const response = await handleSetProjectKey(
      { getUserClient: async () => client, getAdminClient: () => admin.client },
      body({ llmApiKey: "sk-ant-secret" }),
      PROJECT_ID,
    );

    expect(response.status).toBe(401);
    expect(admin.calls).toEqual([]);
  });

  it("rejects an empty key before touching the database", async () => {
    const { client, queried } = fakeClient({ id: "user-1" });
    const admin = fakeAdminClient();

    const response = await handleSetProjectKey(
      { getUserClient: async () => client, getAdminClient: () => admin.client },
      body({ llmApiKey: "   " }),
      PROJECT_ID,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ message: "llmApiKey is required" });
    expect(queried).toEqual([]);
    expect(admin.calls).toEqual([]);
  });

  it("rejects a body that is not JSON", async () => {
    const { client } = fakeClient({ id: "user-1" });
    const admin = fakeAdminClient();

    const response = await handleSetProjectKey(
      { getUserClient: async () => client, getAdminClient: () => admin.client },
      {
        json: async () => {
          throw new Error("invalid json");
        },
      },
      PROJECT_ID,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ message: "body is not JSON" });
    expect(admin.calls).toEqual([]);
  });

  it("returns 404 for a project the user cannot see, and stores nothing", async () => {
    const { client } = fakeClient({ id: "user-1" }, { projects: ok(null) });
    const admin = fakeAdminClient();

    const response = await handleSetProjectKey(
      { getUserClient: async () => client, getAdminClient: () => admin.client },
      body({ llmApiKey: "sk-ant-secret" }),
      PROJECT_ID,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ message: "project not found" });
    expect(admin.calls).toEqual([]);
  });

  it("returns 404 for an id that is not a uuid, without querying", async () => {
    const { client, queried } = fakeClient({ id: "user-1" });
    const admin = fakeAdminClient();

    const response = await handleSetProjectKey(
      { getUserClient: async () => client, getAdminClient: () => admin.client },
      body({ llmApiKey: "sk-ant-secret" }),
      "not-a-uuid",
    );

    expect(response.status).toBe(404);
    expect(queried).toEqual([]);
    expect(admin.calls).toEqual([]);
  });

  it("does not leak the key when the RPC fails", async () => {
    const { client } = fakeClient({ id: "user-1" }, { projects: ok({ id: PROJECT_ID }) });
    const admin = fakeAdminClient({ error: { message: "permission denied" } });

    const response = await handleSetProjectKey(
      { getUserClient: async () => client, getAdminClient: () => admin.client },
      body({ llmApiKey: "sk-ant-secret" }),
      PROJECT_ID,
    );

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("sk-ant-secret");
    expect(text).toBe(JSON.stringify({ message: "could not save the key" }));
  });
});

const asError = (overrides: Partial<DashboardError>): DashboardError =>
  ({
    id: ERROR_ID,
    project_id: PROJECT_ID,
    fingerprint: "fp",
    test_name: null,
    error_type: null,
    error_message: null,
    log_excerpt: null,
    file_path: null,
    line: null,
    commit_sha: "abc1234def",
    workflow_run_id: 1,
    run_url: "https://example.test/run",
    parsed: true,
    occurrences: 1,
    first_seen: "2026-11-13T00:00:00Z",
    last_seen: "2026-11-13T00:00:00Z",
    ...overrides,
  }) as DashboardError;

const asFix = (overrides: Partial<DashboardFix>): DashboardFix =>
  ({
    id: FIX_ID,
    error_id: ERROR_ID,
    status: "queued",
    branch_name: null,
    pr_number: null,
    pr_url: null,
    test_commit_sha: null,
    fix_commit_sha: null,
    red_run_url: null,
    green_run_url: null,
    ai_reasoning: null,
    confidence: null,
    tokens_used: null,
    planned_changes: null,
    created_at: "2026-11-13T00:00:00Z",
    updated_at: "2026-11-13T00:00:00Z",
    ...overrides,
  }) as DashboardFix;

const asItem = (fix: Partial<DashboardFix>, error: Partial<DashboardError> = {}): Item => ({
  error: asError(error),
  fix: asFix(fix),
});

describe("metrics", () => {
  it("counts failures, verified fixes, guardrails and tokens", () => {
    const result = metrics([
      asItem({ status: "verified", tokens_used: 1200 }, { id: "e1" }),
      asItem({ status: "failed", tokens_used: 800 }, { id: "e2" }),
      asItem({ status: "fix_pushed", tokens_used: null }, { id: "e3" }),
    ]);

    expect(result).toEqual({ errors: 3, verified: 1, blocked: 1, tokens: 2000 });
  });

  it("is all zeroes with nothing to show", () => {
    expect(metrics([])).toEqual({ errors: 0, verified: 0, blocked: 0, tokens: 0 });
  });
});

describe("matchesSearch and matchesFilter", () => {
  const item = asItem(
    { branch_name: "autofix/err-1", status: "verified" },
    {
      error_message: "TypeError: cannot read price",
      file_path: "src/price.js",
      commit_sha: "abc1234def",
    },
  );

  it("matches on message, file, sha and branch, ignoring case", () => {
    expect(matchesSearch(item, "typeerror")).toBe(true);
    expect(matchesSearch(item, "price.js")).toBe(true);
    expect(matchesSearch(item, "ABC1234")).toBe(true);
    expect(matchesSearch(item, "autofix/")).toBe(true);
    expect(matchesSearch(item, "   ")).toBe(true);
    expect(matchesSearch(item, "nothing here")).toBe(false);
  });

  it("splits the feed into verified, running and blocked", () => {
    const verified = asItem({ status: "verified" });
    const running = asItem({ status: "fix_pushed" });
    const blocked = asItem({ status: "failed" });

    expect(matchesFilter(verified, "verified")).toBe(true);
    expect(matchesFilter(verified, "running")).toBe(false);
    expect(matchesFilter(running, "running")).toBe(true);
    expect(matchesFilter(blocked, "failed")).toBe(true);
    expect(matchesFilter(blocked, "running")).toBe(false);
    expect([verified, running, blocked].every((item) => matchesFilter(item, "all"))).toBe(true);
  });
});

describe("parsePlannedChanges", () => {
  it("reads the path key Role 2 writes and the file_path alias", () => {
    expect(
      parsePlannedChanges([
        { path: "src/a.js", search: "old", replace: "new" },
        { file_path: "src/b.js", search: "x", replace: "y" },
      ]),
    ).toEqual([
      { path: "src/a.js", search: "old", replace: "new" },
      { path: "src/b.js", search: "x", replace: "y" },
    ]);
  });

  it("accepts a single object and ignores unusable entries", () => {
    expect(parsePlannedChanges({ path: "src/a.js", search: "old", replace: "new" })).toHaveLength(1);
    expect(parsePlannedChanges(null)).toEqual([]);
    expect(parsePlannedChanges([null, 7, "nope", { path: "only" }])).toEqual([]);
  });
});

describe("proofSteps", () => {
  it("walks the three steps as the fix progresses", () => {
    const queued = proofSteps(asItem({ status: "queued" }));
    expect(queued[0].running).toBe(true);
    expect(queued.every((step) => !step.complete)).toBe(true);

    const testPushed = proofSteps(
      asItem({ status: "test_pushed", ai_reasoning: "because", test_commit_sha: "aaaaaaa1" }),
    );
    expect(testPushed[0].complete).toBe(true);
    expect(testPushed[1].running).toBe(true);

    const verified = proofSteps(
      asItem({
        status: "verified",
        ai_reasoning: "because",
        test_commit_sha: "aaaaaaa1",
        fix_commit_sha: "bbbbbbb2",
      }),
    );
    expect(verified.every((step) => step.complete)).toBe(true);
  });

  it("completes the red step from red_run_url when there is no test commit", () => {
    const item = asItem({
      status: "fix_pushed",
      ai_reasoning: "because",
      test_commit_sha: null,
      red_run_url: "https://example.test/red",
      fix_commit_sha: "bbbbbbb2",
    });

    const steps = proofSteps(item);

    expect(redProven(item.fix)).toBe(true);
    expect(steps[1].complete).toBe(true);
    expect(steps[1].tone).toBe("reproduced");
    expect(steps[1].sha).toBeNull();
    expect(steps[1].shaLabel).toBe("existing test");
    expect(steps[1].runUrl).toBe("https://example.test/red");
    expect(steps[2].complete).toBe(false);
    expect(steps[2].running).toBe(true);
  });

  it("marks a guardrail-blocked fix without completing the red step", () => {
    const item = asItem({ status: "failed", ai_reasoning: "because", confidence: 0.2 });

    const steps = proofSteps(item);

    expect(failureKind(item)).toBe("low_confidence");
    expect(statusLabel(item)).toBe("Guardrail blocked");
    expect(guardrailReason(item)).toContain("Guardrail triggered");
    expect(guardrailReason(item)).toContain("no PR opened");
    expect(steps[0].complete).toBe(true);
    expect(steps[0].tone).toBe("diagnosed");
    expect(steps[1].tone).toBe("blocked");
    expect(steps[1].complete).toBe(false);
    expect(steps[2].tone).toBe("blocked");
    expect(steps.every((step) => !step.running)).toBe(true);
  });

  it("clears the Step 1 checkmark when status is failed with an agent crash message (pr_url === null)", () => {
    const item = asItem({
      status: "failed",
      pr_url: null,
      fix_commit_sha: null,
      test_commit_sha: null,
      confidence: null,
      ai_reasoning: "Failed: [step_limit] Agent reached the step limit without submitting a fix.",
    });

    const steps = proofSteps(item);
    const explanation = fixExplanation(item);

    expect(failureKind(item)).toBe("agent_error");
    expect(statusLabel(item)).toBe("Analysis failed");
    expect(guardrailReason(item)).toBe("Agent analysis failed — no PR opened");
    expect(explanation.howHeading).toBe("Why analysis failed");
    expect(explanation.how).not.toContain("reproduction did not prove");
    expect(steps[0].complete).toBe(false);
    expect(steps[0].tone).toBe("blocked");
    expect(steps[0].running).toBe(false);
    expect(steps[0].description).toBe("Analysis failed before diagnosis");
    expect(steps[1].complete).toBe(false);
    expect(steps[1].tone).toBe("blocked");
    expect(steps[2].complete).toBe(false);
    expect(steps[2].tone).toBe("blocked");
    expect(steps[2].description).toBe("No PR opened");
  });

  it("handles a failed fix after diagnosis when pr_url === null", () => {
    const item = asItem({
      status: "failed",
      pr_url: null,
      fix_commit_sha: null,
      confidence: 0.9,
      ai_reasoning: "Missing null check\n\nRoot cause:\nCart items can be undefined.",
    });

    const steps = proofSteps(item);

    expect(failureKind(item)).toBe("agent_error");
    expect(guardrailReason(item)).toBe("Agent analysis failed — no PR opened");
    expect(steps[0].complete).toBe(true);
    expect(steps[0].tone).toBe("diagnosed");
    expect(steps[1].complete).toBe(false);
    expect(steps[2].description).toBe("No PR opened");
  });

  it("differentiates fix_failed_ci (fix_commit_sha !== null) from guardrail blocks", () => {
    const item = asItem(
      {
        status: "failed",
        ai_reasoning: "Subtract percent/100 instead of price * percent/100",
        confidence: 0.92,
        branch_name: "autofix/fix-1",
        pr_url: "https://github.com/octo/demo/pull/5",
        test_commit_sha: "aaaaaaa1111111",
        fix_commit_sha: "bbbbbbb2222222",
        red_run_url: "https://github.com/octo/demo/actions/runs/100",
      },
      { run_url: "https://github.com/octo/demo/actions/runs/99" },
    );

    const steps = proofSteps(item);
    const explanation = fixExplanation(item);

    expect(failureKind(item)).toBe("fix_failed_ci");
    expect(statusLabel(item)).toBe("Fix failed CI");
    expect(guardrailReason(item)).toBe("Fix failed CI checks on bbbbbbb — PR kept as Draft");
    expect(explanation.howHeading).toBe("Why CI failed");
    expect(explanation.how).toContain("pushed a fix commit, but CI checks still failed");
    expect(steps[0].complete).toBe(true);
    expect(steps[1].complete).toBe(true);
    expect(steps[1].tone).toBe("reproduced");
    expect(steps[1].runUrl).toBe("https://github.com/octo/demo/actions/runs/100");
    expect(steps[2].complete).toBe(false);
    expect(steps[2].tone).toBe("blocked");
    expect(steps[2].sha).toBe("bbbbbbb2222222");
    expect(steps[2].description).toBe("Fix failed CI checks");
  });

  it("differentiates guardrail_test_passed when PR stays draft without fix_commit_sha", () => {
    const item = asItem(
      {
        status: "failed",
        ai_reasoning: "Flaky timing test",
        confidence: 0.42,
        pr_url: "https://github.com/octo/demo/pull/4",
        test_commit_sha: "ccccccc3333333",
        fix_commit_sha: null,
      },
      { run_url: "https://github.com/octo/demo/actions/runs/50" },
    );

    const steps = proofSteps(item);
    const explanation = fixExplanation(item);

    expect(failureKind(item)).toBe("guardrail_test_passed");
    expect(statusLabel(item)).toBe("Guardrail blocked");
    expect(guardrailReason(item)).toBe(
      "Guardrail triggered: reproduction test passed without the fix — PR kept as Draft",
    );
    expect(explanation.howHeading).toBe("Why we blocked it");
    expect(steps[1].tone).toBe("blocked");
    expect(steps[1].complete).toBe(false);
    expect(steps[1].description).toBe("Passed without fix");
  });
});

describe("testPanelState", () => {
  it("reports generating state for queued, analyzing, and missing-fix items", () => {
    const noFix: Item = { error: asError({}), fix: null };
    const queued = asItem({ status: "queued" });
    const analyzing = asItem({ status: "analyzing" });

    for (const candidate of [noFix, queued, analyzing]) {
      const state = testPanelState(candidate);
      expect(state.kind).toBe("generating");
      expect(state.message).toBe("Generating reproduction test...");
      expect(state.links).toEqual([]);
      expect(fixExplanation(candidate).how).toContain("generating a reproduction test");
    }
  });

  it("reports not_generated for failed fixes with pr_url === null and no test commit", () => {
    const item = asItem({
      status: "failed",
      pr_url: null,
      test_commit_sha: null,
      fix_commit_sha: null,
      ai_reasoning: "Failed: missing key",
    });

    const state = testPanelState(item);
    expect(state.kind).toBe("not_generated");
    expect(state.message).not.toContain("existing test");
    expect(state.links).toEqual([]);
  });

  it("builds GitHub links for committed reproduction tests using branch_name, test_commit_sha, and pr_url", () => {
    const withPr = asItem(
      {
        status: "test_pushed",
        branch_name: "autofix/fix-1",
        test_commit_sha: "abcdef1234567890",
        pr_url: "https://github.com/octo/demo/pull/7",
      },
      { run_url: "https://github.com/octo/demo/actions/runs/70" },
    );

    expect(githubRepoUrl(withPr)).toBe("https://github.com/octo/demo");
    expect(testPanelState(withPr)).toEqual({
      kind: "committed",
      message: "The reproduction test lives on autofix/fix-1, commit abcdef1.",
      links: [
        { label: "View commit abcdef1", url: "https://github.com/octo/demo/commit/abcdef1234567890" },
        { label: "View PR files", url: "https://github.com/octo/demo/pull/7/files" },
      ],
    });

    const branchOnly = asItem(
      {
        status: "test_pushed",
        branch_name: "autofix/fix-2",
        test_commit_sha: "1234567890abcdef",
        pr_url: null,
      },
      { run_url: "https://github.com/octo/demo/actions/runs/71" },
    );
    expect(testPanelState(branchOnly).links).toEqual([
      { label: "View commit 1234567", url: "https://github.com/octo/demo/commit/1234567890abcdef" },
      { label: "Browse branch", url: "https://github.com/octo/demo/tree/autofix/fix-2" },
    ]);
  });

  it("reports existing_test with GitHub links when fix_commit_sha exists without test_commit_sha", () => {
    const item = asItem(
      {
        status: "failed",
        test_commit_sha: null,
        fix_commit_sha: "bbbbbbb2",
        pr_url: "https://github.com/octo/demo/pull/8",
        red_run_url: "https://github.com/octo/demo/actions/runs/80",
      },
      {
        file_path: "src/discount.test.js",
        commit_sha: "mainsha123",
        run_url: "https://github.com/octo/demo/actions/runs/80",
      },
    );

    const state = testPanelState(item);
    expect(state.kind).toBe("existing_test");
    expect(state.message).toContain("existing test in the repository already reproduced");
    expect(state.links).toEqual([
      {
        label: "View test on GitHub",
        url: "https://github.com/octo/demo/blob/mainsha123/src/discount.test.js",
      },
      { label: "View PR", url: "https://github.com/octo/demo/pull/8" },
    ]);
    expect(testFileName(item)).toBe("src/discount.test.js");

    const sourceFileItem = asItem(
      {
        status: "verified",
        test_commit_sha: null,
        fix_commit_sha: "ddddddd4",
        branch_name: "autofix/fix-9",
        pr_url: null,
      },
      {
        file_path: "src/cart.js",
        commit_sha: "mainsha456",
        run_url: "https://github.com/octo/demo/actions/runs/81",
      },
    );
    expect(testPanelState(sourceFileItem).links).toEqual([
      {
        label: "View failing file",
        url: "https://github.com/octo/demo/blob/mainsha456/src/cart.js",
      },
      {
        label: "Browse branch",
        url: "https://github.com/octo/demo/tree/autofix/fix-9",
      },
    ]);
  });
});
