// Sign out (for testing). GET so a plain link works.
import { NextResponse, type NextRequest } from "next/server";
import { createUserClient } from "@/lib/db/supabase";

export async function GET(request: NextRequest) {
  const supabase = await createUserClient();
  await supabase.auth.signOut({ scope: "local" }); // only this browser, not all of the user's sessions
  return NextResponse.redirect(new URL("/", request.nextUrl.origin));
}
