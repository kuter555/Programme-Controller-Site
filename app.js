(function () {
  'use strict';
  var h = React.createElement;

  var PX = 58;            // px per hour on the grid
  var SNAP = 15;          // minute snap
  var DAY_START = 8;      // default first visible hour
  var MAX_LOGOS = 30;
  var IDLE_MS = 300000;
  var POLL_MS = 20000;    // how often to refresh bookings/members from the server
  var DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  var COLORS = ['#0b2f5e', '#2f6fb0', '#3fa7c9', '#5fb894', '#8a7fd1', '#c76fae', '#e0955c', '#7089a8'];
  var BATH_EMAIL_RE = /^[a-z0-9._%+-]+@bath\.ac\.uk$/i;
  var GENERIC_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function api(method, url, body) {
    return fetch(url, {
      method: method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      credentials: 'same-origin',
      body: body ? JSON.stringify(body) : undefined
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || ('Request failed (' + res.status + ')'));
        return data;
      });
    });
  }

  class App extends React.Component {
    constructor(props) {
      super(props);
      var prefersDark = false;
      try { prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches; } catch (e) {}
      this.state = {
        studio: 1, weekStart: null, bookings: [], members: [],
        admin: false, adminError: '',
        modal: null, form: null, formError: '', saving: false,
        registering: false, regName: '', regEmail: '', regError: '', regBusy: false,
        loginPass: '', loginError: '', loginBusy: false,
        dbReady: false, dbError: '',
        dark: prefersDark, egg: false, idle: false, showEarly: false, loadPhase: 'in'
      };
    }

    /* ---------- data layer (talks to our own /api/* on the same server) ---------- */
    dbFetchBookings() { return api('GET', '/api/bookings'); }
    dbFetchMembers() { return api('GET', '/api/members'); }
    dbCheckAdminSession() { return api('GET', '/api/admin/session').then(function (d) { return !!d.admin; }); }
    startPolling() {
      clearInterval(this._pollTimer);
      this._pollTimer = setInterval(function () {
        if (document.hidden) return;
        Promise.all([this.dbFetchBookings(), this.dbFetchMembers()]).then(function (res) {
          this.setState({ bookings: res[0], members: res[1] });
        }.bind(this)).catch(function (e) { console.error('poll failed', e); });
      }.bind(this), POLL_MS);
    }

    /* ---------- lifecycle ---------- */
    componentDidMount() {
      this._mountedAt = Date.now();
      this.setState({ weekStart: this.mondayOf(new Date()) });
      this._activity = this.resetIdle.bind(this);
      ['mousemove', 'mousedown', 'keydown', 'touchstart', 'wheel'].forEach(function (ev) {
        window.addEventListener(ev, this._activity, { passive: true });
      }, this);
      this.resetIdle();
      this.syncTheme();
      this._loadFallback = setTimeout(this.finishLoading.bind(this), 8000);
      try {
        var mq = window.matchMedia('(prefers-color-scheme: dark)');
        this._mqHandler = function (e) { if (!this._manualTheme) this.setState({ dark: e.matches }); }.bind(this);
        if (mq.addEventListener) mq.addEventListener('change', this._mqHandler); else mq.addListener(this._mqHandler);
        this._mq = mq;
      } catch (e) {}
      Promise.all([this.dbFetchBookings(), this.dbFetchMembers(), this.dbCheckAdminSession()])
        .then(function (res) {
          this.setState({ bookings: res[0], members: res[1], admin: res[2], dbReady: true });
          this.finishLoading();
          this.startPolling();
        }.bind(this)).catch(function (e) {
          console.error('Server init failed', e);
          this.setState({ dbError: 'Could not connect to the server. Check your connection and reload.' });
          this.finishLoading();
        }.bind(this));
    }
    componentDidUpdate(prevProps, prevState) {
      if (prevState.dark !== this.state.dark) this.syncTheme();
    }
    syncTheme() { document.documentElement.setAttribute('data-theme', this.state.dark ? 'dark' : 'light'); }
    componentWillUnmount() {
      this.stopEgg();
      if (this._activity) ['mousemove', 'mousedown', 'keydown', 'touchstart', 'wheel'].forEach(function (ev) {
        window.removeEventListener(ev, this._activity);
      });
      clearTimeout(this._idleTimer); clearTimeout(this._loadFallback); clearTimeout(this._loadDone); clearTimeout(this._adminErrTimer); clearInterval(this._pollTimer);
      if (this._mq && this._mqHandler) { if (this._mq.removeEventListener) this._mq.removeEventListener('change', this._mqHandler); else this._mq.removeListener(this._mqHandler); }
    }
    finishLoading() {
      if (this.state.loadPhase !== 'in') return;
      clearTimeout(this._loadFallback);
      var wait = Math.max(0, 900 - (Date.now() - (this._mountedAt || Date.now())));
      setTimeout(function () {
        this.setState({ loadPhase: 'out' });
        this._loadDone = setTimeout(function () { this.setState({ loadPhase: 'done' }); }.bind(this), 550);
      }.bind(this), wait);
    }
    resetIdle() {
      if (this.state.idle) this.setState({ idle: false });
      clearTimeout(this._idleTimer);
      this._idleTimer = setTimeout(function () { this.setState({ idle: true }); }.bind(this), IDLE_MS);
    }
    toggleTheme() { this._manualTheme = true; this.setState(function (s) { return { dark: !s.dark }; }); }
    firstHour() {
      if (this.state.showEarly) return 0;
      var occ = this.weekOccurrences();
      var min = DAY_START * 60;
      occ.forEach(function (day) { day.forEach(function (o) { if (o.startMin < min) min = o.startMin; }); });
      return Math.max(0, Math.floor(min / 60));
    }

    /* ---------- date helpers ---------- */
    mondayOf(d) { var x = new Date(d); x.setHours(0, 0, 0, 0); var wd = (x.getDay() + 6) % 7; x.setDate(x.getDate() - wd); return x; }
    stripTime(d) { var x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
    addDays(d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; }
    fmt(d) { var x = new Date(d); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); }
    parse(s) { var p = s.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }
    weekDates() { var out = []; if (!this.state.weekStart) return out; for (var i = 0; i < 7; i++) out.push(this.addDays(this.state.weekStart, i)); return out; }
    hh(n) { return String(n).padStart(2, '0'); }
    minLabel(m) { if (m >= 1440) return '24:00'; return this.hh(Math.floor(m / 60)) + ':' + this.hh(m % 60); }
    persist(bookings) { this.setState({ bookings: bookings }); }

    /* ---------- occurrences ---------- */
    weekOccurrences() {
      var dates = this.weekDates();
      var res = dates.map(function () { return []; });
      var list = this.state.bookings.filter(function (b) { return b.studio === this.state.studio; }, this);
      dates.forEach(function (d, i) {
        var ds = this.fmt(d);
        var wd = (d.getDay() + 6) % 7;
        list.forEach(function (b) {
          if (b.repeat === 'weekly') {
            var a = this.parse(b.date);
            if (((a.getDay() + 6) % 7) === wd && d >= this.stripTime(a) && (!b.repeatUntil || d <= this.parse(b.repeatUntil)))
              res[i].push({ booking: b, date: ds, startMin: b.startMin, endMin: b.endMin });
          } else if (b.date === ds) {
            res[i].push({ booking: b, date: ds, startMin: b.startMin, endMin: b.endMin });
          }
        }, this);
        res[i].sort(function (a, b) { return a.startMin - b.startMin || a.endMin - b.endMin; });
      }, this);
      return res;
    }
    canEditBooking(b) { return !b.admin || this.state.admin; }
    overlaps(form) {
      var d = this.parse(form.date), ds = form.date, wd = (d.getDay() + 6) % 7;
      var list = this.state.bookings.filter(function (b) { return b.studio === this.state.studio && b.id !== form.id; });
      var same = [];
      list.forEach(function (b) {
        if (b.repeat === 'weekly') {
          var a = this.parse(b.date);
          if (((a.getDay() + 6) % 7) === wd && d >= this.stripTime(a) && (!b.repeatUntil || d <= this.parse(b.repeatUntil))) same.push(b);
        } else if (b.date === ds) same.push(b);
      }, this);
      return same.some(function (b) { return form.startMin < b.endMin && b.startMin < form.endMin; });
    }

    /* ---------- booking modal ---------- */
    gridClick(e, d) {
      var rect = e.currentTarget.getBoundingClientRect();
      var y = e.clientY - rect.top;
      var min = Math.round(((y / PX * 60) + this.firstHour() * 60) / SNAP) * SNAP;
      min = Math.max(0, Math.min(1440 - 30, min));
      var end = Math.min(1440, min + 30);
      this.setState({
        modal: 'booking', formError: '', registering: false,
        form: { id: null, studio: this.state.studio, title: '', memberId: null, name: '', email: '', description: '', admin: this.state.admin, repeat: 'none', repeatRequest: false, color: null, date: this.fmt(d), startMin: min, endMin: end, repeatUntil: null }
      });
    }
    openEdit(o) {
      if (!this.canEditBooking(o.booking)) {
        this.setState({ modal: 'login', loginError: 'Admin sign-in required to edit this booking.', loginPass: '' });
        return;
      }
      var b = o.booking;
      this.setState({
        modal: 'booking', formError: '', registering: false,
        form: { id: b.id, studio: b.studio, title: b.title, memberId: null, name: b.name, email: b.email, description: b.description || '', admin: b.admin, repeat: b.repeat, repeatRequest: !!b.pendingRepeat, color: b.color || null, date: b.date, startMin: b.startMin, endMin: b.endMin, repeatUntil: b.repeatUntil }
      });
    }
    setField(k, v) { this.setState(function (s) { var f = Object.assign({}, s.form); f[k] = v; return { form: f }; }); }
    closeModal() { this.setState({ modal: null, form: null, formError: '', registering: false, saving: false }); }

    selectMember(idStr) {
      var m = this.state.members.filter(function (x) { return String(x.id) === String(idStr); })[0];
      if (!m) return;
      this.setState(function (s) { return { form: Object.assign({}, s.form, { memberId: m.id, name: m.name, email: m.email }) }; });
    }
    clearWho() { this.setState(function (s) { return { form: Object.assign({}, s.form, { memberId: null, name: '', email: '' }) }; }); }
    startRegister() { this.setState({ registering: true, regName: '', regEmail: '', regError: '' }); }
    cancelRegister() { this.setState({ registering: false }); }
    submitRegister() {
      var name = (this.state.regName || '').trim();
      var email = (this.state.regEmail || '').trim().toLowerCase();
      if (!name) return this.setState({ regError: 'Please enter your name.' });
      if (!BATH_EMAIL_RE.test(email)) return this.setState({ regError: 'Please use your @bath.ac.uk email address.' });
      if (this.state.members.some(function (m) { return m.email.toLowerCase() === email; }))
        return this.setState({ regError: 'That email is already registered — select it from the list instead.' });
      this.setState({ regError: '', regBusy: true });
      api('POST', '/api/members', { name: name, email: email }).then(function (m) {
        this.setState(function (s) {
          return { regBusy: false, members: s.members.concat([m]).sort(function (a, b) { return a.name.localeCompare(b.name); }), registering: false, form: Object.assign({}, s.form, { memberId: m.id, name: m.name, email: m.email }) };
        });
      }.bind(this)).catch(function (e) {
        this.setState({ regBusy: false, regError: e.message || 'Could not register — try again.' });
      }.bind(this));
    }

    saveBooking() {
      var f = this.state.form;
      if (!f.title.trim()) return this.setState({ formError: 'Please enter a booking title.' });
      if (!f.name || !f.email || !GENERIC_EMAIL_RE.test(f.email)) return this.setState({ formError: 'Please select who this booking is for.' });
      if (f.endMin <= f.startMin) return this.setState({ formError: 'End time must be after start time.' });
      var dur = f.endMin - f.startMin;
      if (dur < 30) return this.setState({ formError: 'Minimum booking length is 30 minutes.' });
      if (!f.admin && dur > 120) return this.setState({ formError: 'Members can book a maximum of 2 hours. Sign in as admin for longer bookings.' });
      if (f.repeat === 'weekly' && !this.state.admin) return this.setState({ formError: 'Only admins can create repeating bookings.' });
      if (this.overlaps(f)) return this.setState({ formError: 'That time overlaps an existing booking in this studio.' });
      var memberRequest = !this.state.admin && !!f.repeatRequest;
      var rec = { id: f.id || ('b' + Date.now() + Math.floor(Math.random() * 999)), studio: f.studio, title: f.title.trim(), name: f.name.trim(), email: f.email.trim(), description: f.description.trim(), admin: !!f.admin && this.state.admin, repeat: f.repeat, pendingRepeat: memberRequest, color: f.color || null, date: f.date, startMin: f.startMin, endMin: f.endMin, repeatUntil: f.repeatUntil || null };
      this.setState({ saving: true, formError: '' });
      var req = this.state.admin ? api('POST', '/api/admin/bookings', rec) : api('POST', '/api/bookings', rec);
      req.then(function (saved) {
        var list = this.state.bookings.slice();
        var idx = list.findIndex(function (b) { return b.id === saved.id; });
        if (idx >= 0) list[idx] = saved; else list.push(saved);
        this.setState({ saving: false, bookings: list });
        this.closeModal();
      }.bind(this)).catch(function (e) {
        this.setState({ saving: false, formError: 'Could not save: ' + (e.message || 'try again.') });
      }.bind(this));
    }
    deleteBooking() {
      var f = this.state.form; if (!f.id) return this.closeModal();
      var id = f.id;
      this.setState({ saving: true });
      var req = this.state.admin ? api('DELETE', '/api/admin/bookings/' + encodeURIComponent(id)) : api('DELETE', '/api/bookings/' + encodeURIComponent(id));
      req.then(function () {
        this.setState({ saving: false });
        this.persist(this.state.bookings.filter(function (b) { return b.id !== id; }));
        this.closeModal();
      }.bind(this)).catch(function (e) {
        this.setState({ saving: false, formError: 'Could not delete: ' + (e.message || 'try again.') });
      }.bind(this));
    }

    flashAdminError(msg) {
      clearTimeout(this._adminErrTimer);
      this.setState({ adminError: msg });
      this._adminErrTimer = setTimeout(function () { this.setState({ adminError: '' }); }.bind(this), 4000);
    }
    approveRequest(id) {
      var b = this.state.bookings.find(function (x) { return x.id === id; }); if (!b) return;
      var rec = Object.assign({}, b, { repeat: 'weekly', pendingRepeat: false });
      api('POST', '/api/admin/bookings', rec).then(function (saved) {
        this.persist(this.state.bookings.map(function (x) { return x.id === id ? saved : x; }));
      }.bind(this)).catch(function (e) { this.flashAdminError('Could not approve: ' + e.message); }.bind(this));
    }
    denyRequest(id) {
      var b = this.state.bookings.find(function (x) { return x.id === id; }); if (!b) return;
      var rec = Object.assign({}, b, { pendingRepeat: false });
      api('POST', '/api/admin/bookings', rec).then(function (saved) {
        this.persist(this.state.bookings.map(function (x) { return x.id === id ? saved : x; }));
      }.bind(this)).catch(function (e) { this.flashAdminError('Could not update: ' + e.message); }.bind(this));
    }
    removeMember(id) {
      api('DELETE', '/api/admin/members/' + encodeURIComponent(id)).then(function () {
        this.setState(function (s) { return { members: s.members.filter(function (m) { return m.id !== id; }) }; });
      }.bind(this)).catch(function (e) { this.flashAdminError('Could not remove member: ' + e.message); }.bind(this));
    }

    toggleAdmin() {
      if (this.state.admin) { api('POST', '/api/admin/logout').catch(function () {}); this.setState({ admin: false }); }
      else this.setState({ modal: 'login', loginError: '', loginPass: '' });
    }
    attemptLogin() {
      var pass = this.state.loginPass;
      if (!pass) return this.setState({ loginError: 'Enter the admin passphrase.' });
      this.setState({ loginBusy: true, loginError: '' });
      api('POST', '/api/admin/login', { passphrase: pass }).then(function () {
        this.setState({ loginBusy: false, admin: true, modal: null, loginPass: '' });
      }.bind(this)).catch(function (e) {
        this.setState({ loginBusy: false, loginError: e.message || 'Incorrect passphrase.' });
      }.bind(this));
    }

    /* ---------- week nav ---------- */
    prevWeek() { this.setState(function (s) { return { weekStart: this.addDays(s.weekStart, -7) }; }.bind(this)); }
    nextWeek() { this.setState(function (s) { return { weekStart: this.addDays(s.weekStart, 7) }; }.bind(this)); }
    goToday() {
      this.setState({ weekStart: this.mondayOf(new Date()) }, function () {
        if (this._todayEl && this._todayEl.scrollIntoView) this._todayEl.scrollIntoView({ inline: 'start', block: 'nearest', behavior: 'smooth' });
      }.bind(this));
    }
    weekLabelText() {
      var ds = this.weekDates(); if (!ds.length) return '';
      var mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      var a = ds[0], b = ds[6];
      return a.getDate() + ' ' + mo[a.getMonth()] + ' – ' + b.getDate() + ' ' + mo[b.getMonth()] + ' ' + b.getFullYear();
    }
    timeOptions(startAt, endAt) { var out = []; for (var m = startAt; m <= endAt; m += SNAP) out.push(m); return out; }
    contrastColor(hex) {
      var c = hex.replace('#', '');
      var r = parseInt(c.substring(0, 2), 16), g = parseInt(c.substring(2, 4), 16), bl = parseInt(c.substring(4, 6), 16);
      return ((r * 299 + g * 587 + bl * 114) / 1000) >= 150 ? '#0b2f5e' : '#ffffff';
    }
    pendingRequests() { return this.state.bookings.filter(function (b) { return b.pendingRepeat; }); }

    /* ---------- easter egg (unchanged behaviour, ported to refs/classes) ---------- */
    openEgg() { this.setState({ egg: true }); }
    exitEgg() { this.stopEgg(); this.setState({ egg: false }); }
    stopEgg() {
      if (this._raf) cancelAnimationFrame(this._raf);
      this._raf = null; this._bodies = null; this._eggCanvas = null; this._quake = 0;
      if (this._eggResize) { window.removeEventListener('resize', this._eggResize); this._eggResize = null; }
      if (this._eggKey) { window.removeEventListener('keydown', this._eggKey); this._eggKey = null; }
    }
    eggQuake() {
      if (!this._bodies || !this._bodies.length) return;
      this._quake = 26;
      this._bodies.forEach(function (b) { b.vy -= 10 + Math.random() * 14; b.vx += (Math.random() - 0.5) * 22; });
    }
    mountEgg(el) {
      if (!el) return;
      if (this._eggCanvas === el) return;
      this.stopEgg();
      this._eggCanvas = el; this._bodies = [];
      if (!this._digImg) { var img = new Image(); img.src = 'assets/dig-logo.png'; this._digImg = img; }
      var fit = function () {
        var dpr = window.devicePixelRatio || 1;
        var w = el.clientWidth, ht = el.clientHeight;
        el.width = Math.round(w * dpr); el.height = Math.round(ht * dpr);
        var ctx = el.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this._eggW = w; this._eggH = ht;
      }.bind(this);
      fit();
      this._eggResize = fit; window.addEventListener('resize', this._eggResize);
      this._eggKey = function (ev) { if (ev.code === 'Space' || ev.key === ' ') { ev.preventDefault(); this.eggQuake(); } }.bind(this);
      window.addEventListener('keydown', this._eggKey);
      var step = function () {
        if (this._eggCanvas !== el) return;
        this.eggStep(); this.eggDraw();
        this._raf = requestAnimationFrame(step);
      }.bind(this);
      this._raf = requestAnimationFrame(step);
    }
    eggTouchStart(e) { var t = e.touches[0]; if (!t) return; this._touchY = t.clientY; this._touchX = t.clientX; this._swiped = false; }
    eggTouchEnd(e) {
      var t = e.changedTouches && e.changedTouches[0]; if (!t || this._touchY == null) return;
      var el = this._eggCanvas; if (!el) return;
      var rect = el.getBoundingClientRect();
      var fromBase = (this._touchY - rect.top) > rect.height * 0.7;
      var dy = this._touchY - t.clientY;
      if (fromBase && dy > 70) { this._swiped = true; e.preventDefault(); this.eggQuake(); }
      this._touchY = null;
    }
    eggAdd(e) {
      if (this._swiped) { this._swiped = false; return; }
      if (!this._bodies || this._bodies.length >= MAX_LOGOS) return;
      var el = this._eggCanvas; if (!el) return;
      var rect = el.getBoundingClientRect();
      var aspect = (this._digImg && this._digImg.naturalWidth) ? this._digImg.naturalWidth / this._digImg.naturalHeight : 1.4;
      var w = Math.max(90, Math.min(220, this._eggW * 0.16));
      var ht = w / aspect;
      this._bodies.push({ x: e.clientX - rect.left, y: e.clientY - rect.top, w: w, h: ht, vx: (Math.random() - 0.5) * 9, vy: -2 - Math.random() * 3 });
      this.forceUpdate();
    }
    eggStep() {
      var bs = this._bodies; if (!bs) return;
      var W = this._eggW, H = this._eggH, G = 0.85, REST = 0.62;
      bs.forEach(function (b) {
        b.vy += G; b.x += b.vx; b.y += b.vy;
        var hw = b.w / 2, hh = b.h / 2;
        if (b.x - hw < 0) { b.x = hw; b.vx = -b.vx * REST; }
        if (b.x + hw > W) { b.x = W - hw; b.vx = -b.vx * REST; }
        if (b.y - hh < 0) { b.y = hh; b.vy = -b.vy * REST; }
        if (b.y + hh > H) { b.y = H - hh; b.vy = -b.vy * REST; b.vx *= 0.94; if (Math.abs(b.vy) < 1.4) b.vy = 0; }
      });
      for (var i = 0; i < bs.length; i++) {
        for (var j = i + 1; j < bs.length; j++) {
          var a = bs[i], b = bs[j];
          var dx = b.x - a.x, dy = b.y - a.y;
          var ox = (a.w + b.w) / 2 - Math.abs(dx), oy = (a.h + b.h) / 2 - Math.abs(dy);
          if (ox > 0 && oy > 0) {
            if (ox < oy) {
              var s = (dx < 0 ? -1 : 1) * ox / 2; a.x -= s; b.x += s;
              var t = a.vx; a.vx = b.vx * 0.85; b.vx = t * 0.85;
            } else {
              var s2 = (dy < 0 ? -1 : 1) * oy / 2; a.y -= s2; b.y += s2;
              var t2 = a.vy; a.vy = b.vy * 0.85; b.vy = t2 * 0.85;
            }
          }
        }
      }
    }
    eggDraw() {
      var el = this._eggCanvas; if (!el) return;
      var ctx = el.getContext('2d');
      ctx.clearRect(0, 0, this._eggW, this._eggH);
      var img = this._digImg;
      if (!img || !img.complete || !this._bodies) return;
      ctx.save();
      if (this._quake > 0) {
        var amt = this._quake / 26 * 9;
        ctx.translate((Math.random() - 0.5) * amt, (Math.random() - 0.5) * amt);
        this._quake--;
      }
      if (this.state.dark) ctx.filter = 'invert(1)';
      this._bodies.forEach(function (b) { ctx.drawImage(img, b.x - b.w / 2, b.y - b.h / 2, b.w, b.h); });
      ctx.restore();
    }
    renderEgg() {
      if (!this.state.egg) return null;
      var count = this._bodies ? this._bodies.length : 0;
      return h('div', { className: 'urb-egg urb-fade' },
        h('canvas', { ref: this.mountEgg.bind(this), onClick: this.eggAdd.bind(this), onTouchStart: this.eggTouchStart.bind(this), onTouchEnd: this.eggTouchEnd.bind(this) }),
        h('div', { className: 'urb-egg-hint', style: { opacity: count ? 0 : 1, transition: 'opacity .3s' } }, 'Tap anywhere'),
        h('button', { className: 'urb-egg-back', onClick: this.exitEgg.bind(this) }, '← Back')
      );
    }

    /* ---------- small helpers ---------- */
    input(props) { return h('input', Object.assign({ className: 'urb-input' }, props)); }
    labelEl(t) { return h('div', { className: 'urb-label' }, t); }

    /* ---------- who picker (member registry) ---------- */
    renderWho() {
      var f = this.state.form;
      if (this.state.registering) {
        return h('div', { className: 'urb-who-box' },
          h('div', { className: 'urb-field' }, this.labelEl('Your name'), this.input({ value: this.state.regName, autoFocus: true, onChange: function (e) { this.setState({ regName: e.target.value }); }.bind(this) })),
          h('div', { className: 'urb-field' }, this.labelEl('Bath email'), this.input({ type: 'email', placeholder: 'ab1234@bath.ac.uk', value: this.state.regEmail, onChange: function (e) { this.setState({ regEmail: e.target.value }); }.bind(this), onKeyDown: function (e) { if (e.key === 'Enter') this.submitRegister(); }.bind(this) })),
          this.state.regError ? h('div', { className: 'urb-error' }, this.state.regError) : null,
          h('div', { className: 'urb-actions', style: { marginTop: '10px' } },
            h('button', { className: 'btn btn-ghost btn-md btn-wide', onClick: this.cancelRegister.bind(this) }, 'Cancel'),
            h('button', { className: 'btn btn-primary btn-md btn-wide', disabled: this.state.regBusy, onClick: this.submitRegister.bind(this) }, this.state.regBusy ? 'Registering…' : 'Register & select')
          )
        );
      }
      if (f.name && f.email) {
        return h('div', { className: 'urb-who-box' },
          h('div', { className: 'urb-who-selected' },
            h('div', null, h('div', { className: 'urb-who-name' }, f.name), h('div', { className: 'urb-who-email' }, f.email)),
            h('button', { className: 'urb-link-btn', onClick: this.clearWho.bind(this) }, 'Change')
          )
        );
      }
      return h('div', { className: 'urb-who-box' },
        this.labelEl('Who is this booking for? *'),
        h('select', { className: 'urb-select', value: '', onChange: function (e) { this.selectMember(e.target.value); }.bind(this) },
          h('option', { value: '', disabled: true }, 'Select yourself…'),
          this.state.members.map(function (m) { return h('option', { key: m.id, value: m.id }, m.name + ' — ' + m.email); })
        ),
        h('div', { className: 'urb-register-toggle' },
          h('button', { className: 'urb-link-btn', onClick: this.startRegister.bind(this) }, 'Not on the list? Register')
        )
      );
    }

    /* ---------- grid ---------- */
    renderBlock(o) {
      var b = o.booking;
      var top = ((o.startMin - this.firstHour() * 60) / 60) * PX;
      var height = Math.max(18, ((o.endMin - o.startMin) / 60) * PX);
      var locked = b.admin && !this.state.admin;
      var compact = height < 44;
      var custom = !!b.color;
      var cls = 'urb-block ' + (custom ? '' : (b.admin ? 'urb-block-admin' : 'urb-block-member'));
      var style = { top: (top + 1) + 'px', height: (height - 2) + 'px', padding: compact ? '2px 7px' : '5px 8px' };
      if (custom) { style.background = b.color; style.color = this.contrastColor(b.color); style.borderColor = 'rgba(0,0,0,.15)'; }
      var meta = [];
      if (b.repeat === 'weekly') meta.push(h('span', { key: 'r', title: 'Repeats weekly' }, '↻'));
      if (b.pendingRepeat) meta.push(h('span', { key: 'p', title: 'Awaiting admin approval' }, '⏳'));
      if (locked) meta.push(h('span', { key: 'l', title: 'Locked (admin only)' }, '🔒'));
      var children = [
        h('div', { key: 'h', className: 'urb-block-head' },
          h('span', { className: 'urb-block-title' }, b.title),
          meta.length ? h('span', { className: 'urb-block-meta' }, meta) : null
        )
      ];
      if (!compact) {
        children.push(h('div', { key: 't', className: 'urb-block-time' }, this.minLabel(o.startMin) + '–' + this.minLabel(o.endMin)));
        if (height > 60) children.push(h('div', { key: 'n', className: 'urb-block-name' }, b.name));
      }
      return h('div', { key: b.id + o.date, className: cls, style: style, onClick: function (e) { e.stopPropagation(); this.openEdit(o); }.bind(this) }, children);
    }
    renderGrid() {
      var dates = this.weekDates();
      if (!dates.length) return h('div', { style: { padding: '40px', textAlign: 'center', color: 'var(--dim)' } }, 'Loading…');
      var occ = this.weekOccurrences();
      var todayStr = this.fmt(new Date());
      var H0 = this.firstHour();
      var hours = []; for (var i = H0; i < 24; i++) hours.push(i);

      var hdCells = [h('div', { key: 'c', className: 'urb-gutter-cell' })];
      dates.forEach(function (d, i) {
        var isToday = this.fmt(d) === todayStr;
        hdCells.push(h('div', { key: i, ref: isToday ? function (el) { this._todayEl = el; }.bind(this) : null, className: 'urb-day-head' + (isToday ? ' today' : '') },
          h('div', { className: 'urb-day-head-name' }, DAYS[i]),
          h('div', { className: 'urb-day-head-date' }, d.getDate() + '/' + (d.getMonth() + 1))
        ));
      }, this);
      var header = h('div', { className: 'urb-grid-head' }, hdCells);

      var gutter = h('div', { className: 'urb-gutter' },
        hours.map(function (hr) { return h('div', { key: hr, className: 'urb-hour-row', style: { height: PX + 'px' } },
          hr === H0 ? null : h('span', { className: 'urb-hour-label' }, this.hh(hr) + ':00')
        ); }, this)
      );
      var quarterLines = hours.map(function (hr) { return h('div', { key: 'q' + hr, className: 'urb-quarter-line', style: { top: ((hr - H0 + 0.25) * PX) + 'px' } }); });
      var colEls = dates.map(function (d, i) {
        var isToday = this.fmt(d) === todayStr;
        return h('div', { key: i, className: 'urb-day-col' + (isToday ? ' today' : ''), style: { height: ((24 - H0) * PX) + 'px' }, onClick: function (e) { this.gridClick(e, d); }.bind(this) },
          quarterLines,
          occ[i].map(function (o) { return this.renderBlock(o); }, this)
        );
      }, this);
      var body = h('div', { className: 'urb-grid-body' }, [gutter].concat(colEls));

      var early = (H0 > 0 || this.state.showEarly) ? h('button', {
        className: 'urb-early-toggle',
        onClick: function () { this.setState(function (s) { return { showEarly: !s.showEarly }; }); }.bind(this)
      }, this.state.showEarly ? '▲ Hide overnight hours' : '▼ Show earlier hours (00:00–' + this.hh(H0) + ':00)') : null;

      return h('div', null,
        h('div', { className: 'urb-scroll' }, header, body),
        early
      );
    }

    /* ---------- modal ---------- */
    btnClass(kind, wide) {
      var c = 'btn btn-md' + (wide ? ' btn-wide' : '');
      if (kind === 'primary') c += ' btn-primary'; else if (kind === 'danger') c += ' btn-danger'; else c += ' btn-ghost';
      return c;
    }
    renderModal() {
      if (!this.state.modal) return null;

      if (this.state.modal === 'login') {
        return h('div', { className: 'urb-overlay urb-fade', onClick: this.closeModal.bind(this) },
          h('div', { className: 'urb-card urb-pop', onClick: function (e) { e.stopPropagation(); } },
            h('div', { className: 'urb-card-head' }, h('span', null, '🔐'), h('div', { className: 'urb-card-head-title' }, 'Admin sign-in')),
            h('div', { className: 'urb-card-body' },
              h('p', { style: { margin: '0 0 14px', fontSize: '13px', color: 'var(--dim)', fontWeight: 500 } }, 'Admin mode unlocks repeating bookings, locked slots and unlimited length. For the Programme Controller / Station Manager only.'),
              h('div', { className: 'urb-field' }, this.labelEl('Passphrase'),
                this.input({ type: 'password', value: this.state.loginPass, autoFocus: true, onChange: function (e) { this.setState({ loginPass: e.target.value }); }.bind(this), onKeyDown: function (e) { if (e.key === 'Enter') this.attemptLogin(); }.bind(this) })),
              this.state.loginError ? h('div', { className: 'urb-error' }, this.state.loginError) : null,
              h('div', { className: 'urb-actions', style: { marginTop: '18px' } },
                h('button', { className: this.btnClass('ghost', true), onClick: this.closeModal.bind(this) }, 'Cancel'),
                h('button', { className: this.btnClass('primary', true), disabled: this.state.loginBusy, onClick: this.attemptLogin.bind(this) }, this.state.loginBusy ? 'Checking…' : 'Sign in')
              )
            )
          )
        );
      }

      var f = this.state.form;
      var dur = f.endMin - f.startMin;
      var durTxt = dur > 0 ? ((Math.floor(dur / 60) ? Math.floor(dur / 60) + 'h ' : '') + (dur % 60 ? (dur % 60) + 'm' : '')) : '';
      var dObj = this.parse(f.date);
      var dayLabel = DAYS[(dObj.getDay() + 6) % 7] + ' ' + dObj.getDate() + '/' + (dObj.getMonth() + 1) + '/' + dObj.getFullYear();
      var startOpts = this.timeOptions(0, 1440 - SNAP);
      var endOpts = this.timeOptions(SNAP, 1440);
      var canEditThis = !f.id || this.canEditBooking(f);

      return h('div', { className: 'urb-overlay urb-fade', onClick: this.closeModal.bind(this) },
        h('div', { className: 'urb-card urb-pop', onClick: function (e) { e.stopPropagation(); } },
          h('div', { className: 'urb-card-head' },
            h('span', null, f.id ? '✎' : '＋'),
            h('div', { className: 'urb-card-head-title' }, f.id ? 'Edit booking' : 'New booking'),
            h('div', { style: { flex: 1 } }),
            h('div', { style: { fontSize: '12px', fontWeight: 600, color: '#9cceff' } }, 'Studio ' + (f.studio === 1 ? 'One' : 'Two'))
          ),
          h('div', { className: 'urb-card-body' },
            h('div', { style: { fontSize: '13px', fontWeight: 700, color: 'var(--accent)', marginBottom: '12px' } }, '📅 ' + dayLabel),
            h('div', { className: 'urb-field' }, this.labelEl('Title *'), this.input({ value: f.title, placeholder: 'e.g. Afternoon Session', autoFocus: !f.id, onChange: function (e) { this.setField('title', e.target.value); }.bind(this) })),
            h('div', { className: 'urb-field' }, this.labelEl('Booked by *'), this.renderWho()),
            h('div', { style: { display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: '10px', alignItems: 'end', marginBottom: '6px' } },
              h('div', null, this.labelEl('Start'), h('select', { className: 'urb-select', value: f.startMin, onChange: function (e) { var v = +e.target.value; var ne = Math.min(1440, Math.max(v + SNAP, f.endMin)); this.setState(function (s) { return { form: Object.assign({}, s.form, { startMin: v, endMin: ne }) }; }); }.bind(this) }, startOpts.map(function (m) { return h('option', { key: m, value: m }, this.minLabel(m)); }, this))),
              h('div', { style: { paddingBottom: '10px', color: 'var(--faint)', fontWeight: 700 } }, '→'),
              h('div', null, this.labelEl('End'), h('select', { className: 'urb-select', value: f.endMin, onChange: function (e) { this.setField('endMin', +e.target.value); }.bind(this) }, endOpts.filter(function (m) { return m > f.startMin; }).map(function (m) { return h('option', { key: m, value: m }, this.minLabel(m)); }, this)))
            ),
            h('div', { style: { fontSize: '12px', fontWeight: 600, color: dur > 0 ? 'var(--accent)' : 'var(--danger)', marginBottom: '12px' } }, dur > 0 ? ('Duration: ' + durTxt) : 'End must be after start'),
            h('div', { className: 'urb-field' }, this.labelEl('Description'), h('textarea', { className: 'urb-textarea', value: f.description, rows: 2, placeholder: 'Optional notes', onChange: function (e) { this.setField('description', e.target.value); }.bind(this) })),
            h('div', { className: 'urb-field' }, this.labelEl('Colour'),
              h('div', { className: 'urb-colors' },
                COLORS.map(function (c) { return h('button', { key: c, className: 'urb-color-dot' + (f.color === c ? ' selected' : ''), style: { background: c }, onClick: function () { this.setField('color', f.color === c ? null : c); }.bind(this) }); }, this),
                h('span', { style: { fontSize: '11px', color: 'var(--faint)', fontWeight: 600, marginLeft: '4px' } }, f.color ? 'Custom' : 'Default')
              )
            ),
            this.state.admin ? h('label', { className: 'urb-chip' },
              h('input', { type: 'checkbox', checked: f.repeat === 'weekly', onChange: function (e) { this.setField('repeat', e.target.checked ? 'weekly' : 'none'); }.bind(this) }),
              h('div', null, h('div', { style: { fontWeight: 700, fontSize: '13px' } }, 'Repeat weekly ↻'), h('div', { style: { fontSize: '11px', color: 'var(--dim)' } }, 'Recurs every ' + DAYS[(dObj.getDay() + 6) % 7] + ' at this time'))
            ) : h('label', { className: 'urb-chip' },
              h('input', { type: 'checkbox', checked: !!f.repeatRequest, onChange: function (e) { this.setField('repeatRequest', e.target.checked); }.bind(this) }),
              h('div', null, h('div', { style: { fontWeight: 700, fontSize: '13px' } }, 'Request recurring booking ⏳'), h('div', { style: { fontSize: '11px', color: 'var(--dim)' } }, 'Sends a weekly request to the admin for approval — this slot books as one-off until then'))
            ),
            this.state.admin ? h('div', { className: 'urb-field' }, this.labelEl('Marked as admin / locked'),
              h('label', { style: { display: 'flex', alignItems: 'center', gap: '9px', fontSize: '13px', fontWeight: 600 } },
                h('input', { type: 'checkbox', checked: !!f.admin, onChange: function (e) { this.setField('admin', e.target.checked); }.bind(this) }),
                'Only admins can edit or delete this booking')
            ) : null,
            this.state.formError ? h('div', { className: 'urb-error-box' }, this.state.formError) : null,
            h('div', { className: 'urb-actions' },
              f.id ? h('button', { className: this.btnClass('danger'), disabled: this.state.saving, onClick: this.deleteBooking.bind(this) }, 'Delete') : null,
              h('div', { style: { flex: 1 } }),
              h('button', { className: this.btnClass('ghost'), onClick: this.closeModal.bind(this) }, 'Cancel'),
              canEditThis ? h('button', { className: this.btnClass('primary'), disabled: this.state.saving, onClick: this.saveBooking.bind(this) }, this.state.saving ? 'Saving…' : (f.id ? 'Save changes' : 'Create booking')) : null
            )
          )
        )
      );
    }

    renderAdminPanel() {
      if (!this.state.admin) return null;
      var reqs = this.pendingRequests();
      var reqRow = function (b) {
        return h('div', { key: b.id, className: 'urb-req-row' },
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', { className: 'urb-row-title' }, b.title + ' — Studio ' + (b.studio === 1 ? 'One' : 'Two')),
            h('div', { className: 'urb-row-sub' }, b.name + ' · ' + b.email + ' · weekly on ' + DAYS[(this.parse(b.date).getDay() + 6) % 7] + ' ' + this.minLabel(b.startMin) + '–' + this.minLabel(b.endMin))
          ),
          h('button', { className: this.btnClass('primary'), onClick: function () { this.approveRequest(b.id); }.bind(this) }, 'Approve'),
          h('button', { className: this.btnClass('danger'), onClick: function () { this.denyRequest(b.id); }.bind(this) }, 'Deny')
        );
      }.bind(this);
      var memberRow = function (m) {
        return h('div', { key: m.id, className: 'urb-member-row' },
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', { className: 'urb-row-title' }, m.name),
            h('div', { className: 'urb-row-sub' }, m.email)
          ),
          h('button', { className: this.btnClass('danger'), onClick: function () { this.removeMember(m.id); }.bind(this) }, 'Cancel')
        );
      }.bind(this);

      return h('div', { className: 'urb-admin-panel' },
        h('div', { className: 'urb-admin-title' }, 'Admin'),
        this.state.adminError ? h('div', { className: 'urb-error', style: { marginBottom: '10px' } }, this.state.adminError) : null,
        h('div', { className: 'urb-admin-section' },
          h('div', { className: 'urb-row-title', style: { marginBottom: '8px' } }, 'Pending recurring requests'),
          reqs.length ? reqs.map(reqRow) : h('div', { className: 'urb-row-sub' }, 'No pending recurring booking requests.')
        ),
        h('div', { className: 'urb-admin-section' },
          h('div', { className: 'urb-row-title', style: { marginBottom: '8px' } }, 'Registered members (' + this.state.members.length + ')'),
          this.state.members.length ? this.state.members.map(memberRow) : h('div', { className: 'urb-row-sub' }, 'No one has registered yet.')
        )
      );
    }

    /* ---------- top level ---------- */
    render() {
      var studioName = this.state.studio === 1 ? 'Studio One' : 'Studio Two';
      var studioDesc = this.state.studio === 1 ? 'The Radio Studio' : 'The DJ Booth';
      var idleAnim = this.state.idle && this.state.loadPhase === 'done';

      return h('div', { className: 'urb-page' },
        h('div', { className: 'urb-wrap' },

          h('div', { className: 'urb-toprow' },
            h('button', { className: 'btn btn-sm', onClick: this.toggleTheme.bind(this) }, this.state.dark ? '☀ Light' : '☾ Dark')
          ),

          h('div', { className: 'urb-header' },
            h('img', { className: 'urb-logo' + (idleAnim ? ' idle' : ''), src: 'assets/logo.png', alt: 'URB 1449 AM', title: 'URB 1449 AM', onClick: this.openEgg.bind(this) }),
            h('div', null,
              h('div', { className: 'urb-brand-title' }, 'URB Studio Booking'),
              h('div', { className: 'urb-brand-sub' }, 'Live radio & DJ studio reservations')
            ),
            h('div', { className: 'urb-spacer' }),
            h('button', { className: 'btn btn-md' + (this.state.admin ? ' btn-primary' : ''), onClick: this.toggleAdmin.bind(this) }, this.state.admin ? '✓ Admin mode — exit' : '🔓 Admin sign-in')
          ),

          h('div', { className: 'db-banner ' + (this.state.dbError ? 'error' : (!this.state.dbReady ? 'pending' : 'ok')) }, this.state.dbError || 'Connecting to shared calendar…'),

          h('div', { className: 'urb-tabs' },
            h('button', { className: 'urb-tab' + (this.state.studio === 1 ? ' active' : ''), onClick: function () { this.setState({ studio: 1 }); }.bind(this) },
              h('span', { className: 'urb-tab-title' }, 'STUDIO ONE'), h('span', { className: 'urb-tab-sub' }, 'Live Radio')),
            h('button', { className: 'urb-tab' + (this.state.studio === 2 ? ' active' : ''), onClick: function () { this.setState({ studio: 2 }); }.bind(this) },
              h('span', { className: 'urb-tab-title' }, 'STUDIO TWO'), h('span', { className: 'urb-tab-sub' }, 'DJ Studio'))
          ),

          this.renderAdminPanel(),

          h('div', { className: 'urb-shell' },
            h('div', { className: 'urb-toolbar' },
              h('div', { style: { display: 'flex', gap: '6px' } },
                h('button', { className: 'btn btn-icon', onClick: this.prevWeek.bind(this) }, '‹'),
                h('button', { className: 'btn btn-sm', onClick: this.goToday.bind(this) }, 'Today'),
                h('button', { className: 'btn btn-icon', onClick: this.nextWeek.bind(this) }, '›')
              ),
              h('div', { className: 'urb-weeklabel' }, this.weekLabelText()),
              h('div', { className: 'urb-spacer' }),
              h('div', { className: 'urb-legend' },
                h('span', null, h('span', { className: 'urb-swatch swatch-member' }), 'Member'),
                h('span', null, h('span', { className: 'urb-swatch swatch-admin' }), 'Admin / locked')
              )
            ),
            h('div', { className: 'urb-studio-head' },
              h('div', { className: 'urb-studio-name' }, studioName),
              h('div', { className: 'urb-studio-desc' }, studioDesc)
            ),
            this.renderGrid(),
            h('div', { className: 'urb-hint' }, 'Click any empty slot to create a booking · members up to 2 hours' + (this.state.admin ? ' · admin: unlimited length & repeating slots enabled' : ''))
          ),

          h('div', { className: 'urb-footer' }, 'Toby Gilday 2026')
        ),

        this.renderModal(),
        this.renderEgg(),
        this.state.loadPhase === 'done' ? null : h('div', { className: 'urb-loader' + (this.state.loadPhase === 'out' ? ' out' : '') },
          h('img', { src: 'assets/logo.png', alt: '' })
        )
      );
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    var root = ReactDOM.createRoot(document.getElementById('root'));
    root.render(h(App));
  });
})();
