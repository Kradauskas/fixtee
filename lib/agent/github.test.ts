import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentOutput } from "./types";

type Call = { route: string; params: Record<string, unknown> };

const fake = vi.hoisted(() => ({
  calls: [] as { route: string; params: Record<string, unknown> }[],
  events: [] as string[],
  /** Files at the default branch tip (base000000). */
  files: new Map<string, string>(),
  /** Other commits the repo has: sha -> files at that commit. */
  commits: new Map<string, Map<string, string>>(),
  /** What GET compare returns for <commitSha>...base000000. */
  compareStatus: "ahead" as string,
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
          case "GET /repos/{owner}/{repo}/git/commits/{commit_sha}": {
            const sha = params.commit_sha as string;
            if (sha === "base000000") return { data: { sha, tree: { sha: "basetree" } } };
            const full = [...fake.commits.keys()].find((k) => k.startsWith(sha));
            if (!full) throw Object.assign(new Error("Not Found"), { status: 404 });
            return { data: { sha: full, tree: { sha: `tree-of-${full}` } } };
          }
          case "GET /repos/{owner}/{repo}/compare/{basehead}":
            return { data: { status: fake.compareStatus } };
          case "GET /repos/{owner}/{repo}/contents/{path}": {
            const files = params.ref === "base000000" ? fake.files : fake.commits.get(params.ref as string);
            const content = files?.get(params.path as string);
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
  fake.commits.clear();
  fake.compareStatus = "ahead";
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

describe("openFixPr with the error's commit (errors.commit_sha)", () => {
  const ERR_SHA = "e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1";
  const NEW_TEST = "it('regression', () => {});\n";
  const refCreate = () => fake.calls.find((c: Call) => c.route === "POST /repos/{owner}/{repo}/git/refs");
  const contentReads = () =>
    fake.calls.filter((c: Call) => c.route === "GET /repos/{owner}/{repo}/contents/{path}").map((c) => `${c.params.path}@${c.params.ref}`);

  beforeEach(() => {
    // The error's commit has the buggy code; the default branch tip has since changed that line.
    fake.commits.set(
      ERR_SHA,
      new Map([
        ["src/sum.ts", "export const sum = (a, b) => a + b + 1;\n"],
        ["src/sum.test.ts", EXISTING_TEST],
      ]),
    );
    fake.files.set("src/sum.ts", "// refactored\nexport function sum(a, b) {\n  return a + b + 1;\n}\n");
  });

  it("checks search/replace against the commit's files and branches from that commit", async () => {
    const pr = await openFixPr(output(NEW_TEST), "err-1", "fix-1", { installation, commitSha: ERR_SHA });

    expect(pr).not.toBeNull();
    expect(contentReads()).toContain(`src/sum.ts@${ERR_SHA}`);
    expect(contentReads()).not.toContain("src/sum.ts@base000000");
    expect(refCreate()!.params.sha).toBe(ERR_SHA);

    const commits = commitCalls();
    expect(commits[0]!.params.parents).toEqual([ERR_SHA]);
    const trees = fake.calls.filter((c: Call) => c.route === "POST /repos/{owner}/{repo}/git/trees");
    expect(trees[0]!.params.base_tree).toBe(`tree-of-${ERR_SHA}`);
    const fixTree = trees[1]!.params.tree as { path: string; content: string }[];
    expect(fixTree).toEqual([expect.objectContaining({ path: "src/sum.ts", content: "export const sum = (a, b) => a + b;\n" })]);

    // The PR still targets the default branch.
    const prCall = fake.calls.find((c: Call) => c.route === "POST /repos/{owner}/{repo}/pulls")!;
    expect(prCall.params.base).toBe("main");
    expect(prBody()).toContain("`e1e1e1e`");
  });

  it("accepts a short SHA and uses the full one for the branch", async () => {
    await openFixPr(output(NEW_TEST), "err-1", "fix-1", { installation, commitSha: ERR_SHA.slice(0, 7) });
    expect(refCreate()!.params.sha).toBe(ERR_SHA);
  });

  it("fails with a clear error before writing anything when the commit is not in the repo", async () => {
    const onBranchReady = vi.fn();
    await expect(
      openFixPr(output(NEW_TEST), "err-1", "fix-1", { installation, commitSha: "deadbeef00", onBranchReady }),
    ).rejects.toThrow(/commit "deadbeef00" was not found in o\/r[\s\S]*nothing was written/);
    expect(onBranchReady).not.toHaveBeenCalled();
    expect(fake.events).toEqual([]);
  });

  it("rejects a malformed commit SHA without querying it", async () => {
    await expect(openFixPr(output(NEW_TEST), "err-1", "fix-1", { installation, commitSha: "../main" })).rejects.toThrow(
      /was not found/,
    );
    expect(fake.calls.some((c: Call) => c.params.commit_sha === "../main")).toBe(false);
    expect(fake.events).toEqual([]);
  });

  it("does not create a branch when the search text only matches the default branch tip", async () => {
    fake.commits.get(ERR_SHA)!.set("src/sum.ts", "export const sum = (a, b) => a - b;\n");
    fake.files.set("src/sum.ts", "export const sum = (a, b) => a + b + 1;\n");
    await expect(openFixPr(output(NEW_TEST), "err-1", "fix-1", { installation, commitSha: ERR_SHA })).rejects.toThrow(
      new RegExp(`found 0 times in o/r@${ERR_SHA.slice(0, 7)}`),
    );
    expect(fake.events).toEqual([]);
  });

  it("treats the test as unchanged by comparing with the commit's version, not the tip's", async () => {
    fake.files.set("src/sum.test.ts", "it('changed on main since', () => {});\n");
    const pr = await openFixPr(output(EXISTING_TEST), "err-1", "fix-1", { installation, commitSha: ERR_SHA });
    expect(pr!.testCommitSha).toBeNull();
    expect(commitCalls()).toHaveLength(1);
  });

  describe("when the commit is not on the default branch (e.g. a feature branch)", () => {
    beforeEach(() => {
      fake.compareStatus = "diverged";
    });

    it("branches from the default branch tip, with the edits applied to the tip's files", async () => {
      await openFixPr(output(NEW_TEST), "err-1", "fix-1", { installation, commitSha: ERR_SHA });

      expect(contentReads()).toEqual(expect.arrayContaining([`src/sum.ts@${ERR_SHA}`, "src/sum.ts@base000000"]));
      expect(refCreate()!.params.sha).toBe("base000000");
      expect(commitCalls()[0]!.params.parents).toEqual(["base000000"]);
      const trees = fake.calls.filter((c: Call) => c.route === "POST /repos/{owner}/{repo}/git/trees");
      const fixTree = trees[1]!.params.tree as { path: string; content: string }[];
      // The tip's (refactored) file with the fix, never the older copy from the error's commit.
      expect(fixTree[0]!.content).toBe("// refactored\nexport function sum(a, b) {\n  return a + b;\n}\n");
    });

    it("writes nothing when the edit does not apply to the tip", async () => {
      fake.files.set("src/sum.ts", "export const sum = (a, b) => a + b;\n");
      await expect(openFixPr(output(NEW_TEST), "err-1", "fix-1", { installation, commitSha: ERR_SHA })).rejects.toThrow(
        /found 0 times in o\/r@main[\s\S]*is not on main/,
      );
      expect(fake.events).toEqual([]);
    });
  });
});
