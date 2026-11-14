/**
 * Supabase client for browser / Client Components.
 *
 * Uses createBrowserClient from @supabase/ssr with the logged-in user's session cookies,
 * so Postgres queries and Realtime postgres_changes subscriptions obey RLS.
 */
import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./types";

export type BrowserDb = SupabaseClient<Database>;

/**
 * Returns the browser Supabase client singleton managed by @supabase/ssr.
 * Next.js only inlines NEXT_PUBLIC_* env vars into client bundles on static lookups.
 */
export function getBrowserClient(): BrowserDb {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url) throw new Error("Missing env var NEXT_PUBLIC_SUPABASE_URL");
  if (!anonKey) throw new Error("Missing env var NEXT_PUBLIC_SUPABASE_ANON_KEY");
  return createBrowserClient<Database>(url, anonKey);
}
