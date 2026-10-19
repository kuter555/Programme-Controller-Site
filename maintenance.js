'use strict';
/*
 * Keeps the site healthy without anyone having to log in to the server:
 *   - backups      daily verified snapshots (+ optional second copy), rotation, restore
 *   - retention    removes personal data once it's no longer needed
 *   - yearly reset clears the schedule every 1 September into a browsable archive
 *   - health       checks the database, disk, domain, DNS, certificate, stream, Node.js …
 *   - scheduler    runs all of the above on its own, catching up on anything missed
 *                  while the server was off.
 * Everything it does is written to the activity log (db.addAudit).
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const tls = require('tls');
const dns = require('dns').promises;
const crypto = require('crypto');
const Database = require('better-sqlite3');
const db = require('./db');

const raw = db.raw;
const BACKUP_DIR = db.backupDir;
const UPLOADS_DIR = path.join(db.dataDir, 'uploads');
const MIRROR_DIR = process.env.BACKUP_MIRROR_DIR ? path.resolve(process.env.BACKUP_MIRROR_DIR) : null;
const BACKUP_NAME_RE = /^urb-(\d{4}-\d{2}-\d{2})_(\d{6})-([a-z-]+)\.db$/;
const UPLOAD_NAME_RE = /^[a-zA-Z0-9._-]+$/;
const REMOVED_EMAIL = 'removed@data.invalid'; // still passes the site's email checks, so old bookings stay editable
const REMOVED_NAME = 'Former presenter';
// The schedule clears on 1 September. It runs at 04:00 rather than midnight so
// a show that runs over midnight on 31 August isn't pulled off air mid-show.
const RESET_MONTH = 9, RESET_DAY = 1, RESET_HOUR = 4;
const DAILY_HOUR = 3; // nightly backup + clean-up
// Node.js release end-of-life dates (nodejs.org/en/about/previous-releases).
const NODE_EOL = { 18: '2025-04-30', 20: '2026-04-30', 22: '2027-04-30', 24: '2028-04-30', 26: '2029-04-30' };
const INSTANCE_ID = crypto.randomBytes(12).toString('hex');
const STARTED_AT = new Date();

const DEFAULTS = {
  publicUrl: process.env.PUBLIC_URL || 'https://urb-booking.co.uk',
  // Best quality first; the Listen Live player steps down this list if a connection struggles.
  streams: ['https://urb-ice.bath.ac.uk/urb/320.mp3', 'https://urb-ice.bath.ac.uk/urb/128.mp3', 'https://urb-ice.bath.ac.uk/urb/64.mp3'],
  // 0 switches a rule off.
  retention: { emailMonths: 12, nameMonths: 60, inactiveMemberMonths: 18, pendingMemberDays: 60, orphanImageDays: 7 },
  reset: { enabled: true, clearMedia: false },
  handover: {
    owner: '', hosting: '', domain: '', domainRenews: '', stream: '', notes: ''
  }
};
const RETENTION_LIMITS = { emailMonths: [0, 120], nameMonths: [0, 240], inactiveMemberMonths: [0, 120], pendingMemberDays: [0, 3650], orphanImageDays: [0, 3650] };

function config() {
  return {
    publicUrl: db.getSys('publicUrl', DEFAULTS.publicUrl),
    streams: db.getSys('streams', DEFAULTS.streams),
    retention: Object.assign({}, DEFAULTS.retention, db.getSys('retention', {})),
    reset: Object.assign({}, DEFAULTS.reset, db.getSys('reset', {})),
    handover: Object.assign({}, DEFAULTS.handover, db.getSys('handover', {}))
  };
}
// Returns an error string, or null once saved.
function saveConfig(input, actor) {
  const cur = config();
  const changed = [];
  if (input.publicUrl != null) {
    let u;
    try { u = new URL(String(input.publicUrl).trim()); } catch (e) { return 'The site address must be a full web address, e.g. https://urb-booking.co.uk'; }
    if (!/^https?:$/.test(u.protocol)) return 'The site address must start with https://';
    const v = u.origin;
    if (v !== cur.publicUrl) { db.setSys('publicUrl', v); changed.push('site address → ' + v); }
  }
  if (input.streams != null) {
    const list = (Array.isArray(input.streams) ? input.streams : String(input.streams).split(/\s+/)).map(s => String(s).trim()).filter(Boolean);
    for (const s of list) { try { if (!/^https?:$/.test(new URL(s).protocol)) throw 0; } catch (e) { return 'Not a valid stream address: ' + s; } }
    if (!list.length) return 'Enter at least one stream address.';
    if (list.join(' ') !== cur.streams.join(' ')) { db.setSys('streams', list); changed.push('stream addresses'); }
  }
  if (input.retention != null) {
    const next = Object.assign({}, cur.retention);
    for (const k of Object.keys(RETENTION_LIMITS)) {
      if (input.retention[k] == null) continue;
      const v = Number(input.retention[k]);
      if (!Number.isInteger(v) || v < RETENTION_LIMITS[k][0] || v > RETENTION_LIMITS[k][1]) return 'Invalid value for ' + k + '.';
      next[k] = v;
    }
    if (JSON.stringify(next) !== JSON.stringify(cur.retention)) { db.setSys('retention', next); changed.push('data retention rules'); }
  }
  if (input.reset != null) {
    const next = { enabled: input.reset.enabled != null ? !!input.reset.enabled : cur.reset.enabled, clearMedia: input.reset.clearMedia != null ? !!input.reset.clearMedia : cur.reset.clearMedia };
    if (JSON.stringify(next) !== JSON.stringify(cur.reset)) { db.setSys('reset', next); changed.push('yearly reset (' + (next.enabled ? 'on' : 'OFF') + (next.clearMedia ? ', clears media membership' : '') + ')'); }
  }
  if (input.handover != null) {
    const next = Object.assign({}, cur.handover);
    Object.keys(DEFAULTS.handover).forEach(k => { if (input.handover[k] != null) next[k] = String(input.handover[k]).slice(0, k === 'notes' ? 20000 : 500); });
    if (JSON.stringify(next) !== JSON.stringify(cur.handover)) { db.setSys('handover', next); changed.push('handover notes'); }
  }
  if (changed.length) db.addAudit(actor, 'config.update', 'Changed ' + changed.join(', '));
  return null;
}

/* ---------- small helpers ---------- */
function pad(n, w) { return String(n).padStart(w || 2, '0'); }
function fmtDate(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function stamp(d) { return fmtDate(d) + '_' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()); }
function addMonths(d, n) { const x = new Date(d); x.setMonth(x.getMonth() + n); return x; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
// Backups copy the live database's WAL mode; switch them to a single self-contained file.
function selfContained(file) {
  const d = new Database(file, { fileMustExist: true });
  try { d.pragma('journal_mode = DELETE'); } finally { d.close(); }
}
function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
function dayNum(ds) { const p = ds.split('-').map(Number); return Math.round(Date.UTC(p[0], p[1] - 1, p[2]) / 86400000); }
function daysBetween(a, b) { return Math.floor((b - a) / 86400000); }
// The last calendar day a booking occupies: a weekly series ends on repeatUntil (null = still running).
function bookingLastDay(b) {
  if (b.repeat === 'weekly') return b.repeatUntil || null;
  const extra = Math.max(0, Math.ceil(b.endMin / 1440) - 1);
  const p = b.date.split('-').map(Number);
  return fmtDate(new Date(p[0], p[1] - 1, p[2] + extra));
}
// A problem with what the admin asked for (wrong file, already undone, …) rather than a server fault.
function userError(msg) { const e = new Error(msg); e.expected = true; return e; }
function errText(e) { return (e && (e.cause && e.cause.code ? e.cause.code + ': ' : '') + (e.message || String(e))) || 'Unknown error'; }

/* ================================================================
   Backups
   ================================================================ */
function parseBackupName(name) {
  const m = BACKUP_NAME_RE.exec(name);
  if (!m) return null;
  const t = m[2];
  return { name, date: m[1], time: t.slice(0, 2) + ':' + t.slice(2, 4) + ':' + t.slice(4, 6), kind: m[3] };
}
const verifyCache = new Map(); // name|size -> bool
function listBackups(dir) {
  dir = dir || BACKUP_DIR;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map(parseBackupName).filter(Boolean).map(b => {
    const st = fs.statSync(path.join(dir, b.name));
    const key = b.name + '|' + st.size;
    if (!verifyCache.has(key)) verifyCache.set(key, db.quickCheck(path.join(dir, b.name)));
    return Object.assign(b, { size: st.size, verified: verifyCache.get(key) });
  }).sort((a, b) => (a.name < b.name ? 1 : -1));
}
// Copy any images the backups don't have yet (image names are random and never reused).
function mirrorUploads(destDir) {
  ensureDir(destDir);
  if (!fs.existsSync(UPLOADS_DIR)) return 0;
  let n = 0;
  fs.readdirSync(UPLOADS_DIR).forEach(f => {
    if (!UPLOAD_NAME_RE.test(f) || fs.existsSync(path.join(destDir, f))) return;
    fs.copyFileSync(path.join(UPLOADS_DIR, f), path.join(destDir, f)); n++;
  });
  return n;
}
// Put back any show images the schedule or archives use that have gone missing
// from data/uploads but are in a backup.
function restoreMissingUploads() {
  ensureDir(UPLOADS_DIR);
  const used = referencedImages();
  let n = 0;
  [path.join(BACKUP_DIR, 'uploads'), MIRROR_DIR && path.join(MIRROR_DIR, 'uploads')].filter(Boolean).forEach(src => {
    if (!fs.existsSync(src)) return;
    fs.readdirSync(src).forEach(f => {
      if (!used.has(f) || fs.existsSync(path.join(UPLOADS_DIR, f))) return;
      fs.copyFileSync(path.join(src, f), path.join(UPLOADS_DIR, f)); n++;
    });
  });
  return n;
}
/* Rotation: daily backups keep the last 14 days, then one a week for 8 weeks and
   one a month for 12 months. Backups taken before something risky (restore,
   reset, erase) or by hand are kept for 180 days, pre-reset ones for 400 days.
   So no backup — and no personal data in one — is kept much beyond a year. */
function pruneBackups(dir) {
  const all = listBackups(dir);
  const keep = new Set();
  const daily = all.filter(b => b.kind === 'daily');
  daily.slice(0, 14).forEach(b => keep.add(b.name));
  const weeks = new Map(), months = new Map();
  daily.forEach(b => {
    const wk = Math.floor((dayNum(b.date) + 3) / 7); // Monday-based week number
    if (!weeks.has(wk)) weeks.set(wk, b.name);
    const mo = b.date.slice(0, 7);
    if (!months.has(mo)) months.set(mo, b.name);
  });
  Array.from(weeks.values()).slice(0, 8).forEach(n => keep.add(n));
  Array.from(months.values()).slice(0, 12).forEach(n => keep.add(n));
  const today = dayNum(fmtDate(new Date()));
  const other = all.filter(b => b.kind !== 'daily');
  other.slice(0, 5).forEach(b => keep.add(b.name)); // always keep the newest few
  other.forEach(b => { if (today - dayNum(b.date) <= (b.kind === 'pre-reset' ? 400 : 180)) keep.add(b.name); });
  let removed = 0;
  all.forEach(b => { if (!keep.has(b.name)) { fs.rmSync(path.join(dir, b.name)); removed++; } });
  // Tidy WAL sidecars and half-written files (e.g. left by checking an older WAL-mode backup).
  fs.readdirSync(dir).forEach(f => {
    if (!/^urb-.*\.db(\.partial)?(-wal|-shm|-journal)?$/.test(f) || BACKUP_NAME_RE.test(f)) return;
    const p = path.join(dir, f);
    if (Date.now() - fs.statSync(p).mtimeMs > 10 * 60000) fs.rmSync(p, { force: true }); // not one being written right now
  });
  return removed;
}
async function makeBackup(kind, actor) {
  ensureDir(BACKUP_DIR);
  let name, dest;
  for (;;) { // names go to the second, so wait for a fresh one rather than reuse an older file
    name = 'urb-' + stamp(new Date()) + '-' + kind + '.db';
    dest = path.join(BACKUP_DIR, name);
    if (!fs.existsSync(dest) && !fs.existsSync(dest + '.partial')) break;
    await new Promise(r => setTimeout(r, 250));
  }
  const tmp = dest + '.partial';
  await raw.backup(tmp);
  selfContained(tmp);
  if (!db.quickCheck(tmp)) { ['', '-wal', '-shm', '-journal'].forEach(x => fs.rmSync(tmp + x, { force: true })); throw new Error('The new backup failed its integrity check, so it was thrown away.'); }
  fs.renameSync(tmp, dest);
  mirrorUploads(path.join(BACKUP_DIR, 'uploads'));
  let mirror = null;
  if (MIRROR_DIR) {
    try {
      ensureDir(MIRROR_DIR);
      fs.copyFileSync(dest, path.join(MIRROR_DIR, name));
      mirrorUploads(path.join(MIRROR_DIR, 'uploads'));
      pruneBackups(MIRROR_DIR);
      mirror = 'ok';
    } catch (e) {
      mirror = errText(e);
      db.addAudit('system', 'error.backup-mirror', 'Could not copy backup to the second location (' + MIRROR_DIR + '): ' + mirror);
    }
  }
  const removed = pruneBackups(BACKUP_DIR);
  const size = fs.statSync(dest).size;
  db.setStateJson('lastBackup', { at: new Date().toISOString(), name, kind, size, mirror });
  db.addAudit(actor || 'system', 'backup.create', 'Backup ' + name + ' made (' + Math.round(size / 1024) + ' KB' + (removed ? ', ' + removed + ' old backup' + (removed > 1 ? 's' : '') + ' rotated out' : '') + ')', { kind });
  return { name, size };
}
function backupPath(name) {
  if (!BACKUP_NAME_RE.test(String(name))) return null;
  const p = path.join(BACKUP_DIR, name);
  return fs.existsSync(p) ? p : null;
}

/* A portable backup: one file holding the database and every show image, that
   can be kept anywhere (Google Drive, a USB stick, email) and uploaded on the
   System page to rebuild the site — even on a brand new server. */
async function buildBundle() {
  const tmp = path.join(os.tmpdir(), 'urb-export-' + crypto.randomBytes(6).toString('hex') + '.db');
  try {
    await raw.backup(tmp);
    selfContained(tmp);
    const uploads = {};
    if (fs.existsSync(UPLOADS_DIR)) fs.readdirSync(UPLOADS_DIR).forEach(f => {
      if (UPLOAD_NAME_RE.test(f)) uploads[f] = fs.readFileSync(path.join(UPLOADS_DIR, f)).toString('base64');
    });
    const payload = { format: 'urb-backup', version: 1, createdAt: new Date().toISOString(), site: config().publicUrl, db: fs.readFileSync(tmp).toString('base64'), uploads };
    return zlib.gzipSync(Buffer.from(JSON.stringify(payload)));
  } finally {
    ['', '-wal', '-shm', '-journal'].forEach(x => fs.rmSync(tmp + x, { force: true }));
  }
}
// Everything in plain JSON — readable without this site, if it's ever gone for good.
function readableExport() {
  const q = sql => raw.prepare(sql).all();
  return {
    exportedAt: new Date().toISOString(),
    note: 'URB Studio Booking — full readable export. Times are minutes after midnight (UK time); weekly bookings repeat every 7 days from "date" until "repeatUntil".',
    bookings: db.listBookings(),
    members: q('SELECT id, name, email, approved, media_member, created_at, last_active_at FROM members ORDER BY name'),
    categories: db.listCategories(),
    equipment: db.listEquipment(),
    settings: db.getSettings(),
    config: config(),
    archives: db.listArchives().map(a => db.getArchive(a.id))
  };
}

// Load a backup file into the live database: everything is replaced by the
// backup's copy, except the activity log and archives (merged, so history since
// the backup isn't lost), the admin passphrase and server bookkeeping.
async function restoreFromFile(file, actor, source) {
  if (!db.quickCheck(file)) throw userError('That file isn’t a working URB backup (it failed the integrity check).');
  const safety = await makeBackup('pre-restore', actor);
  raw.prepare('ATTACH DATABASE ? AS bk').run(file);
  const counts = {};
  try {
    const bkHas = t => !!raw.prepare("SELECT 1 FROM bk.sqlite_master WHERE type = 'table' AND name = ?").get(t);
    const cols = (schema, t) => raw.prepare('PRAGMA ' + schema + '.table_info(' + t + ')').all().map(c => c.name);
    raw.transaction(() => {
      ['bookings', 'members', 'equipment', 'categories'].forEach(t => {
        if (!bkHas(t)) return;
        const mine = cols('main', t);
        const shared = cols('bk', t).filter(c => mine.includes(c)).map(c => '"' + c + '"').join(', ');
        raw.exec('DELETE FROM main.' + t);
        counts[t] = raw.prepare('INSERT INTO main.' + t + ' (' + shared + ') SELECT ' + shared + ' FROM bk.' + t).run().changes;
      });
      if (bkHas('settings')) {
        raw.exec("DELETE FROM main.settings WHERE key NOT LIKE 'state.%'");
        raw.exec("INSERT OR REPLACE INTO main.settings (key, value) SELECT key, value FROM bk.settings WHERE key NOT LIKE 'state.%'");
      }
      if (bkHas('archives')) {
        raw.exec(`INSERT INTO main.archives (label, created_at, reason, booking_count, data, undone_at)
          SELECT label, created_at, reason, booking_count, data, undone_at FROM bk.archives b
          WHERE NOT EXISTS (SELECT 1 FROM main.archives a WHERE a.created_at = b.created_at AND a.label = b.label)`);
      }
      if (bkHas('audit_log')) {
        raw.exec(`INSERT INTO main.audit_log (at, actor, action, summary, details)
          SELECT at, actor, action, summary, details FROM bk.audit_log b
          WHERE NOT EXISTS (SELECT 1 FROM main.audit_log a WHERE a.at = b.at AND a.action = b.action AND a.summary = b.summary)
          ORDER BY b.at`);
      }
    })();
  } finally {
    raw.exec('DETACH DATABASE bk');
  }
  const images = restoreMissingUploads();
  db.addAudit(actor, 'backup.restore', 'Restored the site from ' + source + ' (' + (counts.bookings || 0) + ' bookings, ' + (counts.members || 0) + ' members). The state just before was saved as ' + safety.name + '.', { counts, images, safety: safety.name });
  return { counts, safety: safety.name, images };
}
// Accepts either a portable backup (.urbbackup) or a plain database file (.db).
async function restoreFromUpload(buf, actor, filename) {
  const tmp = path.join(os.tmpdir(), 'urb-restore-' + crypto.randomBytes(6).toString('hex') + '.db');
  try {
    let images = 0;
    if (buf[0] === 0x1f && buf[1] === 0x8b) {
      let payload;
      try { payload = JSON.parse(zlib.gunzipSync(buf).toString('utf8')); } catch (e) { throw userError('That file couldn’t be read as a URB backup.'); }
      if (!payload || payload.format !== 'urb-backup' || !payload.db) throw userError('That file isn’t a URB backup.');
      fs.writeFileSync(tmp, Buffer.from(payload.db, 'base64'));
      ensureDir(UPLOADS_DIR);
      Object.keys(payload.uploads || {}).forEach(f => {
        if (!UPLOAD_NAME_RE.test(f) || fs.existsSync(path.join(UPLOADS_DIR, f))) return;
        fs.writeFileSync(path.join(UPLOADS_DIR, f), Buffer.from(payload.uploads[f], 'base64')); images++;
      });
    } else if (buf.slice(0, 16).toString('latin1') === 'SQLite format 3\u0000') {
      fs.writeFileSync(tmp, buf);
    } else {
      throw userError('Please choose a .urbbackup or .db backup file.');
    }
    try { selfContained(tmp); } catch (e) { throw userError('That file isn’t a working URB backup.'); }
    const r = await restoreFromFile(tmp, actor, 'uploaded file "' + String(filename || 'backup').slice(0, 80) + '"');
    r.images += images;
    return r;
  } finally {
    ['', '-wal', '-shm', '-journal'].forEach(x => fs.rmSync(tmp + x, { force: true }));
  }
}

function integrityCheck(actor) {
  let result;
  try { result = raw.pragma('integrity_check', { simple: true }); } catch (e) { result = errText(e); }
  const ok = result === 'ok';
  db.setStateJson('lastIntegrity', { at: new Date().toISOString(), ok, result: String(result).slice(0, 300) });
  if (!ok || actor) db.addAudit(actor || 'system', ok ? 'db.check' : 'error.db-check', ok ? 'Database integrity check passed' : 'Database integrity check FAILED: ' + result);
  return { ok, result };
}

/* ================================================================
   Data retention
   ================================================================ */
const EMAIL_RE = /[^\s@"'<>(),;:]+@[^\s@"'<>(),;:]+\.[A-Za-z]{2,}/g;
function memberActivity() {
  // Latest day each email has something on the schedule (an ongoing weekly show counts as today).
  const today = fmtDate(new Date());
  const latest = {};
  db.listBookings().forEach(b => {
    const k = b.email.toLowerCase();
    const last = bookingLastDay(b) || today;
    if (!latest[k] || latest[k] < last) latest[k] = last;
  });
  return latest;
}
// Works out (and with apply=true carries out) everything the retention rules remove.
function retention(apply, actor) {
  const r = config().retention;
  const now = new Date();
  const out = { bookingEmails: 0, bookingNames: 0, archiveEmails: 0, archiveNames: 0, inactiveMembers: [], pendingMembers: [], images: [], logEntries: 0 };
  const emailCut = r.emailMonths ? fmtDate(addMonths(now, -r.emailMonths)) : null;
  const nameCut = r.nameMonths ? fmtDate(addMonths(now, -r.nameMonths)) : null;
  // Archived weekly series ended when the schedule was cleared, so they fall back to the archive's cutoff.
  const scrub = (b, endedBy) => {
    let last = bookingLastDay(b) || endedBy || null;
    if (endedBy && last > endedBy) last = endedBy;
    if (!last) return null;
    const res = {};
    if (emailCut && last < emailCut && b.email !== REMOVED_EMAIL) res.email = true;
    if (nameCut && last < nameCut && b.name !== REMOVED_NAME) res.name = true;
    return res.email || res.name ? res : null;
  };
  const work = [];

  db.listBookings().forEach(b => {
    const s = scrub(b);
    if (!s) return;
    if (s.email) out.bookingEmails++;
    if (s.name) out.bookingNames++;
    work.push(() => raw.prepare('UPDATE bookings SET email = ?, name = ? WHERE id = ?').run(s.email ? REMOVED_EMAIL : b.email, s.name ? REMOVED_NAME : b.name, b.id));
  });
  db.listArchives().forEach(a => {
    const full = db.getArchive(a.id);
    if (!full.data || !Array.isArray(full.data.bookings)) return;
    let dirty = false;
    full.data.bookings.forEach(b => {
      const s = scrub(b, full.data.cutoff);
      if (!s) return;
      if (s.email) { b.email = REMOVED_EMAIL; out.archiveEmails++; }
      if (s.name) { b.name = REMOVED_NAME; out.archiveNames++; }
      dirty = true;
    });
    if (dirty) work.push(() => db.saveArchiveData(a.id, full.data));
  });

  if (r.inactiveMemberMonths) {
    const cut = fmtDate(addMonths(now, -r.inactiveMemberMonths));
    const latest = memberActivity();
    raw.prepare('SELECT * FROM members WHERE approved = 1').all().forEach(m => {
      const last = [String(m.created_at || '').slice(0, 10), String(m.last_active_at || '').slice(0, 10), latest[m.email.toLowerCase()] || ''].sort().pop();
      if (last < cut) out.inactiveMembers.push({ id: m.id, name: m.name, lastActive: last });
    });
  }
  if (r.pendingMemberDays) {
    const cut = new Date(now.getTime() - r.pendingMemberDays * 86400000).toISOString().replace('T', ' ').slice(0, 19);
    raw.prepare('SELECT * FROM members WHERE approved = 0 AND created_at < ?').all(cut).forEach(m => out.pendingMembers.push({ id: m.id, name: m.name, registered: m.created_at.slice(0, 10) }));
  }
  [].concat(out.inactiveMembers, out.pendingMembers).forEach(m => work.push(() => db.deleteMember(m.id)));

  if (r.orphanImageDays && fs.existsSync(UPLOADS_DIR)) {
    const used = referencedImages();
    const cut = now.getTime() - r.orphanImageDays * 86400000;
    fs.readdirSync(UPLOADS_DIR).forEach(f => {
      if (used.has(f)) return;
      const st = fs.statSync(path.join(UPLOADS_DIR, f));
      if (st.mtimeMs < cut) { out.images.push(f); work.push(() => fs.rmSync(path.join(UPLOADS_DIR, f), { force: true })); }
    });
  }
  // The activity log is kept for good, but emails and IP addresses in old entries are blanked.
  if (r.emailMonths) {
    const cut = addMonths(now, -r.emailMonths).toISOString();
    raw.prepare("SELECT id, summary, actor, details FROM audit_log WHERE at < ? AND (summary LIKE '%@%' OR actor LIKE '%@%' OR details LIKE '%@%' OR details LIKE '%\"ip\"%')").all(cut).forEach(row => {
      out.logEntries++;
      work.push(() => {
        let det = row.details;
        if (det) { try { const d = JSON.parse(det); delete d.ip; det = JSON.stringify(d); } catch (e) {} det = det.replace(EMAIL_RE, '[removed]'); }
        raw.prepare('UPDATE audit_log SET summary = ?, actor = ?, details = ? WHERE id = ?').run(row.summary.replace(EMAIL_RE, '[removed]'), row.actor.replace(EMAIL_RE, '[removed]'), det, row.id);
      });
    });
  }

  if (apply) {
    raw.transaction(() => work.forEach(fn => fn()))();
    const bits = [];
    if (out.bookingEmails + out.archiveEmails) bits.push((out.bookingEmails + out.archiveEmails) + ' old booking emails removed');
    if (out.bookingNames + out.archiveNames) bits.push((out.bookingNames + out.archiveNames) + ' old presenter names removed');
    if (out.inactiveMembers.length) bits.push(out.inactiveMembers.length + ' inactive member' + (out.inactiveMembers.length > 1 ? 's' : '') + ' deleted');
    if (out.pendingMembers.length) bits.push(out.pendingMembers.length + ' stale registration' + (out.pendingMembers.length > 1 ? 's' : '') + ' deleted');
    if (out.images.length) bits.push(out.images.length + ' unused image' + (out.images.length > 1 ? 's' : '') + ' deleted');
    if (out.logEntries) bits.push(out.logEntries + ' old log entries anonymised');
    db.setStateJson('lastRetention', { at: new Date().toISOString(), summary: bits.join('; ') || 'nothing to remove' });
    if (bits.length || actor) db.addAudit(actor || 'system', 'retention.run', 'Data clean-up: ' + (bits.join('; ') || 'nothing needed removing'),
      { members: out.inactiveMembers.concat(out.pendingMembers).map(m => m.name) });
  }
  return out;
}
function referencedImages() {
  const used = new Set();
  const add = p => { if (p && /^\/uploads\//.test(p)) used.add(p.slice(9)); };
  db.listBookings().forEach(b => { add(b.icon); if (b.pendingChange) add(b.pendingChange.icon); });
  db.listArchives().forEach(a => { const d = db.getArchive(a.id).data; ((d && d.bookings) || []).forEach(b => add(b.icon)); });
  return used;
}

/* ---------- one person's data (subject access / right to erasure) ---------- */
function findPerson(email) {
  email = String(email || '').trim().toLowerCase();
  if (!email) return null;
  const member = raw.prepare('SELECT * FROM members WHERE email = ? COLLATE NOCASE').get(email) || null;
  const bookings = db.listBookings().filter(b => b.email.toLowerCase() === email);
  const archived = [];
  db.listArchives().forEach(a => {
    const d = db.getArchive(a.id).data;
    ((d && d.bookings) || []).forEach(b => { if ((b.email || '').toLowerCase() === email) archived.push(Object.assign({ archive: a.label }, b)); });
  });
  const log = raw.prepare('SELECT id, at, actor, action, summary FROM audit_log WHERE summary LIKE ? OR actor LIKE ? OR details LIKE ? ORDER BY id').all('%' + email + '%', '%' + email + '%', '%' + email + '%');
  return { email, member, bookings, archived, log };
}
async function erasePerson(email, actor) {
  const p = findPerson(email);
  if (!p) throw userError('Enter an email address.');
  const safety = await makeBackup('pre-erase', actor);
  const esc = p.email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(esc, 'gi');
  raw.transaction(() => {
    if (p.member) db.deleteMember(p.member.id);
    raw.prepare('UPDATE bookings SET email = ?, name = ? WHERE email = ? COLLATE NOCASE').run(REMOVED_EMAIL, REMOVED_NAME, p.email);
    db.listArchives().forEach(a => {
      const full = db.getArchive(a.id);
      let dirty = false;
      ((full.data && full.data.bookings) || []).forEach(b => { if ((b.email || '').toLowerCase() === p.email) { b.email = REMOVED_EMAIL; b.name = REMOVED_NAME; dirty = true; } });
      if (dirty) db.saveArchiveData(a.id, full.data);
    });
    p.log.forEach(row => {
      const r = raw.prepare('SELECT summary, actor, details FROM audit_log WHERE id = ?').get(row.id);
      raw.prepare('UPDATE audit_log SET summary = ?, actor = ?, details = ? WHERE id = ?').run(r.summary.replace(re, '[removed]'), r.actor.replace(re, '[removed]'), r.details ? r.details.replace(re, '[removed]') : null, row.id);
    });
  })();
  const summary = 'Erased one person’s data: ' + (p.member ? 'member record deleted, ' : '') + p.bookings.length + ' bookings and ' + p.archived.length + ' archived bookings anonymised, ' + p.log.length + ' log entries cleaned';
  db.addAudit(actor, 'privacy.erase', summary + '. Backups made before this (newest: ' + safety.name + ') still hold it until they rotate out.');
  return { summary };
}

/* ================================================================
   Yearly reset (1 September)
   ================================================================ */
function academicLabel(resetYear) { return (resetYear - 1) + '–' + String(resetYear).slice(2); }
// The 1 September (at RESET_HOUR) most recently passed.
function lastResetPoint(now) {
  const y = now.getFullYear();
  const thisYears = new Date(y, RESET_MONTH - 1, RESET_DAY, RESET_HOUR);
  return now >= thisYears ? y : y - 1;
}
function nextResetDate(now) {
  return new Date(lastResetPoint(now) + 1, RESET_MONTH - 1, RESET_DAY, RESET_HOUR);
}
function resetStatus() {
  const now = new Date();
  const cfg = config().reset;
  const last = Number(db.getState('lastResetYear')) || null;
  const next = nextResetDate(now);
  return { enabled: cfg.enabled, clearMedia: cfg.clearMedia, lastResetYear: last, next: next.toISOString(), nextLabel: fmtDate(next), daysUntil: Math.ceil((next - now) / 86400000), willArchiveAs: academicLabel(next.getFullYear()) };
}
// Archive and remove every booking that starts before `cutoff` (weekly series that
// started before it go too). Bookings already made for after the cutoff stay.
async function clearSchedule(opts, actor) {
  const cutoff = opts.cutoff;
  const safety = await makeBackup('pre-reset', actor);
  const removing = db.listBookings().filter(b => b.date < cutoff);
  const clearedMedia = opts.clearMedia ? raw.prepare('SELECT id FROM members WHERE media_member = 1').all().map(r => r.id) : [];
  let archiveId;
  raw.transaction(() => {
    archiveId = db.addArchive(opts.label, opts.reason, { cutoff, bookings: removing, categories: db.listCategories(), equipment: db.listEquipment(), clearedMedia });
    const del = raw.prepare('DELETE FROM bookings WHERE id = ?');
    removing.forEach(b => del.run(b.id));
    if (clearedMedia.length) raw.exec('UPDATE members SET media_member = 0');
    if (opts.resetYear) db.setState('lastResetYear', String(opts.resetYear));
  })();
  db.addAudit(actor, 'reset.run', 'Schedule cleared (' + opts.reason + '): ' + removing.length + ' bookings starting before ' + cutoff + ' moved to the "' + opts.label + '" archive' +
    (clearedMedia.length ? '; media membership switched off for ' + clearedMedia.length + ' members' : '') + '. Backup first: ' + safety.name + '.', { archiveId });
  return { archiveId, count: removing.length, safety: safety.name };
}
async function runYearlyResetIfDue() {
  const cfg = config().reset;
  const due = lastResetPoint(new Date());
  const last = Number(db.getState('lastResetYear'));
  // First run on a new install: don't wipe anything, just start counting from now.
  if (!last) { db.setState('lastResetYear', String(due)); return null; }
  if (last >= due) return null;
  if (!cfg.enabled) {
    // Count the year as handled, so switching the reset back on later doesn't clear this year's schedule mid-year.
    db.setState('lastResetYear', String(due));
    db.addAudit('system', 'reset.skipped', 'The 1 September ' + due + ' schedule reset was skipped because it is switched off on the System page. Use “Clear the schedule now” if it’s still wanted.');
    return null;
  }
  return clearSchedule({ cutoff: due + '-' + pad(RESET_MONTH) + '-' + pad(RESET_DAY), label: academicLabel(due), reason: 'automatic 1 September reset', resetYear: due, clearMedia: cfg.clearMedia }, 'system');
}
function undoArchive(id, actor) {
  const a = db.getArchive(id);
  if (!a) throw userError('Archive not found.');
  if (a.undoneAt) throw userError('That reset has already been undone.');
  let restored = 0;
  raw.transaction(() => {
    (a.data.bookings || []).forEach(b => {
      if (db.getBooking(b.id)) return;
      db.upsertBooking(b);
      if (b.pendingChange) db.setPendingChange(b.id, b.pendingChange);
      restored++;
    });
    (a.data.clearedMedia || []).forEach(mid => raw.prepare('UPDATE members SET media_member = 1 WHERE id = ?').run(mid));
    db.markArchiveUndone(id);
  })();
  db.addAudit(actor, 'reset.undo', 'Undid the "' + a.label + '" reset: ' + restored + ' bookings put back on the schedule. (The archive copy is kept, marked as undone.)');
  return { restored };
}

/* ================================================================
   Health checks
   ================================================================ */
let health = { at: null, checks: [] };
function registrableDomain(host) {
  const parts = host.split('.');
  const two = ['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'sch.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.za', 'com.br', 'co.jp'];
  return parts.slice(two.includes(parts.slice(-2).join('.')) ? -3 : -2).join('.');
}
function certInfo(host) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host, port: 443, servername: host, timeout: 10000 }, () => {
      const c = s.getPeerCertificate();
      const info = { validTo: c.valid_to, issuer: c.issuer && (c.issuer.O || c.issuer.CN), authorized: s.authorized, authError: s.authorizationError };
      s.end();
      resolve(info);
    });
    s.on('error', reject);
    s.on('timeout', () => { s.destroy(); reject(new Error('timed out')); });
  });
}
async function timedFetch(url, ms) { return fetch(url, { signal: AbortSignal.timeout(ms || 10000), redirect: 'follow', headers: { 'User-Agent': 'URB-Booking-HealthCheck' } }); }
function diskFree(dir) {
  try { const s = fs.statfsSync(dir); return s.bavail * s.bsize; } catch (e) { return null; }
}
function fmtBytes(n) { return n == null ? '?' : n > 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.round(n / 1e3) + ' KB'; }
function ageText(iso) {
  if (!iso) return 'never';
  const h = (Date.now() - new Date(iso)) / 3600000;
  return h < 1 ? 'under an hour ago' : h < 48 ? Math.round(h) + ' hours ago' : Math.round(h / 24) + ' days ago';
}

async function runHealthChecks(actor) {
  const cfg = config();
  const now = new Date();
  const checks = [];
  const add = (id, title, status, detail, help) => checks.push({ id, title, status, detail, help: help || '' });
  let host = null;
  try { host = new URL(cfg.publicUrl).hostname; } catch (e) {}
  const isLocal = !host || host === 'localhost' || /^127\./.test(host) || host.endsWith('.localhost') || host.endsWith('.test');

  // Database
  const integ = db.getStateJson('lastIntegrity');
  let dbSize = null; try { dbSize = fs.statSync(db.dbPath).size; } catch (e) {}
  add('database', 'Database', !integ ? 'unknown' : integ.ok ? 'ok' : 'fail',
    (integ ? (integ.ok ? 'Integrity check passed ' : 'Integrity check FAILED ') + ageText(integ.at) : 'Not checked yet') + ' · ' + fmtBytes(dbSize),
    integ && !integ.ok ? 'Restore the most recent good backup from the Backups tab.' : '');
  if (db.recovery) add('recovery', 'Startup recovery', db.recovery.ok ? 'warn' : 'fail', db.recovery.message, 'Check the schedule looks right. This message clears when the server next restarts.');

  // Backups
  const lb = db.getStateJson('lastBackup');
  const bAge = lb ? (now - new Date(lb.at)) / 3600000 : Infinity;
  const backups = listBackups();
  const bad = backups.filter(b => !b.verified).length;
  add('backups', 'Automatic backups', bAge < 36 && !bad ? 'ok' : bAge < 72 ? 'warn' : 'fail',
    (lb ? 'Last backup ' + ageText(lb.at) : 'No backup yet') + ' · ' + backups.length + ' kept in ' + BACKUP_DIR + (bad ? ' · ' + bad + ' failed verification' : ''),
    bAge >= 36 ? 'Backups should run every night at 03:00. Press “Back up now”, then check the Activity log for errors.' : '');
  const lastDl = db.getState('lastOffsiteDownload');
  const dlDays = lastDl ? (now - new Date(lastDl)) / 86400000 : Infinity;
  const mirrorOk = MIRROR_DIR && lb && lb.mirror === 'ok';
  add('offsite', 'Copy kept off this server', mirrorOk || dlDays < 35 ? 'ok' : 'warn',
    (MIRROR_DIR ? 'Second backup folder: ' + MIRROR_DIR + (lb && lb.mirror && lb.mirror !== 'ok' ? ' (last copy failed: ' + lb.mirror + ')' : '') + ' · ' : '') + 'Portable backup last downloaded ' + ageText(lastDl),
    mirrorOk || dlDays < 35 ? '' : 'If this server dies, backups on it die too. Once a month, download a portable backup and keep it in the society’s shared drive.');

  // Disk
  const free = diskFree(db.dataDir);
  add('disk', 'Disk space', free == null ? 'unknown' : free < 100e6 ? 'fail' : free < 500e6 ? 'warn' : 'ok', fmtBytes(free) + ' free', free != null && free < 500e6 ? 'The server is nearly full. Ask the host to add space, or delete old files that aren’t part of this site.' : '');

  // Automatic jobs
  const tickAt = db.getState('lastTick');
  const lr = db.getStateJson('lastRetention');
  add('jobs', 'Automatic jobs', tickAt && now - new Date(tickAt) < 30 * 60000 ? 'ok' : 'warn',
    'Last ran ' + ageText(tickAt) + ' · data clean-up ' + (lr ? ageText(lr.at) + ' (' + lr.summary + ')' : 'not run yet'));

  // Yearly reset
  const rs = resetStatus();
  const overdue = rs.lastResetYear && rs.lastResetYear < lastResetPoint(now);
  add('reset', 'Yearly schedule reset', !rs.enabled ? 'warn' : overdue ? 'fail' : 'ok',
    rs.enabled ? 'Next: ' + rs.nextLabel + ' (in ' + rs.daysUntil + ' days) — the ' + rs.willArchiveAs + ' schedule will be archived' : 'Switched OFF — the schedule will not clear on 1 September',
    overdue ? 'The reset is overdue; it should run within 10 minutes. Check the Activity log for errors.' : '');

  // Site address, DNS and HTTPS
  if (isLocal) {
    add('address', 'Site address', 'warn', 'Set to ' + cfg.publicUrl + ' — set the real public address on the Settings tab so it can be checked.');
  } else {
    let ips = [];
    try { ips = await dns.resolve4(host); } catch (e) {}
    try { ips = ips.concat(await dns.resolve6(host)); } catch (e) {}
    try {
      const r = await timedFetch(cfg.publicUrl + '/api/health', 12000);
      const j = await r.json().catch(() => ({}));
      if (j.instance === INSTANCE_ID) add('address', 'Site address & DNS', 'ok', cfg.publicUrl + ' reaches this server (' + (ips.join(', ') || 'address unknown') + ')');
      else add('address', 'Site address & DNS', 'fail', cfg.publicUrl + ' answered, but it is NOT this server (' + (ips.join(', ') || '?') + ', HTTP ' + r.status + ')',
        'The domain’s DNS points somewhere else — probably an old server. Log in to the domain registrar and point the A record at this server’s IP address.');
    } catch (e) {
      add('address', 'Site address & DNS', 'fail', 'Couldn’t reach ' + cfg.publicUrl + ' (' + errText(e) + ')' + (ips.length ? ' — DNS gives ' + ips.join(', ') : ' — the domain has no DNS records'),
        ips.length ? 'DNS works but the site doesn’t answer: the web server (Nginx) or HTTPS certificate may be broken.' : 'The domain may have expired, or its DNS records were deleted. Check with the registrar.');
    }
    if (cfg.publicUrl.startsWith('https:')) {
      try {
        const c = await certInfo(host);
        const days = Math.floor((new Date(c.validTo) - now) / 86400000);
        add('tls', 'HTTPS certificate', !c.authorized || days < 14 ? 'fail' : days < 25 ? 'warn' : 'ok',
          (c.authorized ? 'Valid' : 'NOT trusted (' + c.authError + ')') + ' · expires ' + fmtDate(new Date(c.validTo)) + ' (' + days + ' days) · issued by ' + (c.issuer || '?'),
          days < 25 ? 'Certificates from Let’s Encrypt renew themselves 30 days before expiry. If it hasn’t, run `sudo certbot renew` on the server (see HANDOVER.md).' : '');
      } catch (e) { add('tls', 'HTTPS certificate', 'fail', 'Couldn’t check: ' + errText(e)); }
    }
    const domain = registrableDomain(host);
    try {
      const r = await timedFetch('https://rdap.org/domain/' + encodeURIComponent(domain), 15000);
      const j = await r.json();
      const ev = (j.events || []).find(e => e.eventAction === 'expiration');
      if (!ev) throw new Error('no expiry date published');
      const days = Math.floor((new Date(ev.eventDate) - now) / 86400000);
      add('domain', 'Domain registration', days < 21 ? 'fail' : days < 60 ? 'warn' : 'ok', domain + ' is paid up until ' + fmtDate(new Date(ev.eventDate)) + ' (' + days + ' days)',
        days < 60 ? 'Renew ' + domain + ' with the registrar' + (cfg.handover.domain ? ' (' + cfg.handover.domain + ')' : '') + ' — if it lapses the whole site and Listen Live widget go dark.' : '');
    } catch (e) {
      add('domain', 'Domain registration', 'unknown', 'Couldn’t look up when ' + domain + ' expires (' + errText(e) + ').' + (cfg.handover.domainRenews ? ' Handover notes say: ' + cfg.handover.domainRenews : ''),
        'Check the renewal date with the registrar and note it on the Handover tab.');
    }
  }

  // Live stream used by the Listen Live widget
  for (const s of cfg.streams) {
    try {
      const r = await timedFetch(s, 8000);
      const type = r.headers.get('content-type') || '';
      try { await r.body.cancel(); } catch (e) {}
      add('stream:' + s, 'Live stream', r.ok ? 'ok' : 'fail', s + ' → HTTP ' + r.status + (type ? ' (' + type + ')' : ''),
        r.ok ? '' : 'The Listen Live player can’t play this stream. If the stream has moved, update the address on the Settings tab.');
    } catch (e) {
      add('stream:' + s, 'Live stream', 'fail', s + ' → ' + errText(e), 'The Listen Live player can’t reach this stream. If the stream has moved, update the address on the Settings tab.');
    }
  }

  // Software and setup
  const major = Number(process.versions.node.split('.')[0]);
  const eol = NODE_EOL[major];
  const eolDays = eol ? Math.floor((new Date(eol) - now) / 86400000) : null;
  add('node', 'Node.js version', eolDays == null ? 'unknown' : eolDays < 0 ? 'fail' : eolDays < 180 ? 'warn' : 'ok',
    'Running Node.js ' + process.versions.node + (eol ? ' · security updates end ' + eol + (eolDays < 0 ? ' (ENDED)' : ' (' + eolDays + ' days)') : ''),
    eolDays != null && eolDays < 180 ? 'Upgrade to the newest even-numbered (LTS) Node.js release, then run `npm rebuild` — see HANDOVER.md.' : '');
  const managed = !!(process.env.INVOCATION_ID || process.env.pm_id != null || process.env.PM2_HOME);
  add('process', 'Auto-restart', managed ? 'ok' : 'warn', managed ? 'Running under a service manager — the site restarts itself after a crash or reboot' : 'Not running under systemd or pm2',
    managed ? '' : 'If the server reboots or the site crashes, nothing will start it again. Install deploy/urb-booking.service (see HANDOVER.md).');
  const weakPass = db.checkAdminPassphrase('change-this-passphrase') || db.checkAdminPassphrase('changeme') || db.checkAdminPassphrase('password');
  add('passphrase', 'Admin passphrase', weakPass ? 'fail' : 'ok', weakPass ? 'Still set to an example/default passphrase' : 'Set (changed ' + ageText(db.getState('passphraseChangedAt')) + ')',
    weakPass ? 'Change it on the Settings tab now.' : '');
  const londonOffset = (() => {
    const p = {}; new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', day: '2-digit' }).formatToParts(now).forEach(x => { p[x.type] = x.value; });
    return Number(p.day) === now.getDate() && Number(p.hour) === now.getHours();
  })();
  add('clock', 'Server clock', londonOffset ? 'ok' : 'warn', 'Server time ' + now.toString().slice(0, 24) + (londonOffset ? ' (UK time)' : ' — does NOT match UK time'),
    londonOffset ? '' : 'Bookings are in UK time. Check the server clock/timezone.');
  const errs = raw.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'error.%' AND at > ?").get(addDays(now, -7).toISOString()).n;
  add('errors', 'Errors this week', errs ? 'warn' : 'ok', errs ? errs + ' error' + (errs > 1 ? 's' : '') + ' logged in the last 7 days' : 'None', errs ? 'See the Activity log, filtered to “Errors”.' : '');

  // Log anything that has newly gone wrong (not every check, every time).
  const prev = {};
  (health.checks || []).forEach(c => { prev[c.id] = c.status; });
  if (!health.checks.length) (db.getStateJson('health') || { checks: [] }).checks.forEach(c => { prev[c.id] = c.status; });
  checks.forEach(c => {
    const was = prev[c.id];
    if ((c.status === 'fail' || c.status === 'warn') && was !== c.status) db.addAudit('system', 'health.' + c.status, c.title + ': ' + c.detail);
    else if (c.status === 'ok' && (was === 'fail' || was === 'warn')) db.addAudit('system', 'health.ok', c.title + ' is OK again: ' + c.detail);
  });
  health = { at: now.toISOString(), checks };
  db.setStateJson('health', health);
  if (actor) db.addAudit(actor, 'health.run', 'Ran health checks: ' + checks.filter(c => c.status === 'fail').length + ' problems, ' + checks.filter(c => c.status === 'warn').length + ' warnings');
  return health;
}
function getHealth() { return health.at ? health : (db.getStateJson('health') || { at: null, checks: [] }); }

/* ================================================================
   Scheduler
   ================================================================ */
let ticking = false;
async function task(name, fn) {
  try { return await fn(); } catch (e) {
    console.error('[' + name + ']', e);
    const msg = errText(e);
    const key = name + '|' + msg + '|' + fmtDate(new Date());
    if (db.getState('lastTaskError') !== key) { db.setState('lastTaskError', key); db.addAudit('system', 'error.' + name, 'Automatic ' + name + ' failed: ' + msg); }
    return null;
  }
}
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const now = new Date();
    db.setState('lastTick', now.toISOString());
    await task('reset', runYearlyResetIfDue);
    // Nightly jobs: from 03:00, or straight away if the last one is over a day old (server was off).
    const lb = db.getStateJson('lastBackup');
    const lastDaily = db.getState('lastDailyDate');
    const today = fmtDate(now);
    const overdue = !lb || now - new Date(lb.at) > 26 * 3600000;
    if (lastDaily !== today && (now.getHours() >= DAILY_HOUR || overdue)) {
      await task('backup', () => makeBackup('daily'));
      await task('db-check', () => integrityCheck());
      await task('retention', () => retention(true));
      await task('uploads', () => { const n = restoreMissingUploads(); if (n) db.addAudit('system', 'uploads.restore', n + ' missing show images were put back from the backups'); });
      db.setState('lastDailyDate', today);
    }
    const h = getHealth();
    if (!h.at || now - new Date(h.at) > 6 * 3600000) await task('health', () => runHealthChecks());
  } finally {
    ticking = false;
  }
}
function start() {
  if (db.recovery) db.addAudit('system', db.recovery.ok ? 'recovery.auto' : 'error.recovery', db.recovery.message);
  db.addAudit('system', 'server.start', 'Server started (Node.js ' + process.versions.node + ', pid ' + process.pid + ')');
  const n = restoreMissingUploads();
  if (n) db.addAudit('system', 'uploads.restore', n + ' missing show images were put back from the backups');
  setTimeout(tick, 20000).unref();
  setInterval(tick, 10 * 60 * 1000).unref();
}

module.exports = {
  INSTANCE_ID, STARTED_AT, BACKUP_DIR, MIRROR_DIR, REMOVED_EMAIL,
  config, saveConfig,
  listBackups, makeBackup, backupPath, buildBundle, readableExport, restoreFromFile, restoreFromUpload, integrityCheck,
  retention, findPerson, erasePerson,
  resetStatus, clearSchedule, undoArchive, academicLabel,
  runHealthChecks, getHealth, start, tick
};
