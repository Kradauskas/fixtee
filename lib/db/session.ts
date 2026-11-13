/**
 * Supabase session refresh for proxy.ts (the standard Supabase + Next.js setup).
 *
 * Why: Server Components can read cookies but not write them. When the access token has
 * expired, supabase-js refreshes it (which rotates the refresh token) and tries to save the
 * new cookies. Inside a Server Component that write is dropped, so the browser keeps a
 * refresh token Supabase has already rotated, and the session goes bad. The proxy runs
 * before every page, where cookies *can* be written: it refreshes the session once and
 * passes the fresh cookies both to the page (request) and back to the browser (response).
 *
 * This only refreshes. It does not decide who may see what: pages still call getUser(),
 * and RLS still guards the data.
 */
import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";
import type { Database } from "./types";

export async function updateSession(request: NextRequest): Promise<NextResponse> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return NextResponse.next({ request });

  let response = NextResponse.next({ request });

  const supabase = createServerClient<Database>(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (toSet, headers) => {
        // Request: so the page rendered after the proxy sees the fresh session.
        for (const { name, value } of toSet) request.cookies.set(name, value);
        // Response: so the browser stores it.
        response = NextResponse.next({ request });
        for (const { name, value, options } of toSet) response.cookies.set(name, value, options);
        // Cache-Control etc. from supabase-js: never cache a response that sets auth cookies.
        for (const [k, v] of Object.entries(headers ?? {})) response.headers.set(k, v);
      },
    },
  });

  // Don't put code between createServerClient and this call: it triggers the refresh.
  await supabase.auth.getClaims();

  return response;
}
