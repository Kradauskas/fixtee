import { readFile } from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { AgentError, runAgent as runAgentLoop } from "@/lib/agent/agent";
import type { ErrorInput } from "@/lib/agent/types";

const FIXTURE_PATH = path.join(process.cwd(), "fixtures", "agent", "error1.json");
const DEMO_REPO_ROOT = path.join(process.cwd(), "fixtures", "agent", "demo-repo");

/**
 * Run the fixing agent for one stored error. Never throws: every failure is logged.
 *
 * TODO: skaityti errors ir rašyti fixes — once Supabase is ready, load the row from
 * `errors` by errorId (instead of the fixture), check out the real repo instead of the
 * demo repo, and write the result (output / PR / failure) into `fixes`.
 */
export async function runAgent(errorId: string): Promise<void> {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) {
      console.error(`[agent] ${errorId}: ANTHROPIC_API_KEY is not set; skipping.`);
      return;
    }

    // TODO: skaityti errors — for now always the fixture, regardless of errorId.
    const input = JSON.parse(await readFile(FIXTURE_PATH, "utf8")) as ErrorInput;
    console.log(`[agent] ${errorId}: running on fixture ${input.error_id} (demo repo)`);

    const result = await runAgentLoop({
      client: new Anthropic({ apiKey }),
      repoRoot: DEMO_REPO_ROOT,
      input,
      onStep: ({ step, tools }) => console.log(`[agent] ${errorId}: step ${step}: ${tools.join(", ") || "(no tool call)"}`),
    });

    // TODO: rašyti fixes — persist result.output instead of just logging it.
    console.log(
      `[agent] ${errorId}: done in ${result.steps} steps ` +
        `(${result.usage.input_tokens} in / ${result.usage.output_tokens} out tokens)`,
    );
    console.log(JSON.stringify(result.output, null, 2));
  } catch (err) {
    const detail =
      err instanceof AgentError ? `[${err.code}] ${err.message}` : err instanceof Error ? err.message : String(err);
    console.error(`[agent] ${errorId}: failed: ${detail}`);
  }
}
