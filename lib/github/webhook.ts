/**
 * GitHub webhook handling: verify, dedupe, route. The route handler in
 * app/api/github/webhook stays thin; everything that touches the outside world is in
 * WebhookDeps so tests can fake it.
 *
 * Server-only (secret-key Supabase client, webhook secret).
 */
import { z } from "zod";
import type { Db } from "../db/supabase";
import { getGitHubApp } from "./app";
import { createInstallDeps, syncInstallation } from "./install";
import {
  type WorkflowRunContext,
  handleAutofixRun,
  handleFailedRun,
} from "../ingest/failed-run";

export const AUTOFIX_BRANCH_PREFIX = "autofix/";

// ---------------------------------------------------------------------------
// Payload shapes: only the fields we use. Everything else is ignored.
// ---------------------------------------------------------------------------

const installationPayload = z.object({
  action: z.string(),
  installation: z.object({ id: z.number().int().positive() }),
});

const workflowRunPayload = z.object({
  action: z.string(),
  installation: z.object({ id: z.number().int().positive() }),
  repository: z.object({ name: z.string(), owner: z.object({ login: z.string() }) }),
  workflow_run: z.object({
    id: z.number().int().positive(),
    run_attempt: z.number().int().positive().default(1),
    html_url: z.string(),
    head_sha: z.string(),
    head_branch: z.string().nullable(),
    conclusion: z.string().nullable(),
    name: z.string().nullable().optional(),
  }),
});

export type WorkflowRunPayload = z.infer<typeof workflowRunPayload>;

export type RunKind = "failed_run" | "autofix_run" | "ignore";

/**
 * Which completed runs we act on:
 * - autofix/* branches: any conclusion (Task 7 needs red and green results)
 * - everything else: only failures
 */
export function classifyWorkflowRun(p: WorkflowRunPayload): RunKind {
  if (p.action !== "completed") return "ignore";
  if (p.workflow_run.head_branch?.startsWith(AUTOFIX_BRANCH_PREFIX)) return "autofix_run";
  if (p.workflow_run.conclusion === "failure") return "failed_run";
  return "ignore";
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export type WebhookDeps = {
  verify(body: string, signature: string): Promise<boolean>;
  /** Insert the delivery id; "duplicate" if it was already there. */
  recordDelivery(deliveryId: string, event: string): Promise<"new" | "duplicate">;
  findProjectId(installationId: number, owner: string, repo: string): Promise<string | null>;
  /** Delete all projects of an installation (errors/fixes cascade). Returns how many. */
  deleteInstallationProjects(installationId: number): Promise<number>;
  /** Re-sync projects with the installation's repos. Returns a short summary for the log. */
  syncInstallationRepos(installationId: number): Promise<string>;
  onFailedRun(ctx: WorkflowRunContext): Promise<void>;
  onAutofixRun(ctx: WorkflowRunContext): Promise<void>;
  /** Run after the response is sent (Next.js after()). */
  runInBackground(task: () => Promise<void>): void;
  log(message: string, details?: Record<string, unknown>): void;
};

export type WebhookRequest = {
  body: string;
  deliveryId: string | null;
  event: string | null;
  signature: string | null;
};

export type WebhookResult = { status: number; message: string };

export async function handleWebhook(deps: WebhookDeps, req: WebhookRequest): Promise<WebhookResult> {
  // 1. Signature first, over the raw body. Nothing else happens for unsigned requests.
  if (!req.signature || !(await safeVerify(deps, req.body, req.signature))) {
    return { status: 401, message: "invalid signature" };
  }
  if (!req.deliveryId || !req.event) {
    return { status: 400, message: "missing delivery or event header" };
  }

  // 2. Idempotency: each delivery is processed once (GitHub "Redeliver" reuses the id).
  if ((await deps.recordDelivery(req.deliveryId, req.event)) === "duplicate") {
    deps.log("webhook: duplicate delivery ignored", { delivery: req.deliveryId, event: req.event });
    return { status: 200, message: "duplicate delivery" };
  }

  let json: unknown;
  try {
    json = JSON.parse(req.body);
  } catch {
    return { status: 400, message: "body is not JSON" };
  }

  // 3. Route by event.
  switch (req.event) {
    case "installation":
      return handleInstallation(deps, req.deliveryId, json);
    case "installation_repositories":
      return handleInstallationRepositories(deps, req.deliveryId, json);
    case "workflow_run":
      return handleWorkflowRun(deps, req.deliveryId, json);
    default:
      return { status: 200, message: `event ${req.event} ignored` };
  }
}

async function safeVerify(deps: WebhookDeps, body: string, signature: string): Promise<boolean> {
  try {
    return await deps.verify(body, signature);
  } catch {
    return false; // malformed signature header
  }
}

async function handleInstallation(deps: WebhookDeps, deliveryId: string, json: unknown) {
  const parsed = installationPayload.safeParse(json);
  if (!parsed.success) return { status: 400, message: "unexpected installation payload" };
  const { action, installation } = parsed.data;
  // created: the Setup URL creates projects (it knows the user; the webhook doesn't).
  if (action !== "deleted") return { status: 200, message: `installation ${action} ignored` };

  const removed = await deps.deleteInstallationProjects(installation.id);
  deps.log("webhook: installation deleted", { delivery: deliveryId, installation: installation.id, removed });
  return { status: 200, message: `installation deleted, ${removed} project(s) removed` };
}

async function handleInstallationRepositories(deps: WebhookDeps, deliveryId: string, json: unknown) {
  const parsed = installationPayload.safeParse(json);
  if (!parsed.success) return { status: 400, message: "unexpected installation_repositories payload" };
  const { action, installation } = parsed.data;

  const summary = await deps.syncInstallationRepos(installation.id);
  deps.log("webhook: installation repositories changed", {
    delivery: deliveryId,
    installation: installation.id,
    action,
    result: summary,
  });
  return { status: 200, message: `repositories ${action}: ${summary}` };
}

async function handleWorkflowRun(deps: WebhookDeps, deliveryId: string, json: unknown) {
  const parsed = workflowRunPayload.safeParse(json);
  if (!parsed.success) return { status: 400, message: "unexpected workflow_run payload" };
  const p = parsed.data;

  const kind = classifyWorkflowRun(p);
  if (kind === "ignore") {
    return { status: 200, message: `workflow_run ${p.action}/${p.workflow_run.conclusion} ignored` };
  }

  const owner = p.repository.owner.login;
  const repo = p.repository.name;
  const projectId = await deps.findProjectId(p.installation.id, owner, repo);
  if (!projectId) {
    deps.log("webhook: workflow_run for unknown project", {
      delivery: deliveryId,
      installation: p.installation.id,
      repo: `${owner}/${repo}`,
    });
    return { status: 200, message: "unknown project" };
  }

  const ctx: WorkflowRunContext = {
    deliveryId,
    projectId,
    installationId: p.installation.id,
    owner,
    repo,
    runId: p.workflow_run.id,
    runAttempt: p.workflow_run.run_attempt,
    runUrl: p.workflow_run.html_url,
    headSha: p.workflow_run.head_sha,
    headBranch: p.workflow_run.head_branch,
    conclusion: p.workflow_run.conclusion,
    workflowName: p.workflow_run.name ?? null,
  };

  // 4. Answer GitHub now (it times out after 10 s); slow work runs after the response.
  const task = kind === "autofix_run" ? deps.onAutofixRun : deps.onFailedRun;
  deps.runInBackground(async () => {
    try {
      await task(ctx);
    } catch (err) {
      deps.log("webhook: background task failed", {
        delivery: deliveryId,
        kind,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
  return { status: 202, message: `${kind} accepted` };
}

// ---------------------------------------------------------------------------
// Real dependencies
// ---------------------------------------------------------------------------

const UNIQUE_VIOLATION = "23505";

export function createWebhookDeps(db: Db, runInBackground: WebhookDeps["runInBackground"]): WebhookDeps {
  const installDeps = createInstallDeps(db);

  return {
    verify: (body, signature) => getGitHubApp().webhooks.verify(body, signature),

    async recordDelivery(deliveryId, event) {
      const { error } = await db.from("webhook_deliveries").insert({ delivery_id: deliveryId, event });
      if (!error) return "new";
      if (error.code === UNIQUE_VIOLATION) return "duplicate";
      throw new Error(`recording delivery failed: ${error.message}`);
    },

    async findProjectId(installationId, owner, repo) {
      // GitHub owner/repo names are case-insensitive; ilike with no wildcards = case-insensitive equals.
      const { data, error } = await db
        .from("projects")
        .select("id")
        .eq("installation_id", installationId)
        .ilike("repo_owner", escapeLike(owner))
        .ilike("repo_name", escapeLike(repo))
        .maybeSingle();
      if (error) throw new Error(`project lookup failed: ${error.message}`);
      return data?.id ?? null;
    },

    async deleteInstallationProjects(installationId) {
      const { data, error } = await db
        .from("projects")
        .delete()
        .eq("installation_id", installationId)
        .select("id");
      if (error) throw new Error(`deleting projects failed: ${error.message}`);
      return data.length;
    },

    async syncInstallationRepos(installationId) {
      // The webhook doesn't know which of our users installed the app; the Setup URL does.
      // So sync for the user who already owns this installation's projects.
      const owners = new Set((await installDeps.listProjects(installationId)).map((p) => p.userId));
      if (owners.size === 0) return "skipped: no user linked to this installation yet (Setup URL will sync)";
      if (owners.size > 1) return "skipped: installation linked to more than one user";
      const result = await syncInstallation(installDeps, [...owners][0], installationId);
      return result.ok ? `synced ${result.repoCount} repo(s), removed ${result.removedCount}` : result.reason;
    },

    onFailedRun: handleFailedRun,
    onAutofixRun: handleAutofixRun,
    runInBackground,
    log: (message, details) => console.info(details ? `${message} ${JSON.stringify(details)}` : message),
  };
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}
