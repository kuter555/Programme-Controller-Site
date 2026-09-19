'use strict';
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const db = require('./db');

const PORT = process.env.PORT || 3000;
if (!process.env.ADMIN_PASSPHRASE) {
  console.error('ADMIN_PASSPHRASE is not set. Copy .env.example to .env and set one, then restart.');
  process.exit(1);
}
db.ensureAdminPassphrase(process.env.ADMIN_PASSPHRASE);

const BATH_EMAIL_RE = /^[a-z0-9._%+-]+@bath\.ac\.uk$/i;
const GENERIC_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SESSION_COOKIE = 'urb_admin';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

const sessions = new Map(); // token -> expiry timestamp
function newSession() {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}
function isValidSession(token) {
  if (!token) return false;
  const exp = sessions.get(token);
  if (!exp) return false;
  if (Date.now() > exp) { sessions.delete(token); return false; }
  return true;
}
setInterval(function () {
  const now = Date.now();
  for (const [token, exp] of sessions) if (now > exp) sessions.delete(token);
}, 10 * 60 * 1000).unref();

const uploadsDir = path.join(__dirname, 'data', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
const ICON_MIME_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };
const upload = multer({
  storage: multer.diskStorage({
    destination: uploadsDir,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + (ICON_MIME_EXT[file.mimetype] || '.jpg'))
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, !!ICON_MIME_EXT[file.mimetype])
});

const app = express();
app.set('trust proxy', 1); // behind Nginx — needed so req.secure reflects the real client protocol
app.use(express.json());
app.use(cookieParser());
app.use('/uploads', express.static(uploadsDir));
app.use(express.static(__dirname, { index: 'index.html' }));

function requireAdmin(req, res, next) {
  if (!isValidSession(req.cookies[SESSION_COOKIE])) return res.status(401).json({ error: 'Admin sign-in required.' });
  next();
}

/* ---------- public read endpoints ---------- */
app.get('/api/bookings', (req, res) => res.json(db.listBookings()));
app.get('/api/members', (req, res) => res.json(db.listMembers()));
app.get('/api/admin/session', (req, res) => res.json({ admin: isValidSession(req.cookies[SESSION_COOKIE]) }));

/* ---------- member registration ---------- */
app.post('/api/members', (req, res) => {
  const name = String((req.body && req.body.name) || '').trim();
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  if (!name) return res.status(400).json({ error: 'Please enter your name.' });
  if (!BATH_EMAIL_RE.test(email)) return res.status(400).json({ error: 'Please use your @bath.ac.uk email address.' });
  if (db.findMemberByEmail(email)) return res.status(409).json({ error: 'That email is already registered — select it from the list instead.' });
  try {
    res.status(201).json(db.insertMember(name, email));
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'That email is already registered — select it from the list instead.' });
    console.error(e);
    res.status(500).json({ error: 'Could not register — try again.' });
  }
});

/* ---------- show icon upload ---------- */
app.post('/api/icon', upload.single('icon'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose a PNG, JPEG or WEBP image under 2MB.' });
  res.json({ path: '/uploads/' + req.file.filename });
});

/* ---------- member booking writes (create only — editing/cancelling an
   existing booking goes through the request-cancel flow below) ---------- */
function validateMemberBooking(b) {
  if (!b || typeof b !== 'object') return 'Invalid booking.';
  if (!b.id || !b.title || !String(b.title).trim()) return 'Please enter a booking title.';
  if (!b.name || !b.email || !GENERIC_EMAIL_RE.test(b.email)) return 'Please select who this booking is for.';
  if (!b.date || !Number.isFinite(b.startMin) || !Number.isFinite(b.endMin)) return 'Invalid booking time.';
  const dur = b.endMin - b.startMin;
  if (b.studio === 1) {
    if (b.startMin % 60 !== 10) return 'Radio shows start 10 minutes past the hour.';
    if (dur !== 60 && dur !== 120) return 'Radio shows run for 1 or 2 hours.';
  } else {
    if (dur < 30 || dur > 120) return 'Bookings must be between 30 minutes and 2 hours.';
  }
  if (b.repeat === 'weekly') return 'Only admins can create repeating bookings.';
  if (b.admin) return 'Only admins can create locked bookings.';
  return null;
}
app.post('/api/bookings', (req, res) => {
  const b = req.body;
  const err = validateMemberBooking(b);
  if (err) return res.status(400).json({ error: err });
  const existing = db.getBooking(b.id);
  if (existing && existing.admin) return res.status(403).json({ error: 'That booking is admin-locked.' });
  b.admin = false;
  b.repeat = 'none';
  if (b.icon && !/^\/uploads\/[a-zA-Z0-9._-]+$/.test(b.icon)) b.icon = null;
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
  const token = newSession();
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: SESSION_TTL_MS });
  res.json({ admin: true });
});
app.post('/api/admin/logout', (req, res) => {
  sessions.delete(req.cookies[SESSION_COOKIE]);
  res.clearCookie(SESSION_COOKIE);
  res.json({ ok: true });
});
app.post('/api/admin/bookings', requireAdmin, (req, res) => {
  const b = req.body;
  if (!b || !b.id || !b.title || !b.name || !b.email || !b.date || !Number.isFinite(b.startMin) || !Number.isFinite(b.endMin)) {
    return res.status(400).json({ error: 'Invalid booking.' });
  }
  if (b.studio === 1) {
    const dur = b.endMin - b.startMin;
    if (b.startMin % 60 !== 10) return res.status(400).json({ error: 'Radio shows start 10 minutes past the hour.' });
    if (dur !== 60 && dur !== 120) return res.status(400).json({ error: 'Radio shows run for 1 or 2 hours.' });
  }
  if (b.icon && !/^\/uploads\/[a-zA-Z0-9._-]+$/.test(b.icon)) b.icon = null;
  res.json(db.upsertBooking(b));
});
app.delete('/api/admin/bookings/:id', requireAdmin, (req, res) => { db.deleteBooking(req.params.id); res.json({ ok: true }); });
app.post('/api/admin/bookings/:id/approve-cancel', requireAdmin, (req, res) => { db.deleteBooking(req.params.id); res.json({ ok: true }); });
app.post('/api/admin/bookings/:id/deny-cancel', requireAdmin, (req, res) => {
  db.setPendingCancel(req.params.id, false);
  res.json(db.getBooking(req.params.id));
});
app.delete('/api/admin/members/:id', requireAdmin, (req, res) => { db.deleteMember(+req.params.id); res.json({ ok: true }); });

app.listen(PORT, () => console.log('URB Studio Booking listening on port ' + PORT));
