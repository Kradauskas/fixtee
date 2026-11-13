/**
 * Turn a raw GitHub Actions job log into the first Jest failure, shaped for the `errors` table.
 * Jest only for now. Pure and never throws: anything unrecognised comes back as parsed: false.
 */

export type ParsedFailure = {
  parsed: boolean;
  testName: string | null;
  errorType: string | null;
  errorMessage: string | null;
  filePath: string | null;
  line: number | null;
  logExcerpt: string;
};

const EXCERPT_LINES = 40;
const UNPARSED_TAIL_LINES = 80;

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const FAILURE = /^\s*● (.+)$/;
const ERROR_LINE = /^\s*((?:[A-Z][A-Za-z]*)?(?:Error|Exception))(?: \[[^\]]+\])?: ?(.*)$/;
const EXPECT_LINE = /^\s*expect\(/;
const STACK = /^\s*at (?:.*? \()?(.+?):(\d+):\d+\)?\s*$/;
// Jest's end-of-run summary: stop the excerpt and the failure search here.
const SUMMARY = /^(Test Suites:|Tests:|Snapshots:|Time:|Ran all test suites)/;

export function cleanLog(raw: string): string[] {
  return raw
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(TIMESTAMP, "").replace(ANSI, "").replace(/^##\[(?:error|warning)\]/, ""))
    .filter((l) => !/^##\[(?:end)?group\]/.test(l));
}

/** Repo-relative path, or null if the frame isn't in the repo's own files. */
export function repoPath(file: string, repo: string): string | null {
  let p = file.replace(/\\/g, "/").replace(/^file:\/\//, "");
  if (p.startsWith("node:") || p.includes("/node_modules/") || p.startsWith("node_modules/")) return null;
  const runner = `/home/runner/work/${repo}/${repo}/`;
  if (p.startsWith(runner)) p = p.slice(runner.length);
  else if (p.startsWith("/")) return null; // some other absolute path: not ours
  p = p.replace(/^\.\//, "");
  return p.length > 0 && !p.startsWith("internal/") ? p : null;
}

export function parseJestLog(raw: string, repo: string): ParsedFailure {
  try {
    return parse(cleanLog(raw), repo);
  } catch {
    return unparsed(cleanLog(String(raw)));
  }
}

function parse(lines: string[], repo: string): ParsedFailure {
  const start = lines.findIndex((l) => FAILURE.test(l));
  if (start < 0) return unparsed(lines);

  const testName = FAILURE.exec(lines[start])![1].trim();
  let end = start + 1;
  while (end < lines.length && !FAILURE.test(lines[end]) && !SUMMARY.test(lines[end].trim())) end++;
  const block = lines.slice(start + 1, end);

  let errorType: string | null = null;
  let errorMessage: string | null = null;
  const errIdx = block.findIndex((l) => ERROR_LINE.test(l) || EXPECT_LINE.test(l));
  if (errIdx >= 0) {
    const m = ERROR_LINE.exec(block[errIdx]);
    if (m) {
      errorType = m[1];
      errorMessage = m[2].trim() || null;
    } else {
      // expect(...) block: matcher line plus the Expected/Received lines, up to the code frame.
      errorType = "AssertionError";
      const msg: string[] = [];
      for (const l of block.slice(errIdx)) {
        if (/^\s*(>?\s*\d+ \||at )/.test(l)) break;
        msg.push(l.trim());
      }
      errorMessage = trimBlank(msg).join("\n") || null;
    }
  }

  let filePath: string | null = null;
  let line: number | null = null;
  for (const l of block) {
    const m = STACK.exec(l);
    const p = m && repoPath(m[1], repo);
    if (p) {
      filePath = p;
      line = Number(m![2]);
      break;
    }
  }

  const excerpt = trimBlank(lines.slice(start, Math.min(end, start + EXCERPT_LINES)));
  return {
    parsed: true,
    testName,
    errorType,
    errorMessage,
    filePath,
    line,
    logExcerpt: excerpt.join("\n"),
  };
}

function unparsed(lines: string[]): ParsedFailure {
  // Drop GitHub's post-job cleanup so the tail ends at the actual error.
  const cleanup = lines.findIndex((l) => l.trim() === "Post job cleanup.");
  if (cleanup >= 0) lines = lines.slice(0, cleanup);
  return {
    parsed: false,
    testName: null,
    errorType: null,
    errorMessage: null,
    filePath: null,
    line: null,
    logExcerpt: trimBlank(lines).slice(-UNPARSED_TAIL_LINES).join("\n"),
  };
}

function trimBlank(lines: string[]): string[] {
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  return lines.slice(a, b);
}
