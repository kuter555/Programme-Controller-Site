'use strict';
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const db = require('./db');
const mailer = require('./mailer');

const PORT = process.env.PORT || 3000;
if (!process.env.ADMIN_PASSPHRASE) {
  console.error('ADMIN_PASSPHRASE is not set. Copy .env.example to .env and set one, then restart.');
  process.exit(1);
}
db.ensureAdminPassphrase(process.env.ADMIN_PASSPHRASE);
if (!mailer.configured) console.warn('SMTP is not configured — account emails will be printed to this log instead of sent.');

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

/* ---------- member accounts ---------- */
// Accounts are optional and only exist so members can edit or cancel their own
// bookings. A password is set (or reset) through a one-time emailed link.
const MEMBER_COOKIE = 'urb_member';
const MEMBER_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 days since last use
const LINK_TTL_MS = 2 * 60 * 60 * 1000;         // emailed links last 2 hours
const MIN_PASSWORD = 8;

function setMemberCookie(req, res, token) {
  res.cookie(MEMBER_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: MEMBER_TTL_MS });
}
function startMemberSession(req, res, memberId) {
  const token = crypto.randomBytes(24).toString('hex');
  db.createMemberSession(token, memberId, Date.now() + MEMBER_TTL_MS);
  setMemberCookie(req, res, token);
}
// The signed-in member (sliding the session forward), or null.
function currentMember(req, res) {
  const token = req.cookies[MEMBER_COOKIE];
  if (!token) return null;
  const m = db.getMemberSession(token, Date.now());
  if (!m) return null;
  db.extendMemberSession(token, Date.now() + MEMBER_TTL_MS);
  setMemberCookie(req, res, token);
  return m;
}
function publicMember(m) { return m ? { id: m.id, name: m.name, email: m.email } : null; }
function ownsBooking(m, b) { return !!(m && b && m.email.toLowerCase() === String(b.email).toLowerCase()); }

// Small in-memory throttles: failed logins per email, and link emails per email.
const loginFails = new Map(); // email -> { n, first }
const linkSent = new Map();   // email -> timestamp
function tooManyFails(email) {
  const f = loginFails.get(email);
  if (!f) return false;
  if (Date.now() - f.first > 15 * 60 * 1000) { loginFails.delete(email); return false; }
  return f.n >= 8;
}
function noteFail(email) {
  const f = loginFails.get(email);
  if (!f || Date.now() - f.first > 15 * 60 * 1000) loginFails.set(email, { n: 1, first: Date.now() });
  else f.n++;
}

setInterval(function () {
  const now = Date.now();
  db.purgeExpiredSessions(now);
  db.purgeExpiredMemberAuth(now);
  for (const [k, t] of linkSent) if (now - t > 60 * 1000) linkSent.delete(k);
}, 10 * 60 * 1000).unref();

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

/* ---------- public read endpoints ---------- */
app.get('/api/bookings', (req, res) => res.json(db.listBookings()));
app.get('/api/members', (req, res) => res.json(db.listApprovedMembers().map(publicMember)));
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
    return res.status(409).json({ error: existing.approved ? 'That email is already registered — select it from the list instead.' : 'That email has already been registered and is awaiting admin approval.' });
  }
  try {
    res.status(201).json(publicMember(db.insertMember(name, email)));
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'That email is already registered — select it from the list instead.' });
    console.error(e);
    res.status(500).json({ error: 'Could not register — try again.' });
  }
});

/* ---------- member accounts ---------- */
app.get('/api/account', (req, res) => res.json({ member: publicMember(currentMember(req, res)) }));

app.post('/api/account/login', (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  const password = String((req.body && req.body.password) || '');
  if (tooManyFails(email)) return res.status(429).json({ error: 'Too many attempts — wait 15 minutes or reset your password.' });
  const m = db.checkMemberLogin(email, password);
  if (!m) {
    noteFail(email);
    return res.status(401).json({ error: 'Wrong email or password. First time here? Use “Create account” to get a link.' });
  }
  loginFails.delete(email);
  startMemberSession(req, res, m.id);
  res.json({ member: publicMember(m) });
});

app.post('/api/account/logout', (req, res) => {
  if (req.cookies[MEMBER_COOKIE]) db.deleteMemberSession(req.cookies[MEMBER_COOKIE]);
  res.clearCookie(MEMBER_COOKIE);
  res.json({ ok: true });
});

// One endpoint for both "create my account" and "forgot password": either way
// the member gets a one-time link to their registered email to set a password.
// The reply is the same whether or not the email is registered, so this can't
// be used to find out who is a member.
app.post('/api/account/request-link', (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  if (!GENERIC_EMAIL_RE.test(email)) return res.status(400).json({ error: 'Please enter your email address.' });
  const reply = { ok: true, message: 'If that email belongs to a registered member, a link is on its way. It expires in 2 hours — check your junk folder too.' };
  const m = db.findMemberByEmail(email);
  if (!m || !m.approved) return res.json(reply);
  if (linkSent.has(m.email)) return res.json(reply); // at most one email a minute per address
  linkSent.set(m.email, Date.now());

  const base = (process.env.APP_URL || (req.protocol + '://' + req.get('host'))).replace(/\/+$/, '');
  const link = base + '/?setpw=' + db.createMemberToken(m.id, LINK_TTL_MS);
  const fresh = !m.hasAccount;
  const subject = fresh ? 'Set up your URB Studio Booking account' : 'Reset your URB Studio Booking password';
  const text = 'Hi ' + m.name + ',\n\n' +
    (fresh ? 'Use this link to choose a password for your URB Studio Booking account. Once it’s set you can log in to edit or cancel your own bookings:'
           : 'Someone (hopefully you) asked to reset the password for your URB Studio Booking account. Use this link to choose a new one:') +
    '\n\n' + link + '\n\nThe link works once and expires in 2 hours. If you didn’t ask for this, you can ignore this email.\n\n— URB 1449 AM';
  mailer.sendMail(m.email, subject, text).catch(e => console.error('Could not send account email to ' + m.email + ':', e.message));
  res.json(reply);
});

// Lets the set-password screen greet the member and spot dead links early.
app.get('/api/account/link/:token', (req, res) => {
  const id = db.peekMemberToken(req.params.token);
  const m = id && db.getMember(id);
  if (!m) return res.status(410).json({ error: 'This link has expired or already been used. Ask for a new one from “Member login”.' });
  res.json({ name: m.name, email: m.email, hasAccount: m.hasAccount });
});

app.post('/api/account/set-password', (req, res) => {
  const password = String((req.body && req.body.password) || '');
  if (password.length < MIN_PASSWORD) return res.status(400).json({ error: 'Use at least ' + MIN_PASSWORD + ' characters.' });
  const id = db.consumeMemberToken(req.body && req.body.token);
  const m = id && db.getMember(id);
  if (!m || !m.approved) return res.status(410).json({ error: 'This link has expired or already been used. Ask for a new one from “Member login”.' });
  db.setMemberPassword(m.id, password);
  db.deleteMemberSessionsFor(m.id); // a reset signs out any other devices
  loginFails.delete(m.email);
  startMemberSession(req, res, m.id);
  res.json({ member: publicMember(m) });
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

/* ---------- member booking writes ----------
   Anyone can create a booking. Changing or deleting one afterwards needs a
   member login for the email the booking is under (or an admin). */
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
  }
  return checkCategory(b, true);
}
app.post('/api/bookings', (req, res) => {
  const b = req.body;
  const s = db.getSettings();
  const me = currentMember(req, res);
  const existing = b && b.id ? db.getBooking(b.id) : null;

  if (existing) {
    // Editing: only the member the booking belongs to.
    if (!me) return res.status(401).json({ error: 'Log in with the account this booking is under to change it.' });
    if (!ownsBooking(me, existing)) return res.status(403).json({ error: 'You can only change your own bookings.' });
    b.studio = existing.studio;
    // Weekly slots stay weekly (an admin approved them); members can't create new repeats.
    b.repeat = existing.repeat;
    b.repeatUntil = existing.repeatUntil;
    b.admin = existing.admin;
    b.pendingCancel = existing.pendingCancel;
    if (existing.repeat === 'weekly') b.pendingRepeat = false;
  } else {
    if (b && b.repeat === 'weekly') return res.status(400).json({ error: 'Only admins can create repeating bookings.' });
    if (b) { b.repeat = 'none'; b.repeatUntil = null; b.pendingCancel = false; }
  }
  // Signed-in members always book as themselves.
  if (me && b) { b.name = me.name; b.email = me.email; }

  const err = validateMemberBooking(b, s, existing);
  if (err) return res.status(400).json({ error: err });
  if (!existing) b.admin = false;

  if (b.studio === 3) {
    const rErr = checkRoadshow(b);
    if (rErr) return res.status(400).json({ error: rErr });
    b.pendingApproval = false;
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
    if (overLimit && !(existing && sameSlot(existing, b) && !existing.pendingApproval)) {
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
app.delete('/api/bookings/:id', (req, res) => {
  const existing = db.getBooking(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found.' });
  const me = currentMember(req, res);
  if (!me) return res.status(401).json({ error: 'Log in to cancel your booking.' });
  if (!ownsBooking(me, existing)) return res.status(403).json({ error: 'You can only cancel your own bookings.' });
  db.deleteBooking(existing.id);
  res.json({ ok: true });
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

app.get('/api/admin/members', requireAdmin, (req, res) => res.json(db.listApprovedMembers()));
app.get('/api/admin/members/pending', requireAdmin, (req, res) => res.json(db.listPendingMembers()));
app.post('/api/admin/members/:id/approve', requireAdmin, (req, res) => res.json(db.approveMember(+req.params.id)));
app.put('/api/admin/members/:id/media', requireAdmin, (req, res) => {
  const m = db.setMediaMember(+req.params.id, !!(req.body && req.body.mediaMember));
  if (!m) return res.status(404).json({ error: 'Not found.' });
  res.json(m);
});
app.delete('/api/admin/members/:id', requireAdmin, (req, res) => { db.deleteMember(+req.params.id); res.json({ ok: true }); });

app.put('/api/admin/settings', requireAdmin, (req, res) => {
  const err = db.saveSettings(req.body);
  if (err) return res.status(400).json({ error: err });
  res.json(db.getSettings());
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
  res.status(201).json(db.addCategory(r.fields.label, r.fields.color, r.fields.hint));
});
app.put('/api/admin/categories/:key', requireAdmin, (req, res) => {
  const r = categoryFields(req.body || {}, true);
  if (r.error) return res.status(400).json({ error: r.error });
  const c = db.updateCategory(req.params.key, r.fields);
  if (!c) return res.status(404).json({ error: 'Not found.' });
  res.json(c);
});
app.post('/api/admin/categories/:key/move', requireAdmin, (req, res) => {
  db.moveCategory(req.params.key, (req.body && req.body.dir) < 0 ? -1 : 1);
  res.json(db.listCategories());
});
app.delete('/api/admin/categories/:key', requireAdmin, (req, res) => {
  if (req.params.key === 'other') return res.status(400).json({ error: '“Other” can’t be removed — it’s where bookings go when their show type is deleted.' });
  db.deleteCategory(req.params.key);
  res.json({ ok: true });
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
