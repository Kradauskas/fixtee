import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DashboardClient } from "./dashboard-client";
import { SettingsDialog } from "./settings-dialog";
import {
  ALL_PROJECTS_ID,
  EMPTY_DASHBOARD,
  mostRecentProjectId,
  resolveProjectSelection,
  type DashboardError,
  type DashboardProject,
} from "./types";

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

const ERROR_P1: DashboardError = {
  id: "err-p1",
  project_id: PROJECT_1.id,
  fingerprint: "fp1",
  test_name: "old test",
  error_type: "TypeError",
  error_message: "Old failure in demo repo",
  log_excerpt: "Error: Old failure",
  file_path: "src/old.js",
  line: 10,
  commit_sha: "1111aaa",
  workflow_run_id: 1,
  run_url: "https://github.com/octo/demo/actions/runs/1",
  parsed: true,
  occurrences: 1,
  first_seen: "2026-11-13T10:00:00Z",
  last_seen: "2026-11-13T10:00:00Z",
};

const ERROR_P2: DashboardError = {
  id: "err-p2",
  project_id: PROJECT_2.id,
  fingerprint: "fp2",
  test_name: "new test",
  error_type: "AssertionError",
  error_message: "Recent failure in second-repo",
  log_excerpt: "Error: Recent failure",
  file_path: "src/new.js",
  line: 22,
  commit_sha: "2222bbb",
  workflow_run_id: 2,
  run_url: "https://github.com/octo/second-repo/actions/runs/2",
  parsed: true,
  occurrences: 1,
  first_seen: "2026-11-14T10:00:00Z",
  last_seen: "2026-11-14T10:00:00Z",
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
    expect(html).toContain("on: [push, pull_request]");
    expect(html).toContain('href="/api/github/install"');
    expect(html).toContain("Manage / Add GitHub repositories");
    expect(html).toContain('href="/api/github/logout"');
    expect(html).toContain("Sign out");
    expect(html).toContain("Signed in as dev@example.com");
  });

  it("shows Target repository selector when multiple repositories are passed", () => {
    const html = renderToStaticMarkup(
      <SettingsDialog
        project={PROJECT_2}
        projects={[PROJECT_1, PROJECT_2]}
        signedIn={true}
        userLabel="dev@example.com"
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );

    expect(html).toContain('id="settings-project"');
    expect(html).toContain("octo/demo");
    expect(html).toContain("octo/second-repo");
    expect(html).toContain("Replace the stored key");
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

describe("resolveProjectSelection and mostRecentProjectId", () => {
  it("picks the repository with the most recent errors.last_seen instead of alphabetical first", () => {
    const data = { projects: [PROJECT_1, PROJECT_2], errors: [ERROR_P1, ERROR_P2], fixes: [] };

    expect(mostRecentProjectId(data)).toBe(PROJECT_2.id);
    expect(resolveProjectSelection(data, null)).toBe(PROJECT_2.id);
  });

  it("honors ?project= URL parameter by id, owner/repo slug, or all", () => {
    const data = { projects: [PROJECT_1, PROJECT_2], errors: [ERROR_P1, ERROR_P2], fixes: [] };

    expect(resolveProjectSelection(data, PROJECT_1.id)).toBe(PROJECT_1.id);
    expect(resolveProjectSelection(data, "octo/demo")).toBe(PROJECT_1.id);
    expect(resolveProjectSelection(data, ALL_PROJECTS_ID)).toBe(ALL_PROJECTS_ID);
    expect(resolveProjectSelection(data, "unknown-id")).toBe(PROJECT_2.id);
  });

  it("defaults to All repositories when multiple repos have zero errors yet", () => {
    const data = { projects: [PROJECT_1, PROJECT_2], errors: [], fixes: [] };

    expect(mostRecentProjectId(data)).toBeNull();
    expect(resolveProjectSelection(data, null)).toBe(ALL_PROJECTS_ID);
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
    expect(html).toContain("Undefined taxRate when applying a coupon");
  });

  it("renders waiting state instead of fake demo cards when signed in with 1 connected repo and 0 errors", () => {
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

    expect(html).toContain("Waiting for CI failures on octo/demo…");
    expect(html).toContain("Load sample preview");
    expect(html).toContain("<strong>0</strong> Errors caught");
    expect(html).not.toContain("src/price.js");
    expect(html).not.toContain("Undefined taxRate when applying a coupon");
  });

  it("defaults to All repositories when multiple repos have 0 errors and includes All option in select", () => {
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
    expect(nav).toContain("All repositories (2)");
    expect(nav).toContain("octo/demo");
    expect(nav).toContain("octo/second-repo");
    expect(html).toContain("Installed: 2 repository(ies) synced.");
    expect(html).toContain("Waiting for CI failures across your connected repositories…");
    expect(html).not.toContain("Undefined taxRate when applying a coupon");
  });

  it("defaults to project with most recent errors.last_seen and supports ?project=all view", () => {
    const data = { projects: [PROJECT_1, PROJECT_2], errors: [ERROR_P1, ERROR_P2], fixes: [] };

    const defaultHtml = renderToStaticMarkup(
      <DashboardClient
        initialData={data}
        signedIn={true}
        userLabel="dev@example.com"
        notice={null}
        initialLoadError={null}
      />,
    );
    expect(defaultHtml).toContain("Recent failure in second-repo");
    expect(defaultHtml).not.toContain("Old failure in demo repo");

    const allHtml = renderToStaticMarkup(
      <DashboardClient
        initialData={data}
        initialProject={ALL_PROJECTS_ID}
        signedIn={true}
        userLabel="dev@example.com"
        notice={null}
        initialLoadError={null}
      />,
    );
    expect(allHtml).toContain("Recent failure in second-repo");
    expect(allHtml).toContain("Old failure in demo repo");
    expect(allHtml).toContain("octo/second-repo");
    expect(allHtml).toContain("octo/demo");
  });
});
