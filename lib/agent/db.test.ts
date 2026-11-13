import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FixRow, FixStatus } from "./db";

const store = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));

/**
 * Tiny in-memory stand-in for the Supabase query builder: supports
 * from().update().eq().is().in().select().maybeSingle() and from().select().eq().maybeSingle().
 */
vi.mock("@/lib/db/supabase", () => ({
  getServiceClient: () => ({
    from: () => {
      const filters: ((row: Record<string, unknown>) => boolean)[] = [];
      let values: Record<string, unknown> | null = null;
      const builder = {
        update(v: Record<string, unknown>) {
          values = v;
          return builder;
        },
        select: () => builder,
        eq(col: string, v: unknown) {
          filters.push((r) => r[col] === v);
          return builder;
        },
        is(col: string, v: unknown) {
          filters.push((r) => (r[col] ?? null) === v);
          return builder;
        },
        in(col: string, vs: unknown[]) {
          filters.push((r) => vs.includes(r[col]));
          return builder;
        },
        async maybeSingle() {
          const row = store.rows.find((r) => filters.every((f) => f(r)));
          if (row && values) Object.assign(row, values);
          return { data: row ? { ...row } : null, error: null };
        },
      };
      return builder;
    },
  }),
}));

const { updateFix, canAdvanceStatus } = await import("./db");

function seed(status: FixStatus, extra: Partial<FixRow> = {}) {
  store.rows = [{ id: "fix-1", status, red_run_url: null, green_run_url: null, branch_name: null, ...extra }];
}

const ORDER: FixStatus[] = ["queued", "analyzing", "test_pushed", "test_failed", "fix_pushed", "verified"];

beforeEach(() => {
  store.rows = [];
});

describe("status never decreases", () => {
  it("canAdvanceStatus only allows strictly later steps", () => {
    for (const [i, from] of ORDER.entries()) {
      for (const [j, to] of ORDER.entries()) {
        expect(canAdvanceStatus(from, to), `${from} -> ${to}`).toBe(j > i);
      }
    }
  });

  it("failed never replaces fix_pushed/verified and is never left", () => {
    expect(canAdvanceStatus("analyzing", "failed")).toBe(true);
    expect(canAdvanceStatus("test_pushed", "failed")).toBe(true);
    expect(canAdvanceStatus("fix_pushed", "failed")).toBe(false);
    expect(canAdvanceStatus("verified", "failed")).toBe(false);
    for (const to of ORDER) expect(canAdvanceStatus("failed", to)).toBe(false);
  });

  it("the post-push update keeps verified and the run URLs set by verification", async () => {
    seed("verified", { red_run_url: "https://red", green_run_url: "https://green" });
    const row = await updateFix("fix-1", {
      status: "fix_pushed",
      fix_commit_sha: "abc",
      pr_number: 7,
      pr_url: "https://github.com/o/r/pull/7",
    });
    expect(row.status).toBe("verified");
    expect(row.red_run_url).toBe("https://red");
    expect(row.green_run_url).toBe("https://green");
    expect(row.pr_number).toBe(7);
    expect(row.pr_url).toBe("https://github.com/o/r/pull/7");
    expect(row.fix_commit_sha).toBe("abc");
  });

  it("test_pushed does not overwrite test_failed set by verification", async () => {
    seed("test_failed");
    const row = await updateFix("fix-1", { status: "test_pushed", test_commit_sha: "t1" });
    expect(row.status).toBe("test_failed");
    expect(row.test_commit_sha).toBe("t1");
  });

  it("moves forward normally", async () => {
    seed("test_pushed");
    expect((await updateFix("fix-1", { status: "fix_pushed" })).status).toBe("fix_pushed");
  });

  it("failed after fix_pushed is ignored", async () => {
    seed("fix_pushed");
    expect((await updateFix("fix-1", { status: "failed" })).status).toBe("fix_pushed");
  });
});

describe("red_run_url", () => {
  it("is set when empty", async () => {
    seed("analyzing");
    expect((await updateFix("fix-1", { red_run_url: "https://run/1" })).red_run_url).toBe("https://run/1");
  });

  it("is not overwritten once set by someone else", async () => {
    seed("test_failed", { red_run_url: "https://run/verified" });
    expect((await updateFix("fix-1", { red_run_url: "https://run/1" })).red_run_url).toBe("https://run/verified");
  });
});

it("throws when the fix does not exist", async () => {
  await expect(updateFix("missing", { branch_name: "autofix/x" })).rejects.toThrow("fix not found");
});
