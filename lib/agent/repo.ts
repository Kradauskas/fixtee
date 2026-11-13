import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
// Relative (not "@/") so vitest, which has no path alias configured, can import this module.
import { getInstallationOctokit } from "../github/app";

/**
 * Read-only checkout of a project's repo at one commit: download GitHub's tarball for the ref and
 * unpack it into a fresh temp dir. The agent's read tools then use that dir as repoRoot.
 *
 * The archive is untrusted input, so extraction is done here by hand and only creates regular
 * files and directories: symlinks, hard links, devices etc. are skipped, and every path must stay
 * inside the target dir. Sizes are capped so a huge repo fails fast instead of filling the disk.
 */

export const MAX_TARBALL_BYTES = 100 * 1024 * 1024; // compressed
export const MAX_EXTRACTED_BYTES = 500 * 1024 * 1024;
export const MAX_ENTRIES = 50_000;

export class RepoCheckoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoCheckoutError";
  }
}

export type RepoCheckout = {
  /** Absolute path of the repo root (the tarball's single top-level dir is stripped). */
  root: string;
  /** Delete the temp dir. Safe to call more than once; never throws. */
  cleanup: () => Promise<void>;
};

type InstallationOctokit = Awaited<ReturnType<typeof getInstallationOctokit>>;

function httpStatus(err: unknown): number | undefined {
  return typeof err === "object" && err !== null && "status" in err && typeof err.status === "number"
    ? err.status
    : undefined;
}

/** Download owner/repo@ref as a tarball via the installation client. */
async function downloadTarball(octokit: InstallationOctokit, owner: string, repo: string, ref: string): Promise<Buffer> {
  let data: unknown;
  try {
    ({ data } = await octokit.request("GET /repos/{owner}/{repo}/tarball/{ref}", { owner, repo, ref }));
  } catch (err) {
    const status = httpStatus(err);
    const detail = err instanceof Error ? err.message : String(err);
    const hint =
      status === 404
        ? ` Check that ${owner}/${repo} exists, that commit ${ref} is in it, and that the app installation can read it.`
        : "";
    throw new RepoCheckoutError(`GitHub: downloading ${owner}/${repo}@${ref} failed${status ? ` (HTTP ${status})` : ""}: ${detail}.${hint}`);
  }
  let buf: Buffer;
  if (data instanceof ArrayBuffer) buf = Buffer.from(data);
  else if (ArrayBuffer.isView(data)) buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  else throw new RepoCheckoutError(`GitHub: unexpected tarball response for ${owner}/${repo}@${ref}.`);
  if (buf.length > MAX_TARBALL_BYTES) {
    throw new RepoCheckoutError(`${owner}/${repo}@${ref} tarball is too large (${buf.length} bytes, limit ${MAX_TARBALL_BYTES}).`);
  }
  return buf;
}

// ---------- tar extraction ----------

const BLOCK = 512;

function readString(block: Buffer, offset: number, length: number): string {
  const raw = block.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString("utf8");
}

function readOctal(block: Buffer, offset: number, length: number): number {
  const s = readString(block, offset, length).trim();
  if (s === "") return 0;
  if (!/^[0-7]+$/.test(s)) throw new RepoCheckoutError(`Corrupt tar header (bad number "${s}").`);
  return parseInt(s, 8);
}

/** Parse a pax extended header body ("<len> key=value\n" records) into a map. */
function parsePax(body: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let pos = 0;
  while (pos < body.length) {
    const space = body.indexOf(0x20, pos);
    if (space === -1) break;
    const len = parseInt(body.subarray(pos, space).toString("ascii"), 10);
    if (!Number.isFinite(len) || len <= 0 || pos + len > body.length) break;
    const record = body.subarray(space + 1, pos + len - 1).toString("utf8"); // drop trailing \n
    const eq = record.indexOf("=");
    if (eq > 0) out.set(record.slice(0, eq), record.slice(eq + 1));
    pos += len;
  }
  return out;
}

/**
 * Map an archive path to a safe path relative to the repo root, dropping the first component
 * (GitHub tarballs wrap everything in "<owner>-<repo>-<sha>/"). Returns null for the wrapper dir
 * itself and throws for anything that would escape the root.
 */
function toRepoRelative(archivePath: string): string | null {
  if (archivePath.includes("\0") || archivePath.includes("\\")) {
    throw new RepoCheckoutError(`Unsafe path in tarball: "${archivePath}".`);
  }
  const parts = archivePath.split("/").filter((p) => p !== "" && p !== ".");
  if (archivePath.startsWith("/") || parts.some((p) => p === "..")) {
    throw new RepoCheckoutError(`Unsafe path in tarball: "${archivePath}".`);
  }
  const rest = parts.slice(1);
  return rest.length === 0 ? null : rest.join("/");
}

/**
 * Extract a (gzipped) tar archive into `dest`, stripping the top-level dir.
 * Only regular files and directories are created; everything else is skipped.
 */
export async function extractTarball(archive: Buffer, dest: string): Promise<void> {
  let tar: Buffer;
  try {
    tar = archive[0] === 0x1f && archive[1] === 0x8b ? gunzipSync(archive, { maxOutputLength: MAX_EXTRACTED_BYTES + 64 * 1024 * 1024 }) : archive;
  } catch (err) {
    throw new RepoCheckoutError(`Could not decompress tarball: ${err instanceof Error ? err.message : String(err)}`);
  }

  const root = path.resolve(dest);
  let offset = 0;
  let entries = 0;
  let written = 0;
  let pendingPath: string | undefined; // from a pax 'x' or GNU 'L' header, applies to the next entry
  const madeDirs = new Set<string>();

  const ensureDir = async (dir: string) => {
    if (madeDirs.has(dir)) return;
    await mkdir(dir, { recursive: true });
    madeDirs.add(dir);
  };

  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((b) => b === 0)) break; // end-of-archive marker

    const size = readOctal(header, 124, 12);
    const type = String.fromCharCode(header[156] ?? 0);
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new RepoCheckoutError("Truncated tarball.");
    const body = tar.subarray(dataStart, dataEnd);
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (type === "x") {
      pendingPath = parsePax(body).get("path") ?? pendingPath;
      continue;
    }
    if (type === "L") {
      pendingPath = readString(body, 0, body.length);
      continue;
    }
    if (type === "g") continue; // global pax header (GitHub puts the commit sha here)

    if (++entries > MAX_ENTRIES) throw new RepoCheckoutError(`Tarball has more than ${MAX_ENTRIES} entries.`);

    let name = pendingPath;
    pendingPath = undefined;
    if (name === undefined) {
      const base = readString(header, 0, 100);
      const isUstar = readString(header, 257, 6).startsWith("ustar");
      const prefix = isUstar ? readString(header, 345, 155) : "";
      name = prefix ? `${prefix}/${base}` : base;
    }

    const rel = toRepoRelative(name);
    if (rel === null) continue;
    const target = path.resolve(root, rel);
    const relCheck = path.relative(root, target);
    if (relCheck === "" || relCheck === ".." || relCheck.startsWith(`..${path.sep}`) || path.isAbsolute(relCheck)) {
      throw new RepoCheckoutError(`Unsafe path in tarball: "${name}".`);
    }

    if (type === "5") {
      await ensureDir(target);
    } else if (type === "0" || type === "\0" || type === "7") {
      written += size;
      if (written > MAX_EXTRACTED_BYTES) {
        throw new RepoCheckoutError(`Repo is too large to check out (over ${MAX_EXTRACTED_BYTES} bytes extracted).`);
      }
      await ensureDir(path.dirname(target));
      // "wx": never overwrite or follow something already there (e.g. a duplicate entry).
      await writeFile(target, body, { flag: "wx", mode: 0o644 });
    }
    // Symlinks ('2'), hard links ('1'), devices, FIFOs, etc.: skipped on purpose.
  }
}

/**
 * Download owner/repo at `ref` using the project's GitHub App installation and unpack it into a
 * new temp dir. Always call `cleanup()` (in a finally) when done.
 */
export async function checkoutRepo(opts: {
  installationId: number;
  owner: string;
  repo: string;
  ref: string;
}): Promise<RepoCheckout> {
  const { installationId, owner, repo, ref } = opts;
  let octokit: InstallationOctokit;
  try {
    octokit = await getInstallationOctokit(installationId);
  } catch (err) {
    throw new RepoCheckoutError(
      `GitHub App: could not get a client for installation ${installationId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const archive = await downloadTarball(octokit, owner, repo, ref);
  const tmp = await mkdtemp(path.join(os.tmpdir(), "fixtee-repo-"));
  const cleanup = () => rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  try {
    const root = path.join(tmp, "repo");
    await mkdir(root);
    await extractTarball(archive, root);
    return { root, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}
