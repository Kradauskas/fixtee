import { afterEach, describe, expect, it, vi } from "vitest";
import type { VerificationResult } from "../verify/state-machine";
import { type VerifyByBranch, type WorkflowRunContext, fixIdFromBranch, handleAutofixRun } from "./failed-run";

const FIX_ID = "f3ac06c4-8f52-4aa2-b893-2f6b407b7ba7";
const PROJECT_ID = "5624ebdd-87da-45b5-ae78-9ed0a2927a1c";
const HEAD_SHA = "f88ce47000000000000000000000000000000000";
const RUN_URL = "https://github.com/Symantas/fixtee-test/actions/runs/43494480530";

function ctx(over: Partial<WorkflowRunContext> = {}): WorkflowRunContext {
  return {
    deliveryId: "d-1",
    projectId: PROJECT_ID,
    installationId: 181698186,
    owner: "Symantas",
    repo: "fixtee-test",
    runId: 43494480530,
    runAttempt: 1,
    runUrl: RUN_URL,
    headSha: HEAD_SHA,
    headBranch: `autofix/${FIX_ID}`,
    conclusion: "success",
    workflowName: "test",
    ...over,
  };
}

const verified: VerificationResult = {
  status: "verified",
  outcome: "verified",
  testRunUrl: "https://github.com/x/y/actions/runs/1",
  fixRunUrl: "https://github.com/x/y/actions/runs/2",
  commented: true,
  markedReadyForReview: true,
};

afterEach(() => vi.restoreAllMocks());

describe("fixIdFromBranch", () => {
  it("reads the fix id from autofix/<uuid>", () => {
    expect(fixIdFromBranch(`autofix/${FIX_ID}`)).toBe(FIX_ID);
    expect(fixIdFromBranch(`autofix/${FIX_ID.toUpperCase()}`)).toBe(FIX_ID);
  });

  it.each([null, "main", "autofix/", "autofix/123", `autofix/${FIX_ID}/x`, `feature/autofix/${FIX_ID}`])(
    "rejects %s",
    (branch) => expect(fixIdFromBranch(branch)).toBeNull(),
  );
});

describe("handleAutofixRun", () => {
  it("asks Role 3's verifyFixByBranch to verify the fix in this project with the run hint", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const verify = vi.fn<VerifyByBranch>(async () => verified);
    await handleAutofixRun(ctx(), verify);
    expect(verify).toHaveBeenCalledExactlyOnceWith({
      projectId: PROJECT_ID,
      branchName: `autofix/${FIX_ID}`,
      headSha: HEAD_SHA,
      conclusion: "success",
      runUrl: RUN_URL,
    });
  });

  it("verifies on failure conclusions too (the red run)", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const verify = vi.fn(async () => ({ ...verified, status: "fix_pushed" as const, outcome: "test_reproduced" as const }));
    await handleAutofixRun(ctx({ conclusion: "failure" }), verify, []);
    expect(verify).toHaveBeenCalledOnce();
  });

  it("looks again when GitHub's run list lags the webhook, until the fix settles", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const pending = { ...verified, status: "fix_pushed" as const, outcome: "test_reproduced" as const };
    const verify = vi.fn().mockResolvedValueOnce(pending).mockResolvedValueOnce(verified);
    await handleAutofixRun(ctx(), verify, [0, 0]);
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it.each(["timed_out", "startup_failure", "action_required"])(
    "treats %s as a final conclusion eligible for retries",
    async (conclusion) => {
      vi.spyOn(console, "info").mockImplementation(() => {});
      const pending = { ...verified, status: "fix_pushed" as const, outcome: "test_reproduced" as const };
      const failed = { ...verified, status: "failed" as const, outcome: "fix_failed_ci" as const };
      const verify = vi.fn().mockResolvedValueOnce(pending).mockResolvedValueOnce(failed);
      await handleAutofixRun(ctx({ conclusion }), verify, [0, 0]);
      expect(verify).toHaveBeenCalledTimes(2);
    },
  );

  it("gives up after the retry delays if the fix still isn't settled", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const pending = { ...verified, status: "fix_pushed" as const, outcome: "test_reproduced" as const };
    const verify = vi.fn(async () => pending);
    await handleAutofixRun(ctx(), verify, [0, 0]);
    expect(verify).toHaveBeenCalledTimes(3);
  });

  it("doesn't retry runs without a final conclusion (e.g. cancelled)", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const pending = { ...verified, status: "fix_pushed" as const, outcome: "test_reproduced" as const };
    const verify = vi.fn(async () => pending);
    await handleAutofixRun(ctx({ conclusion: "cancelled" }), verify, [0, 0]);
    expect(verify).toHaveBeenCalledOnce();
  });

  it("skips malformed autofix branches without calling verify", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const verify = vi.fn(async () => verified);
    await handleAutofixRun(ctx({ headBranch: "autofix/not-a-uuid" }), verify);
    expect(verify).not.toHaveBeenCalled();
    expect(info.mock.calls[0][0]).toMatch(/malformed branch/);
  });

  it("logs and stops when no fix is awaiting verification (unknown or already settled)", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await handleAutofixRun(ctx(), async () => null);
    expect(info.mock.calls[0][0]).toMatch(/unknown or settled fix/);
  });

  it("never throws when verification fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      handleAutofixRun(ctx(), async () => {
        throw new Error("GitHub down");
      }),
    ).resolves.toBeUndefined();
    expect(error.mock.calls[0][0]).toMatch(/fix verification failed/);
  });
});
