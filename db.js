'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, 'urb.db');
// Backups live in data/backups unless BACKUP_DIR points somewhere else (ideally another disk).
const backupDir = path.resolve(process.env.BACKUP_DIR || path.join(dataDir, 'backups'));

/* ---------- self-recovery on startup ----------
   If the database file is missing or damaged but backups exist, put the newest
   good backup in its place before opening it, so the site comes back on its own.
   What happened is kept in `recovery` and written to the activity log below. */
function quickCheck(file) {
  let probe;
  try {
    probe = new Database(file, { readonly: true, fileMustExist: true });
    const res = probe.pragma('quick_check', { simple: true });
    const hasTables = !!probe.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'bookings'").get();
    return res === 'ok' && hasTables;
  } catch (e) {
    return false;
  } finally {
    if (probe) try { probe.close(); } catch (e) {}
  }
}
function newestGoodBackup() {
  if (!fs.existsSync(backupDir)) return null;
  // Names start urb-YYYY-MM-DD_HHMMSS: newest first, with file times breaking same-second ties.
  const files = fs.readdirSync(backupDir).filter(f => /^urb-.*\.db$/.test(f))
    .map(f => ({ f, t: f.slice(0, 21), m: fs.statSync(path.join(backupDir, f)).mtimeMs }))
    .sort((a, b) => (a.t < b.t ? 1 : a.t > b.t ? -1 : b.m - a.m)).map(x => x.f);
  for (const f of files) if (quickCheck(path.join(backupDir, f))) return f;
  return null;
}
let recovery = null;
(function recoverIfNeeded() {
  const exists = fs.existsSync(dbPath);
  if (exists && quickCheck(dbPath)) return;
  const pick = newestGoodBackup();
  if (!pick) {
    if (exists) recovery = { ok: false, reason: 'damaged', message: 'The database failed its health check on startup and no good backup was found, so it was left as it is.' };
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  if (exists) {
    ['', '-wal', '-shm'].forEach(ext => { if (fs.existsSync(dbPath + ext)) fs.renameSync(dbPath + ext, dbPath + '.damaged-' + stamp + ext); });
  } else {
    ['-wal', '-shm'].forEach(ext => { if (fs.existsSync(dbPath + ext)) fs.rmSync(dbPath + ext); });
  }
  fs.copyFileSync(path.join(backupDir, pick), dbPath);
  recovery = { ok: true, reason: exists ? 'damaged' : 'missing', backup: pick,
    message: (exists ? 'The database was damaged (the bad copy was kept as data/urb.db.damaged-' + stamp + ')' : 'The database file was missing') +
      ', so it was restored automatically from backup ' + pick + '. Anything changed after that backup was taken is lost.' };
  console.error('[recovery] ' + recovery.message);
})();

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS bookings (
    id TEXT PRIMARY KEY,
    studio INTEGER NOT NULL,
    title TEXT NOT NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    is_admin INTEGER NOT NULL DEFAULT 0,
    repeat TEXT NOT NULL DEFAULT 'none',
    pending_repeat INTEGER NOT NULL DEFAULT 0,
    color TEXT,
    date TEXT NOT NULL,
    start_min INTEGER NOT NULL,
    end_min INTEGER NOT NULL,
    repeat_until TEXT,
    is_podcast INTEGER NOT NULL DEFAULT 0,
    pending_cancel INTEGER NOT NULL DEFAULT 0,
    icon TEXT
  );
  CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS admin_secret (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    salt TEXT NOT NULL,
    hash TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS admin_sessions (
    token TEXT PRIMARY KEY,
    expires INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS equipment (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS categories (
    key TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    color TEXT NOT NULL,
    hint TEXT NOT NULL DEFAULT '',
    sort INTEGER NOT NULL DEFAULT 0
  );
  -- Everything anyone does on the site, plus what the server does by itself.
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    summary TEXT NOT NULL,
    details TEXT
  );
  CREATE INDEX IF NOT EXISTS audit_log_at ON audit_log (at);
  -- A snapshot of each academic year's schedule, taken when it's cleared on 1 September.
  CREATE TABLE IF NOT EXISTS archives (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    created_at TEXT NOT NULL,
    reason TEXT NOT NULL,
    booking_count INTEGER NOT NULL,
    data TEXT NOT NULL,
    undone_at TEXT
  );
`);

// Migrate older databases created before these columns existed.
const existingCols = db.prepare("PRAGMA table_info(bookings)").all().map(c => c.name);
if (!existingCols.includes('is_podcast')) db.exec("ALTER TABLE bookings ADD COLUMN is_podcast INTEGER NOT NULL DEFAULT 0");
if (!existingCols.includes('pending_cancel')) db.exec("ALTER TABLE bookings ADD COLUMN pending_cancel INTEGER NOT NULL DEFAULT 0");
if (!existingCols.includes('icon')) db.exec("ALTER TABLE bookings ADD COLUMN icon TEXT");
if (!existingCols.includes('pending_approval')) db.exec("ALTER TABLE bookings ADD COLUMN pending_approval INTEGER NOT NULL DEFAULT 0");
// Roadshow (studio 3) bookings reserve equipment rather than a room: JSON array of equipment ids.
if (!existingCols.includes('items')) db.exec("ALTER TABLE bookings ADD COLUMN items TEXT");
// Show type (flagship, training, …) — drives the booking's colour on the grid.
// A member's proposed edit (name/description/image/time) waiting for admin approval, as JSON.
// Kept separate from the live fields so the schedule doesn't change until it's approved.
if (!existingCols.includes('pending_change')) db.exec("ALTER TABLE bookings ADD COLUMN pending_change TEXT");
if (!existingCols.includes('category')) {
  db.exec("ALTER TABLE bookings ADD COLUMN category TEXT");
  // The old podcast checkbox became the "Podcast recording" show type.
  db.exec("UPDATE bookings SET category = 'podcast' WHERE is_podcast = 1");
}

const existingMemberCols = db.prepare("PRAGMA table_info(members)").all().map(c => c.name);
// Existing members were trusted under the old no-approval flow, so grandfather them in as approved.
if (!existingMemberCols.includes('approved')) db.exec("ALTER TABLE members ADD COLUMN approved INTEGER NOT NULL DEFAULT 1");
// Member logins were tried and withdrawn: clear any stored passwords and sessions.
if (existingMemberCols.includes('pw_hash')) db.exec("UPDATE members SET pw_salt = NULL, pw_hash = NULL WHERE pw_hash IS NOT NULL");
db.exec("DROP TABLE IF EXISTS member_sessions; DROP TABLE IF EXISTS member_tokens;");
// Only members with media membership (switched on by an admin) can book.
if (!existingMemberCols.includes('media_member')) db.exec("ALTER TABLE members ADD COLUMN media_member INTEGER NOT NULL DEFAULT 0");
// When the member last booked or asked for something — drives the inactive-member clean-up.
if (!existingMemberCols.includes('last_active_at')) db.exec("ALTER TABLE members ADD COLUMN last_active_at TEXT");

// Show types are admin-editable; seed the starting set the first time.
// 'other' is permanent: removed categories fall back to it.
const DEFAULT_CATEGORIES = [
  ['flagship', 'Flagship', '#f2b705', ''],
  ['training', 'Training', '#3fbfcf', ''],
  ['music', 'Entertainment / General Music', '#2f6fb0', ''],
  ['talk', 'Talk', '#e84a8a', ''],
  ['specialist', 'Specialist Music', '#7b4fc9', 'A show focused on one genre'],
  ['news', 'Journalistic / News', '#c0392b', ''],
  ['sports', 'Sports', '#2e9e4f', ''],
  ['podcast', 'Podcast recording', '#1f8a70', ''],
  ['events', 'Events', '#f07c2a', 'e.g. Varsity, IWD, interviews'],
  ['other', 'Other', '#8a96a3', '']
];
if (db.prepare('SELECT COUNT(*) AS n FROM categories').get().n === 0) {
  const ins = db.prepare('INSERT INTO categories (key, label, color, hint, sort) VALUES (?, ?, ?, ?, ?)');
  DEFAULT_CATEGORIES.forEach((c, i) => ins.run(c[0], c[1], c[2], c[3], i));
}

/* ---------- password hashing (scrypt, no extra dependency) ---------- */
function hashPassphrase(passphrase) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(passphrase, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassphrase(passphrase, salt, hash) {
  const check = crypto.scryptSync(passphrase, salt, 64);
  const stored = Buffer.from(hash, 'hex');
  if (check.length !== stored.length) return false;
  return crypto.timingSafeEqual(check, stored);
}

// The passphrase can be changed from the System page, or by editing ADMIN_PASSPHRASE
// in .env and restarting (the break-glass route if nobody remembers it). The .env
// value only takes over when it differs from the last .env value applied, so a
// passphrase changed on the System page survives restarts.
function setAdminPassphrase(passphrase) {
  const { salt, hash } = hashPassphrase(passphrase);
  db.prepare(`INSERT INTO admin_secret (id, salt, hash) VALUES (1, ?, ?)
              ON CONFLICT(id) DO UPDATE SET salt=excluded.salt, hash=excluded.hash`).run(salt, hash);
  // Rotating the passphrase signs everyone out.
  db.prepare('DELETE FROM admin_sessions').run();
}
// Returns true when the .env passphrase was (re)applied.
function ensureAdminPassphrase(passphraseFromEnv) {
  if (!passphraseFromEnv) throw new Error('ADMIN_PASSPHRASE is not set in .env');
  const row = db.prepare('SELECT salt, hash FROM admin_secret WHERE id = 1').get();
  const envSeen = parseJson(getState('envPassphrase'));
  if (row && envSeen && verifyPassphrase(passphraseFromEnv, envSeen.salt, envSeen.hash)) return false;
  setState('envPassphrase', JSON.stringify(hashPassphrase(passphraseFromEnv)));
  // Unchanged passphrase: keep the stored hash and existing sessions.
  if (row && verifyPassphrase(passphraseFromEnv, row.salt, row.hash)) return false;
  setAdminPassphrase(passphraseFromEnv);
  return true;
}
function checkAdminPassphrase(passphrase) {
  const row = db.prepare('SELECT salt, hash FROM admin_secret WHERE id = 1').get();
  if (!row) return false;
  return verifyPassphrase(passphrase || '', row.salt, row.hash);
}

/* ---------- admin sessions (persisted so a server restart doesn't sign admins out) ---------- */
function createSession(token, expires) { db.prepare('INSERT INTO admin_sessions (token, expires) VALUES (?, ?)').run(token, expires); }
function getSessionExpiry(token) {
  const r = db.prepare('SELECT expires FROM admin_sessions WHERE token = ?').get(token);
  return r ? r.expires : null;
}
function extendSession(token, expires) { db.prepare('UPDATE admin_sessions SET expires = ? WHERE token = ?').run(expires, token); }
function deleteSession(token) { db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(token); }
function purgeExpiredSessions(now) { db.prepare('DELETE FROM admin_sessions WHERE expires < ?').run(now); }

/* ---------- settings (admin-configurable limits) ---------- */
// [default, min, max] — every setting is a whole number.
const SETTING_DEFS = {
  djWeeklyCapMin:  [120, 0, 10080],  // one-off Studio Two minutes per member per week
  djMinSlotMin:    [30, 15, 1440],   // shortest Studio Two slot a member can book
  djMaxSlotMin:    [60, 15, 1440],   // longest Studio Two slot a member can book
  radioMaxHours:   [2, 1, 24],       // longest Studio One show a member can book
  maxAdvanceDays:  [0, 0, 3650],     // how far ahead members can book (0 = no limit)
  roadshowMaxDays: [7, 1, 365],      // longest Roadshow booking a member can make
  normalStartHour: [8, 0, 23],       // first hour shown in the full-week view
  normalEndHour:   [24, 1, 24]       // last hour shown in the full-week view
};
function getSettings() {
  const out = {};
  Object.keys(SETTING_DEFS).forEach(k => { out[k] = SETTING_DEFS[k][0]; });
  db.prepare('SELECT key, value FROM settings').all().forEach(r => {
    if (SETTING_DEFS[r.key]) out[r.key] = Number(r.value);
  });
  return out;
}
// Returns an error string, or null once every supplied value is valid and saved.
function saveSettings(input) {
  const next = getSettings();
  for (const k of Object.keys(input || {})) {
    if (!SETTING_DEFS[k]) continue;
    const v = Number(input[k]);
    const min = SETTING_DEFS[k][1], max = SETTING_DEFS[k][2];
    if (!Number.isInteger(v) || v < min || v > max) return 'Invalid value for ' + k + ' (must be a whole number from ' + min + ' to ' + max + ').';
    next[k] = v;
  }
  if (next.djMinSlotMin > next.djMaxSlotMin) return 'The shortest DJ slot cannot be longer than the longest DJ slot.';
  if (next.normalStartHour >= next.normalEndHour) return 'The full-week view must start before it ends.';
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  db.transaction(() => { Object.keys(next).forEach(k => stmt.run(k, String(next[k]))); })();
  return null;
}

/* ---------- roadshow equipment ---------- */
function rowToItem(r) { return { id: r.id, name: r.name, notes: r.notes || '', active: !!r.active }; }
function listEquipment() { return db.prepare('SELECT * FROM equipment ORDER BY name COLLATE NOCASE').all().map(rowToItem); }
function getEquipment(id) {
  const r = db.prepare('SELECT * FROM equipment WHERE id = ?').get(id);
  return r ? rowToItem(r) : null;
}
function addEquipment(name, notes) {
  const info = db.prepare('INSERT INTO equipment (name, notes) VALUES (?, ?)').run(name, notes || '');
  return getEquipment(info.lastInsertRowid);
}
function updateEquipment(id, fields) {
  const cur = getEquipment(id);
  if (!cur) return null;
  db.prepare('UPDATE equipment SET name = ?, notes = ?, active = ? WHERE id = ?').run(
    fields.name != null ? fields.name : cur.name,
    fields.notes != null ? fields.notes : cur.notes,
    (fields.active != null ? fields.active : cur.active) ? 1 : 0,
    id);
  return getEquipment(id);
}
function deleteEquipment(id) { db.prepare('DELETE FROM equipment WHERE id = ?').run(id); }

/* ---------- row <-> API object mapping ---------- */
function parseJson(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}
function parseItems(raw) {
  if (!raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v.filter(Number.isInteger) : []; } catch (e) { return []; }
}
function rowToBooking(r) {
  return {
    id: r.id, studio: r.studio, title: r.title, name: r.name, email: r.email,
    description: r.description || '', admin: !!r.is_admin, repeat: r.repeat,
    pendingRepeat: !!r.pending_repeat, color: r.color || null, date: r.date,
    startMin: r.start_min, endMin: r.end_min, repeatUntil: r.repeat_until || null,
    isPodcast: !!r.is_podcast, pendingCancel: !!r.pending_cancel,
    pendingApproval: !!r.pending_approval, icon: r.icon || null,
    items: parseItems(r.items), category: r.category || null,
    pendingChange: parseJson(r.pending_change)
  };
}
function rowToMember(r) {
  return { id: r.id, name: r.name, email: r.email, approved: !!r.approved, createdAt: r.created_at, mediaMember: !!r.media_member, lastActiveAt: r.last_active_at || null };
}

/* ---------- bookings ---------- */
function listBookings() {
  return db.prepare('SELECT * FROM bookings ORDER BY date, start_min').all().map(rowToBooking);
}
function getBooking(id) {
  const r = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  return r ? rowToBooking(r) : null;
}
function upsertBooking(b) {
  db.prepare(`
    INSERT INTO bookings (id, studio, title, name, email, description, is_admin, repeat, pending_repeat, color, date, start_min, end_min, repeat_until, is_podcast, pending_cancel, pending_approval, icon, items, category)
    VALUES (@id, @studio, @title, @name, @email, @description, @isAdmin, @repeat, @pendingRepeat, @color, @date, @startMin, @endMin, @repeatUntil, @isPodcast, @pendingCancel, @pendingApproval, @icon, @items, @category)
    ON CONFLICT(id) DO UPDATE SET
      studio=excluded.studio, title=excluded.title, name=excluded.name, email=excluded.email,
      description=excluded.description, is_admin=excluded.is_admin, repeat=excluded.repeat,
      pending_repeat=excluded.pending_repeat, color=excluded.color, date=excluded.date,
      start_min=excluded.start_min, end_min=excluded.end_min, repeat_until=excluded.repeat_until,
      is_podcast=excluded.is_podcast, pending_cancel=excluded.pending_cancel, pending_approval=excluded.pending_approval,
      icon=excluded.icon, items=excluded.items, category=excluded.category
  `).run({
    id: b.id, studio: b.studio, title: b.title, name: b.name, email: b.email,
    description: b.description || '', isAdmin: b.admin ? 1 : 0, repeat: b.repeat || 'none',
    pendingRepeat: b.pendingRepeat ? 1 : 0, color: b.color || null, date: b.date,
    startMin: b.startMin, endMin: b.endMin, repeatUntil: b.repeatUntil || null,
    isPodcast: b.isPodcast ? 1 : 0, pendingCancel: b.pendingCancel ? 1 : 0,
    pendingApproval: b.pendingApproval ? 1 : 0, icon: b.icon || null,
    items: Array.isArray(b.items) && b.items.length ? JSON.stringify(b.items) : null,
    category: b.category || null
  });
  return getBooking(b.id);
}
function deleteBooking(id) { db.prepare('DELETE FROM bookings WHERE id = ?').run(id); }
function setPendingCancel(id, value) { db.prepare('UPDATE bookings SET pending_cancel = ? WHERE id = ?').run(value ? 1 : 0, id); }
// Not touched by upsertBooking, so an admin editing a booking doesn't silently drop a member's request.
function setPendingChange(id, change) { db.prepare('UPDATE bookings SET pending_change = ? WHERE id = ?').run(change ? JSON.stringify(change) : null, id); }

// Sum of minutes already booked by this member as one-off (non-weekly) Studio Two
// slots within [weekStartDate, weekEndDate], excluding a given booking id (for edits)
// and excluding still-pending override requests (they don't count until approved).
function djWeeklyMinutes(email, weekStartDate, weekEndDate, excludeId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(end_min - start_min), 0) AS mins FROM bookings
    WHERE studio = 2 AND repeat != 'weekly' AND pending_approval = 0
      AND email = ? COLLATE NOCASE AND date >= ? AND date <= ? AND id != ?
  `).get(email, weekStartDate, weekEndDate, excludeId || '');
  return row.mins;
}

// Absolute minute index of a (date, minute) pair, so bookings that run past
// midnight (endMin > 1440) can be compared across days.
function absMin(dateStr, min) {
  const p = dateStr.split('-').map(Number);
  return Math.round(Date.UTC(p[0], p[1] - 1, p[2]) / 86400000) * 1440 + min;
}
// Roadshow bookings that share at least one item with the given range.
function roadshowConflicts(itemIds, date, startMin, endMin, excludeId) {
  const s = absMin(date, startMin), e = absMin(date, endMin);
  return db.prepare('SELECT * FROM bookings WHERE studio = 3 AND pending_approval = 0 AND id != ?').all(excludeId || '')
    .map(rowToBooking)
    .filter(b => {
      const bs = absMin(b.date, b.startMin), be = absMin(b.date, b.endMin);
      return s < be && bs < e && b.items.some(i => itemIds.indexOf(i) >= 0);
    });
}

/* ---------- members ---------- */
function listApprovedMembers() { return db.prepare('SELECT * FROM members WHERE approved = 1 ORDER BY name COLLATE NOCASE').all().map(rowToMember); }
function listPendingMembers() { return db.prepare('SELECT * FROM members WHERE approved = 0 ORDER BY created_at').all().map(rowToMember); }
function findMemberByEmail(email) {
  const r = db.prepare('SELECT * FROM members WHERE email = ? COLLATE NOCASE').get(email);
  return r ? rowToMember(r) : null;
}
function insertMember(name, email) {
  const info = db.prepare('INSERT INTO members (name, email, approved) VALUES (?, ?, 0)').run(name, email);
  return rowToMember(db.prepare('SELECT * FROM members WHERE id = ?').get(info.lastInsertRowid));
}
function approveMember(id) {
  db.prepare('UPDATE members SET approved = 1 WHERE id = ?').run(id);
  return rowToMember(db.prepare('SELECT * FROM members WHERE id = ?').get(id));
}
function deleteMember(id) { db.prepare('DELETE FROM members WHERE id = ?').run(id); }
function getMember(id) {
  const r = db.prepare('SELECT * FROM members WHERE id = ?').get(id);
  return r ? rowToMember(r) : null;
}
function setMediaMember(id, value) {
  db.prepare('UPDATE members SET media_member = ? WHERE id = ?').run(value ? 1 : 0, id);
  return getMember(id);
}

/* ---------- show categories ---------- */
function listCategories() { return db.prepare('SELECT key, label, color, hint FROM categories ORDER BY sort, label').all(); }
function categoryExists(key) { return !!db.prepare('SELECT 1 FROM categories WHERE key = ?').get(key); }
function addCategory(label, color, hint) {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'type';
  let key = base, n = 2;
  while (categoryExists(key)) key = base + '-' + (n++);
  const sort = db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM categories').get().s;
  db.prepare('INSERT INTO categories (key, label, color, hint, sort) VALUES (?, ?, ?, ?, ?)').run(key, label, color, hint || '', sort);
  return listCategories().find(c => c.key === key);
}
function updateCategory(key, fields) {
  const cur = db.prepare('SELECT * FROM categories WHERE key = ?').get(key);
  if (!cur) return null;
  db.prepare('UPDATE categories SET label = ?, color = ?, hint = ? WHERE key = ?').run(
    fields.label != null ? fields.label : cur.label,
    fields.color != null ? fields.color : cur.color,
    fields.hint != null ? fields.hint : cur.hint, key);
  return listCategories().find(c => c.key === key);
}
// Removing a show type moves its bookings to 'other'.
function deleteCategory(key) {
  db.transaction(() => {
    db.prepare("UPDATE bookings SET category = 'other', is_podcast = 0 WHERE category = ?").run(key);
    db.prepare('DELETE FROM categories WHERE key = ?').run(key);
  })();
}
// Swap a category with its neighbour (dir -1 = up, +1 = down).
function moveCategory(key, dir) {
  const list = db.prepare('SELECT key FROM categories ORDER BY sort, label').all().map(r => r.key);
  const i = list.indexOf(key), j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  list[i] = list[j]; list[j] = key;
  const upd = db.prepare('UPDATE categories SET sort = ? WHERE key = ?');
  db.transaction(() => list.forEach((k, idx) => upd.run(idx, k)))();
}

/* ---------- system config + server state (System page) ----------
   Stored in the settings table as JSON under 'sys.*' (things admins set) and
   'state.*' (things the server keeps track of, e.g. when the last backup ran). */
function getKey(key) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : null;
}
function setKey(key, value) {
  if (value == null) db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  else db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
function getState(name) { return getKey('state.' + name); }
function setState(name, value) { setKey('state.' + name, value); }
function getStateJson(name) { return parseJson(getState(name)); }
function setStateJson(name, value) { setState(name, value == null ? null : JSON.stringify(value)); }
function getSys(name, fallback) {
  const raw = getKey('sys.' + name);
  if (raw == null) return fallback;
  try { return JSON.parse(raw); } catch (e) { return fallback; }
}
function setSys(name, value) { setKey('sys.' + name, JSON.stringify(value)); }

/* ---------- activity log ---------- */
function addAudit(actor, action, summary, details) {
  db.prepare('INSERT INTO audit_log (at, actor, action, summary, details) VALUES (?, ?, ?, ?, ?)').run(
    new Date().toISOString(), String(actor || 'system').slice(0, 200), action, String(summary).slice(0, 500),
    details == null ? null : JSON.stringify(details));
}
// Newest first. filter: { q, type (action prefix), from, to (YYYY-MM-DD), before (id), limit }
function listAudit(filter) {
  const f = filter || {};
  const where = [], args = [];
  if (f.q) { where.push('(summary LIKE ? OR actor LIKE ? OR details LIKE ?)'); const q = '%' + f.q + '%'; args.push(q, q, q); }
  if (f.type) { where.push('action LIKE ?'); args.push(f.type + '%'); }
  if (f.from) { where.push('at >= ?'); args.push(f.from); }
  if (f.to) { where.push('at < ?'); args.push(f.to + 'T99'); }
  if (f.before) { where.push('id < ?'); args.push(Number(f.before)); }
  const sql = 'SELECT * FROM audit_log' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY id DESC LIMIT ?';
  args.push(Math.min(Number(f.limit) || 100, 5000));
  return db.prepare(sql).all(...args).map(r => ({ id: r.id, at: r.at, actor: r.actor, action: r.action, summary: r.summary, details: parseJson(r.details) }));
}

/* ---------- schedule archives ---------- */
function rowToArchive(r, withData) {
  const out = { id: r.id, label: r.label, createdAt: r.created_at, reason: r.reason, bookingCount: r.booking_count, undoneAt: r.undone_at || null };
  if (withData) out.data = parseJson(r.data);
  return out;
}
function listArchives() { return db.prepare('SELECT id, label, created_at, reason, booking_count, undone_at FROM archives ORDER BY created_at DESC').all().map(r => rowToArchive(r, false)); }
function getArchive(id) {
  const r = db.prepare('SELECT * FROM archives WHERE id = ?').get(id);
  return r ? rowToArchive(r, true) : null;
}
function addArchive(label, reason, data) {
  const info = db.prepare('INSERT INTO archives (label, created_at, reason, booking_count, data) VALUES (?, ?, ?, ?, ?)').run(
    label, new Date().toISOString(), reason, data.bookings.length, JSON.stringify(data));
  return info.lastInsertRowid;
}
function saveArchiveData(id, data) { db.prepare('UPDATE archives SET data = ? WHERE id = ?').run(JSON.stringify(data), id); }
function markArchiveUndone(id) { db.prepare('UPDATE archives SET undone_at = ? WHERE id = ?').run(new Date().toISOString(), id); }

function touchMember(email) {
  db.prepare("UPDATE members SET last_active_at = datetime('now') WHERE email = ? COLLATE NOCASE").run(email);
}

module.exports = {
  raw: db, dbPath, dataDir, backupDir, quickCheck, recovery,
  getState, setState, getStateJson, setStateJson, getSys, setSys,
  addAudit, listAudit,
  listArchives, getArchive, addArchive, saveArchiveData, markArchiveUndone, touchMember,
  ensureAdminPassphrase, setAdminPassphrase, checkAdminPassphrase,
  createSession, getSessionExpiry, extendSession, deleteSession, purgeExpiredSessions,
  getSettings, saveSettings,
  listEquipment, getEquipment, addEquipment, updateEquipment, deleteEquipment,
  listBookings, getBooking, upsertBooking, deleteBooking, setPendingCancel, setPendingChange, djWeeklyMinutes, roadshowConflicts,
  listApprovedMembers, listPendingMembers, findMemberByEmail, insertMember, approveMember, deleteMember,
  getMember, setMediaMember,
  listCategories, categoryExists, addCategory, updateCategory, deleteCategory, moveCategory
};
