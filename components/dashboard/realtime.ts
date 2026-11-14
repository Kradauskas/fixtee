import {
  isPendingVerification,
  type DashboardData,
  type DashboardError,
  type DashboardFix,
  type FixStatus,
} from "./types";

export type RealtimeStatus =
  | "signed_out"
  | "connecting"
  | "subscribed"
  | "reconnecting"
  | "unavailable";

export const REALTIME_FALLBACK_POLL_MS = 30_000;
export const DISCONNECTED_POLL_MS = 10_000;
export const VERIFY_FALLBACK_INTERVAL_MS = 30_000;
export const VERIFY_PENDING_AFTER_MS = 15_000;
export const VERIFY_TEST_PUSHED_AFTER_MS = 120_000;
export const CLOSED_RECONNECT_DELAY_MS = 5_000;

export type RealtimeTable = "errors" | "fixes";

export type PostgresChangePayload = {
  eventType: string;
  new: Record<string, unknown>;
  old: Record<string, unknown>;
};

export type RealtimeApplyResult = {
  data: DashboardData;
  changed: boolean;
  needsRefresh: boolean;
};

export type VerifyApiResponse = {
  status: FixStatus;
  testRunUrl: string | null;
  fixRunUrl: string | null;
};

function timestampMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

function normalizeErrorRow(raw: Record<string, unknown>): DashboardError | null {
  if (typeof raw.id !== "string" || typeof raw.project_id !== "string") return null;
  return raw as unknown as DashboardError;
}

function normalizeFixRow(raw: Record<string, unknown>): DashboardFix | null {
  if (typeof raw.id !== "string" || typeof raw.error_id !== "string" || typeof raw.status !== "string") {
    return null;
  }
  const rawConfidence = raw.confidence;
  const confidence =
    typeof rawConfidence === "number"
      ? rawConfidence
      : typeof rawConfidence === "string" &&
          rawConfidence.trim() !== "" &&
          Number.isFinite(Number(rawConfidence))
        ? Number(rawConfidence)
        : null;

  return {
    ...(raw as unknown as DashboardFix),
    confidence,
  };
}

function sortErrors(errors: DashboardError[]): DashboardError[] {
  return [...errors].sort((a, b) => timestampMs(b.last_seen) - timestampMs(a.last_seen));
}

function sortFixes(fixes: DashboardFix[]): DashboardFix[] {
  return [...fixes].sort((a, b) => timestampMs(b.created_at) - timestampMs(a.created_at));
}

export function applyRealtimeChange(
  data: DashboardData,
  table: RealtimeTable,
  payload: PostgresChangePayload,
): RealtimeApplyResult {
  if (table === "errors") {
    if (payload.eventType === "DELETE") {
      const deletedId = payload.old.id;
      if (typeof deletedId !== "string" || deletedId.length === 0) {
        return { data, changed: false, needsRefresh: false };
      }
      const nextErrors = data.errors.filter((row) => row.id !== deletedId);
      const nextFixes = data.fixes.filter((row) => row.error_id !== deletedId);
      if (nextErrors.length === data.errors.length && nextFixes.length === data.fixes.length) {
        return { data, changed: false, needsRefresh: false };
      }
      return {
        data: { ...data, errors: nextErrors, fixes: nextFixes },
        changed: true,
        needsRefresh: false,
      };
    }

    if (payload.eventType === "INSERT" || payload.eventType === "UPDATE") {
      const row = normalizeErrorRow(payload.new);
      if (!row) return { data, changed: false, needsRefresh: false };
      const exists = data.errors.some((entry) => entry.id === row.id);
      const nextErrors = exists
        ? data.errors.map((entry) => (entry.id === row.id ? row : entry))
        : [row, ...data.errors];
      const knownProject = data.projects.some((project) => project.id === row.project_id);
      return {
        data: { ...data, errors: sortErrors(nextErrors) },
        changed: true,
        needsRefresh: !knownProject,
      };
    }

    return { data, changed: false, needsRefresh: false };
  }

  if (payload.eventType === "DELETE") {
    const deletedId = payload.old.id;
    if (typeof deletedId !== "string" || deletedId.length === 0) {
      return { data, changed: false, needsRefresh: false };
    }
    const nextFixes = data.fixes.filter((row) => row.id !== deletedId);
    if (nextFixes.length === data.fixes.length) {
      return { data, changed: false, needsRefresh: false };
    }
    return {
      data: { ...data, fixes: nextFixes },
      changed: true,
      needsRefresh: false,
    };
  }

  if (payload.eventType === "INSERT" || payload.eventType === "UPDATE") {
    const row = normalizeFixRow(payload.new);
    if (!row) return { data, changed: false, needsRefresh: false };
    const exists = data.fixes.some((entry) => entry.id === row.id);
    const nextFixes = exists
      ? data.fixes.map((entry) => (entry.id === row.id ? row : entry))
      : [row, ...data.fixes];
    const hasParentError = data.errors.some((entry) => entry.id === row.error_id);
    return {
      data: { ...data, fixes: sortFixes(nextFixes) },
      changed: true,
      needsRefresh: !hasParentError,
    };
  }

  return { data, changed: false, needsRefresh: false };
}

export function formatConnectionLabel({
  signedIn,
  sessionExpired,
  offline,
  realtimeStatus,
}: {
  signedIn: boolean;
  sessionExpired: boolean;
  offline: boolean;
  realtimeStatus: RealtimeStatus;
}): string {
  if (!signedIn) return "Demo · not signed in";
  if (sessionExpired) return "Signed out";
  if (offline) return "Offline";
  switch (realtimeStatus) {
    case "subscribed":
      return "Live · SUBSCRIBED";
    case "reconnecting":
      return "Reconnecting…";
    case "unavailable":
      return "Live · Fallback polling";
    case "connecting":
    case "signed_out":
      return "Connecting…";
  }
}

export function getPollIntervalMs(realtimeStatus: RealtimeStatus): number {
  return realtimeStatus === "subscribed" ? REALTIME_FALLBACK_POLL_MS : DISCONNECTED_POLL_MS;
}

export function didVerifyTransition(
  previous: Pick<DashboardFix, "status" | "red_run_url" | "green_run_url"> | undefined,
  result: VerifyApiResponse,
): boolean {
  if (!previous) return true;
  if (result.status !== previous.status) return true;
  if (result.testRunUrl && result.testRunUrl !== previous.red_run_url) return true;
  if (result.status === "verified" && result.fixRunUrl && result.fixRunUrl !== previous.green_run_url) {
    return true;
  }
  return false;
}

export function shouldAutoVerifyFix(
  fix: Pick<DashboardFix, "status" | "updated_at">,
  nowMs: number,
  lastCheckedAtMs: number | undefined,
): boolean {
  if (!isPendingVerification(fix.status)) return false;
  if (lastCheckedAtMs !== undefined && nowMs - lastCheckedAtMs < VERIFY_FALLBACK_INTERVAL_MS) {
    return false;
  }

  const updatedAtMs = timestampMs(fix.updated_at);
  const ageMs = updatedAtMs > 0 ? Math.max(0, nowMs - updatedAtMs) : Number.POSITIVE_INFINITY;

  // Webhooks normally transition `test_pushed` runs (and the agent pushes the fix commit right
  // after), so avoid hammering POST /api/verify until a long staleness window elapses.
  if (fix.status === "test_pushed") {
    return ageMs >= VERIFY_TEST_PUSHED_AFTER_MS;
  }

  return ageMs >= VERIFY_PENDING_AFTER_MS;
}

export async function verifyFixAndSync({
  fixId,
  previous,
  fetchImpl = fetch,
  onTransitioned,
  onSessionExpired,
}: {
  fixId: string;
  previous: Pick<DashboardFix, "status" | "red_run_url" | "green_run_url"> | undefined;
  fetchImpl?: typeof fetch;
  onTransitioned: () => Promise<void> | void;
  onSessionExpired: () => void;
}): Promise<boolean> {
  try {
    const response = await fetchImpl("/api/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fixId }),
    });
    if (response.status === 401) {
      onSessionExpired();
      return false;
    }
    if (!response.ok) return false;
    const body = (await response.json()) as VerifyApiResponse;
    if (didVerifyTransition(previous, body)) {
      await onTransitioned();
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export type RealtimeSubscribeStatus = "SUBSCRIBED" | "TIMED_OUT" | "CLOSED" | "CHANNEL_ERROR";

export interface RealtimeChannelLike {
  on(
    type: "postgres_changes",
    filter: { event: "*"; schema: "public"; table: RealtimeTable },
    callback: (payload: PostgresChangePayload) => void,
  ): this;
  subscribe(callback?: (status: RealtimeSubscribeStatus, err?: Error) => void): this;
}

export interface RealtimeClientLike<TChannel extends RealtimeChannelLike = RealtimeChannelLike> {
  channel(name: string): TChannel;
  removeChannel(channel: TChannel): Promise<unknown>;
}

let channelSeq = 0;

export type SubscribeDashboardRealtimeOptions = {
  syncOnInitialSubscribe: boolean;
  onStatusChange: (status: RealtimeStatus) => void;
  onChange: (table: RealtimeTable, payload: PostgresChangePayload) => void;
  onReconnectSync: () => void;
  onErrorLog?: (message: string, err?: Error) => void;
  closedRetryDelayMs?: number;
};

export function subscribeDashboardRealtime<TChannel extends RealtimeChannelLike>(
  supabase: RealtimeClientLike<TChannel>,
  options: SubscribeDashboardRealtimeOptions,
): () => void {
  let cancelled = false;
  let hasConnectedOnce = false;
  let shouldSyncOnSubscribe = options.syncOnInitialSubscribe;
  let activeChannel: TChannel | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const closedRetryDelayMs = options.closedRetryDelayMs ?? CLOSED_RECONNECT_DELAY_MS;

  const clearRetryTimer = () => {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  const connect = () => {
    if (cancelled) return;
    clearRetryTimer();
    channelSeq += 1;
    const channel = supabase
      .channel(`dashboard-realtime-${channelSeq}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "errors" },
        (payload) => {
          if (cancelled) return;
          options.onChange("errors", payload);
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "fixes" },
        (payload) => {
          if (cancelled) return;
          options.onChange("fixes", payload);
        },
      );

    activeChannel = channel;
    channel.subscribe((status, err) => {
      if (cancelled || activeChannel !== channel) return;

      if (status === "SUBSCRIBED") {
        clearRetryTimer();
        options.onStatusChange("subscribed");
        if (hasConnectedOnce || shouldSyncOnSubscribe) {
          shouldSyncOnSubscribe = false;
          options.onReconnectSync();
        }
        hasConnectedOnce = true;
        return;
      }

      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        if (err) options.onErrorLog?.(`dashboard: realtime ${status}`, err);
        shouldSyncOnSubscribe = true;
        options.onStatusChange("reconnecting");
        return;
      }

      if (status === "CLOSED") {
        shouldSyncOnSubscribe = true;
        options.onStatusChange("reconnecting");
        if (retryTimer === null) {
          retryTimer = setTimeout(() => {
            retryTimer = null;
            if (cancelled) return;
            const previous = activeChannel;
            activeChannel = null;
            if (previous) void supabase.removeChannel(previous);
            connect();
          }, closedRetryDelayMs);
        }
      }
    });
  };

  connect();

  return () => {
    cancelled = true;
    clearRetryTimer();
    const channelToRemove = activeChannel;
    activeChannel = null;
    if (channelToRemove) {
      void supabase.removeChannel(channelToRemove);
    }
  };
}
