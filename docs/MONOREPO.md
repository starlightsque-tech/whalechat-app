# Whalechat monorepo foundation

Branch: `feat/turborepo-architecture` (legacy 3.65 app on `main` is untouched).

```
apps/
  web/     Vite + React + TS + Tailwind + React Router   → PWA / Appwrite Sites / single-file HTML
  mobile/  Expo + React Native + TS + NativeWind + Expo Router → Android APK / iOS
packages/
  shared/  types + Zod + storage port + network port + outbox + sync engine + Appwrite services + runtime + hooks
```

## Commands

```bash
pnpm install
pnpm --filter @whalechat/shared build        # required once (apps consume dist types)
pnpm dev:web                                 # http://localhost:5173
pnpm dev:mobile                              # Expo
pnpm mono:build                              # turbo: shared → web
pnpm mono:test                               # vitest (7 tests: outbox, double-spend, offline drain)
pnpm build:web                               # single-file offline HTML → apps/web/dist-offline/index.html
pnpm --filter @whalechat/web build:hosted    # normal multi-file SPA → apps/web/dist
```

The web app defaults to the **built-in demo backend**, so it boots and all three
domains work with no Appwrite credentials. Set `VITE_APPWRITE_ENDPOINT` and
`VITE_APPWRITE_PROJECT_ID` to switch to Appwrite (see `apps/web/.env.example`).
Mobile does the same with `EXPO_PUBLIC_APPWRITE_*`.

## Layer rules

- `packages/shared` is platform-free. It never imports `react-dom`, `appwrite`,
  `react-native-appwrite`, IndexedDB or MMKV.
- Platform SDKs are **injected**:
  - storage: `PlatformStorageAdapter` (`IndexedDB` on web, `MMKV` on Expo)
  - network: `NetworkMonitor` (`navigator.onLine` on web, `NetInfo` on Expo)
  - backend: `WhalechatBackend` (`createAppwriteBackend` or `createDemoBackend`)
- Screens never call the backend. They call `whalechatRuntime` (sendMessage,
  addToCart, checkout, placeTrade, transfer) which writes the optimistic state +
  outbox row; the sync manager calls the backend.
- React hooks (`useWhalechatSync`, `useChat`, `useWallet`) read the same
  Zustand store on both platforms.

## Appwrite provisioning & sync API

The monorepo writes go through `appwrite-function/monorepo-sync.js`
(`/api/messages`, `/api/orders/checkout`, `/api/trades`,
`/api/wallet/transfer`, `/api/admin/*`). See
[docs/APPWRITE-SYNC-API.md](APPWRITE-SYNC-API.md) for the contract,
idempotency rules and wallet holds.

```bash
APPWRITE_ENDPOINT=https://nyc.cloud.appwrite.io/v1 \
APPWRITE_PROJECT_ID=... APPWRITE_API_KEY=... \
node scripts/provision-monorepo-appwrite.mjs

APPWRITE_PROJECT_ID=... APPWRITE_API_KEY=... \
WC_DEPLOY_DOMAIN=whalechat.appwrite.network \
node scripts/deploy-monorepo-site.mjs
```

The script is idempotent and creates `users`, `wallets`, `conversations`,
`messages`, `products`, `orders`, `trades`, `ledger_transactions` with the
schema in `packages/shared/src/appwrite/schema.ts`. Run `--dry-run` to inspect
the plan without a key. Unique indexes on `idempotencyKey` exist for messages,
orders, trades and ledger rows.

## Deliberate scope

The monorepo is added alongside the shipping 3.65 app so the live product and
its deployment scripts keep working. Wiring the legacy `public/` bundle into
`apps/web` is a follow-up; this branch establishes the architecture, shared
business logic, offline engine and working screens the spec asked for.
