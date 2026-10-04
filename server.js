'use strict';
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const db = require('./db');

const PORT = process.env.PORT || 3000;
if (!process.env.ADMIN_PASSPHRASE) {
  console.error('ADMIN_PASSPHRASE is not set. Copy .env.example to .env and set one, then restart.');
  process.exit(1);
}
db.ensureAdminPassphrase(process.env.ADMIN_PASSPHRASE);

const BATH_EMAIL_RE = /^[a-z0-9._%+-]+@bath\.ac\.uk$/i;
const GENERIC_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ICON_PATH_RE = /^\/uploads\/[a-zA-Z0-9._-]+$/;
// Show types for Studio One/Two bookings (colours live in app.js).
const CATEGORIES = ['flagship', 'training', 'talk', 'music', 'specialist', 'news', 'podcast', 'events', 'other'];
// Normalises b.category in place; returns an error string or null.
function checkCategory(b, required) {
  if (b.studio === 3) { b.category = null; return null; }
  if (!b.category) {
    if (required) return 'Please choose a show type.';
    b.category = null;
  } else if (CATEGORIES.indexOf(b.category) < 0) {
    return 'Unknown show type.';
  }
  b.isPodcast = b.category === 'podcast';
  return null;
}
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
app.use('/uploads', express.static(uploadsDir));
app.use('/data', (req, res) => res.status(404).end()); // never serve the database folder
app.use(express.static(__dirname, { index: 'index.html', dotfiles: 'deny' }));

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

/* ---------- public read endpoints ---------- */
app.get('/api/bookings', (req, res) => res.json(db.listBookings()));
app.get('/api/members', (req, res) => res.json(db.listApprovedMembers()));
app.get('/api/settings', (req, res) => res.json(db.getSettings()));
app.get('/api/equipment', (req, res) => res.json(db.listEquipment()));
app.get('/api/admin/session', (req, res) => res.json({ admin: isValidSession(req.cookies[SESSION_COOKIE]) }));

/* ---------- member registration ---------- */
app.post('/api/members', (req, res) => {
  const name = String((req.body && req.body.name) || '').trim();
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  if (!name) return res.status(400).json({ error: 'Please enter your name.' });
  if (!BATH_EMAIL_RE.test(email)) return res.status(400).json({ error: 'Please use your @bath.ac.uk email address.' });
  const existing = db.findMemberByEmail(email);
  if (existing) {
    return res.status(409).json({ error: existing.approved ? 'That email is already registered — select it from the list instead.' : 'That email has already been registered and is awaiting admin approval.' });
  }
  try {
    res.status(201).json(db.insertMember(name, email));
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'That email is already registered — select it from the list instead.' });
    console.error(e);
    res.status(500).json({ error: 'Could not register — try again.' });
  }
});

/* ---------- show icon upload (already cropped square in the browser) ---------- */
const ICON_TYPES = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };
app.post('/api/icon', (req, res) => {
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

/* ---------- member booking writes (create only — editing/cancelling an
   existing booking goes through the request-cancel flow below) ---------- */
function validateMemberBooking(b, s) {
  if (!b || typeof b !== 'object') return 'Invalid booking.';
  if (!b.id || !b.title || !String(b.title).trim()) return 'Please enter a booking title.';
  if (!b.name || !b.email || !GENERIC_EMAIL_RE.test(b.email)) return 'Please select who this booking is for.';
  if (!b.date || !DATE_RE.test(b.date) || !Number.isFinite(b.startMin) || !Number.isFinite(b.endMin)) return 'Invalid booking time.';
  if (b.startMin < 0 || b.startMin >= 1440 || b.endMin <= b.startMin) return 'Invalid booking time.';
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
  } else if (b.studio === 3) {
    if (dur > s.roadshowMaxDays * 1440) return 'Roadshow bookings can last at most ' + s.roadshowMaxDays + ' days.';
  } else {
    return 'Invalid booking.';
  }
  if (b.repeat === 'weekly') return 'Only admins can create repeating bookings.';
  if (b.admin) return 'Only admins can create locked bookings.';
  if (b.icon && !ICON_PATH_RE.test(b.icon)) b.icon = null;
  return checkCategory(b, true);
}
app.post('/api/bookings', (req, res) => {
  const b = req.body;
  const s = db.getSettings();
  const err = validateMemberBooking(b, s);
  if (err) return res.status(400).json({ error: err });
  const existing = db.getBooking(b.id);
  if (existing) return res.status(403).json({ error: 'That booking already exists — ask an admin to change it.' });
  b.admin = false;
  b.repeat = 'none';
  b.pendingCancel = false;

  if (b.studio === 3) {
    const rErr = checkRoadshow(b);
    if (rErr) return res.status(400).json({ error: rErr });
    b.pendingApproval = false;
    return res.json(db.upsertBooking(b));
  }

  // Studio Two one-off (non-weekly-request) slots are capped per member per week.
  // Over that, the booking is saved but hidden until an admin approves the override.
  let pendingApproval = false;
  if (b.studio === 2 && !b.pendingRepeat) {
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
  res.json(db.upsertBooking(b));
});
app.post('/api/bookings/:id/request-cancel', (req, res) => {
  const existing = db.getBooking(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found.' });
  db.setPendingCancel(req.params.id, true);
  res.json(db.getBooking(req.params.id));
});

/* ---------- admin ---------- */
app.post('/api/admin/login', (req, res) => {
  const pass = (req.body && req.body.passphrase) || '';
  if (!db.checkAdminPassphrase(pass)) return res.status(401).json({ error: 'Incorrect passphrase.' });
  setSessionCookie(req, res, newSession());
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
  if (b.studio === 1 && b.startMin % 60 !== 10) return res.status(400).json({ error: 'Radio shows start 10 minutes past the hour.' });
  if (b.icon && !ICON_PATH_RE.test(b.icon)) b.icon = null;
  // Admins may leave older, pre-category bookings untyped.
  const cErr = checkCategory(b, false);
  if (cErr) return res.status(400).json({ error: cErr });
  if (b.studio === 3) {
    const rErr = checkRoadshow(b);
    if (rErr) return res.status(400).json({ error: rErr });
  }
  res.json(db.upsertBooking(b));
});
app.delete('/api/admin/bookings/:id', requireAdmin, (req, res) => { db.deleteBooking(req.params.id); res.json({ ok: true }); });
app.post('/api/admin/bookings/:id/approve-cancel', requireAdmin, (req, res) => { db.deleteBooking(req.params.id); res.json({ ok: true }); });
app.post('/api/admin/bookings/:id/deny-cancel', requireAdmin, (req, res) => {
  db.setPendingCancel(req.params.id, false);
  res.json(db.getBooking(req.params.id));
});
app.post('/api/admin/bookings/:id/approve-override', requireAdmin, (req, res) => {
  const b = db.getBooking(req.params.id);
  if (!b) return res.status(404).json({ error: 'Not found.' });
  b.pendingApproval = false;
  res.json(db.upsertBooking(b));
});
app.post('/api/admin/bookings/:id/deny-override', requireAdmin, (req, res) => { db.deleteBooking(req.params.id); res.json({ ok: true }); });

app.get('/api/admin/members/pending', requireAdmin, (req, res) => res.json(db.listPendingMembers()));
app.post('/api/admin/members/:id/approve', requireAdmin, (req, res) => res.json(db.approveMember(+req.params.id)));
app.delete('/api/admin/members/:id', requireAdmin, (req, res) => { db.deleteMember(+req.params.id); res.json({ ok: true }); });

app.put('/api/admin/settings', requireAdmin, (req, res) => {
  const err = db.saveSettings(req.body);
  if (err) return res.status(400).json({ error: err });
  res.json(db.getSettings());
});

app.post('/api/admin/equipment', requireAdmin, (req, res) => {
  const name = String((req.body && req.body.name) || '').trim();
  const notes = String((req.body && req.body.notes) || '').trim();
  if (!name) return res.status(400).json({ error: 'Please enter an item name.' });
  res.status(201).json(db.addEquipment(name, notes));
});
app.put('/api/admin/equipment/:id', requireAdmin, (req, res) => {
  const body = req.body || {};
  const fields = {};
  if (body.name != null) { fields.name = String(body.name).trim(); if (!fields.name) return res.status(400).json({ error: 'Please enter an item name.' }); }
  if (body.notes != null) fields.notes = String(body.notes).trim();
  if (body.active != null) fields.active = !!body.active;
  const item = db.updateEquipment(+req.params.id, fields);
  if (!item) return res.status(404).json({ error: 'Not found.' });
  res.json(item);
});
app.delete('/api/admin/equipment/:id', requireAdmin, (req, res) => { db.deleteEquipment(+req.params.id); res.json({ ok: true }); });

app.listen(PORT, () => console.log('URB Studio Booking listening on port ' + PORT));
