import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentOutput, ErrorInput } from "./types";

// vitest has no "@/" alias here; point agent.ts's imports at the real modules.
vi.mock("@/lib/agent/tools", () => import("./tools"));
vi.mock("@/lib/agent/types", () => import("./types"));

const { checkChanges } = await import("./agent");

const EXISTING_TEST = "import { it, expect } from 'vitest';\nimport { sum } from './sum';\nit('adds', () => expect(sum(1, 2)).toBe(3));\n";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "agent-check-"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src/sum.ts"), "export const sum = (a: number, b: number) => a + b + 1;\n");
  await writeFile(path.join(root, "src/sum.test.ts"), EXISTING_TEST);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function output(testContent: string, testPath = "src/sum.test.ts"): AgentOutput {
  return {
    title: "Fix sum",
    explanation: "e",
    root_cause: "r",
    test: { file_path: testPath, content: testContent },
    changes: [{ file_path: "src/sum.ts", search: "a + b + 1", replace: "a + b" }],
    confidence: "high",
  };
}

function input(over: Partial<ErrorInput> = {}): ErrorInput {
  return {
    error_id: "err-1",
    error_message: "expected 4 to be 3",
    log_excerpt: "● adds\n\n  expected 4 to be 3\n\n    at sum (src/sum.ts:1:40)",
    file_path: "src/sum.ts",
    line: 1,
    commit_sha: "c0ffee0000",
    ...over,
  };
}

const copyProblem = (problems: string[]) => problems.find((p) => p.includes("identical to the existing"));

describe("checkChanges: regression test must be new", () => {
  it("rejects an unchanged copy of the existing test file", async () => {
    const problems = await checkChanges(root, output(EXISTING_TEST), input());
    expect(copyProblem(problems)).toMatch(/Submit a NEW regression test/);
  });

  it("rejects a copy that only differs in line endings / trailing whitespace", async () => {
    const reformatted = `${EXISTING_TEST.replace(/\n/g, "  \r\n")}\n\n`;
    expect(copyProblem(await checkChanges(root, output(reformatted), input()))).toBeDefined();
  });

  it("accepts the existing file with a new test case added", async () => {
    const extended = `${EXISTING_TEST}it('regression: no extra 1', () => expect(sum(0, 0)).toBe(0));\n`;
    expect(await checkChanges(root, output(extended), input())).toEqual([]);
  });

  it("accepts a brand-new test file", async () => {
    expect(await checkChanges(root, output(EXISTING_TEST, "src/sum.regression.test.ts"), input())).toEqual([]);
  });

  it("does not loop forever: allows the copy when the CI error location is in that test file", async () => {
    const problems = await checkChanges(root, output(EXISTING_TEST), input({ file_path: "src/sum.test.ts", line: 3 }));
    expect(problems).toEqual([]);
  });

  it("allows the copy when a stack frame of the failure (CI runner path) is in that test file", async () => {
    const log = [
      "● adds",
      "  expected 4 to be 3",
      "    at sum (/home/runner/work/r/r/src/sum.ts:1:40)",
      "    at Object.<anonymous> (/home/runner/work/r/r/src/sum.test.ts:3:30)",
    ].join("\n");
    expect(await checkChanges(root, output(EXISTING_TEST), input({ log_excerpt: log }))).toEqual([]);
  });

  it("still rejects when the log only mentions the test file without a stack frame in it", async () => {
    const log = "FAIL src/sum.test.ts\n● adds\n  expected 4 to be 3\n    at sum (src/sum.ts:1:40)";
    expect(copyProblem(await checkChanges(root, output(EXISTING_TEST), input({ log_excerpt: log })))).toBeDefined();
  });

  it("still rejects when the stack points into a different test file with the same name", async () => {
    await writeFile(path.join(root, "sum.test.ts"), EXISTING_TEST);
    const log = "● adds\n    at Object.<anonymous> (/home/runner/work/r/r/src/sum.test.ts:3:30)";
    const problems = await checkChanges(root, output(EXISTING_TEST, "sum.test.ts"), input({ log_excerpt: log }));
    expect(copyProblem(problems)).toBeDefined();
  });
});
