# GitHub App setup

How to create the AutoFix GitHub App, connect it to local development and to Vercel, and install it on a
repo. The code side lives in `lib/github/app.ts`: everything that talks to GitHub gets its client from
there.

Two different people are involved:

| Who | Does what |
|-----|-----------|
| **App owner** (you) | Creates the app on their own GitHub account, keeps the private key, sets env vars |
| **Repo owner** (Kradauskas, the teammate who owns `Kradauskas/fixtee`) | Installs the app on his repos. Only the owner of a personal-account repo can install an app on it; collaborators can't |

---

## 1. Create a smee.io channel (local webhooks)

GitHub can't reach `localhost`, so during development webhooks go to a smee.io channel and a small
client on your machine forwards them to the Next.js dev server.

1. Open <https://smee.io> and click **Start a new channel**.
2. Copy the channel URL (`https://smee.io/AbC123...`). You'll use it as the Webhook URL in step 2.
3. Keep the URL to yourself. Anyone who has it can read the payloads (repo names, commit info). The
   payloads contain no secrets, and our endpoint still checks every signature.

## 2. Create the GitHub App

On GitHub: **profile picture → Settings → Developer settings → GitHub Apps → New GitHub App**
(direct link: <https://github.com/settings/apps/new>).

### Basic information
| Field | Value |
|-------|-------|
| GitHub App name | e.g. `AutoFix Unfair Weekend`. It must be unique across GitHub; the slug is derived from it |
| Description | optional |
| Homepage URL | the repo URL, e.g. `https://github.com/Kradauskas/fixtee` (any valid URL works) |

### Identifying and authorizing users
| Field | Value |
|-------|-------|
| Callback URL | leave empty |
| Expire user authorization tokens | leave as is (unused) |
| **Request user authorization (OAuth) during installation** | **unchecked**. If it's checked, GitHub disables the Setup URL below |
| Enable Device Flow | unchecked |

### Post installation
| Field | Value |
|-------|-------|
| **Setup URL** | `http://localhost:3000/api/github/setup` for now (later: `https://<deploy url>/api/github/setup`) |
| **Redirect on update** | **checked** |

The Setup URL is a browser redirect, so `localhost` works for whoever is running the app locally.

### Webhook
| Field | Value |
|-------|-------|
| Active | **checked** |
| Webhook URL | the smee.io channel URL from step 1 (later: `https://<deploy url>/api/github/webhook`) |
| Webhook secret | a random string, generated as below. The same value goes into `GITHUB_WEBHOOK_SECRET` |
| SSL verification | Enable |

Generate the secret:
```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Permissions → Repository permissions
Set exactly these. Leave everything else at **No access**.

| Permission | Access | Why |
|------------|--------|-----|
| **Actions** | Read-only | list a run's jobs, download job logs |
| **Contents** | Read and write | read code, push the `autofix/<fix_id>` branch with test + fix commits |
| **Metadata** | Read-only | mandatory, selected automatically |
| **Pull requests** | Read and write | open and update the fix PR |

Organization and account permissions: none.

Notes:
- Commits pushed with the app's installation token **do** trigger workflows, which is what the
  red/green CI verification relies on. (Only pushes made with Actions' own `GITHUB_TOKEN` don't.)
- Contents: write does **not** allow editing files under `.github/workflows/`. That needs the separate
  *Workflows* permission, which we don't request. The agent must not touch workflow files.

### Subscribe to events
- **Workflow run**: check it. The checkbox only appears after **Actions** permission is set above.
- Nothing else. `installation` and `installation_repositories` events are sent to every app
  automatically.

### Where can this GitHub App be installed?
- **Any account**. This is required, because the repos belong to Kradauskas, not to the app owner.
  "Any account" means anyone with the link can install it; it is not listed on the Marketplace.

Click **Create GitHub App**.

## 3. Collect the values and the private key

On the app's **General** page (Settings → Developer settings → GitHub Apps → your app):

| Env var | Where to find it |
|---------|------------------|
| `GITHUB_APP_ID` | "App ID", a number (**not** the "Client ID" `Iv23…`) |
| `GITHUB_APP_SLUG` | the last part of the "Public link" `https://github.com/apps/<slug>` |
| `GITHUB_WEBHOOK_SECRET` | the secret you generated in step 2 |
| `GITHUB_PRIVATE_KEY` | see below |

**Private key:** scroll to **Private keys → Generate a private key**. GitHub downloads a
`<app-name>.<date>.private-key.pem` file. It's shown only once, but you can always generate a new one
(and delete old ones there).

### Put it in `.env.local` (local)
The simplest single-line form is base64:
```
node -e "console.log(require('fs').readFileSync(process.argv[1]).toString('base64'))" path/to/key.pem
```
and paste the output as `GITHUB_PRIVATE_KEY=<output>`.

`lib/github/app.ts` also accepts the raw PEM as a quoted multi-line value, or one line with `\n`
escapes, so any of these forms works.

### Put it in Vercel
Project → Settings → Environment Variables → add `GITHUB_PRIVATE_KEY` and paste the PEM file's contents
as-is (multi-line is fine), or the same base64 string. Add the other three vars too.

Then store the `.pem` somewhere safe (password manager) and delete it from Downloads. Never commit it
(`*.pem` is gitignored).

## 4. Install the app on a repo (repo owner: Kradauskas)

Send Kradauskas the link `https://github.com/apps/<slug>/installations/new`. He then:

1. Opens the link while logged into GitHub.
2. Chooses his account **Kradauskas** as the install target.
3. Selects **Only select repositories** and picks the repos whose CI we should watch: `fixtee` and/or
   the demo repo. Not "All repositories".
4. Reviews the permissions (Actions read, Contents read/write, Metadata read, Pull requests read/write)
   and clicks **Install**.
5. GitHub then redirects his browser to the Setup URL
   (`…/api/github/setup?installation_id=<id>&setup_action=install`). Until the install flow (Task 3) is
   running on his machine or on Vercel this page won't load. That's fine; the installation already
   exists.
6. Sends the **installation ID** to the app owner: it's in that redirect URL, or at
   **Settings → Applications → Installed GitHub Apps → Configure**, in the URL
   `https://github.com/settings/installations/<id>`.

Also make sure the repo has **Actions enabled** (repo → Settings → Actions → General).

Later changes: if we add permissions to the app, Kradauskas gets an email and must **accept** the new
permissions before they apply. Adding or removing repos is done on the same Configure page.

## 5. Run locally

Three terminals:
```
npm run dev
npx smee-client --url https://smee.io/<channel> --target http://localhost:3000/api/github/webhook
node --no-warnings --env-file=.env.local lib/github/scripts/list-installation-repos.mjs
```

The last command is the smoke test for the app config. It prints the app's name, events and permissions,
then every installation with the repos it can access. Pass an installation ID to show only that one.

To replay an event while developing: app settings → **Advanced → Recent Deliveries → Redeliver**.

Troubleshooting:
- `GitHub App env is invalid: …`: the message names the missing or malformed variables.
- `GITHUB_PRIVATE_KEY could not be parsed`: the key got mangled when pasting. Use the base64 form.
- `401 … 'Issued at' claim … / expiration time`: your system clock is off. Sync it.
- `404` for an installation: the app was uninstalled, or the ID belongs to another app.
- Signature checks fail **only** through smee: compare with a delivery to the deployed URL. smee
  re-serialises the JSON body, so in rare cases the bytes differ from what GitHub signed.

## 6. Switching to the deployed app

When Vercel is up, change on the app's General page:
- Webhook URL → `https://<deploy url>/api/github/webhook`
- Setup URL → `https://<deploy url>/api/github/setup`

There is one webhook URL per app, so while it points at Vercel, smee (local) gets nothing. If both are
needed at once, create a second "dev" app with its own env vars.
