#!/usr/bin/env node
/* =========================================================================
   WhaleChat · Expo / EAS deploy helper
   -------------------------------------------------------------------------
   Expo builds and hosts *Expo apps*, not arbitrary static folders. WhaleChat
   is a self-contained PWA, so the Expo deliverable is the WebView shell in
   ./expo that loads the deployed app from https://whalechat.appwrite.network.

   Required:
     EXPO_TOKEN     expo.dev → Account settings → Access tokens (robot token)

   Optional:
     EAS_PROJECT_ID set in expo/app.json (expo.extra.eas.projectId)
     WC_WEB_URL     override the URL the shell loads

   Usage:
     EXPO_TOKEN=... node scripts/deploy-expo.mjs --platform android
     EXPO_TOKEN=... node scripts/deploy-expo.mjs --platform all --profile preview
   ========================================================================= */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const EXPO = path.join(ROOT, 'expo');
const TOKEN = String(process.env.EXPO_TOKEN || '').trim();

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const platform = arg('platform', 'android');
const profile = arg('profile', 'preview');
const WEB_URL = String(process.env.WC_WEB_URL || 'https://whalechat.appwrite.network/whalechat.html');

function run(cmd, argv, opts) {
  console.log('$ ' + [cmd].concat(argv).join(' '));
  return execFileSync(cmd, argv, Object.assign({ stdio: 'inherit', cwd: EXPO, env: process.env }, opts || {}));
}

function banner(msg) { console.log('\n[expo] ' + msg); }

if (!TOKEN) {
  console.error('[expo] EXPO_TOKEN is required (expo.dev → Account settings → Access tokens).');
  process.exit(2);
}
if (!fs.existsSync(EXPO)) {
  console.error('[expo] expo/ folder missing');
  process.exit(2);
}

process.env.EXPO_TOKEN = TOKEN;

try {
  banner('checking Expo credentials');
  run('npx', ['--yes', 'eas-cli', 'whoami']);

  /* point the shell at the live app */
  const appJsonPath = path.join(EXPO, 'app.json');
  const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
  appJson.expo.extra = Object.assign({}, appJson.expo.extra, { webUrl: WEB_URL });
  fs.writeFileSync(appJsonPath, JSON.stringify(appJson, null, 2) + '\n');
  banner('shell URL → ' + WEB_URL);

  const needsProject = !appJson.expo.extra.eas || !appJson.expo.extra.eas.projectId || /REPLACE/.test(appJson.expo.extra.eas.projectId);
  if (needsProject) {
    banner('initialising the EAS project (projectId is written into app.json)');
    run('npx', ['--yes', 'eas-cli', 'project:init', '--non-interactive'], { stdio: 'inherit' });
  }

  const platforms = platform === 'all' ? ['android', 'ios'] : [platform];
  for (const p of platforms) {
    banner('building ' + p + ' · profile ' + profile);
    run('npx', ['--yes', 'eas-cli', 'build', '-p', p, '--profile', profile, '--non-interactive', '--wait'], { stdio: 'inherit' });
  }

  banner('done — install links were printed by EAS and are listed on expo.dev → Projects → WhaleChat → Builds');
} catch (e) {
  console.error('[expo] ' + (e && e.message ? e.message : e));
  process.exit(1);
}
