'use strict';
require('dotenv').config();
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

const app = express();
app.set('trust proxy', 1); // behind Nginx — needed so req.secure reflects the real client protocol
app.use(express.json());
app.use(cookieParser());
app.use(express.static(__dirname, { index: 'index.html' }));

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
const DJ_WEEKLY_CAP_MIN = 120; // 2 hours of one-off DJ slots per member per week

function requireAdmin(req, res, next) {
  if (!isValidSession(req.cookies[SESSION_COOKIE])) return res.status(401).json({ error: 'Admin sign-in required.' });
  next();
}

/* ---------- public read endpoints ---------- */
app.get('/api/bookings', (req, res) => res.json(db.listBookings()));
app.get('/api/members', (req, res) => res.json(db.listApprovedMembers()));
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
    if (dur < 30 || dur > 60) return 'DJ slots must be between 30 minutes and 1 hour.';
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

  // Studio Two one-off (non-weekly-request) slots are capped at 2 hours/week per member.
  // Over that, the booking is saved but hidden until an admin approves the override.
  let pendingApproval = false;
  if (b.studio === 2 && !b.pendingRepeat) {
    const dur = b.endMin - b.startMin;
    const { start, end } = weekBounds(b.date);
    const used = db.djWeeklyMinutes(b.email, start, end, b.id);
    const overLimit = (used + dur) > DJ_WEEKLY_CAP_MIN;
    if (overLimit) {
      if (!b.overrideRequest) {
        return res.status(400).json({
          error: 'That would put you over the 2-hour weekly DJ limit (' + (used / 60) + 'h already booked this week). You can request an admin override instead.',
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

app.listen(PORT, () => console.log('URB Studio Booking listening on port ' + PORT));
