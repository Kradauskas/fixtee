# Deploying Fixtee to Vercel

Fixtee needs a server: GitHub webhooks, Supabase service-role writes and the agent all run server
side, so static hosting (GitHub Pages and friends) cannot run it. Vercel runs the Next.js app as is.

This finishes the "later: `https://<deploy url>/...`" steps left open in
[`github-app-setup.md`](./github-app-setup.md).

Everything below is an account action — it needs access to the Vercel, Supabase and GitHub App
settings, so it cannot be scripted from the repo.

---

## 1. Import the repository

1. Sign in at <https://vercel.com> with GitHub.
2. **Add New → Project** → import `Kradauskas/fixtee`.
3. Leave every build setting at its default. Vercel detects Next.js and runs `next build`; there is
   no `vercel.json` and none is needed.
4. Do **not** deploy yet — add the environment variables first, or the first build will fail on the
   missing Supabase keys.

Production tracks `main`. Every other branch gets its own preview URL automatically, which is how
you can look at an unmerged branch (see [section 6](#6-looking-at-a-branch-before-merging)).

## 2. Environment variables

**Settings → Environment Variables.** Add each to **Production, Preview and Development** unless
noted. Only `NEXT_PUBLIC_*` values reach the browser; everything else stays server side, so never
rename a secret to `NEXT_PUBLIC_`.

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

Optional, only for the PAT fallback used by `scripts/run-pr.ts` when a project has no GitHub App
installation: `GITHUB_TOKEN` and `GITHUB_REPO`. The deployed app does not need them.

### Pasting the private key

`normalizePrivateKey()` in `lib/github/app.ts` accepts the key in any of these shapes, so paste
whichever is easiest:

- the whole multi-line PEM, newlines and all (Vercel's input accepts them)
- one line with literal `\n` escapes
- the PEM base64-encoded

It converts PKCS#1 (`BEGIN RSA PRIVATE KEY`, what GitHub issues) to PKCS#8 and fails fast with a
message that names the variable but never echoes key material.

## 3. First deploy

Deploy, then note the production URL — `https://<project>.vercel.app`. Add a custom domain now if
you want one, because the next two sections hard-code this URL in two external services.

## 4. Point Supabase Auth at the deployment

**Supabase → Authentication → URL Configuration:**

- **Site URL**: `https://<deploy url>`
- **Redirect URLs**: add `https://<deploy url>/api/github/auth/callback`

To let preview deployments sign in too, also add the wildcard
`https://<project>-*.vercel.app/api/github/auth/callback`.

The GitHub OAuth app behind Supabase keeps its existing callback
(`https://<project-ref>.supabase.co/auth/v1/callback`) — that one does not change.

## 5. Point the GitHub App at the deployment

**GitHub → Settings → Developer settings → GitHub Apps → Fixtee:**

| Field | Value |
| --- | --- |
| Webhook URL | `https://<deploy url>/api/github/webhook` |
| Setup URL | `https://<deploy url>/api/github/setup` |

Webhooks go straight to the deployment now, so smee is only needed for local development. The
`proxy.ts` matcher already excludes `/api/github/webhook` from session refresh, and the route
verifies `x-hub-signature-256` against `GITHUB_WEBHOOK_SECRET` before anything else runs.

## 6. Looking at a branch before merging

Production builds `main`, which still has Role 1's placeholder dashboard. Unmerged work lives on
preview URLs:

```
https://fixtee-git-<branch-with-dashes>-<scope>.vercel.app
```

So the dashboard redesign on `r3/dashboard-ui` is reachable at its own preview URL as soon as the
branch is pushed, without merging anything. Preview deployments need the same environment variables
(the Preview scope) and the Supabase wildcard redirect from section 4.

An empty database is enough to see the dashboard: with zero recorded errors it falls back to sample
items, and **Simulate live CI failure** animates the full queued → analyzing → test → fix → verified
proof entirely in the browser.

## 7. Check it works

1. Open `https://<deploy url>/dashboard` → it should bounce you through GitHub sign-in and back.
2. Open `https://<deploy url>/api/github/install` → install the app on a repo → GitHub returns you
   to the Setup URL, which creates the `projects` rows.
3. Push a failing test to that repo's default branch. Within a few seconds the GitHub App's
   **Advanced → Recent Deliveries** tab should show a `workflow_run` delivery with a 202, and the
   error should appear on the dashboard.
4. Vercel → Logs to follow `ingest:`, `webhook:` and `verify:` lines for a run.

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
