// Supabase redirects here after GitHub sign-in: swap the code for a session cookie.
import { NextResponse, type NextRequest } from "next/server";
import { createUserClient } from "@/lib/db/supabase";
import { safeNextPath } from "@/lib/github/install";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get("code");
  const next = safeNextPath(searchParams.get("next"));

  if (code) {
    const supabase = await createUserClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(next, origin));
    console.error("auth callback: code exchange failed", error.message);
  }
  return new NextResponse("Sign-in failed. Go back and try again.", { status: 400 });
}
