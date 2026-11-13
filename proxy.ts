// Next.js Proxy (formerly middleware). Keeps the Supabase session cookie fresh before pages
// render; see lib/db/session.ts for why. Role 3: if you need more proxy logic, add it here
// and keep calling updateSession() first.
import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/db/session";

export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    // Everything except static files, images and the GitHub webhook (no user session there).
    "/((?!_next/static|_next/image|favicon.ico|api/github/webhook|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
