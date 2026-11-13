import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import { AgentError, MAX_STEPS, MODEL, runAgent } from "./agent.js";
import type { AgentOutput, ErrorInput } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agentDir = path.resolve(__dirname, "..");
const fixturePath = path.resolve(agentDir, "fixtures", process.argv[2] ?? "error1.json");
const repoRoot = path.resolve(agentDir, "demo-repo");

loadEnv({ path: path.join(agentDir, ".env"), quiet: true });

const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
if (!apiKey) {
  console.error(
    [
      "ANTHROPIC_API_KEY is not set.",
      "",
      "To fix this:",
      "  1. cp .env.example .env        (in the agent/ directory)",
      "  2. Open agent/.env and set ANTHROPIC_API_KEY=sk-ant-...",
      "     (create a key at https://platform.claude.com/settings/keys)",
      "  3. Run again: npm run dev",
    ].join("\n"),
  );
  process.exit(1);
}

const input = JSON.parse(await readFile(fixturePath, "utf8")) as ErrorInput;

const hr = (title: string) => console.log(`\n── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`);
const indent = (text: string) => text.replace(/^/gm, "    ");

console.log(`Fixture: ${path.relative(process.cwd(), fixturePath)}`);
console.log(`Repo:    ${path.relative(process.cwd(), repoRoot)}`);
console.log(`Model:   ${MODEL} (max ${MAX_STEPS} steps)`);
console.log(`Error:   ${input.error_message.split("\n")[0]} @ ${input.file_path}:${input.line}`);

function printResult(out: AgentOutput, steps: number, usage: { input_tokens: number; output_tokens: number }) {
  hr("Explanation");
  console.log(indent(out.explanation));
  hr("Root cause");
  console.log(indent(out.root_cause));
  hr(`Test: ${out.test.file_path}`);
  console.log(indent(out.test.content));
  out.changes.forEach((c, i) => {
    hr(`Change ${i + 1}/${out.changes.length}: ${c.file_path}`);
    console.log(c.search.replace(/^/gm, "  - "));
    console.log(c.replace.replace(/^/gm, "  + "));
  });
  hr("Summary");
  console.log(`    confidence: ${out.confidence.toUpperCase()}`);
  console.log(`    steps:      ${steps}/${MAX_STEPS}`);
  console.log(`    tokens:     ${usage.input_tokens} in / ${usage.output_tokens} out`);
  console.log("\n(Nothing was written to disk.)");
}

const client = new Anthropic({ apiKey });

try {
  const result = await runAgent({
    client,
    repoRoot,
    input,
    onStep: ({ step, tools }) => console.log(`  step ${step}: ${tools.length ? tools.join(", ") : "(no tool call)"}`),
  });
  printResult(result.output, result.steps, result.usage);
} catch (err) {
  if (err instanceof AgentError) {
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
