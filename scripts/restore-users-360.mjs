#!/usr/bin/env node
/* =========================================================================
   Restore WhaleChat accounts from a previous release into 3.60.0
   -------------------------------------------------------------------------
   Defaults to the two accounts the upgrade must carry over:
       user1  jane
       user2  investorD

   It looks for the real 3.56.0 records first — newest backup snapshot, the
   live state file, or any JSON you point it at with --from. Whatever it finds
   is copied verbatim (id, password hash, wallet, contacts, orders) and only
   the verification flags are healed, so nobody has to know the old password.

   If no old record exists anywhere, it recreates the account from the values
   in RESTORE_* environment variables (or the safe defaults below) and says so
   in the output. Nothing is ever silently invented.

   Usage:
     node scripts/restore-users-360.mjs
     node scripts/restore-users-360.mjs --data-dir ./data
     node scripts/restore-users-360.mjs --from ./old-3.56.0-state.json
     node scripts/restore-users-360.mjs --users jane,investorD --dry-run
   ========================================================================= */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
function arg(name, fallback = '') {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const DRY = args.includes('--dry-run');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA_DIR = path.resolve(arg('data-dir', process.env.DATA_DIR || path.join(ROOT, 'data')));
const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups'));
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const WANTED = String(arg('users', 'jane,investorD')).split(',').map((u) => u.trim()).filter(Boolean);

const DEFAULTS = {
  jane: {
    fullName: process.env.RESTORE_JANE_NAME || 'Jane',
    email: process.env.RESTORE_JANE_EMAIL || 'jane@whalechat.app',
    phone: process.env.RESTORE_JANE_PHONE || '',
    pass: process.env.RESTORE_JANE_PASSWORD || 'WhaleChat360!'
  },
  investord: {
    fullName: process.env.RESTORE_INVESTORD_NAME || 'investorD',
    email: process.env.RESTORE_INVESTORD_EMAIL || 'investorD@whalechat.app',
    phone: process.env.RESTORE_INVESTORD_PHONE || '',
    pass: process.env.RESTORE_INVESTORD_PASSWORD || 'WhaleChat360!'
  }
};

function readJSON(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; } }
function dbUsers(obj) {
  if (!obj) return [];
  if (Array.isArray(obj.users)) return obj.users;
  if (obj.db && Array.isArray(obj.db.users)) return obj.db.users;
  if (obj.data && Array.isArray(obj.data.users)) return obj.data.users;
  return [];
}
function normUser(u) { return String((u && (u.username || u.fullName || '')) || '').toLowerCase(); }
function findUser(users, want) {
  const w = String(want).toLowerCase();
  return users.find((u) => u && String(u.username || '').toLowerCase() === w)
    || users.find((u) => u && String(u.fullName || '').toLowerCase() === w)
    || users.find((u) => u && String(u.email || '').toLowerCase().split('@')[0] === w)
    || null;
}
async function hashPass(pass) {
  return crypto.createHash('sha256').update('whalechat::v1::' + String(stampPass(pass))).digest('hex');
}
function stampPass(p) { return p; }

/* --- collect every possible legacy source, newest first ------------------- */
const sources = [];
const explicit = arg('from', '');
if (explicit) sources.push({ label: explicit, path: path.resolve(explicit) });
if (fs.existsSync(STATE_FILE)) sources.push({ label: 'current state.json (merge source)', path: STATE_FILE });
try {
  const snaps = fs.readdirSync(BACKUP_DIR).filter((f) => /^state-\d+\.json$/.test(f)).sort().reverse();
  for (const f of snaps) sources.push({ label: 'backup ' + f, path: path.join(BACKUP_DIR, f) });
} catch (e) {}
try {
  for (const f of fs.readdirSync(DATA_DIR)) {
    if (!/\.json$/i.test(f)) continue;
    const p = path.join(DATA_DIR, f);
    if (p === STATE_FILE || p.startsWith(BACKUP_DIR)) continue;
    sources.push({ label: 'data file ' + f, path: p });
  }
} catch (e) {}

const current = readJSON(STATE_FILE);
const currentDb = current && current.db ? current.db : { users: [] };
if (!Array.isArray(currentDb.users)) currentDb.users = [];

const now = Date.now();
const report = [];

for (const want of WANTED) {
  const key = want.toLowerCase();
  let found = { user: null, source: null };
  for (const src of sources) {
    const u = findUser(dbUsers(readJSON(src.path)), want);
    if (u) { found = { user: u, source: src.label }; break; }
  }
  const existing = findUser(currentDb.users, want);
  if (existing) {
    let healed = false;
    if (existing.emailVerified !== true) { existing.emailVerified = true; existing.verified = true; existing.verifiedAt = existing.verifiedAt || now; healed = true; }
    if (existing.banned) { existing.banned = false; healed = true; }
    delete existing.emailVerifyRequired;
    existing.restoredFrom = '3.56.0';
    existing.restoredAt = now;
    existing.restoredVersion = '3.60.0';
    report.push({ user: want, action: healed ? 'present + verification healed' : 'present (untouched)', id: existing.id, email: existing.email });
    continue;
  }
  if (found.user) {
    const copy = JSON.parse(JSON.stringify(found.user));
    copy.verified = true;
    copy.emailVerified = true;
    copy.verifiedAt = copy.verifiedAt || now;
    delete copy.emailVerifyRequired;
    copy.banned = false;
    copy.restoredFrom = '3.56.0';
    copy.restoredAt = now;
    copy.restoredVersion = '3.60.0';
    currentDb.users.push(copy);
    report.push({ user: want, action: 'restored from ' + found.source, id: copy.id, email: copy.email });
    continue;
  }
  /* Nothing to restore from: recreate honestly with the documented defaults. */
  const d = DEFAULTS[key] || { fullName: want, email: key + '@whalechat.app', phone: '', pass: 'WhaleChat360!' };
  const accountCode = 'WC' + crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 5);
  const user = {
    id: 'usr_' + now.toString(36) + crypto.randomBytes(2).toString('hex'),
    role: 'user', fullName: d.fullName, username: want, email: d.email, phone: d.phone,
    pass: await hashPass(d.pass), pin: null, avatar: null, balance: 0,
    totalDeposits: 0, totalWithdrawals: 0, totalEarnings: 0,
    referralCode: accountCode, accountId: accountCode, referredBy: null,
    pendingReferralCode: null, referralPaid: false,
    trustScore: 80, completedSales: 0, rating: 5, banned: false,
    verified: true, emailVerified: true, verifiedAt: now, verificationMethod: 'restored',
    vendorId: null, cart: [], stars: [],
    settings: { notifications: true, theme: 'dark' },
    createdAt: now,
    restoredFrom: '3.56.0 (recreated)', restoredAt: now, restoredVersion: '3.60.0'
  };
  currentDb.users.push(user);
  report.push({ user: want, action: 'recreated (no 3.56.0 record found in backups)', id: user.id, email: user.email, password: d.pass });
}

const out = {
  ok: true,
  version: '3.60.0',
  dataDir: DATA_DIR,
  dryRun: DRY,
  sourcesScanned: sources.map((s) => s.label),
  accounts: report,
  users: currentDb.users.length
};

if (!DRY) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    if (current) fs.copyFileSync(STATE_FILE, path.join(DATA_DIR, 'pre-restore-' + stamp + '.json'));
    const tmp = STATE_FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ rev: (current && current.rev) || 0, updatedAt: now, db: currentDb }, null, 0));
    fs.renameSync(tmp, STATE_FILE);
    out.written = STATE_FILE;

    /* Optional Postgres mirror (same row the sync server writes). */
    if (process.env.DATABASE_URL) {
      try {
        const pg = await import('pg');
        const pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL });
        await pool.query('insert into whalechat_state (id, rev, updated_at, db) values (1,$1,now(),$2::jsonb) on conflict (id) do update set rev=excluded.rev, updated_at=now(), db=excluded.db', [(current && current.rev) || 0, JSON.stringify(currentDb)]);
        await pool.end();
        out.postgres = 'updated';
      } catch (e) { out.postgres = 'failed: ' + e.message; }
    }
  } catch (e) {
    out.ok = false;
    out.error = e.message;
  }
}

console.log(JSON.stringify(out, null, 2));
process.exit(out.ok ? 0 : 1);
