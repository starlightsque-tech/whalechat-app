#!/usr/bin/env node
/* =========================================================================
   Restore whalechat_state from a backup file produced by backup-state.mjs.

     DATABASE_URL=... node scripts/restore-state.mjs --file=backups/whalechat-state-2026-11-19.json --yes

   Safety:
     · refuses to run without --yes
     · validates the payload (must contain a db object with a users array,
       unless --force is passed)
     · writes rev+1 so every connected device sees the restore as newer
     · keeps a copy of the current row in <file>.pre-restore.json when it can
   The running web service loads state at boot, so restart it afterwards.
   ========================================================================= */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const hit = args.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.split('=').slice(1).join('=') : dflt;
};
const FILE = arg('file', '');
const YES = args.includes('--yes');
const FORCE = args.includes('--force');

if (!FILE) { console.error('Pass --file=backups/whalechat-state-YYYY-MM-DD.json'); process.exit(2); }
if (!fs.existsSync(FILE)) { console.error('File not found: ' + FILE); process.exit(2); }

const raw = fs.readFileSync(FILE, 'utf8');
let parsed;
try { parsed = JSON.parse(raw); } catch (e) { console.error('Not valid JSON:', e.message); process.exit(2); }

/* accept: {db, rev}, the server snapshot shape {at, tag, rev, db}, or a bare db */
const db = parsed && parsed.db ? parsed.db : parsed;
const rev = Number((parsed && parsed.rev) || 0);

if (!db || typeof db !== 'object') { console.error('Payload has no db object.'); process.exit(2); }
if (!Array.isArray(db.users) && !FORCE) {
  console.error('Payload has no users array — looks wrong. Use --force only if you are certain.');
  process.exit(2);
}

if (!YES) {
  console.log('About to overwrite whalechat_state with:');
  console.log('  file   ', path.resolve(FILE));
  console.log('  rev    ', rev);
  console.log('  users  ', Array.isArray(db.users) ? db.users.length : 'unknown');
  console.log('\nRe-run with --yes to apply.');
  process.exit(0);
}

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set.'); process.exit(2); }

const pg = (await import('pg')).default;
const needsSsl = /sslmode=require|sslmode=no-verify/i.test(url) || /supabase\.(co|com)/i.test(url);
const conn = needsSsl ? url.replace(/([?&])sslmode=[^&]*/i, '$1').replace(/[?&]$/, '') : url;
const pool = new pg.Pool({ connectionString: conn, max: 1, ssl: needsSsl ? { rejectUnauthorized: false } : undefined, connectionTimeoutMillis: 20000 });

try {
  /* keep a copy of whatever is live right now */
  const current = await pool.query('select rev, updated_at, db from whalechat_state where id = 1');
  if (current.rows[0]) {
    const keep = path.resolve(FILE).replace(/\.json$/, '') + '.pre-restore.json';
    fs.writeFileSync(keep, JSON.stringify({ savedAt: new Date().toISOString(), ...current.rows[0] }, null, 2));
    console.log('current row saved to ' + keep);
  }

  const nextRev = Math.max(Number(current.rows[0] && current.rows[0].rev) || 0, rev) + 1;
  await pool.query(
    `insert into whalechat_state (id, rev, updated_at, db)
     values (1, $1, now(), $2::jsonb)
     on conflict (id) do update set rev = excluded.rev, updated_at = now(), db = excluded.db`,
    [nextRev, JSON.stringify(db)]
  );
  console.log('restored whalechat_state at rev ' + nextRev + ' · users ' + (Array.isArray(db.users) ? db.users.length : '?'));
  console.log('\nNext: restart the web service so it loads the restored state');
  console.log('  Render dashboard → Manual Deploy → Deploy latest commit');
  console.log('  or: curl -X POST -H "Authorization: Bearer $RENDER_API" \\');
  console.log('        https://api.render.com/v1/services/<service-id>/deploys -d \'{"clearCache":"do_not_clear"}\'');
} catch (e) {
  console.error('restore failed:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}
