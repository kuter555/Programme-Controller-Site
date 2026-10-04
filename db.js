'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'urb.db'));
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
  CREATE TABLE IF NOT EXISTS member_sessions (
    token TEXT PRIMARY KEY,
    member_id INTEGER NOT NULL,
    expires INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS member_tokens (
    token_hash TEXT PRIMARY KEY,
    member_id INTEGER NOT NULL,
    expires INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS categories (
    key TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    color TEXT NOT NULL,
    hint TEXT NOT NULL DEFAULT '',
    sort INTEGER NOT NULL DEFAULT 0
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
if (!existingCols.includes('category')) {
  db.exec("ALTER TABLE bookings ADD COLUMN category TEXT");
  // The old podcast checkbox became the "Podcast recording" show type.
  db.exec("UPDATE bookings SET category = 'podcast' WHERE is_podcast = 1");
}

const existingMemberCols = db.prepare("PRAGMA table_info(members)").all().map(c => c.name);
// Existing members were trusted under the old no-approval flow, so grandfather them in as approved.
if (!existingMemberCols.includes('approved')) db.exec("ALTER TABLE members ADD COLUMN approved INTEGER NOT NULL DEFAULT 1");
// Optional member accounts (password set via an emailed link) and the admin-managed media membership flag.
if (!existingMemberCols.includes('pw_hash')) {
  db.exec("ALTER TABLE members ADD COLUMN pw_salt TEXT");
  db.exec("ALTER TABLE members ADD COLUMN pw_hash TEXT");
}
if (!existingMemberCols.includes('media_member')) db.exec("ALTER TABLE members ADD COLUMN media_member INTEGER NOT NULL DEFAULT 0");

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

// Re-hash and store the passphrase from .env every time the server starts,
// so changing ADMIN_PASSPHRASE and restarting is all it takes to rotate it.
function ensureAdminPassphrase(passphraseFromEnv) {
  if (!passphraseFromEnv) throw new Error('ADMIN_PASSPHRASE is not set in .env');
  const row = db.prepare('SELECT salt, hash FROM admin_secret WHERE id = 1').get();
  // Unchanged passphrase: keep the stored hash and existing sessions.
  if (row && verifyPassphrase(passphraseFromEnv, row.salt, row.hash)) return;
  const { salt, hash } = hashPassphrase(passphraseFromEnv);
  db.prepare(`INSERT INTO admin_secret (id, salt, hash) VALUES (1, ?, ?)
              ON CONFLICT(id) DO UPDATE SET salt=excluded.salt, hash=excluded.hash`).run(salt, hash);
  // Rotating the passphrase signs everyone out.
  db.prepare('DELETE FROM admin_sessions').run();
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
    items: parseItems(r.items), category: r.category || null
  };
}
function rowToMember(r) {
  return { id: r.id, name: r.name, email: r.email, approved: !!r.approved, createdAt: r.created_at, hasAccount: !!r.pw_hash, mediaMember: !!r.media_member };
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
function deleteMember(id) {
  db.transaction(() => {
    db.prepare('DELETE FROM member_sessions WHERE member_id = ?').run(id);
    db.prepare('DELETE FROM member_tokens WHERE member_id = ?').run(id);
    db.prepare('DELETE FROM members WHERE id = ?').run(id);
  })();
}
function getMember(id) {
  const r = db.prepare('SELECT * FROM members WHERE id = ?').get(id);
  return r ? rowToMember(r) : null;
}
function setMediaMember(id, value) {
  db.prepare('UPDATE members SET media_member = ? WHERE id = ?').run(value ? 1 : 0, id);
  return getMember(id);
}

/* ---------- member accounts ---------- */
function setMemberPassword(id, password) {
  const { salt, hash } = hashPassphrase(password);
  db.prepare('UPDATE members SET pw_salt = ?, pw_hash = ? WHERE id = ?').run(salt, hash, id);
}
// Returns the member for a correct email + password, otherwise null.
function checkMemberLogin(email, password) {
  const r = db.prepare('SELECT * FROM members WHERE email = ? COLLATE NOCASE AND approved = 1').get(email);
  if (!r || !r.pw_hash) return null;
  return verifyPassphrase(password || '', r.pw_salt, r.pw_hash) ? rowToMember(r) : null;
}
function createMemberSession(token, memberId, expires) {
  db.prepare('INSERT INTO member_sessions (token, member_id, expires) VALUES (?, ?, ?)').run(token, memberId, expires);
}
// The signed-in member for a session token, or null if missing/expired.
function getMemberSession(token, now) {
  const r = db.prepare('SELECT m.*, s.expires AS s_expires FROM member_sessions s JOIN members m ON m.id = s.member_id WHERE s.token = ?').get(token);
  if (!r) return null;
  if (r.s_expires < now || !r.approved) { db.prepare('DELETE FROM member_sessions WHERE token = ?').run(token); return null; }
  return rowToMember(r);
}
function extendMemberSession(token, expires) { db.prepare('UPDATE member_sessions SET expires = ? WHERE token = ?').run(expires, token); }
function deleteMemberSession(token) { db.prepare('DELETE FROM member_sessions WHERE token = ?').run(token); }
function deleteMemberSessionsFor(memberId) { db.prepare('DELETE FROM member_sessions WHERE member_id = ?').run(memberId); }
// One-time set/reset-password links. Only a hash of the token is stored.
function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function createMemberToken(memberId, ttlMs) {
  const raw = crypto.randomBytes(32).toString('hex');
  db.prepare('DELETE FROM member_tokens WHERE member_id = ?').run(memberId); // newest link wins
  db.prepare('INSERT INTO member_tokens (token_hash, member_id, expires) VALUES (?, ?, ?)').run(sha256(raw), memberId, Date.now() + ttlMs);
  return raw;
}
// The member id a still-valid link belongs to (without using it up).
function peekMemberToken(raw) {
  const r = db.prepare('SELECT * FROM member_tokens WHERE token_hash = ?').get(sha256(String(raw || '')));
  return r && r.expires >= Date.now() ? r.member_id : null;
}
// Returns the member id if the link is valid, and burns it.
function consumeMemberToken(raw) {
  const h = sha256(String(raw || ''));
  const r = db.prepare('SELECT * FROM member_tokens WHERE token_hash = ?').get(h);
  if (!r) return null;
  db.prepare('DELETE FROM member_tokens WHERE token_hash = ?').run(h);
  return r.expires >= Date.now() ? r.member_id : null;
}
function purgeExpiredMemberAuth(now) {
  db.prepare('DELETE FROM member_sessions WHERE expires < ?').run(now);
  db.prepare('DELETE FROM member_tokens WHERE expires < ?').run(now);
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

module.exports = {
  ensureAdminPassphrase, checkAdminPassphrase,
  createSession, getSessionExpiry, extendSession, deleteSession, purgeExpiredSessions,
  getSettings, saveSettings,
  listEquipment, getEquipment, addEquipment, updateEquipment, deleteEquipment,
  listBookings, getBooking, upsertBooking, deleteBooking, setPendingCancel, djWeeklyMinutes, roadshowConflicts,
  listApprovedMembers, listPendingMembers, findMemberByEmail, insertMember, approveMember, deleteMember,
  getMember, setMediaMember,
  setMemberPassword, checkMemberLogin, createMemberSession, getMemberSession, extendMemberSession,
  deleteMemberSession, deleteMemberSessionsFor, createMemberToken, peekMemberToken, consumeMemberToken, purgeExpiredMemberAuth,
  listCategories, categoryExists, addCategory, updateCategory, deleteCategory, moveCategory
};
