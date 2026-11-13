/**
 * Run runAgent(errorId) locally. By default in DRY RUN mode (nothing is written to GitHub or the
 * fixes table); pass --real to run with dryRun: false (writes the fixes row, pushes, opens a PR).
 *
 *   node scripts/run-agent.mts <errors.id> [--real]
 *
 * Why not tsx: the project is CommonJS (no "type" in package.json), so tsx loads lib/** as CJS and
 * require()s @octokit/* — ESM-only packages with only an "import" export condition
 * (ERR_PACKAGE_PATH_NOT_EXPORTED). Instead this launcher uses Vite's module runner: our TS sources
 * are transformed by Vite (with the "@/" alias), while node_modules are externalized and loaded by
 * Node's native ESM loader, which resolves the "import" condition correctly.
 *
 * Needs NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and ANTHROPIC_API_KEY in .env.local / .env.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runnerImport } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root); // runAgent resolves the demo repo from process.cwd()

const args = process.argv.slice(2);
const real = args.includes("--real");
const errorId = args.find((a) => !a.startsWith("--"));
if (!errorId) {
  console.error("Naudojimas: node scripts/run-agent.mts <errors.id> [--real]");
  process.exit(1);
}

// Same precedence as Next.js: .env.local wins over .env; real env vars win over both.
for (const file of [".env.local", ".env"]) {
  const p = path.join(root, file);
  if (existsSync(p)) process.loadEnvFile(p);
}

type AgentModule = typeof import("../lib/agent/index");

const { module: agent } = await runnerImport<AgentModule>(path.join(root, "lib/agent/index.ts"), {
  configFile: false,
  root,
  logLevel: "warn",
  resolve: { alias: { "@": root } },
});

await agent.runAgent(errorId, { dryRun: !real });
