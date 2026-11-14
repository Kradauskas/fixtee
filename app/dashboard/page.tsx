import { Suspense } from "react";
import { DashboardClient } from "@/components/dashboard/dashboard-client";
import { fetchDashboardData } from "@/components/dashboard/queries";
import { EMPTY_DASHBOARD, type DashboardData } from "@/components/dashboard/types";
import { createUserClient } from "@/lib/db/supabase";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

type Session = {
  signedIn: boolean;
  userLabel: string | null;
  data: DashboardData;
  loadError: string | null;
};

const SIGNED_OUT: Session = {
  signedIn: false,
  userLabel: null,
  data: EMPTY_DASHBOARD,
  loadError: null,
};

function first(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function installNotice(params: Record<string, string | string[] | undefined>): string | null {
  const installed = first(params.installed);
  if (installed) return `Installed: ${installed} repository(ies) synced.`;

  const failure = first(params.install_error);
  if (failure) return `Install error: ${failure}`;

  if (first(params.install_requested)) {
    return "Install requested. An organisation admin has to approve it before repositories appear.";
  }
  return null;
}

async function loadSession(): Promise<Session> {
  let supabase;
  try {
    supabase = await createUserClient();
  } catch (err) {
    console.error("dashboard: Supabase is not configured", err instanceof Error ? err.message : err);
    return SIGNED_OUT;
  }

  let userLabel: string;
  try {
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return SIGNED_OUT;
    userLabel = auth.user.email ?? auth.user.id;
  } catch (err) {
    console.error("dashboard: sign-in check failed", err instanceof Error ? err.message : err);
    return SIGNED_OUT;
  }

  try {
    return { signedIn: true, userLabel, data: await fetchDashboardData(supabase), loadError: null };
  } catch (err) {
    console.error("dashboard: initial load failed", err instanceof Error ? err.message : err);
    return {
      signedIn: true,
      userLabel,
      data: EMPTY_DASHBOARD,
      loadError: "Could not load your projects. Retrying in the background.",
    };
  }
}

export default function DashboardPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<DashboardSkeleton />}>
      <DashboardBody searchParams={searchParams} />
    </Suspense>
  );
}

function DashboardSkeleton() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        background: "oklch(0.145 0.012 275)",
        color: "oklch(0.62 0.016 275)",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 13,
      }}
    >
      Loading dashboard…
    </main>
  );
}

async function DashboardBody({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const session = await loadSession();

  return (
    <DashboardClient
      initialData={session.data}
      initialProject={first(params.project)}
      signedIn={session.signedIn}
      userLabel={session.userLabel}
      notice={installNotice(params)}
      initialLoadError={session.loadError}
    />
  );
}
