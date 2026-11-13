import { NextResponse } from "next/server";
import { createUserClient, type Db } from "../../../lib/db/supabase";
import { fetchDashboardData } from "../../../components/dashboard/queries";

export type DashboardRouteDeps = {
  getUserClient: () => Promise<Db>;
};

export async function handleDashboardRequest(deps: DashboardRouteDeps): Promise<NextResponse> {
  const supabase = await deps.getUserClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) {
    return NextResponse.json({ message: "not signed in" }, { status: 401 });
  }

  try {
    const data = await fetchDashboardData(supabase);
    return NextResponse.json(data);
  } catch (err) {
    console.error("dashboard: load failed", err instanceof Error ? err.message : err);
    return NextResponse.json({ message: "could not load dashboard" }, { status: 500 });
  }
}

export async function GET() {
  return handleDashboardRequest({ getUserClient: createUserClient });
}
