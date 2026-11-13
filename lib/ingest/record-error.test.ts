import { describe, expect, it } from "vitest";
import { fingerprint } from "./fingerprint";
import { type ErrorRecord, type ErrorStore, recordError } from "./record-error";

const PROJECT = "11111111-1111-1111-1111-111111111111";

/** In-memory errors + fixes tables with the same unique rule as the DB. */
function fakeStore() {
  const errors = new Map<string, { id: string; occurrences: number; commitSha: string }>();
  const fixes: { id: string; errorId: string; status: string }[] = [];
  let n = 0;
  const store: ErrorStore = {
    async insertError(e) {
      const key = `${e.projectId}|${e.fingerprint}`;
      if (errors.has(key)) return null;
      const id = `err-${++n}`;
      errors.set(key, { id, occurrences: 1, commitSha: e.commitSha });
      return id;
    },
    async bumpError(e) {
      const row = errors.get(`${e.projectId}|${e.fingerprint}`)!;
      row.occurrences += 1;
      row.commitSha = e.commitSha;
      return row.id;
    },
    async hasActiveFix(errorId) {
      return fixes.some(
        (f) => f.errorId === errorId && ["queued", "analyzing", "test_pushed", "test_failed", "fix_pushed"].includes(f.status),
      );
    },
    async queueFix(errorId) {
      if (await store.hasActiveFix(errorId)) return null; // same rule as the partial unique index
      const id = `fix-${++n}`;
      fixes.push({ id, errorId, status: "queued" });
      return id;
    },
  };
  return { store, errors, fixes };
}

function record(over: Partial<ErrorRecord> = {}): ErrorRecord {
  return {
    projectId: PROJECT,
    fingerprint: "fp-1",
    testName: "cartTotal › subtracts the discount",
    errorType: "AssertionError",
    errorMessage: "expect(received).toBe(expected)",
    logExcerpt: "…",
    filePath: "src/cart.test.js",
    line: 9,
    commitSha: "aaa",
    workflowRunId: 1,
    runUrl: "https://github.com/o/r/actions/runs/1",
    parsed: true,
    ...over,
  };
}

describe("recordError", () => {
  it("same failure twice: one row, occurrences 2, one queued fix", async () => {
    const { store, errors, fixes } = fakeStore();
    const first = await recordError(store, record());
    const second = await recordError(store, record({ commitSha: "bbb", workflowRunId: 2 }));

    expect(first).toMatchObject({ isNew: true, fixId: expect.any(String) });
    expect(second).toEqual({ errorId: first.errorId, isNew: false, fixId: null });
    expect(errors.size).toBe(1);
    expect([...errors.values()][0]).toMatchObject({ occurrences: 2, commitSha: "bbb" });
    expect(fixes).toHaveLength(1);
  });

  it("queues a new fix when the previous one is final (verified/failed)", async () => {
    const { store, fixes } = fakeStore();
    const first = await recordError(store, record());
    fixes[0].status = "failed";
    const again = await recordError(store, record());
    expect(again).toMatchObject({ errorId: first.errorId, isNew: false, fixId: expect.any(String) });
    expect(fixes).toHaveLength(2);
  });

  it("lost race: another run queued a fix first, so no fix and no agent start", async () => {
    const { store, fixes } = fakeStore();
    const first = await recordError(store, record());
    // Simulate the race: our hasActiveFix check ran before the other run's insert landed.
    const racing: ErrorStore = { ...store, hasActiveFix: async () => false };
    const second = await recordError(racing, record({ workflowRunId: 2 }));
    expect(second).toEqual({ errorId: first.errorId, isNew: false, fixId: null });
    expect(fixes).toHaveLength(1);
  });

  it("different failures get separate rows and fixes", async () => {
    const { store, errors, fixes } = fakeStore();
    await recordError(store, record({ fingerprint: "fp-1" }));
    await recordError(store, record({ fingerprint: "fp-2" }));
    expect(errors.size).toBe(2);
    expect(fixes).toHaveLength(2);
  });
});

describe("fingerprint", () => {
  const parsed = { parsed: true, filePath: "src/cart.test.js", testName: "t", errorType: "AssertionError" };

  it("ignores line, message and job/workflow names for parsed failures", () => {
    expect(fingerprint(PROJECT, parsed, "CI", "test")).toBe(fingerprint(PROJECT, parsed, "Other", "node-20"));
  });

  it("differs per project, file, test and error type", () => {
    const base = fingerprint(PROJECT, parsed, null, "j");
    expect(fingerprint("other", parsed, null, "j")).not.toBe(base);
    expect(fingerprint(PROJECT, { ...parsed, filePath: "x.js" }, null, "j")).not.toBe(base);
    expect(fingerprint(PROJECT, { ...parsed, testName: "u" }, null, "j")).not.toBe(base);
    expect(fingerprint(PROJECT, { ...parsed, errorType: "TypeError" }, null, "j")).not.toBe(base);
  });

  it("unparsed failures use workflow + job name", () => {
    const u = { parsed: false, filePath: null, testName: null, errorType: null };
    expect(fingerprint(PROJECT, u, "CI", "build")).toBe(fingerprint(PROJECT, u, "CI", "build"));
    expect(fingerprint(PROJECT, u, "CI", "build")).not.toBe(fingerprint(PROJECT, u, "CI", "lint"));
  });

  it("separator prevents concatenation collisions", () => {
    const a = { ...parsed, filePath: "ab", testName: "c" };
    const b = { ...parsed, filePath: "a", testName: "bc" };
    expect(fingerprint(PROJECT, a, null, "j")).not.toBe(fingerprint(PROJECT, b, null, "j"));
  });
});
