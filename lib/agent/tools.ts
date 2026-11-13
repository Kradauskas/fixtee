import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

/** Thrown for any path the agent is not allowed to touch. Message is safe to show the model. */
export class PathAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathAccessError";
  }
}

const MAX_FILE_BYTES = 200_000;
const MAX_SEARCH_RESULTS = 50;
const MAX_LIST_ENTRIES = 500;

/** Path segments that must never be read or listed. */
function isBlockedSegment(segment: string): boolean {
  return (
    segment === "node_modules" ||
    segment === ".git" ||
    segment === ".env" ||
    segment.startsWith(".env.")
  );
}

/**
 * Resolve a model-supplied, repo-relative path to an absolute path inside `repoRoot`.
 * Rejects absolute paths, `..` escapes, symlinks pointing outside the root,
 * and blocked locations (node_modules, .env, .git).
 */
export async function resolveSafePath(repoRoot: string, requested: string): Promise<string> {
  if (typeof requested !== "string") {
    throw new PathAccessError("Path must be a string.");
  }
  const trimmed = requested.trim() === "" ? "." : requested.trim();

  if (trimmed.includes("\0")) {
    throw new PathAccessError("Path contains a null byte.");
  }
  if (path.isAbsolute(trimmed) || path.win32.isAbsolute(trimmed)) {
    throw new PathAccessError(`Absolute paths are not allowed: "${requested}". Use a path relative to the repo root.`);
  }

  const root = await realpath(path.resolve(repoRoot));
  const resolved = path.resolve(root, trimmed);
  assertInsideRoot(root, resolved, requested);

  const rel = path.relative(root, resolved);
  if (rel !== "" && rel.split(path.sep).some(isBlockedSegment)) {
    throw new PathAccessError(`Access denied: "${requested}" (node_modules, .git and .env files are off limits).`);
  }

  // Follow symlinks for paths that exist and re-check the real location.
  let real: string;
  try {
    real = await realpath(resolved);
  } catch {
    return resolved; // does not exist; callers report "not found"
  }
  assertInsideRoot(root, real, requested);
  const realRel = path.relative(root, real);
  if (realRel !== "" && realRel.split(path.sep).some(isBlockedSegment)) {
    throw new PathAccessError(`Access denied: "${requested}" resolves to a blocked location.`);
  }
  return real;
}

function assertInsideRoot(root: string, candidate: string, requested: string): void {
  const rel = path.relative(root, candidate);
  if (rel === "") return;
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new PathAccessError(`Path escapes the repository root: "${requested}".`);
  }
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

// ---------- read_file ----------

const ReadFileInput = z.object({ path: z.string() });

async function readFileTool(repoRoot: string, raw: unknown): Promise<string> {
  const { path: p } = ReadFileInput.parse(raw);
  const abs = await resolveSafePath(repoRoot, p);
  let info;
  try {
    info = await stat(abs);
  } catch {
    throw new Error(`File not found: "${p}".`);
  }
  if (info.isDirectory()) throw new Error(`"${p}" is a directory; use list_dir instead.`);
  if (info.size > MAX_FILE_BYTES) throw new Error(`"${p}" is too large (${info.size} bytes, limit ${MAX_FILE_BYTES}).`);

  const content = await readFile(abs, "utf8");
  const numbered = content
    .split("\n")
    .map((line, i) => `${String(i + 1).padStart(4, " ")}| ${line}`)
    .join("\n");
  return `File: ${p}\n${numbered}`;
}

// ---------- list_dir ----------

const ListDirInput = z.object({ path: z.string().optional() });

async function listDirTool(repoRoot: string, raw: unknown): Promise<string> {
  const { path: p = "." } = ListDirInput.parse(raw ?? {});
  const abs = await resolveSafePath(repoRoot, p);
  let entries;
  try {
    entries = await readdir(abs, { withFileTypes: true });
  } catch {
    throw new Error(`Directory not found: "${p}".`);
  }
  const visible = entries
    .filter((e) => !isBlockedSegment(e.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_LIST_ENTRIES)
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
  return visible.length === 0 ? `(empty directory: ${p})` : visible.join("\n");
}

// ---------- search_code ----------

const SearchCodeInput = z.object({
  query: z.string().min(1),
  path: z.string().optional(),
});

async function* walkFiles(root: string, dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (isBlockedSegment(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(root, full);
    } else if (entry.isFile()) {
      yield full; // symlinks are skipped on purpose
    }
  }
}

async function searchCodeTool(repoRoot: string, raw: unknown): Promise<string> {
  const { query, path: p = "." } = SearchCodeInput.parse(raw);
  const root = await realpath(path.resolve(repoRoot));
  const start = await resolveSafePath(repoRoot, p);

  const matches: string[] = [];
  for await (const file of walkFiles(root, start)) {
    const info = await stat(file);
    if (info.size > MAX_FILE_BYTES) continue;
    const content = await readFile(file, "utf8");
    if (content.includes("\0")) continue; // binary
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.includes(query)) {
        matches.push(`${toPosix(path.relative(root, file))}:${i + 1}: ${lines[i]!.trim()}`);
        if (matches.length >= MAX_SEARCH_RESULTS) {
          return `${matches.join("\n")}\n(results truncated at ${MAX_SEARCH_RESULTS})`;
        }
      }
    }
  }
  return matches.length === 0 ? `No matches for "${query}".` : matches.join("\n");
}

// ---------- registry ----------

export const toolDefinitions: Anthropic.Beta.BetaTool[] = [
  {
    name: "read_file",
    description:
      "Read a text file from the repository. Returns the content with line numbers prefixed (the 'NNNN| ' prefix is not part of the file). Path is relative to the repo root.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "Repo-relative file path, e.g. src/price.js" } },
      required: ["path"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "list_dir",
    description: "List entries of a directory in the repository. Directories end with '/'. Path is relative to the repo root; omit for the root.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "Repo-relative directory path; defaults to '.'" } },
      required: [],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "search_code",
    description: "Search repository files for a literal (case-sensitive) substring. Returns matching lines as path:line: text.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Literal text to search for" },
        path: { type: "string", description: "Optional repo-relative directory to limit the search to" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    strict: true,
  },
];

type ToolHandler = (repoRoot: string, input: unknown) => Promise<string>;

const handlers: Record<string, ToolHandler> = {
  read_file: readFileTool,
  list_dir: listDirTool,
  search_code: searchCodeTool,
};

export function isReadTool(name: string): boolean {
  return name in handlers;
}

/** Run a read-only tool. Returns `{ content, isError }` — never throws for model-caused errors. */
export async function runTool(
  repoRoot: string,
  name: string,
  input: unknown,
): Promise<{ content: string; isError: boolean }> {
  const handler = handlers[name];
  if (!handler) return { content: `Unknown tool: ${name}`, isError: true };
  try {
    return { content: await handler(repoRoot, input), isError: false };
  } catch (err) {
    if (err instanceof z.ZodError) {
      return { content: `Invalid input for ${name}: ${z.prettifyError(err)}`, isError: true };
    }
    return { content: err instanceof Error ? err.message : String(err), isError: true };
  }
}
