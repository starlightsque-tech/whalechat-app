#!/usr/bin/env node
/* =========================================================================
   Deploy the WhaleChat PWA to Cloudflare Pages.

   Required environment:
     CLOUDFLARE_API_TOKEN   token with Account → Cloudflare Pages → Edit
     CLOUDFLARE_ACCOUNT_ID  the account that owns the project
   Optional:
     CLOUDFLARE_PROJECT_NAME  default whalechat
     CLOUDFLARE_BRANCH        default main

   Usage:
     CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... npm run deploy:cloudflare
   ========================================================================= */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const API = 'https://api.cloudflare.com/client/v4';
const TOKEN = String(process.env.CLOUDFLARE_API_TOKEN || '').trim();
const ACCOUNT = String(process.env.CLOUDFLARE_ACCOUNT_ID || '').trim();
const PROJECT = String(process.env.CLOUDFLARE_PROJECT_NAME || 'whalechat').trim();
const BRANCH = String(process.env.CLOUDFLARE_BRANCH || 'main').trim();

if (!TOKEN || !ACCOUNT) {
  console.error('Missing CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID.');
  process.exit(2);
}

async function api(pathname, opts) {
  const res = await fetch(API + pathname, Object.assign({}, opts || {}, {
    headers: Object.assign({ authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' }, (opts && opts.headers) || {})
  }));
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) {}
  return { ok: res.ok, status: res.status, json, text };
}

(async () => {
  console.log('[cloudflare] account', ACCOUNT, '· project', PROJECT);

  /* build the PWA bundle first */
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'prepare-assets.js')], { stdio: 'inherit' });

  const exists = await api('/accounts/' + ACCOUNT + '/pages/projects/' + encodeURIComponent(PROJECT));
  if (!exists.ok) {
    const made = await api('/accounts/' + ACCOUNT + '/pages/projects', {
      method: 'POST',
      body: JSON.stringify({ name: PROJECT, production_branch: BRANCH })
    });
    if (!made.ok) throw new Error('Could not create Pages project: ' + made.status + ' ' + made.text.slice(0, 300));
    console.log('[cloudflare] project created');
  }

  /* wrangler handles the file hashing/upload and activates the deployment */
  const args = [
    'wrangler', 'pages', 'deploy', PUB,
    '--project-name', PROJECT,
    '--branch', BRANCH,
    '--commit-message', 'WhaleChat PWA ' + new Date().toISOString(),
    '--commit-dirty=true'
  ];
  execFileSync('npx', args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: Object.assign({}, process.env, { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT })
  });

  console.log('[cloudflare] production: https://' + PROJECT + '.pages.dev');
})().catch((e) => {
  console.error('[cloudflare] deploy failed:', e.message);
  process.exit(1);
});
