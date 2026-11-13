// Smoke test for lib/github/app.ts: lists every installation of the app and the repos it can access.
// Usage (from the repo root, Node >= 23.6 for built-in TypeScript support):
//   node --no-warnings --env-file=.env.local lib/github/scripts/list-installation-repos.mjs [installation_id]
import { getGitHubApp, getInstallationOctokit } from "../app.ts";

const onlyInstallation = process.argv[2] ? Number(process.argv[2]) : undefined;
const app = getGitHubApp();

const { data: meta } = await app.octokit.request("GET /app");
console.log(`App: ${meta.name} (slug ${meta.slug}, id ${meta.id})`);
console.log(`Events: ${meta.events.join(", ") || "(none)"}`);
console.log(`Permissions: ${Object.entries(meta.permissions).map(([k, v]) => `${k}=${v}`).join(", ")}`);

let installations = 0;
for await (const { installation } of app.eachInstallation.iterator()) {
  if (onlyInstallation && installation.id !== onlyInstallation) continue;
  installations++;
  const account = installation.account && "login" in installation.account ? installation.account.login : "?";
  console.log(`\nInstallation ${installation.id} on ${account} (${installation.repository_selection})`);

  const octokit = await getInstallationOctokit(installation.id);
  const { data } = await octokit.request("GET /installation/repositories", { per_page: 100 });
  for (const repo of data.repositories) {
    console.log(`  - ${repo.full_name} (default branch ${repo.default_branch}${repo.private ? ", private" : ""})`);
  }
  if (data.total_count > data.repositories.length) console.log(`  … ${data.total_count} repos in total`);
}

if (installations === 0) console.log("\nNo installations yet — install the app on a repo first.");
