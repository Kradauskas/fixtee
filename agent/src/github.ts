import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { Octokit } from "@octokit/rest";
import type { AgentOutput } from "./types.js";

const agentDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadEnv({ path: path.join(agentDir, ".env"), quiet: true });

export type FixPrResult = {
  branch: string;
  prNumber: number;
  prUrl: string;
  testCommitSha: string;
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

export type GithubConfig ={ token: string; owner: string; repo: string };

/** Thrown for every problem in the GitHub flow. The message says what went wrong and what to do. */
export class GithubFixError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubFixError";
  }
}

const ENV_HELP = [
  "To fix this:",
  "  1. Open agent/.env (copy it from agent/.env.example if it does not exist).",
  "  2. Set GITHUB_TOKEN=<token>  — a fine-grained token with access to this repo only and",
  "     permissions: Contents (read & write) and Pull requests (read & write).",
  "     Create one at https://github.com/settings/personal-access-tokens/new",
  "  3. Set GITHUB_REPO=owner/name  — the repository the fix PR is opened against.",
].join("\n");

/** Read and validate GITHUB_TOKEN and GITHUB_REPO from agent/.env (or the environment). */
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

/** Turn an Octokit error into a readable GithubFixError for the given step. */
function describeApiError(step: string, err: unknown, cfg: GithubConfig): GithubFixError {
  const status = httpStatus(err);
  const detail = err instanceof Error ? err.message : String(err);
  const repo = `${cfg.owner}/${cfg.repo}`;
  let hint = "";
  if (status === 401) hint = "GITHUB_TOKEN is invalid or expired. Create a new token and update agent/.env.";
  else if (status === 403) hint = `The token lacks permission on ${repo}. It needs Contents and Pull requests: read & write.`;
  else if (status === 404) hint = `Not found. Check that GITHUB_REPO=${repo} is correct and that the token has access to it.`;
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

function timestamp(d = new Date()): string {
  // 2026-11-13T16:54:07.123Z -> 20261113-165407
  return d.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Read a UTF-8 text file from the repo at an exact commit. Returns null if it does not exist. */
async function readRepoFile(octokit: Octokit, cfg: GithubConfig, filePath: string, ref: string): Promise<string | null> {
  let data;
  try {
    ({ data } = await octokit.rest.repos.getContent({ owner: cfg.owner, repo: cfg.repo, path: filePath, ref }));
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
      base64 = (await octokit.rest.git.getBlob({ owner: cfg.owner, repo: cfg.repo, file_sha: data.sha })).data.content;
    } catch (err) {
      throw describeApiError(`reading blob for ${filePath}`, err, cfg);
    }
  }
  return Buffer.from(base64, "base64").toString("utf8");
}

// ---------- main entry point ----------

/**
 * Open a draft PR with the agent's fix on a fresh `ai-fix/<errorId>-<time>` branch:
 * commit 1 = the reproducing test only, commit 2 = the search/replace fix only.
 *
 * Everything that can fail on bad agent output (paths, search text not found or ambiguous)
 * is checked BEFORE anything is written to GitHub, so a bad fix leaves no stray branch.
 * Returns null without touching GitHub when confidence is "low".
 */
export async function openFixPr(output: AgentOutput, errorId: string): Promise<FixPrResult | null> {
  if (output.confidence === "low") return null;

  const cfg = getGithubConfig();
  const octokit = new Octokit({ auth: cfg.token, userAgent: "fixtee-agent" });
  const { owner, repo } = cfg;

  // 1. Default branch and its latest commit. Pin everything to this exact SHA.
  let baseBranch: string;
  let baseCommitSha: string;
  let baseTreeSha: string;
  try {
    baseBranch = (await octokit.rest.repos.get({ owner, repo })).data.default_branch;
    const { data: ref } = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${baseBranch}` });
    baseCommitSha = ref.object.sha;
    baseTreeSha = (await octokit.rest.git.getCommit({ owner, repo, commit_sha: baseCommitSha })).data.tree.sha;
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
            "Is GITHUB_REPO the same project as the local repo the agent read? PR not opened.",
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

  // 2. Create the branch. Never the default branch.
  const branch = `ai-fix/${sanitizeForRef(errorId)}-${timestamp()}`;
  if (branch === baseBranch || !branch.startsWith("ai-fix/")) {
    throw new GithubFixError(`Refusing to write to branch "${branch}".`);
  }
  const branchRef = `heads/${branch}`;
  try {
    await octokit.rest.git.createRef({ owner, repo, ref: `refs/${branchRef}`, sha: baseCommitSha });
  } catch (err) {
    throw describeApiError(`creating branch ${branch}`, err, cfg);
  }

  /** Create a commit on top of `parent` and fast-forward the ai-fix branch to it (never force). */
  const commitFiles = async (step: string, parent: string, parentTree: string, files: Map<string, string>, message: string) => {
    try {
      const { data: tree } = await octokit.rest.git.createTree({
        owner,
        repo,
        base_tree: parentTree,
        tree: [...files].map(([p, content]) => ({ path: p, mode: "100644" as const, type: "blob" as const, content })),
      });
      const { data: commit } = await octokit.rest.git.createCommit({ owner, repo, message, tree: tree.sha, parents: [parent] });
      await octokit.rest.git.updateRef({ owner, repo, ref: branchRef, sha: commit.sha, force: false });
      return { commitSha: commit.sha, treeSha: tree.sha };
    } catch (err) {
      const e = describeApiError(step, err, cfg);
      e.message += `\nBranch ${branch} was created and may need to be deleted manually.`;
      throw e;
    }
  };

  // 3. Commit #1: only the test file.
  const testCommit = await commitFiles(
    "committing the test",
    baseCommitSha,
    baseTreeSha,
    new Map([[testPath, output.test.content]]),
    `test: reproduce ${errorId}\n\nAdds a test that fails on ${baseBranch} (${baseCommitSha.slice(0, 7)}).\nGenerated by fixtee agent.`,
  );

  // 4. Commit #2: only the fix.
  const fixCommit = await commitFiles(
    "committing the fix",
    testCommit.commitSha,
    testCommit.treeSha,
    fixedFiles,
    `fix: ${errorId}\n\n${output.root_cause}\n\nGenerated by fixtee agent.`,
  );

  // 5. Draft PR.
  const body = [
    "> 🤖 Opened automatically by the fixtee agent. Review carefully before merging.",
    "",
    "## Explanation",
    output.explanation,
    "",
    "## Root cause",
    output.root_cause,
    "",
    "## Commits",
    `1. \`${testCommit.commitSha.slice(0, 7)}\` test only: \`${testPath}\` (should fail on its own)`,
    `2. \`${fixCommit.commitSha.slice(0, 7)}\` fix only: ${[...fixedFiles.keys()].map((p) => `\`${p}\``).join(", ")}`,
    "",
    `**Confidence:** ${output.confidence}  ·  **Error ID:** \`${errorId}\`  ·  **Base:** \`${baseCommitSha.slice(0, 7)}\``,
  ].join("\n");

  let pr;
  try {
    ({ data: pr } = await octokit.rest.pulls.create({
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
    e.message += `\nBranch ${branch} has both commits; you can open the PR manually.`;
    throw e;
  }

  return {
    branch,
    prNumber: pr.number,
    prUrl: pr.html_url,
    testCommitSha: testCommit.commitSha,
    fixCommitSha: fixCommit.commitSha,
  };
}
