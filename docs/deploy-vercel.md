# Deploying Fixtee to Vercel

Fixtee needs a server: GitHub webhooks, Supabase service-role writes and the agent all run server
side, so static hosting (GitHub Pages and friends) cannot run it. Vercel runs the Next.js app as is.

This finishes the "later: `https://<deploy url>/...`" steps left open in
[`github-app-setup.md`](./github-app-setup.md).

Everything below is an account action — it needs access to the Vercel, Supabase and GitHub App
settings, so it cannot be scripted from the repo.

---

## 1. Import the repository (or deploy via CLI)

1. Sign in at <https://vercel.com> with GitHub.
2. **Add New → Project** → import `Kradauskas/fixtee` (or deploy manually with `npx vercel --prod` as described in [`github-app-setup.md`](./github-app-setup.md#7-deploy-to-vercel-production-app) if GitHub repo permissions block Vercel Git integration).
3. Leave every build setting at its default. Vercel detects Next.js and runs `next build`; there is
   no `vercel.json` and none is needed.
4. Do **not** deploy yet — apply the Supabase migrations and add the environment variables first, or
   the first build will fail on the missing `NEXT_PUBLIC_SUPABASE_*` keys.

Production tracks `main`. Every other branch gets its own preview URL when deployed (see
[section 6](#6-looking-at-a-branch-before-merging)).

## 2. Database migrations and environment variables

Before the first deploy, apply both SQL migrations in `supabase/migrations/` to your target
Supabase project:

- `supabase/migrations/20261113160000_initial_schema.sql` — tables, Vault LLM key helpers, RLS
  `SELECT` policies, and the `supabase_realtime` publication for `public.errors` and `public.fixes`.
- `supabase/migrations/20261113220000_one_active_fix_per_error.sql` — deduplicates active fixes per
  error.

In Vercel: **Settings → Environment Variables.** Add each to **Production, Preview and
Development** unless noted. Only `NEXT_PUBLIC_*` values reach the browser; everything else stays
server side, so never rename a secret to `NEXT_PUBLIC_`.

| Variable | Where it comes from |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project Settings → API → Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase → API → anon / publishable key |
| `SUPABASE_URL` | same value as `NEXT_PUBLIC_SUPABASE_URL` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → API → service_role key. **Secret** — bypasses RLS |
| `GITHUB_APP_ID` | GitHub App settings → App ID (numeric) |
| `GITHUB_APP_SLUG` | last path segment of the app's public link `github.com/apps/<slug>` |
| `GITHUB_PRIVATE_KEY` | the `.pem` GitHub generated. **Secret** — see the note below |
| `GITHUB_WEBHOOK_SECRET` | the webhook secret set on the GitHub App. **Secret** |
| `ANTHROPIC_API_KEY` | fallback LLM key for projects with no key of their own. **Secret** |

Optional variables in `.env.example`:

- `AGENT_MODEL` / `AGENT_MAX_STEPS` — override the defaults in `lib/agent/agent.ts`.
- `ELEVENLABS_API_KEY` — reserved in `.env.example` for voice alerts (audio alert hooks are not
  wired into `main` yet, so omitting it will not affect builds or runtime).
- `GITHUB_TOKEN` and `GITHUB_REPO` — PAT fallback for local `scripts/run-pr.ts` only; the deployed
  app does not need them.

### Pasting the private key

`normalizePrivateKey()` in `lib/github/app.ts` accepts the key in any of these shapes, so paste
whichever is easiest:

- the whole multi-line PEM, newlines and all (Vercel's input accepts them)
- one line with literal `\n` escapes
- the PEM base64-encoded

It converts PKCS#1 (`BEGIN RSA PRIVATE KEY`, what GitHub issues) to PKCS#8 and fails fast with a
message that names the variable but never echoes key material.

## 3. First deploy

Deploy (`npx vercel --prod` or trigger a Vercel Git deploy), then note the production URL —
`https://<project>.vercel.app`. Add a custom domain now if you want one, because the next two
sections hard-code this URL in two external services.

## 4. Point Supabase Auth at the deployment

**Supabase → Authentication → URL Configuration:**

- **Site URL**: `https://<deploy url>`
- **Redirect URLs**: add `https://<deploy url>/api/github/auth/callback`

To let preview deployments sign in too, also add the wildcard
`https://<project>-*.vercel.app/api/github/auth/callback`.

The GitHub OAuth app behind Supabase keeps its existing callback
(`https://<project-ref>.supabase.co/auth/v1/callback`) — that one does not change.

## 5. Point the GitHub App at the deployment

**GitHub → Settings → Developer settings → GitHub Apps → Fixtee (`fixtee-bot`):**

| Field | Value |
| --- | --- |
| Webhook URL | `https://<deploy url>/api/github/webhook` |
| Setup URL | `https://<deploy url>/api/github/setup` |

Webhooks go straight to the deployment now, so smee is only needed for local development (with a
separate `fixtee-bot-dev` app). The `proxy.ts` matcher already excludes `/api/github/webhook` from
session refresh, and the route verifies `x-hub-signature-256` against `GITHUB_WEBHOOK_SECRET` before
anything else runs.

## 6. Looking at a branch before merging

`main` already includes the live Realtime dashboard (`DashboardClient`), verification state machine
(`lib/verify/state-machine.ts`), and PR description/comment updater. For any future unmerged feature
branch, Vercel creates a preview URL:

```
https://fixtee-git-<branch-with-dashes>-<scope>.vercel.app
```

Preview deployments need the same environment variables (the Preview scope) and the Supabase
wildcard redirect from section 4.

An empty database is enough to see the dashboard: with zero recorded errors it falls back to sample
items, and **Simulate live CI failure** animates the full queued → analyzing → test → fix → verified
proof entirely in the browser.

## 7. Check it works (E2E on `Kradauskas/DemoFixtee`)

1. Open `https://<deploy url>/dashboard` → it should bounce you through GitHub sign-in and back,
   and show the live Realtime badge (`SUBSCRIBED`).
2. Open `https://<deploy url>/api/github/install` → install `fixtee-bot` on `Kradauskas/DemoFixtee`
   (never install both `fixtee-bot` and `fixtee-bot-dev` on the same repo) → GitHub returns you to
   the Setup URL, which creates the `projects` row.
3. Verify **one bug at a time** on `DemoFixtee`'s `main` branch (keep `main` green initially, and
   never leave multiple unrelated failing Jest tests active in the same suite simultaneously, or a
   passing fix for Bug #1 will still fail CI because of Bug #2):
   - Push Bug #1 to `main` → GitHub Actions runs Jest and fails → the GitHub App's **Advanced →
     Recent Deliveries** shows `workflow_run` `202` → `/dashboard` receives `errors` + `fixes`
     changes live via Realtime without a page reload.
   - Watch the agent open a Draft PR on `autofix/<fix_id>` → Red CI fails on `test_commit_sha` →
     Green CI passes on `fix_commit_sha` → verification populates the PR's
     `<!-- fixtee-verification -->` description section and summary comment with Red/Green CI links
     and marks the PR Ready for Review.
   - Repeat for Bug #2 and the guardrail scenario (e.g., an unreproduced or low-confidence failure
     that leaves the PR as Draft / `failed`).
4. Check Vercel → Logs (`npx vercel logs <deploy url>`) to follow `ingest:`, `webhook:` and `verify:`
   lines for a run.

## Notes

- **Function duration.** `app/api/github/webhook/route.ts` sets `maxDuration = 300` so log download,
  parsing and the agent can finish in the background after the 202. 300s is both the default and the
  maximum on Vercel's Hobby plan, so this deploys as is; Pro raises the ceiling but is not required.
- **The webhook answers before the work finishes.** GitHub times out after 10s, so the route returns
  202 immediately and runs the rest inside `after()`. Keep `maxDuration` at or above the time that
  background work needs.
- **`pixel-perfect-echo-7216/`** is a local design reference with its own dependencies that are not
  installed at the repo root. It is git-ignored, so it never reaches Vercel — if it ever were
  committed, `next build` would fail type-checking it.
- **Rotating a secret** means updating it in Vercel and redeploying; environment variables are read
  at request time but the build bakes in `NEXT_PUBLIC_*` values.
