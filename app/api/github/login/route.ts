// Minimal sign-in for testing the install flow: GitHub OAuth through Supabase Auth.
// GET /api/github/login?next=/some/path
import { NextResponse, type NextRequest } from "next/server";
import { createUserClient } from "@/lib/db/supabase";
import { safeNextPath } from "@/lib/github/install";

export async function GET(request: NextRequest) {
  const next = safeNextPath(request.nextUrl.searchParams.get("next"));
  const callback = new URL("/api/github/auth/callback", request.nextUrl.origin);
  callback.searchParams.set("next", next);

  const supabase = await createUserClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "github",
    // skipBrowserRedirect: we redirect ourselves. The PKCE verifier cookie is set on this response.
    options: { redirectTo: callback.toString(), skipBrowserRedirect: true },
  });
  if (error || !data.url) {
    console.error("login: signInWithOAuth failed", error?.message);
    return new NextResponse("Sign-in is not available right now.", { status: 500 });
  }
  return NextResponse.redirect(data.url);
}
