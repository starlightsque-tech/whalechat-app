#!/usr/bin/env bash
# Build the Cloudflare Pages bundle: static app + Pages Functions.
#   ./scripts/build-pages.sh
# Output: dist/  (deploy with: npx wrangler pages deploy dist --project-name whalechat)
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> assembling app bundle"
node scripts/prepare-assets.js

echo "==> preparing dist/"
rm -rf dist
mkdir -p dist
# static app (everything public/ serves)
cp -R public/. dist/
# Pages Functions (same-origin /api/welcome)
cp -R functions dist/functions

# never publish local data or secrets
rm -rf dist/data dist/.env dist/node_modules 2>/dev/null || true

echo "==> dist ready: $(find dist -type f | wc -l) files, $(du -sh dist | cut -f1)"
