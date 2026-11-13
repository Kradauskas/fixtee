import { Octokit } from "@octokit/rest";
import type { AgentOutput } from "@/lib/agent/types";
import { getInstallationOctokit } from "@/lib/github/app";

// Config comes from process.env: Next.js loads .env.local itself; scripts/run-pr.ts loads it manually.

export type FixPrResult = {
  branch: string;
  prNumber: number;
  prUrl: string;
  /**
   * The test-only commit, or null when the test file already had exactly this content on the base
   * branch: then no (empty) test commit is made and the existing test is the reproduction.
   */
  testCommitSha: string | null;
  fixCommitSha: string;
};

const PR_TITLE_PREFIX = "[AI fix] ";
const PR_TITLE_MAX = 70;

/** Cut text to at most `max` chars, at a word boundary when possible, adding "…" if cut. */
function truncateAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  const base = lastSpace > max / 2 ? cut.slice(0, lastSpace) : cut;
  return `${base.replace(/[\s.,;:!?-]+$/, "")}…`;
}

/** "[AI fix] <short description>", at most 70 chars. Uses output.title, else the explanation. */
export function buildPrTitle(output: AgentOutput): string {
  const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
  let desc = oneLine(output.title ?? "").replace(/^\[AI fix\]\s*/i, "");
  if (!desc) desc = oneLine(output.explanation.split(/\n\s*\n/)[0] ?? "") || "Automated fix";
  return PR_TITLE_PREFIX + truncateAtWord(desc, PR_TITLE_MAX - PR_TITLE_PREFIX.length);
}

export type GithubConfig = { token: string; owner: string; repo: string };

/** Thrown for every problem in the GitHub flow. The message says what went wrong and what to do. */
export class GithubFixError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubFixError";
  }
}

const ENV_HELP = [
  "To fix this:",
  "  1. Open .env.local in the project root (create it if it does not exist).",
  "  2. Set GITHUB_TOKEN=<token>  — a fine-grained token with access to this repo only and",
  "     permissions: Contents (read & write) and Pull requests (read & write).",
  "     Create one at https://github.com/settings/personal-access-tokens/new",
  "  3. Set GITHUB_REPO=owner/name  — the repository the fix PR is opened against.",
].join("\n");

/** Read and validate GITHUB_TOKEN and GITHUB_REPO from the environment. */
export function getGithubConfig(): GithubConfig {
  const token = process.env.GITHUB_TOKEN?.trim();
  const repoSpec = process.env.GITHUB_REPO?.trim();
  const missing = [!token && "GITHUB_TOKEN", !repoSpec && "GITHUB_REPO"].filter(Boolean);
  if (missing.length > 0) {
    throw new GithubFixError(`${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not set.\n\n${ENV_HELP}`);
  }
  const match = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(repoSpec!);
  if (!match) {
    throw new GithubFixError(
      `GITHUB_REPO must have the form owner/name (e.g. octocat/hello-world), got "${repoSpec}".\n\n${ENV_HELP}`,
    );
  }
  return { token: token!, owner: match[1]!, repo: match[2]!.replace(/\.git$/, "") };
}

// ---------- helpers ----------

function httpStatus(err: unknown): number | undefined {
  return typeof err === "object" && err !== null && "status" in err && typeof err.status === "number"
    ? err.status
    : undefined;
}

/**
 * Works with both the GitHub App installation client (@octokit/core) and the PAT client
 * (@octokit/rest extends core), so all calls below go through `octokit.request(route, ...)`.
 */
type GithubClient = Awaited<ReturnType<typeof getInstallationOctokit>>;

/** Which repo to write to and how we are authenticated (only used for error hints). */
type RepoTarget =
  | { auth: "app"; installationId: number; owner: string; repo: string }
  | { auth: "token"; owner: string; repo: string };

/** Turn an Octokit error into a readable GithubFixError for the given step. */
function describeApiError(step: string, err: unknown, cfg: RepoTarget): GithubFixError {
  const status = httpStatus(err);
  const detail = err instanceof Error ? err.message : String(err);
  const repo = `${cfg.owner}/${cfg.repo}`;
  let hint = "";
  if (cfg.auth === "app") {
    if (status === 401) hint = `The GitHub App installation ${cfg.installationId} was rejected. Check GITHUB_APP_ID / GITHUB_PRIVATE_KEY and that the app is still installed.`;
    else if (status === 403) hint = `The GitHub App lacks permission on ${repo}. It needs Contents and Pull requests: read & write.`;
    else if (status === 404) hint = `Not found. Check that the project's repo ${repo} is correct and that the app installation ${cfg.installationId} has access to it.`;
  } else {
    if (status === 401) hint = "GITHUB_TOKEN is invalid or expired. Create a new token and update .env.local.";
    else if (status === 403) hint = `The token lacks permission on ${repo}. It needs Contents and Pull requests: read & write.`;
    else if (status === 404) hint = `Not found. Check that GITHUB_REPO=${repo} is correct and that the token has access to it.`;
  }
  return new GithubFixError(`GitHub: ${step} failed${status ? ` (HTTP ${status})` : ""}: ${detail}${hint ? `\n${hint}` : ""}`);
}

/** Reject anything that is not a plain repo-relative path. */
function normalizeRepoPath(p: string, label: string): string {
  const posix = p.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (
    posix === "" ||
    posix.startsWith("/") ||
    /^[A-Za-z]:/.test(posix) ||
    posix.includes("\0") ||
    posix.split("/").some((seg) => seg === "" || seg === "." || seg === ".." || seg === ".git")
  ) {
    throw new GithubFixError(`${label}: "${p}" is not a valid repo-relative path.`);
  }
  return posix;
}

/** Git ref names cannot contain spaces, "..", "~", "^", ":" etc. Keep a safe subset. */
function sanitizeForRef(s: string): string {
  const cleaned = s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/\.{2,}/g, ".").replace(/^[-.]+|[-.]+$/g, "");
  return cleaned.slice(0, 60) || "error";
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Read a UTF-8 text file from the repo at an exact commit. Returns null if it does not exist. */
async function readRepoFile(octokit: GithubClient, cfg: RepoTarget, filePath: string, ref: string): Promise<string | null> {
  let data;
  try {
    ({ data } = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner: cfg.owner,
      repo: cfg.repo,
      path: filePath,
      ref,
    }));
  } catch (err) {
    if (httpStatus(err) === 404) return null;
    throw describeApiError(`reading ${filePath}`, err, cfg);
  }
  if (Array.isArray(data) || data.type !== "file") {
    throw new GithubFixError(`"${filePath}" in ${cfg.owner}/${cfg.repo} is not a regular file.`);
  }
  // Files over 1 MB come back without inline content; fetch the blob instead.
  let base64 = data.content;
  if (!base64) {
    try {
      base64 = (
        await octokit.request("GET /repos/{owner}/{repo}/git/blobs/{file_sha}", {
          owner: cfg.owner,
          repo: cfg.repo,
          file_sha: data.sha,
        })
      ).data.content;
    } catch (err) {
      throw describeApiError(`reading blob for ${filePath}`, err, cfg);
    }
  }
  return Buffer.from(base64, "base64").toString("utf8");
}

// ---------- main entry point ----------

/**
 * Open a draft PR with the agent's fix on a fresh `autofix/<fixId>` branch (fixId defaults to errorId):
 * commit 1 = the reproducing test only, commit 2 = the search/replace fix only.
 * If the test file already has exactly that content on the base branch, commit 1 is skipped
 * (no empty commit; testCommitSha is null) and the PR says the existing test reproduces the error.
 *
 * Everything that can fail on bad agent output (paths, search text not found or ambiguous)
 * is checked BEFORE anything is written to GitHub, so a bad fix leaves no stray branch.
 * Returns null without touching GitHub when confidence is "low".
 * Fails (HTTP 422) if the autofix/<fixId> branch already exists; it is never overwritten.
 */
export type OpenFixPrHooks = {
  /**
   * Called once all agent output is validated and BEFORE anything is written to GitHub (before the
   * branch is created). Use it to record the branch name. Errors propagate and nothing is pushed.
   */
  onBranchReady?: (info: { branch: string }) => Promise<void> | void;
  /**
   * Called after commit #1 (test only) is on the branch, before the fix commit. Errors propagate.
   * Not called when the test file is unchanged (no test commit is made).
   */
  onTestCommitted?: (info: { branch: string; testCommitSha: string }) => Promise<void> | void;
  /** URL of the CI run where the error was seen (errors.run_url); linked as evidence in the PR. */
  failingRunUrl?: string;
  /**
   * The project's GitHub App installation (projects.installation_id / repo_owner / repo_name).
   * When given, the PR is opened as the app on that repo; otherwise GITHUB_TOKEN + GITHUB_REPO are used.
   */
  installation?: { installationId: number; owner: string; repo: string };
};

/** Pick the client: GitHub App installation when given, else the GITHUB_TOKEN (PAT) fallback. */
async function resolveClient(installation: OpenFixPrHooks["installation"]): Promise<{ octokit: GithubClient; cfg: RepoTarget }> {
  if (installation) {
    const cfg: RepoTarget = { auth: "app", ...installation };
    try {
      return { octokit: await getInstallationOctokit(installation.installationId), cfg };
    } catch (err) {
      throw new GithubFixError(
        `GitHub App: could not get a client for installation ${installation.installationId}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }
  const { token, owner, repo } = getGithubConfig();
  return { octokit: new Octokit({ auth: token, userAgent: "fixtee-agent" }), cfg: { auth: "token", owner, repo } };
}

export async function openFixPr(
  output: AgentOutput,
  errorId: string,
  fixId: string = errorId,
  hooks: OpenFixPrHooks = {},
): Promise<FixPrResult | null> {
  if (output.confidence === "low") return null;

  const { octokit, cfg } = await resolveClient(hooks.installation);
  const { owner, repo } = cfg;

  // 1. Default branch and its latest commit. Pin everything to this exact SHA.
  let baseBranch: string;
  let baseCommitSha: string;
  let baseTreeSha: string;
  try {
    baseBranch = (await octokit.request("GET /repos/{owner}/{repo}", { owner, repo })).data.default_branch;
    const { data: ref } = await octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
      owner,
      repo,
      ref: `heads/${baseBranch}`,
    });
    baseCommitSha = ref.object.sha;
    baseTreeSha = (
      await octokit.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", { owner, repo, commit_sha: baseCommitSha })
    ).data.tree.sha;
  } catch (err) {
    throw describeApiError("fetching the default branch", err, cfg);
  }

  // Validate and prepare both commits up front.
  const testPath = normalizeRepoPath(output.test.file_path, "test.file_path");
  if (output.changes.length === 0) {
    throw new GithubFixError("The agent output has no changes; nothing to fix. PR not opened.");
  }

  const fixedFiles = new Map<string, string>(); // path -> new content
  for (const [i, change] of output.changes.entries()) {
    const filePath = normalizeRepoPath(change.file_path, `changes[${i}].file_path`);
    const label = `changes[${i}] (${filePath})`;
    if (filePath === testPath) {
      throw new GithubFixError(`${label}: a fix change targets the test file; test and fix must be separate. PR not opened.`);
    }
    if (change.search.length === 0) {
      throw new GithubFixError(`${label}: search text is empty. PR not opened.`);
    }
    let content = fixedFiles.get(filePath);
    if (content === undefined) {
      const remote = await readRepoFile(octokit, cfg, filePath, baseCommitSha);
      if (remote === null) {
        throw new GithubFixError(
          `${label}: file does not exist in ${owner}/${repo}@${baseBranch} (${baseCommitSha.slice(0, 7)}). ` +
            (cfg.auth === "app"
              ? "Is this project's repo the same as the local repo the agent read? PR not opened."
              : "Is GITHUB_REPO the same project as the local repo the agent read? PR not opened."),
        );
      }
      content = remote;
    }
    const n = countOccurrences(content, change.search);
    if (n !== 1) {
      throw new GithubFixError(
        `${label}: search text found ${n} times in ${owner}/${repo}@${baseBranch} (${baseCommitSha.slice(0, 7)}); ` +
          `it must match exactly once. ${n === 0 ? "The GitHub file probably differs from the local copy the agent read." : "The search text is ambiguous."} ` +
          "PR not opened.",
      );
    }
    // Function replacer so "$&", "$1" etc. in the replacement are inserted literally.
    fixedFiles.set(filePath, content.replace(change.search, () => change.replace));
  }

  // If the test file already has exactly this content, a test commit would be empty: skip it.
  const existingTest = await readRepoFile(octokit, cfg, testPath, baseCommitSha);
  const testUnchanged = existingTest === output.test.content;

  // 2. Create the branch. Never the default branch.
  const branch = `autofix/${sanitizeForRef(fixId)}`;
  if (branch === baseBranch || !branch.startsWith("autofix/")) {
    throw new GithubFixError(`Refusing to write to branch "${branch}".`);
  }
  const branchRef = `heads/${branch}`;
  await hooks.onBranchReady?.({ branch });
  try {
    await octokit.request("POST /repos/{owner}/{repo}/git/refs", { owner, repo, ref: `refs/${branchRef}`, sha: baseCommitSha });
  } catch (err) {
    throw describeApiError(`creating branch ${branch}`, err, cfg);
  }

  /** Create a commit on top of `parent` and fast-forward the autofix branch to it (never force). */
  const commitFiles = async (step: string, parent: string, parentTree: string, files: Map<string, string>, message: string) => {
    try {
      const { data: tree } = await octokit.request("POST /repos/{owner}/{repo}/git/trees", {
        owner,
        repo,
        base_tree: parentTree,
        tree: [...files].map(([p, content]) => ({ path: p, mode: "100644" as const, type: "blob" as const, content })),
      });
      const { data: commit } = await octokit.request("POST /repos/{owner}/{repo}/git/commits", {
        owner,
        repo,
        message,
        tree: tree.sha,
        parents: [parent],
      });
      await octokit.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
        owner,
        repo,
        ref: branchRef,
        sha: commit.sha,
        force: false,
      });
      return { commitSha: commit.sha, treeSha: tree.sha };
    } catch (err) {
      const e = describeApiError(step, err, cfg);
      e.message += `\nBranch ${branch} was created and may need to be deleted manually.`;
      throw e;
    }
  };

  // 3. Commit #1: only the test file. Skipped (never an empty commit) when the test is unchanged.
  let testCommit: { commitSha: string; treeSha: string } | null = null;
  if (!testUnchanged) {
    testCommit = await commitFiles(
      "committing the test",
      baseCommitSha,
      baseTreeSha,
      new Map([[testPath, output.test.content]]),
      `test: reproduce ${errorId}\n\nAdds a test that fails on ${baseBranch} (${baseCommitSha.slice(0, 7)}).\nGenerated by fixtee agent.`,
    );
    await hooks.onTestCommitted?.({ branch, testCommitSha: testCommit.commitSha });
  }

  // 4. Commit #2: only the fix.
  const fixCommit = await commitFiles(
    "committing the fix",
    testCommit?.commitSha ?? baseCommitSha,
    testCommit?.treeSha ?? baseTreeSha,
    fixedFiles,
    `fix: ${errorId}\n\n${output.root_cause}\n\nGenerated by fixtee agent.`,
  );

  // 5. Draft PR.
  const body = buildPrBody({
    output,
    errorId,
    baseCommitSha,
    testPath,
    testCommitSha: testCommit?.commitSha ?? null,
    fixCommitSha: fixCommit.commitSha,
    fixedPaths: [...fixedFiles.keys()],
    failingRunUrl: hooks.failingRunUrl,
  });

  let pr;
  try {
    ({ data: pr } = await octokit.request("POST /repos/{owner}/{repo}/pulls", {
      owner,
      repo,
      head: branch,
      base: baseBranch,
      title: buildPrTitle(output),
      body,
      draft: true,
    }));
  } catch (err) {
    const e = describeApiError("opening the draft pull request", err, cfg);
    if (httpStatus(err) === 422) e.message += "\n(Draft PRs are not available for private repos on some GitHub plans.)";
    e.message += `\nBranch ${branch} has ${testCommit ? "both commits" : "the fix commit"}; you can open the PR manually.`;
    throw e;
  }

  return {
    branch,
    prNumber: pr.number,
    prUrl: pr.html_url,
    testCommitSha: testCommit?.commitSha ?? null,
    fixCommitSha: fixCommit.commitSha,
  };
}

/**
 * PR description. Always contains the evidence: the red run link, the test file, and what the
 * fix commit has to prove. When there is no test commit it says so explicitly.
 */
export function buildPrBody(p: {
  output: AgentOutput;
  errorId: string;
  baseCommitSha: string;
  testPath: string;
  testCommitSha: string | null;
  fixCommitSha: string;
  fixedPaths: string[];
  failingRunUrl?: string;
}): string {
  const short = (sha: string) => sha.slice(0, 7);
  const code = (s: string) => `\`${s}\``;
  const failingRun = p.failingRunUrl ? p.failingRunUrl : "_(run URL not available)_";
  const fixFiles = p.fixedPaths.map(code).join(", ");

  const evidence = p.testCommitSha
    ? [
        `- **Test file:** ${code(p.testPath)} — new regression test, alone in commit ${code(short(p.testCommitSha))}.`,
        `- **Red run:** CI on the test commit ${code(short(p.testCommitSha))} must fail with the reported error ` +
          `(it is linked here once verification records it). Original failing run: ${failingRun}`,
        `- **The fix commit ${code(short(p.fixCommitSha))} must prove:** with only ${fixFiles} changed and the test untouched, ` +
          `${code(p.testPath)} passes (green run).`,
      ]
    : [
        `- ⚠️ **No test commit:** the test ${code(p.testPath)} already exists unchanged at base ${code(short(p.baseCommitSha))}, ` +
          "so the error is already reproduced by an existing test. No empty commit was made.",
        `- **Red run (existing test failing):** ${failingRun}`,
        `- **Test file:** ${code(p.testPath)} (existing, unchanged).`,
        `- **The fix commit ${code(short(p.fixCommitSha))} must prove:** with only ${fixFiles} changed and no test modified, ` +
          `${code(p.testPath)} passes (green run).`,
      ];

  const commits = p.testCommitSha
    ? [
        `1. ${code(short(p.testCommitSha))} test only: ${code(p.testPath)} (should fail on its own)`,
        `2. ${code(short(p.fixCommitSha))} fix only: ${fixFiles}`,
      ]
    : [`1. ${code(short(p.fixCommitSha))} fix only: ${fixFiles} (no test commit; see Evidence)`];

  return [
    "> 🤖 Opened automatically by the fixtee agent. Review carefully before merging.",
    "",
    "## Explanation",
    p.output.explanation,
    "",
    "## Root cause",
    p.output.root_cause,
    "",
    "## Evidence",
    ...evidence,
    "",
    "## Commits",
    ...commits,
    "",
    `**Confidence:** ${p.output.confidence}  ·  **Error ID:** ${code(p.errorId)}  ·  **Base:** ${code(short(p.baseCommitSha))}`,
  ].join("\n");
}
