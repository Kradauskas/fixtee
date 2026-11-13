import { readFile } from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { resolveSafePath, runTool, toolDefinitions, isReadTool, PathAccessError } from "./tools.js";
import { AgentOutput, type ErrorInput } from "./types.js";

export const MODEL = "claude-sonnet-5-5";
export const MAX_STEPS = 10;

export class AgentError extends Error {
  constructor(
    message: string,
    readonly code: "step_limit" | "refusal" | "max_tokens" | "unexpected_stop",
  ) {
    super(message);
    this.name = "AgentError";
  }
}

export type AgentResult = {
  output: AgentOutput;
  steps: number;
  usage: { input_tokens: number; output_tokens: number };
};

const SYSTEM_PROMPT = `You are a bug-fixing agent. You receive a failing test or runtime error from CI and a read-only view of the repository.

Tools:
- list_dir, read_file, search_code: inspect the repository (paths are relative to the repo root).
- submit_fix: your final answer. Calling it ends the task.

Work like this:
1. Locate and read the code involved in the error. Confirm the root cause from the code itself, not just the error message.
2. First write a test that reproduces the bug: it must fail on the current code and pass once the fix is applied. Use the repository's existing test framework and conventions (check package.json). Put the full test file content in "test".
3. Then write the fix as search/replace edits in "changes", never as whole-file rewrites. Each "search" must be copied exactly from the current file (no line-number prefixes from read_file) and must match exactly one place; include just enough surrounding lines to be unique. Keep the fix minimal.
4. Set "confidence" honestly: "high" only if you read the relevant code and the fix clearly addresses the root cause; if you are unsure about the cause, the fix, or how the test is run, use "low".

You have at most ${MAX_STEPS} steps (model turns) in total, so be efficient and call submit_fix before you run out. Always finish by calling submit_fix; do not answer in plain text.`;

function buildSubmitFixTool(): Anthropic.Beta.BetaTool {
  // Derive the schema from the zod definition so the tool and validation never drift apart.
  const { $schema: _ignored, ...schema } = z.toJSONSchema(AgentOutput) as Record<string, unknown>;
  return {
    name: "submit_fix",
    description:
      "Submit the final result: explanation, root cause, a reproducing test, search/replace changes and confidence. Call exactly once, when you are done.",
    input_schema: schema as Anthropic.Beta.BetaTool.InputSchema,
    strict: true,
  };
}

function buildUserMessage(input: ErrorInput): string {
  return [
    "A CI run failed. Find the root cause and propose a fix.",
    "",
    `<error id="${input.error_id}" commit="${input.commit_sha}">`,
    `<message>\n${input.error_message}\n</message>`,
    `<location>${input.file_path}:${input.line}</location>`,
    `<log>\n${input.log_excerpt}\n</log>`,
    "</error>",
  ].join("\n");
}

/**
 * Validate a submit_fix payload beyond the zod shape: paths must be inside the repo,
 * and every search string must occur exactly once in its target file.
 * Returns a list of problems (empty = OK).
 */
async function checkChanges(repoRoot: string, output: AgentOutput): Promise<string[]> {
  const problems: string[] = [];

  try {
    await resolveSafePath(repoRoot, output.test.file_path);
  } catch (err) {
    problems.push(`test.file_path: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (output.changes.length === 0) problems.push("changes must contain at least one search/replace edit.");

  for (const [i, change] of output.changes.entries()) {
    const label = `changes[${i}] (${change.file_path})`;
    let abs: string;
    try {
      abs = await resolveSafePath(repoRoot, change.file_path);
    } catch (err) {
      problems.push(`${label}: ${err instanceof PathAccessError ? err.message : String(err)}`);
      continue;
    }
    let content: string;
    try {
      content = await readFile(abs, "utf8");
    } catch {
      problems.push(`${label}: file does not exist.`);
      continue;
    }
    if (change.search.length === 0) {
      problems.push(`${label}: search must not be empty.`);
      continue;
    }
    const occurrences = content.split(change.search).length - 1;
    if (occurrences !== 1) {
      problems.push(
        `${label}: search text found ${occurrences} times; it must match exactly once. Copy it verbatim from the file (without line-number prefixes).`,
      );
    }
  }
  return problems;
}

export async function runAgent(opts: {
  client: Anthropic;
  repoRoot: string;
  input: ErrorInput;
  onStep?: (info: { step: number; tools: string[] }) => void;
}): Promise<AgentResult> {
  const { client, repoRoot, input, onStep } = opts;
  const tools = [...toolDefinitions, buildSubmitFixTool()];
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: buildUserMessage(input) }];
  const usage = { input_tokens: 0, output_tokens: 0 };

  for (let step = 1; step <= MAX_STEPS; step++) {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      tools,
      messages,
      // Forced tool_choice is not supported on this model; the system prompt steers toward submit_fix.
      tool_choice: { type: "auto" },
      // If a safety classifier declines, the API retries on a fallback model in the same call.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    usage.input_tokens += response.usage.input_tokens;
    usage.output_tokens += response.usage.output_tokens;

    if (response.stop_reason === "refusal") {
      throw new AgentError(`Model refused the request (${response.stop_details?.category ?? "unknown category"}).`, "refusal");
    }
    if (response.stop_reason === "max_tokens") {
      throw new AgentError("Model response hit max_tokens before finishing.", "max_tokens");
    }

    // Pass the full content back unchanged (thinking blocks must be preserved).
    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    onStep?.({ step, tools: toolUses.map((t) => t.name) });

    if (toolUses.length === 0) {
      if (response.stop_reason === "pause_turn") continue;
      messages.push({
        role: "user",
        content: "You must finish by calling the submit_fix tool. Continue investigating if needed, then call submit_fix.",
      });
      continue;
    }

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    let accepted: AgentOutput | undefined;

    for (const toolUse of toolUses) {
      if (toolUse.name === "submit_fix") {
        if (accepted) {
          results.push({ type: "tool_result", tool_use_id: toolUse.id, content: "Ignored: a fix was already submitted.", is_error: true });
          continue;
        }
        const parsed = AgentOutput.safeParse(toolUse.input);
        if (!parsed.success) {
          results.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: `submit_fix input is invalid:\n${z.prettifyError(parsed.error)}\nFix the problems and call submit_fix again.`,
            is_error: true,
          });
          continue;
        }
        const problems = await checkChanges(repoRoot, parsed.data);
        if (problems.length > 0) {
          results.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: `submit_fix rejected:\n- ${problems.join("\n- ")}\nFix the problems and call submit_fix again.`,
            is_error: true,
          });
          continue;
        }
        accepted = parsed.data;
        results.push({ type: "tool_result", tool_use_id: toolUse.id, content: "Fix accepted." });
      } else if (isReadTool(toolUse.name)) {
        const { content, isError } = await runTool(repoRoot, toolUse.name, toolUse.input);
        results.push({ type: "tool_result", tool_use_id: toolUse.id, content, is_error: isError });
      } else {
        results.push({ type: "tool_result", tool_use_id: toolUse.id, content: `Unknown tool: ${toolUse.name}`, is_error: true });
      }
    }

    if (accepted) return { output: accepted, steps: step, usage };

    // All tool results for this turn go back in a single user message.
    messages.push({ role: "user", content: results });
  }

  throw new AgentError(
    `Agent reached the step limit (${MAX_STEPS}) without submitting a valid fix via submit_fix.`,
    "step_limit",
  );
}
