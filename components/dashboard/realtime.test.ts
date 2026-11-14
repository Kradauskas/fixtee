import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyRealtimeChange,
  CLOSED_RECONNECT_DELAY_MS,
  didVerifyTransition,
  DISCONNECTED_POLL_MS,
  formatConnectionLabel,
  getPollIntervalMs,
  REALTIME_FALLBACK_POLL_MS,
  shouldAutoVerifyFix,
  subscribeDashboardRealtime,
  VERIFY_FALLBACK_INTERVAL_MS,
  VERIFY_PENDING_AFTER_MS,
  VERIFY_TEST_PUSHED_AFTER_MS,
  verifyFixAndSync,
  type PostgresChangePayload,
  type RealtimeChannelLike,
  type RealtimeClientLike,
  type RealtimeSubscribeStatus,
  type RealtimeTable,
} from "./realtime";
import {
  buildItems,
  type DashboardData,
  type DashboardError,
  type DashboardFix,
  type DashboardProject,
} from "./types";

const PROJECT_1 = "11111111-1111-4111-8111-111111111111";
const PROJECT_2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ERROR_1 = "22222222-2222-4222-8222-222222222222";
const ERROR_2 = "33333333-3333-4333-8333-333333333333";
const FIX_1 = "44444444-4444-4444-8444-444444444444";
const FIX_2 = "55555555-5555-4555-8555-555555555555";

const makeProject = (overrides: Partial<DashboardProject> = {}): DashboardProject => ({
  id: PROJECT_1,
  repo_owner: "octo",
  repo_name: "demo",
  default_branch: "main",
  installation_id: 7,
  llm_provider: "anthropic",
  has_llm_key: true,
  ...overrides,
});

const makeError = (overrides: Partial<DashboardError> = {}): DashboardError => ({
  id: ERROR_1,
  project_id: PROJECT_1,
  fingerprint: "fp-1",
  test_name: "calculates price",
  error_type: "TypeError",
  error_message: "boom",
  log_excerpt: null,
  file_path: "src/price.js",
  line: 10,
  commit_sha: "abc1234",
  workflow_run_id: 101,
  run_url: "https://github.com/octo/demo/actions/runs/101",
  parsed: true,
  occurrences: 1,
  first_seen: "2026-11-14T10:00:00Z",
  last_seen: "2026-11-14T10:00:00Z",
  ...overrides,
});

const makeFix = (overrides: Partial<DashboardFix> = {}): DashboardFix => ({
  id: FIX_1,
  error_id: ERROR_1,
  status: "queued",
  branch_name: `autofix/${FIX_1}`,
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
  created_at: "2026-11-14T10:00:05Z",
  updated_at: "2026-11-14T10:00:05Z",
  ...overrides,
});

describe("applyRealtimeChange", () => {
  it("handles errors INSERT, UPDATE ordering, deduplication, and unknown projects", () => {
    const older = makeError({ id: ERROR_1, last_seen: "2026-11-14T10:00:00Z" });
    const newer = makeError({
      id: ERROR_2,
      fingerprint: "fp-2",
      last_seen: "2026-11-14T10:05:00Z",
    });

    const initial: DashboardData = {
      projects: [makeProject()],
      errors: [older],
      fixes: [],
    };

    const inserted = applyRealtimeChange(initial, "errors", {
      eventType: "INSERT",
      new: newer as unknown as Record<string, unknown>,
      old: {},
    });
    expect(inserted.changed).toBe(true);
    expect(inserted.needsRefresh).toBe(false);
    expect(inserted.data.errors.map((row) => row.id)).toEqual([ERROR_2, ERROR_1]);

    // Updating the older error with a newer last_seen bubbles it back to the top.
    const bumped = { ...older, occurrences: 3, last_seen: "2026-11-14T10:10:00Z" };
    const updated = applyRealtimeChange(inserted.data, "errors", {
      eventType: "UPDATE",
      new: bumped as unknown as Record<string, unknown>,
      old: { id: ERROR_1 },
    });
    expect(updated.changed).toBe(true);
    expect(updated.data.errors.map((row) => row.id)).toEqual([ERROR_1, ERROR_2]);
    expect(updated.data.errors[0].occurrences).toBe(3);

    // Duplicate INSERT does not duplicate the row.
    const dup = applyRealtimeChange(updated.data, "errors", {
      eventType: "INSERT",
      new: bumped as unknown as Record<string, unknown>,
      old: {},
    });
    expect(dup.data.errors).toHaveLength(2);

    // An error belonging to a project not yet in memory requests a parent refresh.
    const unknownProjError = makeError({
      id: "66666666-6666-4666-8666-666666666666",
      project_id: PROJECT_2,
    });
    const otherProj = applyRealtimeChange(updated.data, "errors", {
      eventType: "INSERT",
      new: unknownProjError as unknown as Record<string, unknown>,
      old: {},
    });
    expect(otherProj.needsRefresh).toBe(true);
  });

  it("handles errors DELETE and cascades removal of orphaned fixes", () => {
    const data: DashboardData = {
      projects: [makeProject()],
      errors: [makeError({ id: ERROR_1 }), makeError({ id: ERROR_2, fingerprint: "fp-2" })],
      fixes: [makeFix({ id: FIX_1, error_id: ERROR_1 }), makeFix({ id: FIX_2, error_id: ERROR_2 })],
    };

    const result = applyRealtimeChange(data, "errors", {
      eventType: "DELETE",
      new: {},
      old: { id: ERROR_1 },
    });

    expect(result.changed).toBe(true);
    expect(result.data.errors.map((row) => row.id)).toEqual([ERROR_2]);
    expect(result.data.fixes.map((row) => row.id)).toEqual([FIX_2]);

    const noop = applyRealtimeChange(result.data, "errors", {
      eventType: "DELETE",
      new: {},
      old: { id: ERROR_1 },
    });
    expect(noop.changed).toBe(false);
    expect(noop.data).toBe(result.data);
  });

  it("streams queued -> analyzing -> test_pushed -> fix_pushed -> verified transitions immediately", () => {
    let data: DashboardData = {
      projects: [makeProject()],
      errors: [makeError({ id: ERROR_1 })],
      fixes: [],
    };

    const queued = makeFix({ status: "queued" });
    const insertRes = applyRealtimeChange(data, "fixes", {
      eventType: "INSERT",
      new: queued as unknown as Record<string, unknown>,
      old: {},
    });
    expect(insertRes.changed).toBe(true);
    expect(insertRes.needsRefresh).toBe(false);
    data = insertRes.data;
    expect(buildItems(data, PROJECT_1)[0].fix?.status).toBe("queued");

    const stages: Partial<DashboardFix>[] = [
      { status: "analyzing" },
      { status: "test_pushed", test_commit_sha: "aaaa1111", ai_reasoning: "root cause" },
      {
        status: "fix_pushed",
        fix_commit_sha: "bbbb2222",
        red_run_url: "https://github.com/octo/demo/actions/runs/201",
        pr_number: 12,
        pr_url: "https://github.com/octo/demo/pull/12",
        confidence: "0.9" as unknown as number,
      },
      {
        status: "verified",
        green_run_url: "https://github.com/octo/demo/actions/runs/202",
        tokens_used: 4100,
      },
    ];

    let current = { ...queued };
    for (const patch of stages) {
      current = { ...current, ...patch };
      const res = applyRealtimeChange(data, "fixes", {
        eventType: "UPDATE",
        new: current as unknown as Record<string, unknown>,
        old: { id: FIX_1 },
      });
      data = res.data;
      const item = buildItems(data, PROJECT_1)[0];
      expect(item.fix?.status).toBe(patch.status);
    }

    const finalFix = buildItems(data, PROJECT_1)[0].fix!;
    expect(finalFix.confidence).toBe(0.9);
    expect(finalFix.green_run_url).toBe("https://github.com/octo/demo/actions/runs/202");
  });

  it("keeps newest fix first by created_at and handles fixes DELETE and missing parent error", () => {
    const olderFix = makeFix({ id: FIX_1, created_at: "2026-11-14T10:00:00Z", status: "failed" });
    const newerFix = makeFix({ id: FIX_2, created_at: "2026-11-14T10:05:00Z", status: "queued" });

    const data: DashboardData = {
      projects: [makeProject()],
      errors: [makeError({ id: ERROR_1 })],
      fixes: [olderFix],
    };

    const inserted = applyRealtimeChange(data, "fixes", {
      eventType: "INSERT",
      new: newerFix as unknown as Record<string, unknown>,
      old: {},
    });
    expect(buildItems(inserted.data, PROJECT_1)[0].fix?.id).toBe(FIX_2);

    const orphan = applyRealtimeChange(inserted.data, "fixes", {
      eventType: "INSERT",
      new: makeFix({ id: "orphan-fix", error_id: ERROR_2 }) as unknown as Record<string, unknown>,
      old: {},
    });
    expect(orphan.needsRefresh).toBe(true);

    const deleted = applyRealtimeChange(inserted.data, "fixes", {
      eventType: "DELETE",
      new: {},
      old: { id: FIX_2 },
    });
    expect(deleted.changed).toBe(true);
    expect(buildItems(deleted.data, PROJECT_1)[0].fix?.id).toBe(FIX_1);
  });
});

describe("connection status & polling interval", () => {
  it("formats connection labels including SUBSCRIBED and Reconnecting states", () => {
    expect(
      formatConnectionLabel({
        signedIn: false,
        sessionExpired: false,
        offline: false,
        realtimeStatus: "signed_out",
      }),
    ).toBe("Demo · not signed in");

    expect(
      formatConnectionLabel({
        signedIn: true,
        sessionExpired: false,
        offline: false,
        realtimeStatus: "connecting",
      }),
    ).toBe("Connecting…");

    expect(
      formatConnectionLabel({
        signedIn: true,
        sessionExpired: false,
        offline: false,
        realtimeStatus: "subscribed",
      }),
    ).toBe("Live · SUBSCRIBED");

    expect(
      formatConnectionLabel({
        signedIn: true,
        sessionExpired: false,
        offline: false,
        realtimeStatus: "reconnecting",
      }),
    ).toBe("Reconnecting…");

    expect(
      formatConnectionLabel({
        signedIn: true,
        sessionExpired: true,
        offline: false,
        realtimeStatus: "subscribed",
      }),
    ).toBe("Signed out");

    expect(
      formatConnectionLabel({
        signedIn: true,
        sessionExpired: false,
        offline: true,
        realtimeStatus: "reconnecting",
      }),
    ).toBe("Offline");
  });

  it("slows polling interval to fallback cadence when SUBSCRIBED", () => {
    expect(getPollIntervalMs("subscribed")).toBe(REALTIME_FALLBACK_POLL_MS);
    expect(getPollIntervalMs("reconnecting")).toBe(DISCONNECTED_POLL_MS);
    expect(getPollIntervalMs("connecting")).toBe(DISCONNECTED_POLL_MS);
    expect(getPollIntervalMs("unavailable")).toBe(DISCONNECTED_POLL_MS);
  });
});

describe("verification gating and load-on-transition", () => {
  it("never hammers POST /api/verify for active test_pushed fixes and respects cooldown", () => {
    const baseNow = Date.parse("2026-11-14T12:00:00Z");

    // 5s after test_pushed: webhooks handle it -> do not verify.
    expect(
      shouldAutoVerifyFix(
        { status: "test_pushed", updated_at: new Date(baseNow - 5_000).toISOString() },
        baseNow,
        undefined,
      ),
    ).toBe(false);

    // 60s after test_pushed: still within webhook grace period -> do not verify.
    expect(
      shouldAutoVerifyFix(
        { status: "test_pushed", updated_at: new Date(baseNow - 60_000).toISOString() },
        baseNow,
        undefined,
      ),
    ).toBe(false);

    // Stale test_pushed (>= VERIFY_TEST_PUSHED_AFTER_MS) falls back cleanly, respecting cooldown.
    const staleUpdatedAt = new Date(baseNow - VERIFY_TEST_PUSHED_AFTER_MS - 1_000).toISOString();
    expect(
      shouldAutoVerifyFix({ status: "test_pushed", updated_at: staleUpdatedAt }, baseNow, undefined),
    ).toBe(true);
    expect(
      shouldAutoVerifyFix(
        { status: "test_pushed", updated_at: staleUpdatedAt },
        baseNow,
        baseNow - 5_000,
      ),
    ).toBe(false);
    expect(
      shouldAutoVerifyFix(
        { status: "test_pushed", updated_at: staleUpdatedAt },
        baseNow,
        baseNow - VERIFY_FALLBACK_INTERVAL_MS,
      ),
    ).toBe(true);

    // fix_pushed waits briefly for webhooks then falls back once per cooldown.
    expect(
      shouldAutoVerifyFix(
        { status: "fix_pushed", updated_at: new Date(baseNow - 3_000).toISOString() },
        baseNow,
        undefined,
      ),
    ).toBe(false);
    expect(
      shouldAutoVerifyFix(
        { status: "fix_pushed", updated_at: new Date(baseNow - VERIFY_PENDING_AFTER_MS).toISOString() },
        baseNow,
        undefined,
      ),
    ).toBe(true);

    // Non-pending statuses are never auto-verified.
    expect(
      shouldAutoVerifyFix(
        { status: "verified", updated_at: new Date(baseNow - 500_000).toISOString() },
        baseNow,
        undefined,
      ),
    ).toBe(false);
  });

  it("detects transitions and triggers load() when requestVerify transitions a fix", async () => {
    expect(
      didVerifyTransition(
        { status: "test_pushed", red_run_url: null, green_run_url: null },
        { status: "test_pushed", testRunUrl: null, fixRunUrl: null },
      ),
    ).toBe(false);

    expect(
      didVerifyTransition(
        { status: "test_pushed", red_run_url: null, green_run_url: null },
        { status: "test_failed", testRunUrl: "https://example.test/red", fixRunUrl: null },
      ),
    ).toBe(true);

    const onTransitioned = vi.fn(async () => {});
    const onSessionExpired = vi.fn();
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          status: "verified",
          testRunUrl: "https://example.test/red",
          fixRunUrl: "https://example.test/green",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const changed = await verifyFixAndSync({
      fixId: FIX_1,
      previous: makeFix({ status: "fix_pushed", red_run_url: "https://example.test/red" }),
      fetchImpl: fetchMock as unknown as typeof fetch,
      onTransitioned,
      onSessionExpired,
    });
    expect(changed).toBe(true);
    expect(onTransitioned).toHaveBeenCalledTimes(1);

    // When /api/verify reports no transition, load() is not called.
    const unchangedFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ status: "test_pushed", testRunUrl: null, fixRunUrl: null }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const unchanged = await verifyFixAndSync({
      fixId: FIX_1,
      previous: makeFix({ status: "test_pushed" }),
      fetchImpl: unchangedFetch as unknown as typeof fetch,
      onTransitioned,
      onSessionExpired,
    });
    expect(unchanged).toBe(false);
    expect(onTransitioned).toHaveBeenCalledTimes(1);

    // 401 marks session expired cleanly.
    const expiredFetch = vi.fn(async () => new Response("{}", { status: 401 }));
    await verifyFixAndSync({
      fixId: FIX_1,
      previous: makeFix({ status: "fix_pushed" }),
      fetchImpl: expiredFetch as unknown as typeof fetch,
      onTransitioned,
      onSessionExpired,
    });
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });
});

type FakeChannelRecord = {
  name: string;
  handlers: Record<RealtimeTable, ((payload: PostgresChangePayload) => void) | undefined>;
  statusCallback?: (status: RealtimeSubscribeStatus, err?: Error) => void;
};

function createFakeRealtimeClient() {
  const channels: FakeChannelRecord[] = [];
  const removed: unknown[] = [];

  const client: RealtimeClientLike<RealtimeChannelLike> = {
    channel(name: string) {
      const record: FakeChannelRecord = {
        name,
        handlers: { errors: undefined, fixes: undefined },
      };
      channels.push(record);

      const channel: RealtimeChannelLike = {
        on(_type, filter, callback) {
          record.handlers[filter.table] = callback;
          return channel;
        },
        subscribe(callback) {
          record.statusCallback = callback;
          return channel;
        },
      };
      return channel;
    },
    async removeChannel(channel) {
      removed.push(channel);
      return "ok";
    },
  };

  return { client, channels, removed };
}

describe("subscribeDashboardRealtime", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("subscribes to public.errors and public.fixes, tracks status, and syncs on reconnect", () => {
    vi.useFakeTimers();
    const { client, channels, removed } = createFakeRealtimeClient();
    const statuses: string[] = [];
    const changes: Array<{ table: RealtimeTable; eventType: string }> = [];
    const syncs = vi.fn();

    const cleanup = subscribeDashboardRealtime(client, {
      syncOnInitialSubscribe: false,
      onStatusChange: (status) => statuses.push(status),
      onChange: (table, payload) => changes.push({ table, eventType: payload.eventType }),
      onReconnectSync: syncs,
      closedRetryDelayMs: CLOSED_RECONNECT_DELAY_MS,
    });

    expect(channels).toHaveLength(1);
    expect(channels[0].handlers.errors).toBeTypeOf("function");
    expect(channels[0].handlers.fixes).toBeTypeOf("function");

    // First healthy SUBSCRIBED does not trigger redundant sync.
    channels[0].statusCallback?.("SUBSCRIBED");
    expect(statuses).toEqual(["subscribed"]);
    expect(syncs).toHaveBeenCalledTimes(0);

    // Realtime change arrives immediately.
    channels[0].handlers.fixes?.({
      eventType: "UPDATE",
      new: makeFix({ status: "verified" }) as unknown as Record<string, unknown>,
      old: { id: FIX_1 },
    });
    expect(changes).toEqual([{ table: "fixes", eventType: "UPDATE" }]);

    // Drop -> Reconnecting -> SUBSCRIBED triggers reconnect sync.
    channels[0].statusCallback?.("CHANNEL_ERROR", new Error("socket lost"));
    expect(statuses).toEqual(["subscribed", "reconnecting"]);

    channels[0].statusCallback?.("SUBSCRIBED");
    expect(statuses).toEqual(["subscribed", "reconnecting", "subscribed"]);
    expect(syncs).toHaveBeenCalledTimes(1);

    // Unexpected CLOSED tears down old channel and opens a fresh uniquely named channel.
    channels[0].statusCallback?.("CLOSED");
    expect(statuses.at(-1)).toBe("reconnecting");

    vi.advanceTimersByTime(CLOSED_RECONNECT_DELAY_MS);
    expect(removed).toHaveLength(1);
    expect(channels).toHaveLength(2);
    expect(channels[1].name).not.toBe(channels[0].name);

    channels[1].statusCallback?.("SUBSCRIBED");
    expect(syncs).toHaveBeenCalledTimes(2);
    expect(statuses.at(-1)).toBe("subscribed");

    // Stale events on cleaned-up channel are ignored after unmount.
    cleanup();
    expect(removed).toHaveLength(2);
    channels[1].handlers.errors?.({ eventType: "INSERT", new: {}, old: {} });
    expect(changes).toHaveLength(1);
  });

  it("reconciles missed initial data on first SUBSCRIBED when initial load had an error", () => {
    const { client, channels } = createFakeRealtimeClient();
    const syncs = vi.fn();

    const cleanup = subscribeDashboardRealtime(client, {
      syncOnInitialSubscribe: true,
      onStatusChange: () => {},
      onChange: () => {},
      onReconnectSync: syncs,
    });

    channels[0].statusCallback?.("SUBSCRIBED");
    expect(syncs).toHaveBeenCalledTimes(1);
    cleanup();
  });
});
