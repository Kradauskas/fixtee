import type { DashboardError, DashboardFix, Item } from "./types";

export const DEMO_REPOSITORY = "fixtee/demo-repo";

const AT = "2026-11-13T18:51:00Z";

function demoError(error: Partial<DashboardError> & { id: string }): DashboardError {
  return {
    project_id: "demo",
    fingerprint: error.id,
    test_name: null,
    error_type: null,
    error_message: null,
    log_excerpt: null,
    file_path: null,
    line: null,
    commit_sha: "a7f3c21",
    workflow_run_id: 192837461,
    run_url: `https://github.com/${DEMO_REPOSITORY}/actions/runs/192837461`,
    parsed: true,
    occurrences: 1,
    first_seen: AT,
    last_seen: AT,
    ...error,
  } as DashboardError;
}

function demoFix(fix: Partial<DashboardFix> & { id: string; error_id: string }): DashboardFix {
  return {
    status: "queued",
    branch_name: `autofix/${fix.error_id}`,
    pr_number: null,
    pr_url: null,
    test_commit_sha: null,
    fix_commit_sha: null,
    red_run_url: null,
    green_run_url: null,
    ai_reasoning: null,
    confidence: null,
    tokens_used: null,
    planned_changes: null,
    created_at: AT,
    updated_at: AT,
    ...fix,
  } as DashboardFix;
}

export const DEMO_ITEMS: Item[] = [
  {
    demo: true,
    durations: [6, 14, 12],
    error: demoError({
      id: "err_001",
      error_message: "Incorrect percentage calculation in applyDiscount",
      file_path: "src/price.js",
      line: 2,
      error_type: "AssertionError",
      occurrences: 3,
      log_excerpt:
        "FAIL  src/price.discount.test.js\n  ● applyDiscount › applies a percentage discount\n\n    expect(received).toBe(expected)\n\n    Expected: 80\n    Received: 99.8\n\n      4 | test(\"applies a percentage discount\", () => {\n    > 5 |   expect(applyDiscount(100, 20)).toBe(80);\n        |                                  ^\n      6 | });\n\nTest Suites: 1 failed, 1 total\nTests:       1 failed, 4 passed, 5 total",
    }),
    fix: demoFix({
      id: "fix_001",
      error_id: "err_001",
      status: "verified",
      pr_number: 2,
      pr_url: `https://github.com/${DEMO_REPOSITORY}/pull/2`,
      test_commit_sha: "cd593f5a1b2c3d4e5f60718293a4b5c6d7e8f901",
      fix_commit_sha: "89ab079c1d2e3f405162738495a6b7c8d9e0f123",
      red_run_url: `https://github.com/${DEMO_REPOSITORY}/actions/runs/43456825573`,
      green_run_url: `https://github.com/${DEMO_REPOSITORY}/actions/runs/43456832092`,
      confidence: 0.96,
      tokens_used: 2847,
      ai_reasoning:
        "The discount formula subtracts the percentage as a decimal instead of taking a percentage of the price. For a price of 100 and a discount of 20%, it subtracts 0.2 and returns 99.8 instead of 80.\n\nMultiplying the price by the percentage before dividing by 100 fixes the root cause. The isolated reproduction failed on the test commit; every check passed on the fix commit.",
      planned_changes: [
        {
          path: "src/price.js",
          search: "return price - percent / 100;",
          replace: "return price - (price * percent) / 100;",
        },
      ],
    }),
  },
  {
    demo: true,
    error: demoError({
      id: "err_002",
      commit_sha: "e4b8d09",
      error_message: "Undefined taxRate when applying a coupon",
      file_path: "src/cart.js",
      line: 44,
      error_type: "TypeError",
      log_excerpt:
        "TypeError: Cannot read properties of undefined (reading 'taxRate')\n    at calculateTotal (src/cart.js:44:28)\n    at applyCoupon (src/cart.js:61:12)\n\nTests: 1 failed, 12 passed",
    }),
    fix: demoFix({
      id: "fix_002",
      error_id: "err_002",
      status: "test_pushed",
      pr_number: 3,
      pr_url: `https://github.com/${DEMO_REPOSITORY}/pull/3`,
      test_commit_sha: "fa8b291c3d4e5f6071829304a5b6c7d8e9f01234",
      confidence: 0.89,
      tokens_used: 1920,
      ai_reasoning:
        "Applying a coupon drops the cart configuration before calculateTotal reads taxRate. A reproduction test covers the coupon path. Waiting for the failing CI check before pushing the fix.",
      planned_changes: [
        {
          path: "src/cart.js",
          search: "const tax = config.taxRate;",
          replace: "const tax = config?.taxRate ?? 0;",
        },
      ],
    }),
  },
  {
    demo: true,
    error: demoError({
      id: "err_003",
      commit_sha: "b1c6f82",
      error_message: "Race condition in session token expiry",
      file_path: "src/auth/token.js",
      line: 19,
      last_seen: "2026-11-13T18:25:00Z",
      log_excerpt:
        "PASS src/auth/token.expiry.test.js\n\nReproduction test passed before fix.\nGUARDRAIL: no deterministic reproduction.\nPR remains Draft. Manual investigation required.",
    }),
    fix: demoFix({
      id: "fix_003",
      error_id: "err_003",
      status: "failed",
      pr_number: 4,
      pr_url: `https://github.com/${DEMO_REPOSITORY}/pull/4`,
      test_commit_sha: "cc71b02d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7081",
      confidence: 0.42,
      tokens_used: 3210,
      ai_reasoning:
        "The session expiry race could not be reproduced deterministically. The reproduction test passed without any code change, so Fixtee blocked the fix and kept the PR as a draft rather than send an unproven change to review.",
      planned_changes: [],
    }),
  },
];

export function reproductionFor(item: Item): string | null {
  if (!item.demo) return null;
  if (item.error.file_path === "src/price.js") {
    return "import { applyDiscount } from './price';\n\ndescribe('applyDiscount', () => {\n  test('applies a percentage discount', () => {\n    expect(applyDiscount(100, 20)).toBe(80);\n  });\n\n  test('handles a zero discount', () => {\n    expect(applyDiscount(100, 0)).toBe(100);\n  });\n});";
  }
  if (item.error.file_path === "src/cart.js") {
    return "import { applyCoupon } from './cart';\n\ntest('preserves tax configuration with a coupon', () => {\n  const cart = { total: 100, config: { taxRate: 0.2 } };\n  expect(() => applyCoupon(cart, 'SAVE20')).not.toThrow();\n});";
  }
  return "import { isExpired } from './token';\n\ntest('expires the session at the boundary', () => {\n  jest.useFakeTimers();\n  jest.setSystemTime(new Date('2026-11-13T12:00:00Z'));\n  expect(isExpired({ expiresAt: Date.now() })).toBe(true);\n  jest.useRealTimers();\n});";
}

export function testFileName(item: Item): string {
  const path = item.error.file_path;
  if (!path) return "reproduction.test.js";
  return path.replace(/\.(m?[jt]sx?)$/, ".test.$1");
}
