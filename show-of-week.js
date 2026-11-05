'use strict';
/*
 * Show of the Week (/show-of-the-week)
 *   - Every Sunday draws 3 random Studio One shows airing in the coming Mon–Sun.
 *   - Records 15 minutes from the middle of each while it airs, by saving the
 *     lowest sensible-quality MP3 stream straight to disk. Recordings are deleted
 *     after 2 weeks.
 *   - The team can swap shows by hand, choose the winner and download its logo.
 * Everything here is behind its own password (the admin passphrase also works).
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const db = require('./db');
const ops = require('./maintenance');

const raw = db.raw;
const REC_DIR = path.join(db.dataDir, 'sotw-recordings');
const UPLOADS_DIR = path.join(db.dataDir, 'uploads');
const DEFAULT_LOGO = path.join(__dirname, 'assets', 'listen-logo.png');
const REC_NAME_RE = /^\d+\.mp3$/;
const ICON_RE = /^\/uploads\/([a-zA-Z0-9._-]+)$/;

const PICKS_PER_WEEK = 3;
const RECORD_MINUTES = 15;
const KEEP_DAYS = 14;              // recordings
const KEEP_ROWS_WEEKS = 12;        // shortlist history (holds presenter names)
const AVOID_WEEKS = 4;             // don't re-draw a show shortlisted this recently, if there's a choice
const SKIP_CATEGORIES = ['podcast', 'training']; // not shows to promote; podcasts aren't on air
const TICK_MS = 15000;
const NO_DATA_MS = 20000;          // stream connected but silent for this long: reconnect
const RETRY_MS = 3000;
const MAX_FILE_BYTES = 60 * 1024 * 1024; // 15 mins at 320kbps is 36MB
const MIN_FILE_BYTES = 16 * 1024;
const SESSION_COOKIE = 'urb_sotw';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/* ---------- UK time (bookings are stored in UK local time, whatever the server's clock says) ---------- */
function londonNow() {
  const parts = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).forEach(p => { parts[p.type] = p.value; });
  const date = parts.year + '-' + parts.month + '-' + parts.day;
  const min = Number(parts.hour) * 60 + Number(parts.minute);
  return { date, min, sec: Number(parts.second), abs: dayIndex(date) * 1440 + min };
}
function dayIndex(ds) { const p = ds.split('-').map(Number); return Math.round(Date.UTC(p[0], p[1] - 1, p[2]) / 86400000); }
function dateOfIndex(n) { return new Date(n * 86400000).toISOString().slice(0, 10); }
function shiftDate(ds, n) { return dateOfIndex(dayIndex(ds) + n); }
function weekdayOf(ds) { return (dayIndex(ds) + 3) % 7; } // Monday = 0
function mondayOf(ds) { return shiftDate(ds, -weekdayOf(ds)); }
// The week the next draw is for: on Sunday that's the week starting tomorrow.
function targetWeek(ds) { return weekdayOf(ds) === 6 ? shiftDate(ds, 1) : mondayOf(ds); }
// The stretch to record: up to 15 minutes, centred in the show.
function midWindow(startAbs, endAbs) {
  const len = Math.min(RECORD_MINUTES, endAbs - startAbs);
  const from = startAbs + Math.floor((endAbs - startAbs - len) / 2);
  return { from, to: from + len };
}
// Does booking b have an instance starting on date ds? (mirrors startsOn in app.js)
function startsOn(b, ds) {
  if (b.repeat === 'weekly') return ds >= b.date && (!b.repeatUntil || ds <= b.repeatUntil) && (dayIndex(ds) - dayIndex(b.date)) % 7 === 0;
  return b.date === ds;
}
// This booking's airings in a Mon–Sun week, leaving out any marked "No show" or replaced by a one-week override.
function instancesIn(b, week) {
  const out = [];
  for (let k = 0; k < 7; k++) {
    const ds = shiftDate(week, k);
    if (startsOn(b, ds) && !db.isOffAir(b, ds)) {
      const base = dayIndex(ds) * 1440;
      out.push({ date: ds, startMin: b.startMin, endMin: b.endMin, window: midWindow(base + b.startMin, base + b.endMin) });
    }
  }
  return out;
}
function isRadioShow(b) { return b.studio === 1 && !b.pendingApproval; }
function drawable(b) {
  return isRadioShow(b) && !b.pendingCancel && !b.isPodcast && !SKIP_CATEGORIES.includes(b.category);
}

/* ---------- storing picks ---------- */
function audit(action, summary, actor) { try { db.addAudit(actor || 'system', 'sotw.' + action, summary); } catch (e) { console.error('audit failed', e); } }
function getPick(id) { return raw.prepare('SELECT * FROM sotw_picks WHERE id = ?').get(id) || null; }
function picksIn(week) { return raw.prepare('SELECT * FROM sotw_picks WHERE week = ? ORDER BY id').all(week); }
function recFile(id) { return path.join(REC_DIR, id + '.mp3'); }
function removeFile(id) { try { fs.unlinkSync(recFile(id)); } catch (e) { if (e.code !== 'ENOENT') console.error(e); } }
function setPick(id, fields) {
  const keys = Object.keys(fields);
  if (keys.length) raw.prepare('UPDATE sotw_picks SET ' + keys.map(k => k + ' = @' + k).join(', ') + ' WHERE id = @id').run(Object.assign({}, fields, { id }));
}
function insertPick(week, b, inst, source) {
  const info = raw.prepare(`INSERT INTO sotw_picks (week, booking_id, title, presenter, email, icon, category, occ_date, start_min, end_min, source, rec_status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?)`)
    .run(week, b.id, b.title, b.name, b.email, b.icon || null, b.category || null, inst.date, inst.startMin, inst.endMin, source, new Date().toISOString());
  return getPick(info.lastInsertRowid);
}
function ensureWeekRow(week) { raw.prepare('INSERT OR IGNORE INTO sotw_weeks (week, drawn_at, manual) VALUES (?, ?, 0)').run(week, new Date().toISOString()); }
function isManual(week) { const r = raw.prepare('SELECT manual FROM sotw_weeks WHERE week = ?').get(week); return !!(r && r.manual); }
function markManual(week) { ensureWeekRow(week); raw.prepare('UPDATE sotw_weeks SET manual = 1 WHERE week = ?').run(week); }
function deletePick(p) {
  const a = active.get(p.id);
  if (a) { a.discard = true; a.controller.abort(); }
  raw.prepare('DELETE FROM sotw_picks WHERE id = ?').run(p.id);
  if (!a) removeFile(p.id);
}

/* ---------- the random draw ---------- */
function shuffled(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); const t = a[i]; a[i] = a[j]; a[j] = t; }
  return a;
}
// Tops the week up to 3 picks, from shows still able to be recorded. Returns what it added.
function fillWeek(week, source) {
  const current = picksIn(week).filter(p => p.rec_status !== 'off_schedule');
  let need = PICKS_PER_WEEK - current.length;
  if (need <= 0) return [];
  const nowAbs = londonNow().abs;
  const taken = new Set(current.map(p => p.booking_id));
  const emails = new Set(current.map(p => (p.email || '').toLowerCase()));
  const recent = new Set(raw.prepare('SELECT booking_id FROM sotw_picks WHERE week < ? AND week >= ?').all(week, shiftDate(week, -7 * AVOID_WEEKS)).map(r => r.booking_id));
  const pool = shuffled(db.listBookings().filter(b => drawable(b) && !taken.has(b.id))
    .map(b => ({ b, inst: instancesIn(b, week).find(i => i.window.to > nowAbs) }))
    .filter(c => c.inst));
  // Best first: not shortlisted lately, and a presenter not already in this week's three.
  const score = c => (recent.has(c.b.id) ? 2 : 0) + (emails.has(c.b.email.toLowerCase()) ? 1 : 0);
  const added = [];
  while (need > 0 && pool.length) {
    let best = 0;
    pool.forEach((c, i) => { if (score(c) < score(pool[best])) best = i; });
    const c = pool.splice(best, 1)[0];
    added.push(insertPick(week, c.b, c.inst, source));
    emails.add(c.b.email.toLowerCase());
    need--;
  }
  return added;
}
function ensureDraw() {
  const week = targetWeek(londonNow().date);
  const exists = raw.prepare('SELECT 1 FROM sotw_weeks WHERE week = ?').get(week);
  ensureWeekRow(week);
  if (!isManual(week)) {
    // A drawn show that's since left the schedule is replaced, unless someone has taken over by hand.
    picksIn(week).filter(p => p.rec_status === 'off_schedule').forEach(deletePick);
  }
  if (exists && isManual(week)) return;
  const added = fillWeek(week, 'auto');
  if (added.length) audit('draw', 'Show of the Week: drew ' + added.map(p => '"' + p.title + '"').join(', ') + ' for the week of ' + week);
  else if (!exists) audit('draw', 'Show of the Week: no shows to draw for the week of ' + week + ' yet; will keep looking');
}

/* ---------- recording ---------- */
const active = new Map(); // pick id -> { controller, discard }

function kbpsOf(url) { const m = /(\d+)\.mp3(\?|$)/.exec(url); return m ? Number(m[1]) : null; }
// Speech and music are still clear at 64kbps and it keeps files to about 7MB, so
// prefer that, then the next heavier stream, and only go lighter as a last resort.
function recordingStreams() {
  const all = ops.config().streams;
  const mp3 = all.filter(u => /\.mp3(\?|$)/.test(u));
  const rank = u => { const k = kbpsOf(u); return k == null ? 1e6 : k >= 64 ? k : 1e5 - k; };
  return (mp3.length ? mp3 : all).slice().sort((a, b) => rank(a) - rank(b));
}
async function writeChunk(out, chunk) {
  if (!out.write(chunk)) await new Promise(res => out.once('drain', res));
}
// Saves the stream until stopAt, reconnecting whenever it drops. A resumed recording
// (the server restarted mid-way) appends, so it just has a gap rather than being lost.
async function record(state, stopAt, onStream) {
  fs.mkdirSync(REC_DIR, { recursive: true });
  const file = state.file;
  const out = fs.createWriteStream(file, { flags: 'a' });
  const streams = recordingStreams();
  let idx = 0, bytes = fs.existsSync(file) ? fs.statSync(file).size : 0, lastError = null, gotData = bytes > 0;
  const stopTimer = setTimeout(() => state.controller.abort(), Math.max(0, stopAt - Date.now()));
  try {
    while (Date.now() < stopAt && !state.discard && bytes < MAX_FILE_BYTES) {
      const attempt = new AbortController();
      const onStop = () => attempt.abort();
      state.controller.signal.addEventListener('abort', onStop);
      let silence = setTimeout(() => attempt.abort(), NO_DATA_MS);
      let received = false;
      try {
        const url = streams[idx];
        onStream(url);
        const res = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), { signal: attempt.signal, headers: { 'User-Agent': 'URB-Booking-ShowOfTheWeek' } });
        if (!res.ok) throw new Error('stream answered ' + res.status);
        for await (const chunk of res.body) {
          received = gotData = true;
          clearTimeout(silence);
          silence = setTimeout(() => attempt.abort(), NO_DATA_MS);
          await writeChunk(out, chunk);
          bytes += chunk.length;
          if (bytes >= MAX_FILE_BYTES) break;
        }
        if (Date.now() < stopAt) lastError = 'the stream closed the connection';
      } catch (e) {
        if (!state.controller.signal.aborted) lastError = e.cause && e.cause.code ? e.cause.code : (e.name === 'AbortError' ? 'no audio for ' + NO_DATA_MS / 1000 + 's' : e.message);
      } finally {
        clearTimeout(silence);
        state.controller.signal.removeEventListener('abort', onStop);
      }
      if (Date.now() >= stopAt || state.discard) break;
      // Nothing at all from this address: try the next one. Don't change quality mid-file otherwise.
      if (!received && !gotData && streams.length > 1) idx = (idx + 1) % streams.length;
      await new Promise(res => setTimeout(res, RETRY_MS));
    }
  } finally {
    clearTimeout(stopTimer);
    await new Promise(res => out.end(res));
  }
  return { bytes, lastError };
}
function beginRecording(p, win, now) {
  const stopAt = Date.now() + ((win.to - now.abs) * 60 - now.sec) * 1000;
  const state = { controller: new AbortController(), discard: false, file: recFile(p.id) };
  active.set(p.id, state);
  setPick(p.id, { rec_status: 'recording', rec_started: p.rec_started || new Date().toISOString(), rec_error: null });
  if (!p.rec_started) audit('record', 'Show of the Week: recording "' + p.title + '"');
  let stream = null;
  record(state, stopAt, u => { stream = u; })
    .then(r => finishRecording(p.id, state, r.lastError, stream))
    .catch(e => finishRecording(p.id, state, e.message, stream));
}
function fileSize(id) { try { return fs.statSync(recFile(id)).size; } catch (e) { return 0; } }
function finishRecording(id, state, lastError, stream) {
  active.delete(id);
  const p = getPick(id);
  if (!p || (state && state.discard)) { removeFile(id); return; }
  const size = fileSize(id);
  if (size >= MIN_FILE_BYTES) {
    setPick(id, { rec_status: 'ready', rec_finished: new Date().toISOString(), rec_expires: new Date(Date.now() + KEEP_DAYS * 86400000).toISOString(), rec_bytes: size, rec_kbps: stream ? kbpsOf(stream) : p.rec_kbps, rec_error: lastError });
  } else {
    removeFile(id);
    setPick(id, { rec_status: 'failed', rec_finished: new Date().toISOString(), rec_error: lastError || 'no audio arrived from the stream' });
    audit('record-failed', 'Show of the Week: couldn’t record "' + p.title + '" (' + (lastError || 'no audio arrived from the stream') + ')');
  }
}
// Keeps picks in step with the schedule, and starts or finishes recordings on time.
function runRecordings() {
  const now = londonNow();
  const from = shiftDate(mondayOf(now.date), -7);
  raw.prepare("SELECT * FROM sotw_picks WHERE rec_status IN ('scheduled', 'recording', 'off_schedule') AND week >= ?").all(from).forEach(p => {
    if (active.has(p.id)) return;
    const b = db.getBooking(p.booking_id);
    const inst = b && isRadioShow(b) ? instancesIn(b, p.week)[0] : null;
    if (!inst) {
      if (p.rec_status === 'recording') finishRecording(p.id, null, 'the show left the schedule part-way through', null);
      else if (p.rec_status !== 'off_schedule') setPick(p.id, { rec_status: 'off_schedule' });
      return;
    }
    // Follow any change made to the show: renames, a new logo, or a move within the week.
    setPick(p.id, { title: b.title, presenter: b.name, email: b.email, icon: b.icon || null, category: b.category || null, occ_date: inst.date, start_min: inst.startMin, end_min: inst.endMin });
    if (now.abs >= inst.window.to) {
      if (fileSize(p.id) >= MIN_FILE_BYTES) finishRecording(p.id, null, p.rec_status === 'recording' ? 'the server restarted during the recording' : null, null);
      else {
        removeFile(p.id);
        setPick(p.id, { rec_status: 'missed' });
        audit('record-missed', 'Show of the Week: "' + p.title + '" wasn’t recorded (its slot had passed)');
      }
    } else if (now.abs >= inst.window.from) {
      beginRecording(p, inst.window, now);
    } else if (p.rec_status !== 'scheduled') {
      setPick(p.id, { rec_status: 'scheduled' });
    }
  });
}

/* ---------- clean-up ---------- */
function runCleanup() {
  const nowIso = new Date().toISOString();
  raw.prepare("SELECT * FROM sotw_picks WHERE rec_status = 'ready' AND rec_expires <= ?").all(nowIso).forEach(p => {
    removeFile(p.id);
    setPick(p.id, { rec_status: 'expired', rec_bytes: null });
    audit('recording-deleted', 'Show of the Week: deleted the 2-week-old recording of "' + p.title + '"');
  });
  const cutoff = shiftDate(mondayOf(londonNow().date), -7 * KEEP_ROWS_WEEKS);
  raw.prepare('SELECT * FROM sotw_picks WHERE week < ?').all(cutoff).forEach(p => { removeFile(p.id); raw.prepare('DELETE FROM sotw_picks WHERE id = ?').run(p.id); });
  raw.prepare('DELETE FROM sotw_weeks WHERE week < ?').run(cutoff);
  raw.prepare('DELETE FROM sotw_sessions WHERE expires < ?').run(Date.now());
  // Anything on disk with no matching pick (e.g. after restoring an older database).
  if (fs.existsSync(REC_DIR)) {
    fs.readdirSync(REC_DIR).filter(n => REC_NAME_RE.test(n)).forEach(n => {
      const id = parseInt(n, 10);
      const p = getPick(id);
      if (!active.has(id) && (!p || !['ready', 'recording'].includes(p.rec_status))) removeFile(id);
    });
  }
}

/* ---------- scheduler ---------- */
let lastDrawCheck = 0, lastCleanup = 0, lastErrorKey = null;
function tick() {
  try {
    const t = Date.now();
    if (t - lastDrawCheck >= 10 * 60 * 1000) { lastDrawCheck = t; ensureDraw(); }
    runRecordings();
    if (t - lastCleanup >= 60 * 60 * 1000) { lastCleanup = t; runCleanup(); }
  } catch (e) {
    console.error('[show of the week]', e);
    const key = e.message + '|' + new Date().toISOString().slice(0, 10);
    if (key !== lastErrorKey) { lastErrorKey = key; audit('error', 'Show of the Week job failed: ' + e.message); }
  }
}
function start() {
  fs.mkdirSync(REC_DIR, { recursive: true });
  setTimeout(tick, 5000).unref();
  setInterval(tick, TICK_MS).unref();
}

/* ---------- privacy (called from the System page's person search and erase) ---------- */
function picksForEmail(email) {
  return raw.prepare('SELECT week, title, presenter, occ_date, rec_status, rec_expires FROM sotw_picks WHERE email = ? COLLATE NOCASE').all(email);
}
function eraseEmail(email) {
  const rows = raw.prepare('SELECT * FROM sotw_picks WHERE email = ? COLLATE NOCASE').all(email);
  rows.forEach(deletePick);
  return rows.length;
}

/* ---------- what the page sees ---------- */
function logoInfo(p) {
  const b = db.getBooking(p.booking_id);
  const icon = (b && b.icon) || p.icon;
  const m = icon ? ICON_RE.exec(icon) : null;
  const file = m ? path.join(UPLOADS_DIR, m[1]) : null;
  if (file && fs.existsSync(file)) return { own: true, file, url: icon };
  return { own: false, file: DEFAULT_LOGO, url: '/assets/listen-logo.png' };
}
function pickJson(p, categories) {
  const base = dayIndex(p.occ_date) * 1440;
  const win = midWindow(base + p.start_min, base + p.end_min);
  const cat = categories.find(c => c.key === p.category);
  const hasAudio = p.rec_status === 'ready' && fileSize(p.id) > 0;
  const expected = (win.to - win.from) * 60 * (p.rec_kbps || 0) * 125;
  const size = hasAudio ? fileSize(p.id) : 0;
  return {
    id: p.id, bookingId: p.booking_id, title: p.title, presenter: p.presenter, date: p.occ_date,
    startMin: p.start_min, endMin: p.end_min, recFromMin: win.from - base, recToMin: win.to - base, source: p.source,
    chosen: !!p.chosen, status: hasAudio || p.rec_status !== 'ready' ? p.rec_status : 'expired',
    hasAudio, bytes: size, expires: p.rec_expires, error: p.rec_error,
    partialMinutes: hasAudio && expected && size < expected * 0.9 ? Math.round(size / expected * (win.to - win.from)) : null,
    category: cat ? cat.label : null, color: cat ? cat.color : null, logo: logoInfo(p).url, ownLogo: logoInfo(p).own
  };
}
function weeksJson() {
  const today = londonNow().date;
  const thisWeek = mondayOf(today), nextWeek = shiftDate(thisWeek, 7);
  const cats = db.listCategories();
  return raw.prepare('SELECT * FROM sotw_weeks ORDER BY week DESC LIMIT 8').all().map(w => ({
    week: w.week, manual: !!w.manual, isThis: w.week === thisWeek, isNext: w.week === nextWeek,
    picks: picksIn(w.week).map(p => pickJson(p, cats))
  }));
}
function candidatesFor(week) {
  const now = londonNow().abs;
  const out = [];
  db.listBookings().filter(isRadioShow).forEach(b => {
    const inst = instancesIn(b, week)[0];
    if (inst) out.push({ id: b.id, title: b.title, presenter: b.name, date: inst.date, startMin: inst.startMin, endMin: inst.endMin, canRecord: inst.window.to > now });
  });
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin);
}

/* ---------- password + sessions ---------- */
function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function passwordRecord() { return db.getStateJson('sotwPassword'); }
function checkPassword(pass) {
  const r = passwordRecord();
  if (!r) return false;
  const a = crypto.scryptSync(String(pass), r.salt, 64), b = Buffer.from(r.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function hasSession(req) {
  const t = req.cookies[SESSION_COOKIE];
  if (!t) return false;
  const r = raw.prepare('SELECT expires FROM sotw_sessions WHERE token_hash = ?').get(sha256(t));
  return !!r && r.expires > Date.now();
}

/* ---------- the API, under /api/sotw ---------- */
function router(deps) {
  const r = express.Router();
  const signedIn = req => deps.isAdminReq(req) || hasSession(req);
  const actor = req => (deps.isAdminReq(req) ? 'admin' : 'show-of-the-week team');
  const validWeek = w => /^\d{4}-\d{2}-\d{2}$/.test(w) && weekdayOf(w) === 0 && !isNaN(new Date(w));

  r.get('/session', (req, res) => res.json({ signedIn: signedIn(req), admin: deps.isAdminReq(req), passwordSet: !!passwordRecord() }));
  r.post('/login', (req, res) => {
    const ip = req.ip;
    const wait = deps.loginLocked(ip);
    if (wait) return res.status(429).json({ error: 'Too many wrong passwords — try again in ' + wait + ' minute' + (wait > 1 ? 's' : '') + '.' });
    const pass = String((req.body && req.body.password) || '');
    if (pass && checkPassword(pass)) {
      deps.clearLoginFails(ip);
      const token = crypto.randomBytes(24).toString('hex');
      raw.prepare('INSERT INTO sotw_sessions (token_hash, expires) VALUES (?, ?)').run(sha256(token), Date.now() + SESSION_TTL_MS);
      res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: SESSION_TTL_MS });
      audit('login', 'Signed in to Show of the Week', 'show-of-the-week team');
      return res.json({ signedIn: true, admin: false, passwordSet: true });
    }
    if (pass && db.checkAdminPassphrase(pass)) {
      deps.clearLoginFails(ip);
      deps.startAdminSession(req, res);
      deps.audit('admin', 'admin.login', 'Admin signed in (Show of the Week page)', { ip });
      return res.json({ signedIn: true, admin: true, passwordSet: !!passwordRecord() });
    }
    deps.noteLoginFail(ip);
    res.status(401).json({ error: 'Incorrect password.' });
  });
  r.post('/logout', (req, res) => {
    if (req.cookies[SESSION_COOKIE]) raw.prepare('DELETE FROM sotw_sessions WHERE token_hash = ?').run(sha256(req.cookies[SESSION_COOKIE]));
    res.clearCookie(SESSION_COOKIE);
    deps.endAdminSession(req, res);
    res.json({ ok: true });
  });

  r.use((req, res, next) => {
    if (!signedIn(req)) return res.status(401).json({ error: 'Please sign in.', authLost: true });
    next();
  });

  r.get('/weeks', (req, res) => res.json(weeksJson()));
  r.get('/weeks/:week/candidates', (req, res) => {
    if (!validWeek(req.params.week)) return res.status(400).json({ error: 'Invalid week.' });
    res.json(candidatesFor(req.params.week));
  });
  // Draws again, keeping anything already recorded, being recorded, or chosen.
  r.post('/weeks/:week/redraw', (req, res) => {
    const week = req.params.week;
    if (!validWeek(week)) return res.status(400).json({ error: 'Invalid week.' });
    ensureWeekRow(week);
    const removed = picksIn(week).filter(p => !p.chosen && ['scheduled', 'missed', 'failed', 'off_schedule'].includes(p.rec_status));
    removed.forEach(deletePick);
    const added = fillWeek(week, 'auto');
    markManual(week);
    runRecordings();
    audit('redraw', 'Show of the Week: re-drew the week of ' + week + (added.length ? ' → ' + added.map(p => '"' + p.title + '"').join(', ') : ' (no other shows available)'), actor(req));
    res.json(weeksJson());
  });
  // Puts a hand-picked show into the week, optionally in place of an existing pick.
  r.post('/weeks/:week/picks', (req, res) => {
    const week = req.params.week;
    if (!validWeek(week)) return res.status(400).json({ error: 'Invalid week.' });
    const b = db.getBooking(String((req.body && req.body.bookingId) || ''));
    const inst = b && isRadioShow(b) ? instancesIn(b, week)[0] : null;
    if (!inst) return res.status(400).json({ error: 'That show isn’t on Studio One’s schedule that week.' });
    const replace = req.body.replacePickId ? getPick(+req.body.replacePickId) : null;
    if (replace && replace.week !== week) return res.status(400).json({ error: 'That pick belongs to another week.' });
    const others = picksIn(week).filter(p => !replace || p.id !== replace.id);
    if (others.some(p => p.booking_id === b.id)) return res.status(400).json({ error: 'That show is already shortlisted this week.' });
    if (others.length >= PICKS_PER_WEEK) return res.status(400).json({ error: 'This week already has ' + PICKS_PER_WEEK + ' shows. Swap one instead.' });
    if (replace) deletePick(replace);
    markManual(week);
    insertPick(week, b, inst, 'manual');
    runRecordings();
    audit('swap', 'Show of the Week: added "' + b.title + '" to the week of ' + week + (replace ? ' in place of "' + replace.title + '"' : ''), actor(req));
    res.json(weeksJson());
  });
  r.delete('/picks/:id', (req, res) => {
    const p = getPick(+req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found.' });
    deletePick(p);
    markManual(p.week);
    audit('remove', 'Show of the Week: removed "' + p.title + '" from the week of ' + p.week, actor(req));
    res.json(weeksJson());
  });
  // Choosing a show un-chooses any other in the same week.
  r.post('/picks/:id/choose', (req, res) => {
    const p = getPick(+req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found.' });
    const on = !(req.body && req.body.chosen === false);
    raw.transaction(() => {
      raw.prepare('UPDATE sotw_picks SET chosen = 0 WHERE week = ?').run(p.week);
      if (on) raw.prepare('UPDATE sotw_picks SET chosen = 1 WHERE id = ?').run(p.id);
    })();
    audit('choose', 'Show of the Week: ' + (on ? 'chose' : 'un-chose') + ' "' + p.title + '" for the week of ' + p.week, actor(req));
    res.json(weeksJson());
  });
  r.get('/picks/:id/audio', (req, res) => {
    const p = getPick(+req.params.id);
    if (!p || p.rec_status !== 'ready' || !fs.existsSync(recFile(p.id))) return res.status(404).json({ error: 'That recording is no longer available.' });
    res.set('Content-Type', 'audio/mpeg');
    res.set('Cache-Control', 'private, no-store');
    res.sendFile(recFile(p.id), { acceptRanges: true, cacheControl: false });
  });
  r.get('/picks/:id/logo', (req, res) => {
    const p = getPick(+req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found.' });
    const logo = logoInfo(p);
    const name = (p.title.replace(/[^a-zA-Z0-9 _-]+/g, '').trim().replace(/\s+/g, '-') || 'show') + '-logo' + path.extname(logo.file);
    res.download(logo.file, name, { headers: { 'Cache-Control': 'private, no-store' } });
  });
  // Only an admin can set the team's password. An empty password removes it.
  r.put('/password', deps.requireAdmin, (req, res) => {
    const pass = String((req.body && req.body.password) || '');
    if (pass && pass.length < 8) return res.status(400).json({ error: 'Use at least 8 characters.' });
    if (pass) {
      const salt = crypto.randomBytes(16).toString('hex');
      db.setStateJson('sotwPassword', { salt, hash: crypto.scryptSync(pass, salt, 64).toString('hex') });
    } else {
      db.setStateJson('sotwPassword', null);
    }
    raw.prepare('DELETE FROM sotw_sessions').run();
    audit('password', pass ? 'Show of the Week password changed; the team was signed out' : 'Show of the Week password removed', 'admin');
    res.json({ passwordSet: !!pass });
  });
  return r;
}

module.exports = {
  router, start, tick, picksForEmail, eraseEmail, recordingStreams,
  targetWeek, mondayOf, midWindow, weekdayOf, fillWeek, weeksJson, REC_DIR
};
