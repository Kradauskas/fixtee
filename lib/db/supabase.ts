/**
 * Supabase clients for server code. Two kinds, pick deliberately:
 *
 * - createUserClient(): acts as the logged-in user (publishable key + session cookie).
 *   RLS applies, so it only sees that user's rows. Use it in pages and route handlers
 *   that show data to a user.
 * - getServiceClient(): the secret key. Bypasses RLS and can write anything. Use it
 *   only in server code that has already decided what is allowed (webhooks, install
 *   flow, agent). Never import it into a Client Component.
 *
 * Server-only: reads secrets from process.env and uses next/headers.
 */
import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { connection } from "next/server";
import type { Database } from "./types";

export type Db = SupabaseClient<Database>;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var ${name}`);
  return value;
}

/** Client for the current request's user. RLS applies. */
export async function createUserClient(): Promise<Db> {
  // Auth checks session expiry with Date.now(). With cacheComponents on, Next only allows that
  // after an explicit request-time signal; without it the page's Suspense boundary errors and the
  // browser retries forever. connection() marks everything after it as request-time.
  await connection();
  const cookieStore = await cookies();
  return createServerClient<Database>(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (toSet) => {
          try {
            for (const { name, value, options } of toSet) cookieStore.set(name, value, options);
          } catch {
            // Server Components can't set cookies. Fine: route handlers (login, callback)
            // set them, and getUser() still works with the existing cookie.
          }
        },
      },
    },
  );
}

let serviceClient: Db | undefined;

/** Secret-key client. Bypasses RLS: server-side code only. */
export function getServiceClient(): Db {
  serviceClient ??= createClient<Database>(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  return serviceClient;
}
