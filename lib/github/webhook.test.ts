import { describe, expect, it } from "vitest";
import type { WorkflowRunContext } from "../ingest/failed-run";
import { type WebhookDeps, type WebhookRequest, handleWebhook } from "./webhook";

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";

/** Fake deps: records what was called; background tasks are queued and run by flush(). */
function fakeDeps(opts: { projects?: Record<string, string>; validSignature?: string } = {}) {
  const projects = opts.projects ?? { "42:octo/demo": PROJECT_ID };
  const deliveries = new Set<string>();
  const queued: (() => Promise<void>)[] = [];
  const calls = {
    failed: [] as WorkflowRunContext[],
    autofix: [] as WorkflowRunContext[],
    deletedInstallations: [] as number[],
    synced: [] as number[],
    logs: [] as string[],
  };

  const deps: WebhookDeps = {
    verify: async (_body, sig) => {
      if (sig === "throw") throw new Error("bad header");
      return sig === (opts.validSignature ?? "sha256=good");
    },
    recordDelivery: async (id) => {
      if (deliveries.has(id)) return "duplicate";
      deliveries.add(id);
      return "new";
    },
    findProjectId: async (inst, owner, repo) => projects[`${inst}:${owner}/${repo}`.toLowerCase()] ?? null,
    deleteInstallationProjects: async (inst) => {
      calls.deletedInstallations.push(inst);
      return 2;
    },
    syncInstallationRepos: async (inst) => {
      calls.synced.push(inst);
      return "synced 1 repo(s), removed 0";
    },
    onFailedRun: async (ctx) => {
      calls.failed.push(ctx);
    },
    onAutofixRun: async (ctx) => {
      calls.autofix.push(ctx);
    },
    runInBackground: (task) => {
      queued.push(task);
    },
    log: (m) => {
      calls.logs.push(m);
    },
  };

  const flush = async () => {
    while (queued.length) await queued.shift()!();
  };
  return { deps, calls, flush, queued };
}

let nextDelivery = 0;
function req(event: string, payload: unknown, overrides: Partial<WebhookRequest> = {}): WebhookRequest {
  return {
    body: JSON.stringify(payload),
    deliveryId: `delivery-${++nextDelivery}`,
    event,
    signature: "sha256=good",
    ...overrides,
  };
}

function workflowRun(overrides: { action?: string; conclusion?: string | null; branch?: string | null; owner?: string } = {}) {
  return {
    action: overrides.action ?? "completed",
    installation: { id: 42 },
    repository: { name: "demo", owner: { login: overrides.owner ?? "octo" } },
    workflow_run: {
      id: 9001,
      run_attempt: 1,
      name: "test",
      html_url: "https://github.com/octo/demo/actions/runs/9001",
      head_sha: "abcdef1234567890",
      head_branch: overrides.branch === undefined ? "main" : overrides.branch,
      conclusion: overrides.conclusion === undefined ? "failure" : overrides.conclusion,
    },
  };
}

describe("handleWebhook: verification and idempotency", () => {
  it("rejects a missing signature with 401 and touches nothing", async () => {
    const { deps, calls, queued } = fakeDeps();
    const res = await handleWebhook(deps, req("workflow_run", workflowRun(), { signature: null }));
    expect(res.status).toBe(401);
    expect(queued).toHaveLength(0);
    expect(calls.logs).toHaveLength(0);
  });

  it("rejects a wrong or malformed signature with 401", async () => {
    const { deps } = fakeDeps();
    expect((await handleWebhook(deps, req("workflow_run", workflowRun(), { signature: "sha256=bad" }))).status).toBe(401);
    expect((await handleWebhook(deps, req("workflow_run", workflowRun(), { signature: "throw" }))).status).toBe(401);
  });

  it("rejects a signed request without delivery or event header with 400", async () => {
    const { deps } = fakeDeps();
    expect((await handleWebhook(deps, req("workflow_run", workflowRun(), { deliveryId: null }))).status).toBe(400);
    expect((await handleWebhook(deps, req("workflow_run", workflowRun(), { event: null }))).status).toBe(400);
  });

  it("processes a delivery once; a redelivery gets 200 and is ignored", async () => {
    const { deps, calls, flush } = fakeDeps();
    const first = req("workflow_run", workflowRun());
    expect((await handleWebhook(deps, first)).status).toBe(202);
    expect(await handleWebhook(deps, first)).toEqual({ status: 200, message: "duplicate delivery" });
    await flush();
    expect(calls.failed).toHaveLength(1);
  });

  it("returns 400 for a signed body that isn't JSON", async () => {
    const { deps } = fakeDeps();
    expect((await handleWebhook(deps, req("workflow_run", null, { body: "not json" }))).status).toBe(400);
  });
});

describe("handleWebhook: workflow_run", () => {
  it("accepts a failed run for a known project with 202 and runs the work in the background", async () => {
    const { deps, calls, flush } = fakeDeps();
    const res = await handleWebhook(deps, req("workflow_run", workflowRun()));
    expect(res).toEqual({ status: 202, message: "failed_run accepted" });
    expect(calls.failed).toHaveLength(0); // not before the response
    await flush();
    expect(calls.failed).toEqual([
      expect.objectContaining({
        projectId: PROJECT_ID,
        installationId: 42,
        owner: "octo",
        repo: "demo",
        runId: 9001,
        runAttempt: 1,
        headSha: "abcdef1234567890",
        headBranch: "main",
        conclusion: "failure",
        runUrl: "https://github.com/octo/demo/actions/runs/9001",
      }),
    ]);
    expect(calls.autofix).toHaveLength(0);
  });

  it.each([
    ["successful run", { conclusion: "success" }],
    ["cancelled run", { conclusion: "cancelled" }],
    ["run that only started", { action: "requested", conclusion: null }],
    ["run in progress", { action: "in_progress", conclusion: null }],
  ])("ignores a %s with 200", async (_name, o) => {
    const { deps, queued } = fakeDeps();
    const res = await handleWebhook(deps, req("workflow_run", workflowRun(o)));
    expect(res.status).toBe(200);
    expect(queued).toHaveLength(0);
  });

  it.each(["success", "failure"])("routes a completed autofix/* run (%s) to the autofix handler", async (conclusion) => {
    const { deps, calls, flush } = fakeDeps();
    const res = await handleWebhook(deps, req("workflow_run", workflowRun({ branch: "autofix/abc", conclusion })));
    expect(res.status).toBe(202);
    await flush();
    expect(calls.autofix).toHaveLength(1);
    expect(calls.failed).toHaveLength(0);
  });

  it("ignores a run with no branch that succeeded (e.g. a tag)", async () => {
    const { deps, queued } = fakeDeps();
    expect((await handleWebhook(deps, req("workflow_run", workflowRun({ branch: null, conclusion: "success" })))).status).toBe(200);
    expect(queued).toHaveLength(0);
  });

  it("answers 200 and logs for an unknown project", async () => {
    const { deps, calls, queued } = fakeDeps();
    const res = await handleWebhook(deps, req("workflow_run", workflowRun({ owner: "stranger" })));
    expect(res).toEqual({ status: 200, message: "unknown project" });
    expect(queued).toHaveLength(0);
    expect(calls.logs).toContain("webhook: workflow_run for unknown project");
  });

  it("returns 400 for a workflow_run payload missing fields", async () => {
    const { deps } = fakeDeps();
    expect((await handleWebhook(deps, req("workflow_run", { action: "completed" }))).status).toBe(400);
  });

  it("catches and logs a background failure instead of throwing", async () => {
    const { deps, calls, flush } = fakeDeps();
    deps.onFailedRun = async () => {
      throw new Error("boom");
    };
    await handleWebhook(deps, req("workflow_run", workflowRun()));
    await flush();
    expect(calls.logs).toContain("webhook: background task failed");
  });
});

describe("handleWebhook: installation events", () => {
  it("deletes the installation's projects when the app is uninstalled", async () => {
    const { deps, calls } = fakeDeps();
    const res = await handleWebhook(deps, req("installation", { action: "deleted", installation: { id: 42 } }));
    expect(res.status).toBe(200);
    expect(calls.deletedInstallations).toEqual([42]);
  });

  it.each(["created", "suspend", "new_permissions_accepted"])("ignores installation %s", async (action) => {
    const { deps, calls } = fakeDeps();
    expect((await handleWebhook(deps, req("installation", { action, installation: { id: 42 } }))).status).toBe(200);
    expect(calls.deletedInstallations).toEqual([]);
  });

  it.each(["added", "removed"])("re-syncs projects when repositories are %s", async (action) => {
    const { deps, calls } = fakeDeps();
    const res = await handleWebhook(deps, req("installation_repositories", { action, installation: { id: 42 } }));
    expect(res.status).toBe(200);
    expect(calls.synced).toEqual([42]);
  });

  it("ignores other events with 200", async () => {
    const { deps, queued } = fakeDeps();
    expect(await handleWebhook(deps, req("push", { ref: "refs/heads/main" }))).toEqual({
      status: 200,
      message: "event push ignored",
    });
    expect(queued).toHaveLength(0);
  });
});
