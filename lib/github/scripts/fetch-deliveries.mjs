// Pulls recent webhook deliveries from the GitHub App's delivery log and saves their payloads as
// test fixtures. Auth is the app JWT (private key from env); nothing secret is written to disk.
//
// Usage (from the repo root, Node >= 23.6):
//   node --no-warnings --env-file=.env.local lib/github/scripts/fetch-deliveries.mjs           # list recent deliveries
//   node --no-warnings --env-file=.env.local lib/github/scripts/fetch-deliveries.mjs <id> <name>
//     -> fixtures/webhooks/<name>.json  (payload + the event header, trimmed)
import { mkdirSync, writeFileSync } from "node:fs";
import { getGitHubApp } from "../app.ts";

const app = getGitHubApp();
const [deliveryId, name] = process.argv.slice(2);

if (!deliveryId) {
  const { data } = await app.octokit.request("GET /app/hook/deliveries", { per_page: 30 });
  for (const d of data) {
    const what = [d.event, d.action].filter(Boolean).join(".");
    console.log(`${d.id}  ${d.delivered_at}  ${String(d.status_code).padEnd(3)}  ${what}${d.redelivery ? "  (redelivery)" : ""}`);
  }
  if (data.length === 0) console.log("No deliveries yet.");
  process.exit(0);
}

if (!name || !/^[a-z0-9-]+$/.test(name)) {
  console.error("Give a fixture name too (lowercase, digits, dashes), e.g. workflow-run-failure");
  process.exit(1);
}

const { data } = await app.octokit.request("GET /app/hook/deliveries/{delivery_id}", {
  delivery_id: deliveryId, // keep as string: delivery ids exceed Number precision
});
const fixture = {
  event: data.event,
  payload: trim(data.request.payload),
};

mkdirSync("fixtures/webhooks", { recursive: true });
const file = `fixtures/webhooks/${name}.json`;
writeFileSync(file, JSON.stringify(fixture, null, 2) + "\n");
console.log(`Saved ${data.event}.${data.action ?? ""} delivery ${deliveryId} -> ${file}`);

// Drop noise we never read (API URLs, node ids, avatars, sender details) so fixtures stay small
// and contain as little account data as possible. Keeps html_url.
function trim(value) {
  if (Array.isArray(value)) return value.map(trim);
  if (value === null || typeof value !== "object") return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === "node_id" || k === "gravatar_id" || k === "avatar_url") continue;
    if (k.endsWith("_url") && k !== "html_url") continue;
    if (k === "url") continue;
    // Commit author/committer: personal name + email. Replace with placeholders.
    if ((k === "author" || k === "committer") && v && typeof v === "object" && "email" in v) {
      out[k] = { name: "Test Dev", email: "dev@example.com" };
      continue;
    }
    out[k] = trim(v);
  }
  if ("sender" in out) out.sender = { login: out.sender?.login, type: out.sender?.type };
  return out;
}
