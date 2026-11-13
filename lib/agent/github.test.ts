import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentOutput } from "./types";

type Call = { route: string; params: Record<string, unknown> };

const fake = vi.hoisted(() => ({
  calls: [] as { route: string; params: Record<string, unknown> }[],
  events: [] as string[],
  files: new Map<string, string>(),
}));

/** Minimal in-memory stand-in for the GitHub App installation client (only octokit.request). */
vi.mock("@/lib/github/app", () => ({
  getInstallationOctokit: async () => {
    let n = 0;
    return {
      request: async (route: string, params: Record<string, unknown>) => {
        fake.calls.push({ route, params });
        if (!route.startsWith("GET ")) fake.events.push(route);
        switch (route) {
          case "GET /repos/{owner}/{repo}":
            return { data: { default_branch: "main" } };
          case "GET /repos/{owner}/{repo}/git/ref/{ref}":
            return { data: { object: { sha: "base000000" } } };
          case "GET /repos/{owner}/{repo}/git/commits/{commit_sha}":
            return { data: { tree: { sha: "basetree" } } };
          case "GET /repos/{owner}/{repo}/contents/{path}": {
            const content = fake.files.get(params.path as string);
            if (content === undefined) throw Object.assign(new Error("Not Found"), { status: 404 });
            return { data: { type: "file", sha: "blob", content: Buffer.from(content).toString("base64") } };
          }
          case "POST /repos/{owner}/{repo}/git/trees":
            return { data: { sha: `tree${++n}` } };
          case "POST /repos/{owner}/{repo}/git/commits":
            return { data: { sha: `commit${++n}` } };
          case "POST /repos/{owner}/{repo}/git/refs":
          case "PATCH /repos/{owner}/{repo}/git/refs/{ref}":
            return { data: {} };
          case "POST /repos/{owner}/{repo}/pulls":
            return { data: { number: 7, html_url: "https://github.com/o/r/pull/7" } };
          default:
            throw new Error(`unexpected route ${route}`);
        }
      },
    };
  },
}));

const { openFixPr } = await import("./github");

const installation = { installationId: 1, owner: "o", repo: "r" };
const RED_RUN = "https://github.com/o/r/actions/runs/123";
const EXISTING_TEST = "import { it } from 'vitest';\nit('old', () => {});\n";

function output(testContent: string): AgentOutput {
  return {
    title: "Fix sum",
    explanation: "Sum was wrong.",
    root_cause: "Off by one.",
    test: { file_path: "src/sum.test.ts", content: testContent },
    changes: [{ file_path: "src/sum.ts", search: "a + b + 1", replace: "a + b" }],
    confidence: "high",
  };
}

const commitCalls = () => fake.calls.filter((c: Call) => c.route === "POST /repos/{owner}/{repo}/git/commits");
const prBody = () => fake.calls.find((c: Call) => c.route === "POST /repos/{owner}/{repo}/pulls")!.params.body as string;

beforeEach(() => {
  fake.calls.length = 0;
  fake.events.length = 0;
  fake.files.clear();
  fake.files.set("src/sum.ts", "export const sum = (a, b) => a + b + 1;\n");
  fake.files.set("src/sum.test.ts", EXISTING_TEST);
});

describe("openFixPr", () => {
  it("does not create an empty test commit when the test file is unchanged", async () => {
    const onTestCommitted = vi.fn();
    const pr = await openFixPr(output(EXISTING_TEST), "err-1", "fix-1", {
      installation,
      onTestCommitted,
      failingRunUrl: RED_RUN,
    });

    expect(pr).not.toBeNull();
    expect(pr!.testCommitSha).toBeNull();
    expect(onTestCommitted).not.toHaveBeenCalled();

    // Exactly one commit (the fix), parented directly on the base commit, touching only the fix file.
    const commits = commitCalls();
    expect(commits).toHaveLength(1);
    expect(commits[0]!.params.parents).toEqual(["base000000"]);
    const trees = fake.calls.filter((c: Call) => c.route === "POST /repos/{owner}/{repo}/git/trees");
    expect(trees).toHaveLength(1);
    expect((trees[0]!.params.tree as { path: string }[]).map((t) => t.path)).toEqual(["src/sum.ts"]);

    const body = prBody();
    expect(body).toContain("already reproduced by an existing test");
    expect(body).toContain(RED_RUN);
    expect(body).toContain("`src/sum.test.ts`");
    expect(body).toContain("must prove");
  });

  it("commits a new test separately and still shows the evidence in the PR", async () => {
    const onTestCommitted = vi.fn();
    const pr = await openFixPr(output(`${EXISTING_TEST}it('regression', () => {});\n`), "err-1", "fix-1", {
      installation,
      onTestCommitted,
      failingRunUrl: RED_RUN,
    });

    expect(pr!.testCommitSha).not.toBeNull();
    expect(onTestCommitted).toHaveBeenCalledWith({ branch: "autofix/fix-1", testCommitSha: pr!.testCommitSha });
    const commits = commitCalls();
    expect(commits).toHaveLength(2);
    expect(commits[1]!.params.parents).toEqual([pr!.testCommitSha]);

    const body = prBody();
    expect(body).toContain("Red run");
    expect(body).toContain(RED_RUN);
    expect(body).toContain("`src/sum.test.ts`");
    expect(body).toContain("must prove");
  });

  it("reports the branch name before anything is pushed", async () => {
    const onBranchReady = vi.fn(({ branch }: { branch: string }) => {
      fake.events.push(`branch-ready:${branch}`);
    });
    await openFixPr(output("it('new', () => {});\n"), "err-1", "fix-1", { installation, onBranchReady });

    expect(onBranchReady).toHaveBeenCalledOnce();
    expect(fake.events[0]).toBe("branch-ready:autofix/fix-1");
    expect(fake.events.slice(1)).toContain("POST /repos/{owner}/{repo}/git/refs");
  });

  it("pushes nothing when recording the branch name fails", async () => {
    await expect(
      openFixPr(output("it('new', () => {});\n"), "err-1", "fix-1", {
        installation,
        onBranchReady: () => {
          throw new Error("db down");
        },
      }),
    ).rejects.toThrow("db down");
    expect(fake.events).toEqual([]);
  });
});
