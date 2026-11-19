# Vite single-file offline build

The web app uses [`vite-plugin-singlefile-offline`](https://github.com/Jacobinwwey/vite-plugin-singlefile-offline)
(MIT) to emit **one HTML file that opens under `file://`** — required for the
Expo WebView shell and distribution as an offline artifact.

The plugin is a normal dependency (`apps/web/package.json`):

```json
"vite-plugin-singlefile-offline": "^0.1.0"
```

`apps/web/vite.config.ts` includes it for `--mode offline` / `--mode singlefile`:

```ts
plugins: [
  react(),
  ...(offline ? [singleFileOffline({
    deleteOriginalAssets: true,
    hashRouterPolyfill: true,
    inlineCSS: true,
    inlineImages: true,
    storagePolyfill: true,
    urlPolyfill: true,
    maxImageSize: 8_000_000,
  })] : []),
],
build: { cssCodeSplit: false, assetsInlineLimit: 100_000_000 },
```

## Commands

```bash
pnpm --filter @whalechat/web build           # offline single file → dist-offline/index.html
pnpm --filter @whalechat/web build:hosted    # normal SPA → dist/ (Appwrite Sites / CDN)
```

## Why the plugin (not plain vite-plugin-singlefile)

Vite emits native ES modules. Under `file://` (and inside a WebView without a
server) those are blocked. The plugin AST-transforms every chunk to CommonJS and
evaluates it through a shared `__require` loader, registers chunks by file name,
inlines CSS/fonts/remote images, injects file:// polyfills (storage, URL, hash
router), and removes orphaned assets. It also caches the module **object** (not
`module.exports`) so reassigned exports are not silently lost.

## Verification performed

- `dist-offline/index.html` is ~334 KB, contains `meta[name=singlefile-offline]`,
  the `__modules` registry, and **zero** `<script src=...>` tags.
- `dist/` keeps the multi-file build for hosted deployment.
- App uses `HashRouter`, matching the plugin's hash-router polyfill, so deep
  links work under `file://`.

## Operational note

The plugin rewrites Vite's emitted output internals. Pin Vite/plugin versions
together when upgrading (`vite ^6`, plugin `^0.1.0` here) and re-run a build plus
a manual `file://` smoke test.
