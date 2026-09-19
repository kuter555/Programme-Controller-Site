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
`);

// Migrate older databases created before these columns existed.
const existingCols = db.prepare("PRAGMA table_info(bookings)").all().map(c => c.name);
if (!existingCols.includes('is_podcast')) db.exec("ALTER TABLE bookings ADD COLUMN is_podcast INTEGER NOT NULL DEFAULT 0");
if (!existingCols.includes('pending_cancel')) db.exec("ALTER TABLE bookings ADD COLUMN pending_cancel INTEGER NOT NULL DEFAULT 0");
if (!existingCols.includes('icon')) db.exec("ALTER TABLE bookings ADD COLUMN icon TEXT");

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
  const { salt, hash } = hashPassphrase(passphraseFromEnv);
  db.prepare(`INSERT INTO admin_secret (id, salt, hash) VALUES (1, ?, ?)
              ON CONFLICT(id) DO UPDATE SET salt=excluded.salt, hash=excluded.hash`).run(salt, hash);
}
function checkAdminPassphrase(passphrase) {
  const row = db.prepare('SELECT salt, hash FROM admin_secret WHERE id = 1').get();
  if (!row) return false;
  return verifyPassphrase(passphrase || '', row.salt, row.hash);
}

/* ---------- row <-> API object mapping ---------- */
function rowToBooking(r) {
  return {
    id: r.id, studio: r.studio, title: r.title, name: r.name, email: r.email,
    description: r.description || '', admin: !!r.is_admin, repeat: r.repeat,
    pendingRepeat: !!r.pending_repeat, color: r.color || null, date: r.date,
    startMin: r.start_min, endMin: r.end_min, repeatUntil: r.repeat_until || null,
    isPodcast: !!r.is_podcast, pendingCancel: !!r.pending_cancel, icon: r.icon || null
  };
}
function rowToMember(r) { return { id: r.id, name: r.name, email: r.email, createdAt: r.created_at }; }

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
    INSERT INTO bookings (id, studio, title, name, email, description, is_admin, repeat, pending_repeat, color, date, start_min, end_min, repeat_until, is_podcast, pending_cancel, icon)
    VALUES (@id, @studio, @title, @name, @email, @description, @isAdmin, @repeat, @pendingRepeat, @color, @date, @startMin, @endMin, @repeatUntil, @isPodcast, @pendingCancel, @icon)
    ON CONFLICT(id) DO UPDATE SET
      studio=excluded.studio, title=excluded.title, name=excluded.name, email=excluded.email,
      description=excluded.description, is_admin=excluded.is_admin, repeat=excluded.repeat,
      pending_repeat=excluded.pending_repeat, color=excluded.color, date=excluded.date,
      start_min=excluded.start_min, end_min=excluded.end_min, repeat_until=excluded.repeat_until,
      is_podcast=excluded.is_podcast, pending_cancel=excluded.pending_cancel, icon=excluded.icon
  `).run({
    id: b.id, studio: b.studio, title: b.title, name: b.name, email: b.email,
    description: b.description || '', isAdmin: b.admin ? 1 : 0, repeat: b.repeat || 'none',
    pendingRepeat: b.pendingRepeat ? 1 : 0, color: b.color || null, date: b.date,
    startMin: b.startMin, endMin: b.endMin, repeatUntil: b.repeatUntil || null,
    isPodcast: b.isPodcast ? 1 : 0, pendingCancel: b.pendingCancel ? 1 : 0, icon: b.icon || null
  });
  return getBooking(b.id);
}
function deleteBooking(id) { db.prepare('DELETE FROM bookings WHERE id = ?').run(id); }
function setPendingCancel(id, value) { db.prepare('UPDATE bookings SET pending_cancel = ? WHERE id = ?').run(value ? 1 : 0, id); }

/* ---------- members ---------- */
function listMembers() { return db.prepare('SELECT * FROM members ORDER BY name COLLATE NOCASE').all().map(rowToMember); }
function findMemberByEmail(email) {
  const r = db.prepare('SELECT * FROM members WHERE email = ? COLLATE NOCASE').get(email);
  return r ? rowToMember(r) : null;
}
function insertMember(name, email) {
  const info = db.prepare('INSERT INTO members (name, email) VALUES (?, ?)').run(name, email);
  return rowToMember(db.prepare('SELECT * FROM members WHERE id = ?').get(info.lastInsertRowid));
}
function deleteMember(id) { db.prepare('DELETE FROM members WHERE id = ?').run(id); }

module.exports = {
  ensureAdminPassphrase, checkAdminPassphrase,
  listBookings, getBooking, upsertBooking, deleteBooking, setPendingCancel,
  listMembers, findMemberByEmail, insertMember, deleteMember
};
