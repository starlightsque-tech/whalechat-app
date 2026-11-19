import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { singleFileOffline } from 'vite-plugin-singlefile-offline';

/**
 * Whalechat web build.
 *
 * `vite build` produces a normal multi-file SPA for Appwrite Sites.
 * `vite build --mode offline` uses the singlefile-offline transform from
 * github.com/Jacobinwwey/vite-plugin-singlefile-offline: every chunk is
 * rewritten ESM → CommonJS and inlined into one HTML file that runs under
 * file:// (and inside the Expo WebView shell) with no server.
 */
export default defineConfig(({ mode }) => {
  const offline = mode === 'offline' || mode === 'singlefile';
  return {
    base: './',
    plugins: [
      react(),
      ...(offline
        ? [
            singleFileOffline({
              deleteOriginalAssets: true,
              hashRouterPolyfill: true,
              inlineCSS: true,
              inlineImages: true,
              storagePolyfill: true,
              urlPolyfill: true,
              maxImageSize: 8_000_000,
            }),
          ]
        : []),
    ],
    define: {
      __WHALECHAT_OFFLINE__: JSON.stringify(offline),
    },
    build: {
      outDir: offline ? 'dist-offline' : 'dist',
      emptyOutDir: true,
      target: 'es2020',
      cssCodeSplit: false,
      assetsInlineLimit: 100_000_000,
      sourcemap: false,
      rollupOptions: {
        output: {
          manualChunks: undefined,
        },
      },
    },
    server: {
      port: 5173,
      host: true,
    },
    preview: {
      port: 4173,
    },
  };
});
