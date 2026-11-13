/**
 * The single place that builds the GitHub App client from env vars.
 * Everything else asks this module for an (installation) client; never build tokens by hand.
 *
 * Server-only: reads secrets from process.env and uses node:crypto.
 */
import { createPrivateKey } from "node:crypto";
import { App } from "@octokit/app";
import type { Octokit } from "@octokit/core";
import { z } from "zod";

export type GitHubAppConfig = {
  appId: number;
  slug: string;
  privateKey: string; // PKCS#8 PEM
  webhookSecret: string;
};

const envSchema = z.object({
  GITHUB_APP_ID: z.string().trim().regex(/^\d+$/, "must be the numeric App ID"),
  GITHUB_APP_SLUG: z.string().trim().min(1),
  GITHUB_PRIVATE_KEY: z.string().trim().min(1),
  GITHUB_WEBHOOK_SECRET: z.string().min(1),
});

/**
 * Accepts the private key the way it tends to arrive in env vars and returns a PKCS#8 PEM:
 * - real newlines (Vercel dashboard, quoted multi-line value in .env.local)
 * - escaped `\n` on one line
 * - surrounding quotes left in by copy/paste
 * - the whole PEM base64-encoded
 * GitHub issues PKCS#1 keys ("BEGIN RSA PRIVATE KEY"); we convert to PKCS#8 so signing works on
 * any runtime, and so a broken key fails here with a clear message instead of on the first request.
 */
export function normalizePrivateKey(raw: string): string {
  let pem = raw.trim().replace(/^(['"])([\s\S]*)\1$/, "$2").trim();
  pem = pem.replace(/\\r/g, "").replace(/\\n/g, "\n").replace(/\r\n/g, "\n");

  if (!pem.includes("-----BEGIN")) {
    const decoded = Buffer.from(pem, "base64").toString("utf8");
    if (!decoded.includes("-----BEGIN")) {
      throw new Error("GITHUB_PRIVATE_KEY is not a PEM key (nor a base64-encoded PEM)");
    }
    pem = decoded.trim();
  }

  try {
    return createPrivateKey(pem).export({ format: "pem", type: "pkcs8" }).toString();
  } catch {
    // Don't include the key or the underlying error text (it can echo key material).
    throw new Error("GITHUB_PRIVATE_KEY could not be parsed as a private key");
  }
}

/** Parse and validate GitHub App env vars. Error messages name variables, never values. */
export function loadGitHubAppConfig(
  env: Record<string, string | undefined> = process.env,
): GitHubAppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`GitHub App env is invalid: ${problems}`);
  }
  const e = parsed.data;
  return {
    appId: Number(e.GITHUB_APP_ID),
    slug: e.GITHUB_APP_SLUG,
    privateKey: normalizePrivateKey(e.GITHUB_PRIVATE_KEY),
    webhookSecret: e.GITHUB_WEBHOOK_SECRET,
  };
}

let cachedApp: App | undefined;
let cachedConfig: GitHubAppConfig | undefined;

export function getGitHubAppConfig(): GitHubAppConfig {
  cachedConfig ??= loadGitHubAppConfig();
  return cachedConfig;
}

/**
 * The App instance (one per server process). Use `.webhooks.verify()` for signatures and
 * `.eachRepository.iterator({ installationId })` to list an installation's repos.
 */
export function getGitHubApp(): App {
  if (!cachedApp) {
    const config = getGitHubAppConfig();
    cachedApp = new App({
      appId: config.appId,
      privateKey: config.privateKey,
      webhooks: { secret: config.webhookSecret },
    });
  }
  return cachedApp;
}

/**
 * An Octokit client authenticated as installation `installationId`.
 * Installation tokens are created, cached and refreshed by @octokit/auth-app.
 * Use `octokit.request("GET /repos/{owner}/{repo}/...", { ... })` (typed by route string).
 */
export async function getInstallationOctokit(installationId: number): Promise<Octokit> {
  return getGitHubApp().getInstallationOctokit(installationId);
}

/** Where to send a user to install the app (Task 3 redirects here). */
export function getInstallUrl(): string {
  return `https://github.com/apps/${getGitHubAppConfig().slug}/installations/new`;
}

/** Test helper: forget the cached app/config (e.g. after changing env vars). */
export function resetGitHubAppForTests(): void {
  cachedApp = undefined;
  cachedConfig = undefined;
}
