/**
 * Run the agent like run-local.ts, but instead of only printing the result,
 * open a draft PR with the fix on GitHub (GITHUB_REPO).
 *
 * The agent still reads the LOCAL agent/demo-repo (read-only) to investigate.
 * The fix is applied to the files fetched from GitHub, never to the local copy.
 *
 *   npm run pr                 # uses fixtures/error1.json
 *   npm run pr -- error2.json
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import { AgentError, MAX_STEPS, MODEL, runAgent } from "./agent.js";
import { getGithubConfig, GithubFixError, openFixPr } from "./github.js";
import type { ErrorInput } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agentDir = path.resolve(__dirname, "..");
const fixturePath = path.resolve(agentDir, "fixtures", process.argv[2] ?? "error1.json");
const repoRoot = path.resolve(agentDir, "demo-repo");

loadEnv({ path: path.join(agentDir, ".env"), quiet: true });

// Check all configuration before spending any API tokens.
const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
if (!apiKey) {
  console.error(
    [
      "ANTHROPIC_API_KEY is not set.",
      "",
      "To fix this:",
      "  1. cp .env.example .env        (in the agent/ directory)",
      "  2. Open agent/.env and set ANTHROPIC_API_KEY=sk-ant-...",
      "  3. Run again: npm run pr",
    ].join("\n"),
  );
  process.exit(1);
}
let github;
try {
  github = getGithubConfig();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const input = JSON.parse(await readFile(fixturePath, "utf8")) as ErrorInput;

console.log(`Fixture: ${path.relative(process.cwd(), fixturePath)}`);
console.log(`Reads:   ${path.relative(process.cwd(), repoRoot)} (local, read-only)`);
console.log(`Writes:  github.com/${github.owner}/${github.repo} (new ai-fix/* branch + draft PR)`);
console.log(`Model:   ${MODEL} (max ${MAX_STEPS} steps)`);
console.log(`Error:   ${input.error_message.split("\n")[0]} @ ${input.file_path}:${input.line}`);

const client = new Anthropic({ apiKey });

try {
  const result = await runAgent({
    client,
    repoRoot,
    input,
    onStep: ({ step, tools }) => console.log(`  step ${step}: ${tools.length ? tools.join(", ") : "(no tool call)"}`),
  });
  const out = result.output;
  console.log(`\nAgent finished in ${result.steps} steps (${result.usage.input_tokens} in / ${result.usage.output_tokens} out tokens).`);
  console.log(`Confidence: ${out.confidence.toUpperCase()}`);
  console.log(`Root cause: ${out.root_cause}`);

  const pr = await openFixPr(out, input.error_id);
  if (pr === null) {
    console.log("\nConfidence is LOW, so no PR was opened. Nothing was written to GitHub.");
  } else {
    console.log("\nDraft PR opened:");
    console.log(`    url:         ${pr.prUrl}`);
    console.log(`    number:      #${pr.prNumber}`);
    console.log(`    branch:      ${pr.branch}`);
    console.log(`    test commit: ${pr.testCommitSha}`);
    console.log(`    fix commit:  ${pr.fixCommitSha}`);
  }
} catch (err) {
  if (err instanceof GithubFixError) {
    console.error(`\nGitHub step failed: ${err.message}`);
  } else if (err instanceof AgentError) {
    console.error(`\nAgent failed [${err.code}]: ${err.message}`);
  } else if (err instanceof Anthropic.AuthenticationError) {
    console.error("\nAuthentication failed: ANTHROPIC_API_KEY in agent/.env is invalid or revoked.");
  } else if (err instanceof Anthropic.RateLimitError) {
    console.error("\nRate limited by the API. Wait a bit and try again.");
  } else if (err instanceof Anthropic.APIError) {
    console.error(`\nAPI error ${err.status ?? ""}: ${err.message}`);
  } else {
    throw err;
  }
  process.exit(1);
}
