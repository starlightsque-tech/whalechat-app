#!/usr/bin/env node
/**
 * Deploy the monorepo web app (apps/web/dist) to Appwrite Sites.
 *
 * Required:
 *   APPWRITE_PROJECT_ID, APPWRITE_API_KEY (sites.*, databases.*)
 * Optional:
 *   APPWRITE_ENDPOINT, APPWRITE_SITE_ID=whalechat
 *   WC_DEPLOY_DOMAIN=whalechat.appwrite.network   (bind/verify a custom domain)
 *   WC_SKIP_BUILD=1
 *
 * The build is copied to whalechat.html as well as index.html because the
 * existing Android APK (build 833ac022) loads /whalechat.html.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/web/dist');
const ENDPOINT = String(process.env.APPWRITE_ENDPOINT || 'https://nyc.cloud.appwrite.io/v1').replace(/\/+$/, '');
const PROJECT = String(process.env.APPWRITE_PROJECT_ID || '').trim();
const KEY = String(process.env.APPWRITE_API_KEY || '').trim();
const SITE_ID = String(process.env.APPWRITE_SITE_ID || 'whalechat').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
const DOMAIN = String(process.env.WC_DEPLOY_DOMAIN || '').trim();

if (!PROJECT || !KEY) {
  console.error('[deploy] Missing APPWRITE_PROJECT_ID / APPWRITE_API_KEY.');
  console.error('[deploy] Create a key with sites.* + databases.* scopes in Appwrite Console, then re-run.');
  process.exit(2);
}

const headers = {
  'X-Appwrite-Project': PROJECT,
  'X-Appwrite-Key': KEY,
  'X-Appwrite-Response-Format': '1.9.5',
};

async function req(pathname, opts) {
  const res = await fetch(ENDPOINT + pathname, Object.assign({ headers }, opts || {}));
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* text response */ }
  return { ok: res.ok, status: res.status, json, text };
}

async function ensureSite() {
  const got = await req('/sites/' + encodeURIComponent(SITE_ID));
  if (got.ok) return got.json;
  const made = await req('/sites', {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' }, headers),
    body: JSON.stringify({
      siteId: SITE_ID,
      name: process.env.APPWRITE_SITE_NAME || 'Whalechat',
      framework: 'other',
      buildRuntime: 'node-22',
      adapter: 'static',
      installCommand: '',
      buildCommand: '',
      outputDirectory: './',
      enabled: true,
    }),
  });
  if (!made.ok) throw new Error('create site failed: ' + made.status + ' ' + (made.json?.message || made.text));
  return made.json;
}

function buildIfNeeded() {
  if (process.env.WC_SKIP_BUILD === '1' && fs.existsSync(path.join(DIST, 'index.html'))) return;
  console.log('[deploy] building apps/web (hosted multi-file bundle)…');
  execFileSync('pnpm', ['--filter', '@whalechat/web', 'build:hosted'], { stdio: 'inherit', cwd: ROOT });
}

function packageDist() {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) throw new Error('apps/web/dist/index.html missing');
  // The shipping APK requests /whalechat.html, so publish both entry names.
  fs.copyFileSync(path.join(DIST, 'index.html'), path.join(DIST, 'whalechat.html'));
  const out = path.join(os.tmpdir(), 'whalechat-monorepo-' + Date.now() + '.tar.gz');
  execFileSync('tar', ['--exclude=*.map', '-czf', out, '-C', DIST, '.']);
  console.log('[deploy] packaged', (fs.statSync(out).size / 1024).toFixed(0) + ' KB');
  return out;
}

async function bindDomain() {
  if (!DOMAIN) return;
  // Appwrite's own <site>.appwrite.network hostname is assigned automatically;
  // attempting to add it as a custom domain can 400/409. Verify it instead.
  if (DOMAIN === SITE_ID + '.appwrite.network') {
    console.log('[deploy] using the Appwrite-assigned hostname:', DOMAIN);
    return;
  }
  const list = await req('/sites/' + encodeURIComponent(SITE_ID) + '/domains');
  const exists = list.ok && (list.json?.domains || []).some((d) => d.domain === DOMAIN);
  if (exists) {
    console.log('[deploy] domain already attached:', DOMAIN);
    return;
  }
  const made = await req('/sites/' + encodeURIComponent(SITE_ID) + '/domains', {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' }, headers),
    body: JSON.stringify({ domain: DOMAIN }),
  });
  if (!made.ok) console.warn('[deploy] domain bind warning:', made.status, made.json?.message || made.text);
  else console.log('[deploy] domain bound:', DOMAIN);
}

(async () => {
  console.log('[deploy]', ENDPOINT, '· project', PROJECT, '· site', SITE_ID);
  buildIfNeeded();
  await ensureSite();
  const tarPath = packageDist();
  const form = new FormData();
  form.append('installCommand', '');
  form.append('buildCommand', '');
  form.append('outputDirectory', './');
  form.append('activate', 'true');
  form.append('code', new Blob([fs.readFileSync(tarPath)], { type: 'application/gzip' }), path.basename(tarPath));

  const dep = await req('/sites/' + encodeURIComponent(SITE_ID) + '/deployments', { method: 'POST', body: form });
  if (!dep.ok) throw new Error('deployment failed: ' + dep.status + ' ' + (dep.json?.message || dep.text));
  const id = dep.json?.$id;
  console.log('[deploy] deployment', id, dep.json?.status);

  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => setTimeout(r, 3000));
    const st = await req('/sites/' + encodeURIComponent(SITE_ID) + '/deployments/' + encodeURIComponent(id));
    const status = st.json?.status;
    console.log('[deploy] status:', status || st.status);
    if (status === 'ready' || status === 'active') break;
    if (status === 'failed' || status === 'canceled') {
      throw new Error('deployment ' + status + ': ' + (st.json?.buildLogs || ''));
    }
  }

  await bindDomain();

  if (DOMAIN) {
    const probe = await fetch('https://' + DOMAIN + '/whalechat.html', { cache: 'no-store' });
    console.log('[deploy] verify https://' + DOMAIN + '/whalechat.html →', probe.status);
    const body = await probe.text();
    if (probe.status !== 200 || !/Whalechat|WhaleChat/i.test(body)) {
      throw new Error('deployed bundle did not serve the Whalechat app (HTTP ' + probe.status + ')');
    }
    console.log('[deploy] bundle verified — the existing APK loads this URL.');
  }
})().catch((e) => {
  console.error('[deploy] error:', e.message);
  process.exit(1);
});
