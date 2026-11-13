// GET /api/github/install: send a logged-in user to GitHub to install the app.
import { NextResponse, type NextRequest } from "next/server";
import { createUserClient } from "@/lib/db/supabase";
import { getInstallUrl } from "@/lib/github/app";
import { loginPath } from "@/lib/github/install";

export async function GET(request: NextRequest) {
  const supabase = await createUserClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) {
    return NextResponse.redirect(new URL(loginPath("/api/github/install"), request.nextUrl.origin));
  }
  return NextResponse.redirect(getInstallUrl());
}
