import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DashboardClient } from "./dashboard-client";
import { SettingsDialog } from "./settings-dialog";
import { EMPTY_DASHBOARD, type DashboardProject } from "./types";

const PROJECT_1: DashboardProject = {
  id: "11111111-1111-4111-8111-111111111111",
  repo_owner: "octo",
  repo_name: "demo",
  default_branch: "main",
  installation_id: 42,
  llm_provider: "anthropic",
  has_llm_key: false,
};

const PROJECT_2: DashboardProject = {
  id: "22222222-2222-4222-8222-222222222222",
  repo_owner: "octo",
  repo_name: "second-repo",
  default_branch: "main",
  installation_id: 42,
  llm_provider: "anthropic",
  has_llm_key: true,
};

function topbarHtml(html: string): string {
  const match = html.match(/<nav class="topbar">([\s\S]*?)<\/nav>/);
  if (!match) throw new Error("Expected <nav class=\"topbar\"> in rendered markup");
  return match[1];
}

describe("SettingsDialog", () => {
  it("keeps Manage / Add GitHub repositories (/api/github/install) visible when 1 project is connected", () => {
    const html = renderToStaticMarkup(
      <SettingsDialog
        project={PROJECT_1}
        signedIn={true}
        userLabel="dev@example.com"
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );

    expect(html).toContain("octo/demo");
    expect(html).toContain('href="/api/github/install"');
    expect(html).toContain("Manage / Add GitHub repositories");
    expect(html).toContain('href="/api/github/logout"');
    expect(html).toContain("Sign out");
    expect(html).toContain("Signed in as dev@example.com");
  });

  it("shows Manage / Add GitHub repositories and Sign out when signed in with no projects yet", () => {
    const html = renderToStaticMarkup(
      <SettingsDialog
        project={null}
        signedIn={true}
        userLabel="dev@example.com"
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );

    expect(html).toContain('href="/api/github/install"');
    expect(html).toContain("Manage / Add GitHub repositories");
    expect(html).toContain('href="/api/github/logout"');
    expect(html).toContain("Sign out");
  });

  it("shows plain Sign in (/api/github/login?next=/dashboard) alongside Connect GitHub when signed out", () => {
    const html = renderToStaticMarkup(
      <SettingsDialog
        project={null}
        signedIn={false}
        userLabel={null}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );

    expect(html).toContain('href="/api/github/login?next=/dashboard"');
    expect(html).toContain(">Sign in</a>");
    expect(html).toContain('href="/api/github/install"');
    expect(html).toContain("Connect GitHub");
    expect(html).not.toContain('href="/api/github/logout"');
  });
});

describe("DashboardClient navigation and auth controls", () => {
  it("renders plain Sign in alongside Connect GitHub when signed out and omits ChevronDown on static pill", () => {
    const html = renderToStaticMarkup(
      <DashboardClient
        initialData={EMPTY_DASHBOARD}
        signedIn={false}
        userLabel={null}
        notice={null}
        initialLoadError={null}
      />,
    );

    const nav = topbarHtml(html);
    expect(nav).toContain('href="/api/github/login?next=/dashboard"');
    expect(nav).toContain(">Sign in</a>");
    expect(nav).toContain('href="/api/github/install"');
    expect(nav).toContain("Connect GitHub");
    expect(nav).not.toContain('href="/api/github/logout"');
    expect(nav).not.toContain("<select");
    expect(nav).not.toContain("m6 9 6 6 6-6");
  });

  it("renders explicit Sign out action and static repo pill without ChevronDown for 1 connected project", () => {
    const html = renderToStaticMarkup(
      <DashboardClient
        initialData={{ projects: [PROJECT_1], errors: [], fixes: [] }}
        signedIn={true}
        userLabel="dev@example.com"
        notice={null}
        initialLoadError={null}
      />,
    );

    const nav = topbarHtml(html);
    expect(nav).toContain("octo /");
    expect(nav).toContain("demo");
    expect(nav).not.toContain("<select");
    expect(nav).not.toContain("m6 9 6 6 6-6");
    expect(nav).toContain('<span class="avatar"');
    expect(nav).not.toMatch(/<a[^>]*class="avatar"/);
    expect(nav).toContain('href="/api/github/logout"');
    expect(nav).toContain("Sign out");
    expect(nav).not.toContain('href="/api/github/login?next=/dashboard"');
  });

  it("switches the topbar repository pill to a select dropdown when multiple repositories are connected", () => {
    const html = renderToStaticMarkup(
      <DashboardClient
        initialData={{ projects: [PROJECT_1, PROJECT_2], errors: [], fixes: [] }}
        signedIn={true}
        userLabel="dev@example.com"
        notice="Installed: 2 repository(ies) synced."
        initialLoadError={null}
      />,
    );

    const nav = topbarHtml(html);
    expect(nav).toContain('<select aria-label="Repository">');
    expect(nav).toContain("octo/demo");
    expect(nav).toContain("octo/second-repo");
    expect(html).toContain("Installed: 2 repository(ies) synced.");
  });
});
