/**
 * Manual run: run the agent on a fixture and open a draft PR with the fix on GitHub (GITHUB_REPO).
 * WRITES TO GITHUB (new autofix/<fixId> branch + draft PR) unless the agent's confidence is low.
 *
 * The agent reads the LOCAL fixtures/agent/demo-repo (read-only) to investigate.
 * The fix is applied to the files fetched from GitHub, never to the local copy.
 *
 *   npm run agent:pr                        # uses fixtures/agent/error1.json
 *   npm run agent:pr -- error2.json         # another file in fixtures/agent/
 *
 * Needs ANTHROPIC_API_KEY, GITHUB_TOKEN and GITHUB_REPO in .env.local (or .env / the environment).
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { AgentError, MAX_STEPS, MODEL, runAgent } from "@/lib/agent/agent";
import { getGithubConfig, GithubFixError, openFixPr } from "@/lib/agent/github";
import type { ErrorInput } from "@/lib/agent/types";

const root = process.cwd();
const fixturePath = path.resolve(root, "fixtures", "agent", process.argv[2] ?? "error1.json");
const repoRoot = path.resolve(root, "fixtures", "agent", "demo-repo");

// Same precedence as Next.js: .env.local wins over .env; real env vars win over both.
for (const file of [".env.local", ".env"]) {
  const p = path.join(root, file);
  if (existsSync(p)) process.loadEnvFile(p);
}

async function main(): Promise<number> {
  // Check all configuration before spending any API tokens.
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY is not set. Add ANTHROPIC_API_KEY=sk-ant-... to .env.local and run again.");
    return 1;
  }
  let github;
  try {
    github = getGithubConfig();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const input = JSON.parse(await readFile(fixturePath, "utf8")) as ErrorInput;

  console.log(`Fixture: ${path.relative(root, fixturePath)}`);
  console.log(`Reads:   ${path.relative(root, repoRoot)} (local, read-only)`);
  console.log(`Writes:  github.com/${github.owner}/${github.repo} (autofix/${input.error_id} branch + draft PR)`);
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
    return 0;
  } catch (err) {
    if (err instanceof GithubFixError) {
      console.error(`\nGitHub step failed: ${err.message}`);
    } else if (err instanceof AgentError) {
      console.error(`\nAgent failed [${err.code}]: ${err.message}`);
    } else if (err instanceof Anthropic.AuthenticationError) {
      console.error("\nAuthentication failed: ANTHROPIC_API_KEY is invalid or revoked.");
    } else if (err instanceof Anthropic.RateLimitError) {
      console.error("\nRate limited by the API. Wait a bit and try again.");
    } else if (err instanceof Anthropic.APIError) {
      console.error(`\nAPI error ${err.status ?? ""}: ${err.message}`);
    } else {
      throw err;
    }
    return 1;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
