export type PlannedChange = { path: string; search: string; replace: string };

export function parsePlannedChanges(value: unknown): PlannedChange[] {
  const entries = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
  const changes: PlannedChange[] = [];

  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const path =
      typeof record.path === "string"
        ? record.path
        : typeof record.file_path === "string"
          ? record.file_path
          : null;
    const search = typeof record.search === "string" ? record.search : null;
    const replace = typeof record.replace === "string" ? record.replace : null;
    if (search === null && replace === null) continue;
    changes.push({ path: path ?? "unknown file", search: search ?? "", replace: replace ?? "" });
  }

  return changes;
}

function lines(block: string): string[] {
  if (block.length === 0) return [];
  return block.replace(/\n$/, "").split("\n");
}

export function DiffView({ changes }: { changes: PlannedChange[] }) {
  if (changes.length === 0) {
    return <p className="text-sm text-zinc-500">The agent did not record a planned change.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {changes.map((change, index) => (
        <div
          key={`${change.path}-${index}`}
          className="overflow-hidden rounded-lg border border-zinc-800"
        >
          <p className="border-b border-zinc-800 bg-zinc-900 px-3 py-1.5 font-mono text-xs text-zinc-400">
            {change.path}
          </p>
          <pre className="overflow-x-auto bg-zinc-950 py-1 font-mono text-xs leading-relaxed">
            {lines(change.search).map((line, lineIndex) => (
              <div key={`minus-${lineIndex}`} className="bg-red-950/40 px-3 text-red-300">
                <span className="mr-2 inline-block w-3 text-red-500 select-none">-</span>
                {line}
              </div>
            ))}
            {lines(change.replace).map((line, lineIndex) => (
              <div key={`plus-${lineIndex}`} className="bg-emerald-950/40 px-3 text-emerald-300">
                <span className="mr-2 inline-block w-3 text-emerald-500 select-none">+</span>
                {line}
              </div>
            ))}
          </pre>
        </div>
      ))}
    </div>
  );
}
