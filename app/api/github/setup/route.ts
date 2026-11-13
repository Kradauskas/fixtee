// GET /api/github/setup: GitHub's "Setup URL". Runs after the app is installed or its repo
// selection changes (?installation_id=..&setup_action=install|update|request).
import { NextResponse, type NextRequest } from "next/server";
import { createUserClient, getServiceClient } from "@/lib/db/supabase";
import { createInstallDeps, loginPath, parseSetupQuery, syncInstallation } from "@/lib/github/install";

export async function GET(request: NextRequest) {
  const { origin, pathname, search } = request.nextUrl;
  const to = (path: string) => NextResponse.redirect(new URL(path, origin));

  const supabase = await createUserClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return to(loginPath(pathname + search)); // come back here after login

  const query = parseSetupQuery(request.nextUrl.searchParams);
  if (!query) return to("/dashboard?install_error=bad_request");
  if (query.setup_action === "request") return to("/dashboard?install_requested=1");

  try {
    const result = await syncInstallation(
      createInstallDeps(getServiceClient()),
      data.user.id,
      query.installation_id,
    );
    if (!result.ok) return to(`/dashboard?install_error=${result.reason}`);
    return to(`/dashboard?installed=${result.repoCount}`);
  } catch (err) {
    console.error("setup: syncing installation failed", query.installation_id, err);
    return to("/dashboard?install_error=failed");
  }
}
