import { Suspense } from "react";
import { redirect } from "next/navigation";
import { DashboardClient } from "@/components/dashboard/dashboard-client";
import { fetchDashboardData } from "@/components/dashboard/queries";
import { EMPTY_DASHBOARD, type DashboardData } from "@/components/dashboard/types";
import { createUserClient } from "@/lib/db/supabase";
import { loginPath } from "@/lib/github/install";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

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
  const supabase = await createUserClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect(loginPath("/dashboard"));

  const params = await searchParams;

  let data: DashboardData = EMPTY_DASHBOARD;
  let loadError: string | null = null;
  try {
    data = await fetchDashboardData(supabase);
  } catch (err) {
    console.error("dashboard: initial load failed", err instanceof Error ? err.message : err);
    loadError = "Could not load your projects. Retrying in the background.";
  }

  return (
    <DashboardClient
      initialData={data}
      userLabel={auth.user.email ?? auth.user.id}
      notice={installNotice(params)}
      initialLoadError={loadError}
    />
  );
}
