# Provisioning status & blockers (verified)

Checked against the repo and live endpoints on the current branch.

| Task | Status | Evidence / blocker |
|---|---|---|
| Monorepo + shared engine | **Done** | `apps/web`, `apps/mobile`, `packages/shared`, `turbo.json`, `pnpm-workspace.yaml` on `feat/turborepo-architecture`. Shared unit tests 7/7 pass; web build passes. |
| Vite singlefile-offline workflow | **Done** | Plugin configured in `apps/web/vite.config.ts`; `dist-offline/index.html` is a 334 KB self-contained bundle with no external script tags. |
| iOS EAS build | **Blocked** | No `EXPO_TOKEN` in this environment, and no Apple account/credentials. iOS on EAS requires an Apple Developer account plus a distribution certificate + provisioning profile. Expo project `@whalechat.com/whalechat` (`c114889f-…`) is the existing Android-only shell; iOS has never been built (`expo/README.md`). |
| Telesign OTP → `/api/telesign/start` VALID | **Blocked** | `TELESIGN_CUSTOMER_ID` and `TELESIGN_API_KEY` are absent; no verified trial phone number was supplied. The server endpoint and `phoneVerified` stamping exist (`server.js` `/api/telesign/start`, signup flow), but no live send/verify can be executed without credentials and a trial-verified number. |
| Bind `whalechat.appwrite.network` → whalechat site | **Blocked** | Requires the Appwrite Console / Sites API key (`sites.*`). `APPWRITE_API_KEY` is not available. DNS already points at Appwrite's edge (`fastly.appwrite.systems`), so this is a site/domain attachment problem, not DNS. |
| Verify deployed bundle loads | **FAILS** | `https://whalechat.appwrite.network/`, `/whalechat.html`, `/version.json`, `/sw.js` all return **404** `router_rule_not_found` (Appwrite 0.10.93). No active deployment is attached to the domain. |
| Verify APK loads live app | **FAILS (by dependency)** | The EAS APK is downloadable (HTTP 200, 60,790,891 bytes, build `833ac022`). Its `assets/app.config` bakes `webUrl: https://whalechat.appwrite.network/whalechat.html`, which currently 404s — so the WebView opens an error page. Re-deploy the site, then the same APK will load it. |
| Appwrite schema provisioning | **Ready, not applied** | `scripts/provision-monorepo-appwrite.mjs --dry-run` prints the 8-collection plan with unique idempotency indexes. Needs `APPWRITE_API_KEY` to execute. |

## What is needed to close each blocker

1. **iOS:** `EXPO_TOKEN` + Apple Developer team (or `eas credentials` with an
   App Store Connect API key), then `eas build -p ios --profile production`.
2. **Telesign:** set `TELESIGN_CUSTOMER_ID` / `TELESIGN_API_KEY` and a phone
   number verified in the trial account; then POST `/api/telesign/start`
   followed by `/api/telesign/verify`.
3. **Appwrite:** console access (or a `sites.*` API key) to attach `whalechat`
   site to `whalechat.appwrite.network`; then run
   `npm run deploy:appwrite` (or the new schema provisioner for collections).
4. **APK/bundle verification:** rerun after (3); the existing APK does not need
   rebuilding because the URL is already baked correctly.

No credential values were read, printed or committed.
