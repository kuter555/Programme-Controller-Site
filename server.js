'use strict';
// Bookings are UK local times, so run the whole server on UK time whatever the machine is set to.
process.env.TZ = 'Europe/London';
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const db = require('./db');
const ops = require('./maintenance');

const PORT = process.env.PORT || 3000;
if (!process.env.ADMIN_PASSPHRASE) {
  console.error('ADMIN_PASSPHRASE is not set. Copy .env.example to .env and set one, then restart.');
  process.exit(1);
}
if (db.ensureAdminPassphrase(process.env.ADMIN_PASSPHRASE)) {
  db.setState('passphraseChangedAt', new Date().toISOString());
  db.addAudit('system', 'admin.passphrase', 'Admin passphrase set from ADMIN_PASSPHRASE in .env — all admins were signed out');
}

const BATH_EMAIL_RE = /^[a-z0-9._%+-]+@bath\.ac\.uk$/i;
const GENERIC_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ICON_PATH_RE = /^\/uploads\/[a-zA-Z0-9._-]+$/;
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

// Normalises b.category in place against the admin-managed list; returns an error string or null.
function checkCategory(b, required) {
  if (b.studio === 3) { b.category = null; return null; }
  if (!b.category) {
    if (required) return 'Please choose a show type.';
    b.category = null;
  } else if (!db.categoryExists(b.category)) {
    return 'That show type no longer exists — refresh and pick another.';
  }
  b.isPodcast = b.category === 'podcast';
  return null;
}

/* ---------- admin sessions ---------- */
const SESSION_COOKIE = 'urb_admin';
// Sessions live in the database (so restarts don't sign admins out) and slide:
// every admin request pushes the expiry back, so an admin actively using the
// site is never bounced mid-task.
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days since last use

function newSession() {
  const token = crypto.randomBytes(24).toString('hex');
  db.createSession(token, Date.now() + SESSION_TTL_MS);
  return token;
}
function isValidSession(token) {
  if (!token) return false;
  const exp = db.getSessionExpiry(token);
  if (!exp) return false;
  if (Date.now() > exp) { db.deleteSession(token); return false; }
  return true;
}
function setSessionCookie(req, res, token) {
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: SESSION_TTL_MS });
}

function publicMember(m) { return m ? { id: m.id, name: m.name, email: m.email, ownerKey: ownerKey(m.email) } : null; }
// Public pages get bookings without presenters' email addresses; this stable,
// meaningless key still lets the booking form count a member's weekly DJ time.
let ownerSecret = db.getState('ownerKeySecret');
if (!ownerSecret) { ownerSecret = crypto.randomBytes(16).toString('hex'); db.setState('ownerKeySecret', ownerSecret); }
function ownerKey(email) { return crypto.createHmac('sha256', ownerSecret).update(String(email || '').toLowerCase()).digest('hex').slice(0, 16); }

/* ---------- activity log ---------- */
function isAdminReq(req) { return isValidSession(req.cookies[SESSION_COOKIE]); }
function memberActor(name, email) { return 'member: ' + (name || '?') + ' <' + (email || '?') + '>'; }
function audit(actor, action, summary, details) {
  try { db.addAudit(actor, action, summary, details); } catch (e) { console.error('audit failed', e); }
}
function bookingLabel(b) {
  const hhmm = m => String(Math.floor((m % 1440) / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  return '"' + b.title + '" (' + ({ 1: 'Studio One', 2: 'Studio Two', 3: 'Roadshow' }[b.studio] || 'studio ' + b.studio) + ', ' + b.date + ' ' + hhmm(b.startMin) + (b.repeat === 'weekly' ? ', weekly' : '') + ')';
}
// Which fields an edit changed, for the log.
function bookingDiff(before, after) {
  const out = {};
  ['studio', 'title', 'name', 'email', 'description', 'date', 'startMin', 'endMin', 'repeat', 'repeatUntil', 'category', 'icon', 'items', 'admin'].forEach(k => {
    const a = before ? before[k] : undefined, b = after[k];
    if (JSON.stringify(a == null ? null : a) !== JSON.stringify(b == null ? null : b)) out[k] = [a == null ? null : a, b == null ? null : b];
  });
  return out;
}
setInterval(function () { db.purgeExpiredSessions(Date.now()); }, 10 * 60 * 1000).unref();

const uploadsDir = path.join(__dirname, 'data', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const app = express();
app.set('trust proxy', 1); // behind Nginx — needed so req.secure reflects the real client protocol
// Cropped show icons arrive as base64 data URLs, so that one route needs a bigger body limit.
const smallJson = express.json();
const iconJson = express.json({ limit: '3mb' });
app.use((req, res, next) => (req.path === '/api/icon' ? iconJson : smallJson)(req, res, next));
app.use(cookieParser());
// The Listen Live widget runs on other sites: let them load our fonts, images and "on now" feed.
app.use(['/fonts', '/assets', '/uploads', '/api/now'], (req, res, next) => { res.set('Access-Control-Allow-Origin', '*'); next(); });
app.use('/uploads', express.static(uploadsDir));
// Only the files the browser needs are public — never the server code, database, backups or notes.
['assets', 'fonts', 'vendor'].forEach(d => app.use('/' + d, express.static(path.join(__dirname, d), { dotfiles: 'deny' })));
['app.js', 'style.css', 'listen-live.js', 'system-panel.js'].forEach(f => app.get('/' + f, (req, res) => res.sendFile(path.join(__dirname, f))));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/index.html', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
// The System page: backups, data retention, the yearly reset, logs and health checks.
app.get('/system', (req, res) => res.sendFile(path.join(__dirname, 'system.html')));
// The same single-page app serves both addresses; it reads the path to decide what to
// show: / = public view-only schedule (embeddable), /book = the full site incl. admin.
app.get('/book', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

/* ---------- date helpers (mirrors the Monday-start week logic in app.js) ---------- */
function parseDate(s) { const p = s.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }
function fmtDate(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function mondayOf(dateStr) {
  const d = parseDate(dateStr);
  const wd = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - wd);
  return d;
}
function weekBounds(dateStr) {
  const start = mondayOf(dateStr);
  const end = new Date(start); end.setDate(end.getDate() + 6);
  return { start: fmtDate(start), end: fmtDate(end) };
}
function daysFromToday(dateStr) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.round((parseDate(dateStr) - today) / 86400000);
}
// True when an edit leaves the booking's slot exactly where it was, so rules
// about *when* a booking may be made (past dates, :10 starts, lengths) don't
// block fixing a title or description on an older booking.
function sameSlot(existing, b) {
  return !!existing && existing.studio === b.studio && existing.date === b.date && existing.startMin === b.startMin && existing.endMin === b.endMin;
}

function requireAdmin(req, res, next) {
  const token = req.cookies[SESSION_COOKIE];
  if (!isValidSession(token)) return res.status(401).json({ error: 'Your admin session has expired — please sign in again.', authLost: true });
  db.extendSession(token, Date.now() + SESSION_TTL_MS);
  setSessionCookie(req, res, token);
  next();
}

function cleanItems(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  raw.forEach(v => { const n = Number(v); if (Number.isInteger(n) && out.indexOf(n) < 0) out.push(n); });
  return out;
}
// Shared checks for any Roadshow booking; returns an error string or null.
function checkRoadshow(b) {
  b.items = cleanItems(b.items);
  if (!b.items.length) return 'Pick at least one piece of equipment.';
  const all = db.listEquipment();
  for (const id of b.items) {
    const item = all.find(i => i.id === id);
    if (!item) return 'One of the selected items no longer exists — refresh and try again.';
    if (!item.active) return item.name + ' is retired and can no longer be booked.';
  }
  const clash = db.roadshowConflicts(b.items, b.date, b.startMin, b.endMin, b.id)[0];
  if (clash) {
    const names = clash.items.filter(i => b.items.indexOf(i) >= 0).map(i => (all.find(x => x.id === i) || {}).name).filter(Boolean);
    return (names.join(', ') || 'Some equipment') + ' is already booked for "' + clash.title + '" at that time.';
  }
  b.repeat = 'none';
  b.pendingRepeat = false;
  b.isPodcast = false;
  b.icon = null;
  return null;
}

/* ---------- "on now" for the Listen Live widget ---------- */
// Bookings are stored in UK local time, so work out "now" in Europe/London
// rather than trusting the server's own clock/timezone.
function londonNow() {
  const parts = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).forEach(p => { parts[p.type] = p.value; });
  return { date: parts.year + '-' + parts.month + '-' + parts.day, min: Number(parts.hour) * 60 + Number(parts.minute) };
}
function dayIndex(ds) { const p = ds.split('-').map(Number); return Math.round(Date.UTC(p[0], p[1] - 1, p[2]) / 86400000); }
function shiftDate(ds, n) { const d = new Date(Date.UTC(...ds.split('-').map((v, i) => i === 1 ? v - 1 : +v)) + n * 86400000); return d.toISOString().slice(0, 10); }
// Does booking b have an instance starting on date ds? (mirrors startsOn in app.js)
function startsOn(b, ds) {
  if (b.repeat === 'weekly') return ds >= b.date && (!b.repeatUntil || ds <= b.repeatUntil) && (dayIndex(ds) - dayIndex(b.date)) % 7 === 0;
  return b.date === ds;
}
// Studio One instances touching the window [today - 1 day, today + 1 day], as absolute minutes.
function radioInstances(today) {
  const out = [];
  db.listBookings().filter(b => b.studio === 1 && !b.pendingApproval).forEach(b => {
    const span = Math.max(0, Math.ceil(b.endMin / 1440) - 1);
    for (let k = -1 - span; k <= 1; k++) {
      const ds = shiftDate(today, k);
      if (startsOn(b, ds)) out.push({ b, start: dayIndex(ds) * 1440 + b.startMin, end: dayIndex(ds) * 1440 + b.endMin });
    }
  });
  return out.sort((x, y) => x.start - y.start);
}
function showInfo(inst) {
  const b = inst.b;
  const cat = b.category ? db.listCategories().find(c => c.key === b.category) : null;
  const hhmm = m => { m = ((m % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
  return {
    title: b.title, presenter: b.name, start: hhmm(inst.start), end: hhmm(inst.end),
    image: b.icon || null, category: cat ? cat.label : null, color: cat ? cat.color : null
  };
}
app.get('/api/now', (req, res) => {
  const now = londonNow();
  const t = dayIndex(now.date) * 1440 + now.min;
  const list = radioInstances(now.date);
  const live = list.find(i => i.start <= t && t < i.end);
  const next = list.find(i => i.start > t && i.start - t <= 24 * 60);
  res.set('Cache-Control', 'public, max-age=30');
  // Public: no presenter emails. Image paths are relative to this site; the widget resolves them.
  res.json({ live: live ? showInfo(live) : null, next: next ? showInfo(next) : null, logo: '/assets/listen-logo.png', streams: ops.config().streams });
});
// For uptime monitors (e.g. UptimeRobot) and the System page's own DNS check.
app.get('/api/health', (req, res) => {
  let ok = true;
  try { db.raw.prepare('SELECT 1').get(); } catch (e) { ok = false; }
  res.set('Cache-Control', 'no-store');
  res.status(ok ? 200 : 503).json({ ok, instance: ops.INSTANCE_ID, time: new Date().toISOString() });
});

/* ---------- public read endpoints ---------- */
app.get('/api/bookings', (req, res) => {
  const admin = isAdminReq(req);
  res.json(db.listBookings().map(b => Object.assign(b, { ownerKey: ownerKey(b.email) }, admin ? {} : { email: '' })));
});
// Feeds the /book "who is this booking for?" dropdown — only media members can book.
app.get('/api/members', (req, res) => res.json(db.listApprovedMembers().filter(m => m.mediaMember).map(publicMember)));
app.get('/api/settings', (req, res) => res.json(db.getSettings()));
app.get('/api/equipment', (req, res) => res.json(db.listEquipment()));
app.get('/api/categories', (req, res) => res.json(db.listCategories()));
app.get('/api/admin/session', (req, res) => res.json({ admin: isValidSession(req.cookies[SESSION_COOKIE]) }));

/* ---------- member registration ---------- */
app.post('/api/members', (req, res) => {
  const name = String((req.body && req.body.name) || '').trim();
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  if (!name) return res.status(400).json({ error: 'Please enter your name.' });
  if (!BATH_EMAIL_RE.test(email)) return res.status(400).json({ error: 'Please use your @bath.ac.uk email address.' });
  const existing = db.findMemberByEmail(email);
  if (existing) {
    return res.status(409).json({ error: !existing.approved ? 'That email has already been registered and is awaiting admin approval.'
      : existing.mediaMember ? 'That email is already registered — select it from the list instead.'
      : 'That email is registered but doesn’t have media membership yet — ask an admin to switch it on.' });
  }
  try {
    const m = db.insertMember(name, email);
    audit(memberActor(name, email), 'member.register', name + ' registered (awaiting approval)');
    res.status(201).json(publicMember(m));
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'That email is already registered — select it from the list instead.' });
    console.error(e);
    res.status(500).json({ error: 'Could not register — try again.' });
  }
});

/* ---------- show icon upload (already cropped square in the browser) ---------- */
const ICON_TYPES = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };
app.post('/api/icon', (req, res) => {
  const free = (() => { try { const st = fs.statfsSync(uploadsDir); return st.bavail * st.bsize; } catch (e) { return Infinity; } })();
  if (free < 50e6) return res.status(507).json({ error: 'The server is out of space, so images can’t be uploaded right now. Please tell an admin.' });
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String((req.body && req.body.dataUrl) || ''));
  if (!m) return res.status(400).json({ error: 'Please choose a PNG, JPEG or WebP image.' });
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > 2 * 1024 * 1024) return res.status(400).json({ error: 'That image is too large.' });
  const name = crypto.randomBytes(16).toString('hex') + ICON_TYPES[m[1]];
  fs.writeFile(path.join(uploadsDir, name), buf, err => {
    if (err) { console.error(err); return res.status(500).json({ error: 'Could not save image.' }); }
    res.json({ path: '/uploads/' + name });
  });
});

/* ---------- member booking writes (create only — changing or cancelling an
   existing booking goes through the request-cancel flow / an admin) ---------- */
function validateMemberBooking(b, s, existing) {
  if (!b || typeof b !== 'object') return 'Invalid booking.';
  if (!b.id || !b.title || !String(b.title).trim()) return 'Please enter a booking title.';
  if (!b.name || !b.email || !GENERIC_EMAIL_RE.test(b.email)) return 'Please select who this booking is for.';
  if (!b.date || !DATE_RE.test(b.date) || !Number.isFinite(b.startMin) || !Number.isFinite(b.endMin)) return 'Invalid booking time.';
  if (b.startMin < 0 || b.startMin >= 1440 || b.endMin <= b.startMin) return 'Invalid booking time.';
  if (![1, 2, 3].includes(b.studio)) return 'Invalid booking.';
  if (b.admin && !existing) return 'Only admins can create locked bookings.';
  if (b.icon && !ICON_PATH_RE.test(b.icon)) b.icon = null;
  if (!sameSlot(existing, b)) {
    const slotErr = validateSlot(b, s);
    if (slotErr) return slotErr;
  }
  return checkCategory(b, true);
}
// Member rules for *when* a booking (or a requested move) can be: not in the past,
// within the book-ahead window, and the per-studio length limits.
function validateSlot(b, s) {
  if (!b.date || !DATE_RE.test(b.date) || !Number.isFinite(b.startMin) || !Number.isFinite(b.endMin)) return 'Invalid booking time.';
  if (b.startMin < 0 || b.startMin >= 1440 || b.endMin <= b.startMin) return 'End time must be after start time.';
  if (daysFromToday(b.date) < 0) return 'You can’t book a date in the past.';
  if (s.maxAdvanceDays && daysFromToday(b.date) > s.maxAdvanceDays) return 'Bookings can only be made up to ' + s.maxAdvanceDays + ' days ahead.';
  const dur = b.endMin - b.startMin;
  if (b.studio === 1) {
    if (b.endMin > 1440) return 'Radio shows must finish by midnight.';
    if (b.startMin % 60 !== 10) return 'Radio shows start 10 minutes past the hour.';
    if (dur % 60 !== 0 || dur < 60 || dur > s.radioMaxHours * 60) return 'Radio shows run for 1 to ' + s.radioMaxHours + ' hours.';
  } else if (b.studio === 2) {
    if (b.endMin > 1440) return 'DJ slots must finish by midnight.';
    if (dur < s.djMinSlotMin || dur > s.djMaxSlotMin) return 'DJ slots must be between ' + s.djMinSlotMin + ' and ' + s.djMaxSlotMin + ' minutes.';
  } else if (dur > s.roadshowMaxDays * 1440) {
    return 'Roadshow bookings can last at most ' + s.roadshowMaxDays + ' days.';
  }
  return null;
}
app.post('/api/bookings', (req, res) => {
  const b = req.body;
  const s = db.getSettings();
  if (b && b.id && db.getBooking(b.id)) return res.status(403).json({ error: 'That booking already exists — ask an admin to change it, or request to cancel it.' });
  if (b && b.repeat === 'weekly') return res.status(400).json({ error: 'Only admins can create repeating bookings.' });
  const err = validateMemberBooking(b, s, null);
  if (err) return res.status(400).json({ error: err });
  // Only approved members with media membership can book; use their registered name.
  const who = db.findMemberByEmail(b.email);
  if (!who || !who.approved) return res.status(400).json({ error: 'Please select who this booking is for.' });
  if (!who.mediaMember) return res.status(403).json({ error: 'Only media members can book. If you think you should be one, ask an admin.' });
  b.name = who.name; b.email = who.email;
  b.admin = false; b.repeat = 'none'; b.repeatUntil = null; b.pendingCancel = false;

  if (b.studio === 3) {
    const rErr = checkRoadshow(b);
    if (rErr) return res.status(400).json({ error: rErr });
    b.pendingApproval = false;
    db.touchMember(b.email);
    audit(memberActor(b.name, b.email), 'booking.create', 'Booked ' + bookingLabel(b));
    return res.json(db.upsertBooking(b));
  }

  // Studio Two one-off (non-weekly) slots are capped per member per week.
  // Over that, the booking is saved but hidden until an admin approves the override.
  let pendingApproval = false;
  if (b.studio === 2 && !b.pendingRepeat && b.repeat !== 'weekly') {
    const dur = b.endMin - b.startMin;
    const { start, end } = weekBounds(b.date);
    const used = db.djWeeklyMinutes(b.email, start, end, b.id);
    const overLimit = (used + dur) > s.djWeeklyCapMin;
    if (overLimit) {
      if (!b.overrideRequest) {
        return res.status(400).json({
          error: 'That would put you over the ' + (s.djWeeklyCapMin / 60) + '-hour weekly DJ limit (' + (used / 60) + 'h already booked this week). You can request an admin override instead.',
          overLimit: true
        });
      }
      pendingApproval = true;
    }
  }
  b.pendingApproval = pendingApproval;
  db.touchMember(b.email);
  audit(memberActor(b.name, b.email), 'booking.create', (pendingApproval ? 'Asked for a DJ-limit override for ' : b.pendingRepeat ? 'Booked (asking for it to repeat weekly) ' : 'Booked ') + bookingLabel(b));
  res.json(db.upsertBooking(b));
});
// Anyone on /book can propose a new name, description, image or time for a show.
// Nothing changes on the schedule until an admin approves it; a newer request
// for the same show replaces the older one.
app.post('/api/bookings/:id/request-change', (req, res) => {
  const existing = db.getBooking(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found.' });
  if (existing.studio === 3) return res.status(400).json({ error: 'Roadshow bookings can’t be changed this way — ask an admin.' });
  const body = req.body || {};
  const proposed = {
    title: body.title != null ? String(body.title).trim().slice(0, 120) : existing.title,
    description: body.description != null ? String(body.description).trim().slice(0, 2000) : existing.description,
    icon: body.icon === null ? null : (body.icon != null ? String(body.icon) : existing.icon),
    date: body.date != null ? String(body.date) : existing.date,
    startMin: body.startMin != null ? Number(body.startMin) : existing.startMin,
    endMin: body.endMin != null ? Number(body.endMin) : existing.endMin
  };
  if (!proposed.title) return res.status(400).json({ error: 'The show needs a name.' });
  if (proposed.icon && !ICON_PATH_RE.test(proposed.icon)) return res.status(400).json({ error: 'That image couldn’t be used — try uploading it again.' });
  const moved = !sameSlot(existing, Object.assign({}, existing, proposed));
  if (moved) {
    const err = validateSlot(Object.assign({}, existing, proposed), db.getSettings());
    if (err) return res.status(400).json({ error: err });
  }
  const changed = moved || proposed.title !== existing.title || proposed.description !== (existing.description || '') || (proposed.icon || null) !== (existing.icon || null);
  if (!changed) return res.status(400).json({ error: 'Nothing has been changed yet.' });
  const note = String(body.note || '').trim().slice(0, 300);
  db.setPendingChange(existing.id, Object.assign(proposed, { note, requestedAt: new Date().toISOString() }));
  audit('public', 'booking.request-change', 'Change requested for ' + bookingLabel(existing) + (note ? ' — note: ' + note : ''), { proposed });
  res.json(db.getBooking(existing.id));
});
app.post('/api/bookings/:id/request-cancel', (req, res) => {
  const existing = db.getBooking(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found.' });
  db.setPendingCancel(req.params.id, true);
  audit('public', 'booking.request-cancel', 'Cancellation requested for ' + bookingLabel(existing));
  res.json(db.getBooking(req.params.id));
});

/* ---------- admin ---------- */
// Slow down passphrase guessing: 8 wrong tries from one address locks it out for 15 minutes.
const loginFails = new Map(); // ip -> { n, first, lockedUntil }
const LOGIN_MAX_FAILS = 8, LOGIN_WINDOW_MS = 15 * 60 * 1000;
function loginLocked(ip) {
  const f = loginFails.get(ip);
  if (!f) return 0;
  if (f.lockedUntil && f.lockedUntil > Date.now()) return Math.ceil((f.lockedUntil - Date.now()) / 60000);
  if (Date.now() - f.first > LOGIN_WINDOW_MS) loginFails.delete(ip);
  return 0;
}
setInterval(() => { const now = Date.now(); loginFails.forEach((f, ip) => { if (now - f.first > LOGIN_WINDOW_MS && !(f.lockedUntil > now)) loginFails.delete(ip); }); }, 10 * 60 * 1000).unref();
app.post('/api/admin/login', (req, res) => {
  const ip = req.ip;
  const wait = loginLocked(ip);
  if (wait) return res.status(429).json({ error: 'Too many wrong passphrases — try again in ' + wait + ' minute' + (wait > 1 ? 's' : '') + '.' });
  const pass = (req.body && req.body.passphrase) || '';
  if (!db.checkAdminPassphrase(pass)) {
    const f = loginFails.get(ip) || { n: 0, first: Date.now() };
    f.n++;
    if (f.n >= LOGIN_MAX_FAILS) {
      f.lockedUntil = Date.now() + LOGIN_WINDOW_MS;
      audit('public', 'admin.lockout', 'Admin sign-in locked for 15 minutes after ' + f.n + ' wrong passphrases', { ip });
    }
    loginFails.set(ip, f);
    if (f.n === 3) audit('public', 'admin.login-failed', 'Several wrong admin passphrases entered', { ip });
    return res.status(401).json({ error: 'Incorrect passphrase.' });
  }
  loginFails.delete(ip);
  setSessionCookie(req, res, newSession());
  audit('admin', 'admin.login', 'Admin signed in' + (req.body && req.body.from === 'system' ? ' (System page)' : ''), { ip });
  res.json({ admin: true });
});
app.post('/api/admin/logout', (req, res) => {
  if (req.cookies[SESSION_COOKIE]) db.deleteSession(req.cookies[SESSION_COOKIE]);
  res.clearCookie(SESSION_COOKIE);
  res.json({ ok: true });
});
// Admins have no length limits: a booking may run for any number of days
// (endMin past 1440 carries over into the following days).
app.post('/api/admin/bookings', requireAdmin, (req, res) => {
  const b = req.body;
  if (!b || !b.id || !b.title || !b.name || !b.email || !b.date || !DATE_RE.test(b.date) || !Number.isFinite(b.startMin) || !Number.isFinite(b.endMin)) {
    return res.status(400).json({ error: 'Invalid booking.' });
  }
  if (b.startMin < 0 || b.startMin >= 1440 || b.endMin <= b.startMin) return res.status(400).json({ error: 'End time must be after start time.' });
  const existing = db.getBooking(b.id);
  if (b.studio === 1 && b.startMin % 60 !== 10 && !sameSlot(existing, b)) return res.status(400).json({ error: 'Radio shows start 10 minutes past the hour.' });
  if (b.icon && !ICON_PATH_RE.test(b.icon)) b.icon = null;
  // Admins may leave older, pre-category bookings untyped.
  const cErr = checkCategory(b, false);
  if (cErr) return res.status(400).json({ error: cErr });
  if (b.studio === 3) {
    const rErr = checkRoadshow(b);
    if (rErr) return res.status(400).json({ error: rErr });
  }
  const saved = db.upsertBooking(b);
  if (!existing) audit('admin', 'booking.create', 'Admin booked ' + bookingLabel(saved) + ' for ' + saved.name, { booking: saved });
  else {
    const diff = bookingDiff(existing, saved);
    const what = existing.pendingRepeat && !saved.pendingRepeat ? (saved.repeat === 'weekly' ? 'Approved weekly repeat for ' : 'Declined weekly repeat for ') : 'Edited ';
    if (Object.keys(diff).length || what !== 'Edited ') audit('admin', 'booking.edit', what + bookingLabel(existing) + (Object.keys(diff).length ? ' — changed ' + Object.keys(diff).join(', ') : ''), { id: saved.id, changes: diff });
  }
  res.json(saved);
});
// Deleting keeps a full copy of the booking in the log, so it can be put back by hand.
function deleteWithLog(req, res, action, verb) {
  const b = db.getBooking(req.params.id);
  db.deleteBooking(req.params.id);
  if (b) audit('admin', action, verb + ' ' + bookingLabel(b) + ' by ' + b.name, { booking: b });
  res.json({ ok: true });
}
app.delete('/api/admin/bookings/:id', requireAdmin, (req, res) => deleteWithLog(req, res, 'booking.delete', 'Deleted'));
app.post('/api/admin/bookings/:id/approve-cancel', requireAdmin, (req, res) => deleteWithLog(req, res, 'booking.cancel-approved', 'Approved cancellation of'));
app.post('/api/admin/bookings/:id/deny-cancel', requireAdmin, (req, res) => {
  db.setPendingCancel(req.params.id, false);
  const b = db.getBooking(req.params.id);
  if (b) audit('admin', 'booking.cancel-denied', 'Kept ' + bookingLabel(b) + ' (cancellation request declined)');
  res.json(b);
});
app.post('/api/admin/bookings/:id/approve-override', requireAdmin, (req, res) => {
  const b = db.getBooking(req.params.id);
  if (!b) return res.status(404).json({ error: 'Not found.' });
  b.pendingApproval = false;
  audit('admin', 'booking.override-approved', 'Approved DJ-limit override for ' + bookingLabel(b) + ' by ' + b.name);
  res.json(db.upsertBooking(b));
});
app.post('/api/admin/bookings/:id/deny-override', requireAdmin, (req, res) => deleteWithLog(req, res, 'booking.override-denied', 'Denied DJ-limit override for'));

// Apply a member's requested change. Moving a weekly show to a later date splits
// the series: earlier weeks keep the old details, the new series starts on the
// requested date — so past weeks on the schedule aren't rewritten.
app.post('/api/admin/bookings/:id/approve-change', requireAdmin, (req, res) => {
  const b = db.getBooking(req.params.id);
  if (!b) return res.status(404).json({ error: 'Not found.' });
  const c = b.pendingChange;
  if (!c) return res.status(400).json({ error: 'There’s no change waiting for this show.' });
  const updated = Object.assign({}, b, { title: c.title, description: c.description, icon: c.icon || null, date: c.date, startMin: c.startMin, endMin: c.endMin });
  const splitSeries = b.repeat === 'weekly' && c.date > b.date && !sameSlot(b, updated) &&
    (!b.repeatUntil || b.repeatUntil >= c.date);
  if (splitSeries) {
    const old = Object.assign({}, b, { repeatUntil: shiftDate(c.date, -1) });
    db.upsertBooking(old);
    updated.id = 'b' + Date.now() + crypto.randomBytes(2).toString('hex');
    updated.pendingCancel = false;
    db.upsertBooking(updated);
  } else {
    db.upsertBooking(updated);
  }
  db.setPendingChange(b.id, null);
  audit('admin', 'booking.change-approved', 'Approved change to ' + bookingLabel(b) + (splitSeries ? ' (series split from ' + c.date + ')' : ''), { id: b.id, changes: bookingDiff(b, updated) });
  res.json({ ok: true, split: splitSeries });
});
app.post('/api/admin/bookings/:id/deny-change', requireAdmin, (req, res) => {
  const b = db.getBooking(req.params.id);
  if (!b) return res.status(404).json({ error: 'Not found.' });
  audit('admin', 'booking.change-denied', 'Declined change to ' + bookingLabel(b), { proposed: b.pendingChange });
  db.setPendingChange(req.params.id, null);
  res.json(db.getBooking(req.params.id));
});

app.get('/api/admin/members', requireAdmin, (req, res) => res.json(db.listApprovedMembers()));
// Spreadsheet export of approved members: name and username (the part before @).
function csvCell(v) {
  let s = String(v == null ? '' : v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheets treating it as a formula
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
app.get('/api/admin/members.csv', requireAdmin, (req, res) => {
  audit('admin', 'member.export', 'Downloaded the member list (CSV)');
  const rows = [['Name', 'Username']].concat(db.listApprovedMembers().map(m => [m.name, m.email.split('@')[0]]));
  const day = new Date().toISOString().slice(0, 10);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="urb-members-' + day + '.csv"');
  // BOM so Excel reads names with accents correctly.
  res.send('﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n');
});
app.get('/api/admin/members/pending', requireAdmin, (req, res) => res.json(db.listPendingMembers()));
app.post('/api/admin/members/:id/approve', requireAdmin, (req, res) => {
  const m = db.approveMember(+req.params.id);
  if (!m) return res.status(404).json({ error: 'Not found.' });
  audit('admin', 'member.approve', 'Approved member ' + m.name + ' <' + m.email + '>');
  res.json(m);
});
app.put('/api/admin/members/:id/media', requireAdmin, (req, res) => {
  const m = db.setMediaMember(+req.params.id, !!(req.body && req.body.mediaMember));
  if (!m) return res.status(404).json({ error: 'Not found.' });
  audit('admin', 'member.media', (m.mediaMember ? 'Gave media membership to ' : 'Removed media membership from ') + m.name + ' <' + m.email + '>');
  res.json(m);
});
app.delete('/api/admin/members/:id', requireAdmin, (req, res) => {
  const m = db.getMember(+req.params.id);
  db.deleteMember(+req.params.id);
  if (m) audit('admin', 'member.delete', (m.approved ? 'Removed member ' : 'Declined registration from ') + m.name + ' <' + m.email + '>');
  res.json({ ok: true });
});

app.put('/api/admin/settings', requireAdmin, (req, res) => {
  const before = db.getSettings();
  const err = db.saveSettings(req.body);
  if (err) return res.status(400).json({ error: err });
  const after = db.getSettings();
  const changed = Object.keys(after).filter(k => after[k] !== before[k]).map(k => k + ' ' + before[k] + ' → ' + after[k]);
  if (changed.length) audit('admin', 'settings.update', 'Changed booking limits: ' + changed.join(', '));
  res.json(after);
});

/* ---------- show categories ---------- */
function categoryFields(body, partial) {
  const out = {};
  if (body.label != null || !partial) {
    out.label = String(body.label || '').trim().slice(0, 60);
    if (!out.label) return { error: 'Please enter a name for the show type.' };
  }
  if (body.color != null || !partial) {
    out.color = String(body.color || '');
    if (!HEX_COLOR_RE.test(out.color)) return { error: 'Please pick a colour.' };
  }
  if (body.hint != null) out.hint = String(body.hint).trim().slice(0, 120);
  return { fields: out };
}
app.post('/api/admin/categories', requireAdmin, (req, res) => {
  const r = categoryFields(req.body || {}, false);
  if (r.error) return res.status(400).json({ error: r.error });
  const c = db.addCategory(r.fields.label, r.fields.color, r.fields.hint);
  audit('admin', 'category.create', 'Added show type "' + c.label + '"');
  res.status(201).json(c);
});
app.put('/api/admin/categories/:key', requireAdmin, (req, res) => {
  const r = categoryFields(req.body || {}, true);
  if (r.error) return res.status(400).json({ error: r.error });
  const before = db.listCategories().find(x => x.key === req.params.key);
  const c = db.updateCategory(req.params.key, r.fields);
  if (!c) return res.status(404).json({ error: 'Not found.' });
  audit('admin', 'category.edit', 'Edited show type "' + before.label + '"' + (before.label !== c.label ? ' → "' + c.label + '"' : ''), { before, after: c });
  res.json(c);
});
app.post('/api/admin/categories/:key/move', requireAdmin, (req, res) => {
  db.moveCategory(req.params.key, (req.body && req.body.dir) < 0 ? -1 : 1);
  res.json(db.listCategories());
});
app.delete('/api/admin/categories/:key', requireAdmin, (req, res) => {
  if (req.params.key === 'other') return res.status(400).json({ error: '“Other” can’t be removed — it’s where bookings go when their show type is deleted.' });
  const c = db.listCategories().find(x => x.key === req.params.key);
  db.deleteCategory(req.params.key);
  if (c) audit('admin', 'category.delete', 'Removed show type "' + c.label + '" (its bookings moved to Other)', { category: c });
  res.json({ ok: true });
});

app.post('/api/admin/equipment', requireAdmin, (req, res) => {
  const name = String((req.body && req.body.name) || '').trim();
  const notes = String((req.body && req.body.notes) || '').trim();
  if (!name) return res.status(400).json({ error: 'Please enter an item name.' });
  const item = db.addEquipment(name, notes);
  audit('admin', 'equipment.create', 'Added Roadshow item "' + name + '"');
  res.status(201).json(item);
});
app.put('/api/admin/equipment/:id', requireAdmin, (req, res) => {
  const body = req.body || {};
  const fields = {};
  if (body.name != null) { fields.name = String(body.name).trim(); if (!fields.name) return res.status(400).json({ error: 'Please enter an item name.' }); }
  if (body.notes != null) fields.notes = String(body.notes).trim();
  if (body.active != null) fields.active = !!body.active;
  const before = db.getEquipment(+req.params.id);
  const item = db.updateEquipment(+req.params.id, fields);
  if (!item) return res.status(404).json({ error: 'Not found.' });
  audit('admin', 'equipment.edit', (fields.active != null && fields.active !== before.active ? (item.active ? 'Brought back' : 'Retired') : 'Edited') + ' Roadshow item "' + before.name + '"', { before, after: item });
  res.json(item);
});
app.delete('/api/admin/equipment/:id', requireAdmin, (req, res) => {
  const item = db.getEquipment(+req.params.id);
  db.deleteEquipment(+req.params.id);
  if (item) audit('admin', 'equipment.delete', 'Deleted Roadshow item "' + item.name + '"', { item });
  res.json({ ok: true });
});

/* ---------- System page (/system) ----------
   Backups, restore, data retention, the yearly reset, archives, the activity log
   and health checks. Anything that can't be undone asks for the passphrase again. */
function confirmed(req, res) {
  const pass = (req.body && req.body.passphrase) || req.get('X-Confirm-Passphrase') || '';
  if (db.checkAdminPassphrase(pass)) return true;
  res.status(403).json({ error: 'Type the admin passphrase to confirm.', needPassphrase: true });
  return false;
}
// Wraps async handlers so a failure becomes a readable error (and is logged) instead of a hung request.
function job(fn) {
  return (req, res) => Promise.resolve(fn(req, res)).catch(e => {
    if (e.expected) return res.status(400).json({ error: e.message });
    console.error(e);
    audit('admin', 'error.system', 'System page action failed (' + req.method + ' ' + req.path + '): ' + e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message || 'Something went wrong.' });
  });
}
function sendDownload(res, name, type, body) {
  res.set('Content-Type', type);
  res.set('Content-Disposition', 'attachment; filename="' + name + '"');
  res.set('Cache-Control', 'no-store');
  res.send(body);
}
const sys = express.Router();
sys.use(requireAdmin);
sys.get('/overview', (req, res) => {
  const counts = {
    bookings: db.raw.prepare('SELECT COUNT(*) AS n FROM bookings').get().n,
    members: db.raw.prepare('SELECT COUNT(*) AS n FROM members WHERE approved = 1').get().n,
    pendingMembers: db.raw.prepare('SELECT COUNT(*) AS n FROM members WHERE approved = 0').get().n,
    archives: db.listArchives().length,
    logEntries: db.raw.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n
  };
  res.json({
    health: ops.getHealth(), reset: ops.resetStatus(), config: ops.config(), counts,
    lastBackup: db.getStateJson('lastBackup'), lastIntegrity: db.getStateJson('lastIntegrity'), lastRetention: db.getStateJson('lastRetention'),
    lastOffsiteDownload: db.getState('lastOffsiteDownload'), recovery: db.recovery,
    server: { startedAt: ops.STARTED_AT.toISOString(), node: process.versions.node, platform: process.platform + ' ' + require('os').release(), hostname: require('os').hostname(),
      dataDir: db.dataDir, backupDir: ops.BACKUP_DIR, mirrorDir: ops.MIRROR_DIR, appDir: __dirname }
  });
});
sys.post('/health/run', job(async (req, res) => res.json(await ops.runHealthChecks('admin'))));
sys.post('/integrity', (req, res) => res.json(ops.integrityCheck('admin')));

sys.get('/backups', (req, res) => res.json(ops.listBackups()));
sys.post('/backups', job(async (req, res) => res.json(await ops.makeBackup('manual', 'admin'))));
sys.get('/backups/:name/download', (req, res) => {
  const p = ops.backupPath(req.params.name);
  if (!p) return res.status(404).json({ error: 'Not found.' });
  audit('admin', 'backup.download', 'Downloaded backup ' + req.params.name);
  res.download(p, req.params.name);
});
sys.get('/bundle', job(async (req, res) => {
  const buf = await ops.buildBundle();
  const name = 'urb-backup-' + new Date().toISOString().slice(0, 10) + '.urbbackup';
  db.setState('lastOffsiteDownload', new Date().toISOString());
  audit('admin', 'backup.download', 'Downloaded a portable backup (' + Math.round(buf.length / 1024) + ' KB)');
  sendDownload(res, name, 'application/octet-stream', buf);
}));
sys.get('/export.json', (req, res) => {
  audit('admin', 'backup.export', 'Downloaded a readable export of all data (JSON)');
  sendDownload(res, 'urb-export-' + new Date().toISOString().slice(0, 10) + '.json', 'application/json; charset=utf-8', JSON.stringify(ops.readableExport(), null, 2));
});
sys.post('/backups/:name/restore', job(async (req, res) => {
  if (!confirmed(req, res)) return;
  const p = ops.backupPath(req.params.name);
  if (!p) return res.status(404).json({ error: 'Not found.' });
  res.json(await ops.restoreFromFile(p, 'admin', 'backup ' + req.params.name));
}));
sys.post('/restore-upload', express.raw({ type: '*/*', limit: '500mb' }), job(async (req, res) => {
  if (!confirmed(req, res)) return;
  if (!req.body || !req.body.length) return res.status(400).json({ error: 'No file received.' });
  res.json(await ops.restoreFromUpload(req.body, 'admin', req.get('X-Filename')));
}));

sys.get('/retention/preview', (req, res) => res.json(ops.retention(false)));
sys.post('/retention/run', job(async (req, res) => {
  if (!confirmed(req, res)) return;
  await ops.makeBackup('manual', 'admin');
  res.json(ops.retention(true, 'admin'));
}));
sys.post('/person/find', (req, res) => {
  const p = ops.findPerson(req.body && req.body.email);
  if (!p) return res.status(400).json({ error: 'Enter an email address.' });
  audit('admin', 'privacy.lookup', 'Looked up the data held about one person');
  res.json(p);
});
sys.post('/person/erase', job(async (req, res) => {
  if (!confirmed(req, res)) return;
  res.json(await ops.erasePerson(req.body && req.body.email, 'admin'));
}));

sys.get('/reset', (req, res) => res.json(ops.resetStatus()));
sys.post('/reset', job(async (req, res) => {
  if (!confirmed(req, res)) return;
  const today = new Date();
  const ds = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
  res.json(await ops.clearSchedule({ cutoff: ds, label: 'Cleared by hand on ' + ds, reason: 'cleared by hand', clearMedia: !!(req.body && req.body.clearMedia) }, 'admin'));
}));
sys.get('/archives', (req, res) => res.json(db.listArchives()));
sys.get('/archives/:id', (req, res) => {
  const a = db.getArchive(+req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found.' });
  res.json(a);
});
sys.get('/archives/:id/csv', (req, res) => {
  const a = db.getArchive(+req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found.' });
  const cats = {}; ((a.data && a.data.categories) || []).forEach(c => { cats[c.key] = c.label; });
  const hhmm = m => String(Math.floor((m % 1440) / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  const rows = [['Studio', 'Show', 'Presenter', 'Show type', 'First date', 'Day', 'Start', 'End', 'Repeats', 'Until', 'Description']].concat(
    ((a.data && a.data.bookings) || []).map(b => [{ 1: 'Studio One', 2: 'Studio Two', 3: 'Roadshow' }[b.studio], b.title, b.name, cats[b.category] || '', b.date,
      ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(b.date + 'T12:00').getDay()], hhmm(b.startMin), hhmm(b.endMin), b.repeat === 'weekly' ? 'Weekly' : 'No', b.repeat === 'weekly' ? (b.repeatUntil || a.data.cutoff) : '', b.description || '']));
  audit('admin', 'archive.export', 'Downloaded the "' + a.label + '" archive (CSV)');
  sendDownload(res, 'urb-schedule-' + a.label.replace(/[^a-z0-9]+/gi, '-') + '.csv', 'text/csv; charset=utf-8', '\ufeff' + rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n');
});
sys.post('/archives/:id/undo', (req, res) => {
  if (!confirmed(req, res)) return;
  try { res.json(ops.undoArchive(+req.params.id, 'admin')); } catch (e) { if (!e.expected) throw e; res.status(400).json({ error: e.message }); }
});

sys.get('/log', (req, res) => res.json(db.listAudit(req.query)));
sys.get('/log.csv', (req, res) => {
  const rows = [['When (UTC)', 'Who', 'Action', 'What happened', 'Details']].concat(
    db.listAudit(Object.assign({}, req.query, { limit: 5000 })).map(r => [r.at, r.actor, r.action, r.summary, r.details ? JSON.stringify(r.details) : '']));
  sendDownload(res, 'urb-activity-log-' + new Date().toISOString().slice(0, 10) + '.csv', 'text/csv; charset=utf-8', '\ufeff' + rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n');
});

sys.put('/config', (req, res) => {
  const err = ops.saveConfig(req.body || {}, 'admin');
  if (err) return res.status(400).json({ error: err });
  res.json(ops.config());
});
sys.post('/passphrase', (req, res) => {
  const body = req.body || {};
  if (!db.checkAdminPassphrase(body.current || '')) return res.status(403).json({ error: 'The current passphrase is wrong.' });
  const next = String(body.next || '');
  if (next.length < 10) return res.status(400).json({ error: 'Use at least 10 characters — a few random words works well.' });
  if (next === 'change-this-passphrase') return res.status(400).json({ error: 'Pick something other than the example passphrase.' });
  db.setAdminPassphrase(next);
  db.setState('passphraseChangedAt', new Date().toISOString());
  audit('admin', 'admin.passphrase', 'Admin passphrase changed on the System page — all admins were signed out');
  const token = newSession();
  setSessionCookie(req, res, token);
  res.json({ ok: true });
});
app.use('/api/system', sys);

/* ---------- errors ---------- */
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large')) {
    return res.status(err.status || 400).json({ error: err.type === 'entity.too.large' ? 'That upload is too large.' : 'The request couldn’t be read.' });
  }
  console.error(err);
  audit('system', 'error.request', 'Unexpected error on ' + req.method + ' ' + req.path + ': ' + (err && err.message));
  if (!res.headersSent) res.status(500).json({ error: 'Something went wrong on the server. It has been logged.' });
});
process.on('unhandledRejection', e => { console.error(e); audit('system', 'error.unhandled', 'Unhandled error: ' + (e && e.message || e)); });
process.on('uncaughtException', e => {
  console.error(e);
  audit('system', 'error.crash', 'The server crashed and is restarting: ' + (e && e.stack || e).toString().slice(0, 400));
  process.exit(1); // the service manager (systemd/pm2) starts it again
});
// Close the database cleanly on shutdown/restart so nothing half-written is left behind.
['SIGTERM', 'SIGINT'].forEach(sig => process.on(sig, () => {
  try { audit('system', 'server.stop', 'Server stopping (' + sig + ')'); db.raw.close(); } catch (e) {}
  process.exit(0);
}));

ops.start();
app.listen(PORT, () => console.log('URB Studio Booking listening on port ' + PORT));
