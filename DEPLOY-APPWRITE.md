# Deploy WhaleChat to Appwrite

WhaleChat uses Appwrite for **two** things:

1. **Client hosting** — the assembled `public/` app is deployed as an Appwrite
   Site (`scripts/deploy-appwrite.mjs`).
2. **Durable data mirror** — the Node sync server keeps the whole database and
   uploaded app files in Appwrite Storage/Database (`appwrite.js`), so a Render
   redeploy, a disk reset or a sleeping instance can never erase accounts,
   balances or active trades.

## 1. Appwrite project

1. Create a project at <https://cloud.appwrite.io> and copy its **Project ID**.
2. Project Settings → API Keys → create a key with scopes:
   `sites.*`, `storage.*`, `databases.*`, `files.*`.
3. Keep the key outside the repo (Render env var or your shell).

## 2. Deploy the client to Appwrite Sites

```bash
APPWRITE_ENDPOINT=https://nyc.cloud.appwrite.io/v1 \
APPWRITE_PROJECT_ID=6afec9ae002d0af5e0c6 \
APPWRITE_API_KEY=<api-key> \
npm run deploy:appwrite
```

The live site is **https://whalechat.appwrite.network**.

The script:

* runs `node scripts/prepare-assets.js` (assembles `whalechat.html`),
* creates the `whalechat` site if it does not exist,
* packages `public/` as a tar.gz and uploads a static deployment,
* activates it and waits for `ready`.

The site is served from `https://<site-id>.<appwrite-domain>` (the exact host is
shown in the Appwrite console → Sites → Domains).

## 3. Enable the server-side data mirror

Set these on Render (Environment):

| Variable | Value |
| --- | --- |
| `APPWRITE_ENDPOINT` | `https://nyc.cloud.appwrite.io/v1` |
| `APPWRITE_PROJECT_ID` | `6afec9ae002d0af5e0c6` |
| `APPWRITE_API_KEY` | the key from step 1 |
| `APPWRITE_BUCKET_ID` | `whalechat` (created automatically) |
| `APPWRITE_DATABASE_ID` | `whalechat` (optional document mirror) |

On boot the server downloads `whalechat-state.json` from Appwrite and **merges**
it with the local state (accounts are added, never deleted). Every database
write schedules a backup, a full backup runs every 5 minutes and on shutdown.

Check it:

```bash
curl https://<render-host>/api/appwrite/status
```

Manual backup (admin token required):

```bash
curl -X POST https://<render-host>/api/appwrite/sync \
  -H "x-admin-token: <admin session>"
```

## 4. Email verification codes

Sign-up and password reset send a 6-digit code. Configure any one provider:

* `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` (Outlook/Microsoft 365)
* `RESEND_API_KEY`
* `BREVO_API_KEY`

If none is configured the app shows the code on screen (clearly labelled) so
account creation and password reset never dead-end. Configure mail to have the
code delivered to the user's inbox.

## 5. Notes

* Never commit `APPWRITE_API_KEY`; rotate it if it is ever pasted in chat.
* `APPWRITE_*` variables are server/CI only. The browser app has no Appwrite
  key and talks only to the WhaleChat sync server.

## 6. Sync service (live)

The Appwrite site is static, so cross-device sync and email codes are served
by an Appwrite **Function** named `whalechat-sync`:

* Function URL: **https://whalechat-api.appwrite.network**
* Client constant: `DEFAULT_SYNC_SERVER` in `public/whalechat.html.part01`
* State: `whalechat-state.json` in the `whalechat` Storage bucket (delete +
  recreate on every write, because Appwrite's update-file endpoint only changes
  metadata)
* Transport: HTTP polling every 15 s (Functions cannot hold SSE open)
* Email codes: `whalechat-codes.json` in the same bucket; set `RESEND_API_KEY`
  or `BREVO_API_KEY` as a function variable to deliver mail, otherwise the code
  is returned to the app and shown in a labelled fallback panel.

Redeploy the function after changing `appwrite-function/index.js`:

```bash
export APPWRITE_ENDPOINT=https://nyc.cloud.appwrite.io/v1
export APPWRITE_PROJECT_ID=6afec9ae002d0af5e0c6
export APPWRITE_API_KEY=...
appwrite functions create-deployment \
  --function-id whalechat-sync \
  --code appwrite-function --activate \
  --entrypoint index.js --commands "npm install"
```

Health check:

```bash
curl https://whalechat-api.appwrite.network/api/health
```

## 7. Admin panel

A separate, standalone admin panel is deployed as its own Appwrite Site:

* **URL:** https://whalechat-admin.appwrite.network
* **Source:** `admin-panel/index.html`
* **API:** the same `whalechat-sync` function
* **Initial account:** the seeded WhaleChat admin (`admin@whalechat.app`) with
  the app's default admin password. Change it from **Account security** on the
  first sign-in.

Admin endpoints on the function:

| Endpoint | Purpose |
| --- | --- |
| `POST /api/admin/login` | verify email/username + password, issue 8-hour token |
| `POST /api/admin/me` | validate a token |
| `POST /api/admin/update` | change email, username or password |
| `POST /api/admin/set-recovery` | store a hashed recovery key |
| `POST /api/admin/recovery` | reset password with recovery key |
| `POST /api/admin/user-flag` | verify / ban a user |

Redeploy the admin site after editing `admin-panel/index.html`:

```bash
APPWRITE_ENDPOINT=https://nyc.cloud.appwrite.io/v1 \
APPWRITE_PROJECT_ID=6afec9ae002d0af5e0c6 \
APPWRITE_SITE_ID=whalechat-admin \
APPWRITE_SITE_NAME="WhaleChat Admin" \
APPWRITE_SITE_DIR=admin-panel \
APPWRITE_SKIP_BUILD=1 \
npm run deploy:appwrite
```
