import { describe, expect, it } from "vitest";
import type { Db } from "../../../lib/db/supabase";
import { parsePlannedChanges } from "../../../components/dashboard/diff-view";
import { matchesSearch } from "../../../components/dashboard/error-feed";
import { computeKpis } from "../../../components/dashboard/kpi-cards";
import { stepIndex } from "../../../components/dashboard/pipeline-stepper";
import type { DashboardError, DashboardFix } from "../../../components/dashboard/types";
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
  ({ id: FIX_ID, error_id: ERROR_ID, status: "queued", tokens_used: null, ...overrides }) as DashboardFix;

describe("computeKpis", () => {
  it("counts failures, outcomes and tokens", () => {
    const kpis = computeKpis(
      [asError({ id: "e1" }), asError({ id: "e2" })],
      [
        asFix({ status: "verified", tokens_used: 1200 }),
        asFix({ status: "failed", tokens_used: 800 }),
        asFix({ status: "fix_pushed", tokens_used: null }),
      ],
    );

    expect(kpis).toEqual({ failuresCaught: 2, verified: 1, failed: 1, tokensUsed: 2000 });
  });

  it("is all zeroes with nothing to show", () => {
    expect(computeKpis([], [])).toEqual({
      failuresCaught: 0,
      verified: 0,
      failed: 0,
      tokensUsed: 0,
    });
  });
});

describe("matchesSearch", () => {
  const error = asError({
    error_message: "TypeError: cannot read price",
    file_path: "src/price.js",
    commit_sha: "abc1234def",
  });

  it("matches on message, file and sha, ignoring case", () => {
    expect(matchesSearch(error, "typeerror")).toBe(true);
    expect(matchesSearch(error, "price.js")).toBe(true);
    expect(matchesSearch(error, "ABC1234")).toBe(true);
  });

  it("keeps everything when the query is blank", () => {
    expect(matchesSearch(error, "   ")).toBe(true);
  });

  it("drops rows that match nothing, and tolerates null fields", () => {
    expect(matchesSearch(error, "nothing here")).toBe(false);
    expect(matchesSearch(asError({ error_message: null }), "anything")).toBe(false);
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

describe("stepIndex", () => {
  it("places each status on the pipeline", () => {
    expect(stepIndex("queued")).toBe(0);
    expect(stepIndex("test_failed")).toBe(3);
    expect(stepIndex("verified")).toBe(5);
  });

  it("has no position for a failed or missing fix", () => {
    expect(stepIndex("failed")).toBe(-1);
    expect(stepIndex(null)).toBe(-1);
  });
});
