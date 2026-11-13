// PLACEHOLDER (Role 1): just enough to test the install flow end to end.
// Role 3 owns the real dashboard and should replace this file entirely.
// Keep the path /dashboard: the install flow redirects here with
// ?installed=<n> | ?install_error=<reason> | ?install_requested=1.
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { createUserClient } from "@/lib/db/supabase";
import { loginPath } from "@/lib/github/install";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

// cacheComponents is on: request-time work (cookies, searchParams) must sit inside <Suspense>.
export default function DashboardPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<p style={{ fontFamily: "monospace", padding: 32 }}>Loading…</p>}>
      <DashboardPlaceholder searchParams={searchParams} />
    </Suspense>
  );
}

async function DashboardPlaceholder({ searchParams }: { searchParams: SearchParams }) {
  const supabase = await createUserClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect(loginPath("/dashboard"));

  const params = await searchParams;
  // Uses the user's own client, so RLS decides what shows up here.
  const { data: projects, error } = await supabase
    .from("projects")
    .select("id, repo_owner, repo_name, default_branch, installation_id")
    .order("repo_owner")
    .order("repo_name");

  return (
    <main style={{ fontFamily: "monospace", padding: 32, maxWidth: 720 }}>
      <p style={{ color: "#a00" }}>Placeholder dashboard (Role 1). Role 3 replaces this.</p>
      <p>Signed in as {data.user.email ?? data.user.id}</p>
      {params.installed && <p>Installed: {params.installed} repo(s) synced.</p>}
      {params.install_error && <p style={{ color: "#a00" }}>Install error: {params.install_error}</p>}
      {params.install_requested && <p>Install requested; an org admin must approve it.</p>}

      <h2>Projects</h2>
      {error && <p style={{ color: "#a00" }}>Could not load projects: {error.message}</p>}
      {projects?.length === 0 && <p>No projects yet.</p>}
      <ul>
        {projects?.map((p) => (
          <li key={p.id}>
            {p.repo_owner}/{p.repo_name} (branch {p.default_branch}, installation {p.installation_id})
          </li>
        ))}
      </ul>

      <p>
        <a href="/api/github/install">Install the GitHub App / add repos</a> ·{" "}
        <a href="/api/github/logout">Sign out</a>
      </p>
    </main>
  );
}
