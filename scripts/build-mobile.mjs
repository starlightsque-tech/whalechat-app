#!/usr/bin/env node
/* Build the mobile bundle: copy public/ → mobile/www, bake sync server, disable SW for the native shell.
   Usage: WC_SYNC_SERVER=https://chat.yourdomain.com node scripts/build-mobile.mjs */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const src = path.join(root, 'public');
const out = path.resolve(process.env.WWW_DIR || path.join(root, 'mobile', 'www'));
const sync = (process.env.WC_SYNC_SERVER || '').replace(/\/+$/, '');

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    // ignore a nested build artifact folder that duplicates the web root
    if (entry.isDirectory() && entry.name === 'public' && from === src) continue;
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

copyDir(src, out);

const appFile = path.join(out, 'whalechat.html');
let html = fs.readFileSync(appFile, 'utf8');
html = html.replace(/const DEFAULT_SYNC_SERVER = '[^']*';/,
  `const DEFAULT_SYNC_SERVER = '${sync.replace(/'/g, "\\'")}';`);
// native shell: no service worker (Capacitor serves from https://localhost)
html = html.replace(
  "if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {",
  "if (false && 'serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {");
fs.writeFileSync(appFile, html);

fs.writeFileSync(path.join(out, 'mobile-config.json'), JSON.stringify({
  syncServer: sync || null,
  builtAt: new Date().toISOString(),
  platform: 'capacitor'
}, null, 2));

console.log('[mobile] bundle ready →', out);
console.log('[mobile] sync server:', sync || '(none — local mode until connected)');
