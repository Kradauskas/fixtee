import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cleanLog, parseJestLog, repoPath } from "./parse-jest";

// Real job logs (fixtures/ci-logs, saved by lib/github/scripts/fetch-job-logs.mjs).
// Each *.expected.json was checked by hand against the log.
const dir = join(__dirname, "../../fixtures/ci-logs");
const read = (name: string) => readFileSync(join(dir, name), "utf8");

describe("parseJestLog on real CI logs", () => {
  it.each([
    ["expect-tobe", "fixtee-test"], // failed expect
    ["expect-multiple", "fixtee-demos"], // two failures: the first one wins
    ["type-error", "fixtee-test"], // TypeError: file/line point at the source, not the test
    ["nested-describe", "fixtee-test"], // describe › describe › test
    ["tsc-error", "fixtee-test"], // not Jest: parsed false, tail of the log
  ])("%s", (name, repo) => {
    expect(parseJestLog(read(`${name}.log`), repo)).toEqual(JSON.parse(read(`${name}.expected.json`)));
  });
});

describe("cleanLog", () => {
  it("strips timestamps, ANSI codes and group markers", () => {
    const raw =
      "2026-11-13T17:49:33.3513936Z \x1b[1m\x1b[31m  ● a › b\x1b[39m\x1b[22m\r\n" +
      "2026-11-13T17:49:33.1Z ##[group]Run npm test\n" +
      "##[endgroup]\n" +
      "2026-11-13T17:49:43.1Z ##[error]Process completed with exit code 1.";
    expect(cleanLog(raw)).toEqual(["  ● a › b", "Process completed with exit code 1."]);
  });
});

describe("repoPath", () => {
  it.each([
    ["src/a.js", "src/a.js"],
    ["/home/runner/work/demo/demo/src/a.js", "src/a.js"],
    ["/home/runner/work/demo/demo/node_modules/x/i.js", null],
    ["node_modules/jest-circus/build/x.js", null],
    ["node:internal/process/task_queues", null],
    ["/usr/lib/node/x.js", null],
  ])("%s -> %s", (input, out) => {
    expect(repoPath(input, "demo")).toBe(out);
  });
});

describe("parseJestLog edge cases", () => {
  it("returns parsed: false for empty input and never throws", () => {
    expect(parseJestLog("", "r")).toMatchObject({ parsed: false, logExcerpt: "" });
    expect(() => parseJestLog(undefined as unknown as string, "r")).not.toThrow();
  });

  it("caps the excerpt at 40 lines", () => {
    const raw = ["  ● s › t", "    Error: boom", ...Array.from({ length: 100 }, (_, i) => `line ${i}`)].join("\n");
    const r = parseJestLog(raw, "r");
    expect(r).toMatchObject({ parsed: true, testName: "s › t", errorType: "Error", errorMessage: "boom" });
    expect(r.logExcerpt.split("\n")).toHaveLength(40);
  });
});
