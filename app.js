(function () {
  'use strict';
  var h = React.createElement;

  var PX = 58;            // px per hour on the grid
  var SNAP = 15;          // minute snap
  var DAY_START = 8;      // default first visible hour
  var MAX_LOGOS = 30;
  var CROP_VIEW = 260;    // px size of the square icon-crop viewport
  var IDLE_MS = 300000;
  var POLL_MS = 20000;    // how often to refresh bookings/members from the server
  var DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  var COLORS = [
    '#0b2f5e', '#2f6fb0', '#3fa7c9', '#1f8a70', '#5fb894', '#9ccc3c', '#f2c14e', '#e0955c',
    '#d9534f', '#e84a8a', '#b05cc4', '#5b4bd1', '#7a5230', '#6c7a89', '#222831'
  ];
  // Show types for Studio One/Two; the booking's colour comes from its type.
  // Admins edit the list (Categories page), so it's loaded from the server —
  // App replaces this array whenever a fresh copy arrives.
  var CATEGORIES = [];
  // A type that has since been removed reads as "Other" (the server also moves those bookings there).
  function categoryOf(key) {
    if (!key) return null;
    return CATEGORIES.find(function (c) { return c.key === key; }) || CATEGORIES.find(function (c) { return c.key === 'other'; }) || null;
  }
  var STUDIO_NAMES = { 1: 'Studio One', 2: 'Studio Two', 3: 'Roadshow' };
  var DEFAULT_SETTINGS = {
    djWeeklyCapMin: 120, djMinSlotMin: 30, djMaxSlotMin: 60, radioMaxHours: 2,
    maxAdvanceDays: 0, roadshowMaxDays: 7, normalStartHour: 8, normalEndHour: 24
  };
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
        if (!res.ok) {
          if (data.authLost && api.onAuthLost) api.onAuthLost();
          throw new Error(data.error || ('Request failed (' + res.status + ')'));
        }
        return data;
      });
    });
  }

  // Whole-day index for a YYYY-MM-DD string, used to measure bookings that
  // run past midnight (endMin > 1440 spills into the following days).
  function dayNum(ds) { var p = ds.split('-').map(Number); return Math.round(Date.UTC(p[0], p[1] - 1, p[2]) / 86400000); }
  function absStart(b) { return dayNum(b.date) * 1440 + b.startMin; }
  function absEnd(b) { return dayNum(b.date) * 1440 + b.endMin; }
  function extraDays(b) { return Math.max(0, Math.ceil(b.endMin / 1440) - 1); }

  class App extends React.Component {
    constructor(props) {
      super(props);
      var prefersDark = false;
      try { prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches; } catch (e) {}
      this.state = {
        studio: 1, weekStart: null, bookings: [], members: [], pendingMembers: [], adminMembers: [], categories: [],
        member: null, acct: null, memberFilter: 'all', catDrafts: {}, catMsg: '', newCat: { label: '', color: '#6c7a89', hint: '' },
        settings: Object.assign({}, DEFAULT_SETTINGS), equipment: [],
        admin: false, adminError: '', adminNotice: '', page: 'schedule',
        modal: null, form: null, formError: '', saving: false, canOverride: false,
        registering: false, regName: '', regEmail: '', regError: '', regBusy: false, regSubmitted: false,
        loginPass: '', loginError: '', loginBusy: false, reauth: false,
        crop: null, iconUploading: false, fullWeek: false,
        settingsDraft: null, settingsMsg: '', settingsBusy: false,
        newItemName: '', newItemNotes: '', itemEdit: null, itemMsg: '',
        dbReady: false, dbError: '',
        dark: prefersDark, egg: false, idle: false, showEarly: false, loadPhase: 'in'
      };
      // Any admin request rejected because the session ended lands here: drop
      // admin mode and ask for the passphrase on top of whatever is open, so an
      // unsaved booking form isn't lost.
      api.onAuthLost = function () {
        // Only prompt someone who was actually in admin mode.
        if (!this.state.admin) return;
        this.setState({ admin: false, pendingMembers: [], reauth: true, loginPass: '', loginError: 'Your admin session ended — sign in again, then retry.' });
      }.bind(this);
    }

    /* ---------- data layer (talks to our own /api/* on the same server) ---------- */
    dbFetchBookings() { return api('GET', '/api/bookings'); }
    dbFetchMembers() { return api('GET', '/api/members'); }
    dbFetchPendingMembers() { return api('GET', '/api/admin/members/pending').catch(function () { return []; }); }
    dbCheckAdminSession() { return api('GET', '/api/admin/session').then(function (d) { return !!d.admin; }); }
    dbFetchSettings() { return api('GET', '/api/settings'); }
    dbFetchEquipment() { return api('GET', '/api/equipment'); }
    dbFetchCategories() { return api('GET', '/api/categories'); }
    dbFetchAccount() { return api('GET', '/api/account').then(function (d) { return d.member || null; }).catch(function () { return null; }); }
    setCategories(list) { CATEGORIES = list; this.setState({ categories: list }); }
    // Admin-only lists: pending registrations, plus the full member list with account / media flags.
    refreshPendingMembers() {
      this.dbFetchPendingMembers().then(function (list) { this.setState({ pendingMembers: list }); }.bind(this));
      api('GET', '/api/admin/members').then(function (list) { this.setState({ adminMembers: list }); }.bind(this)).catch(function () {});
    }
    startPolling() {
      clearInterval(this._pollTimer);
      this._pollTimer = setInterval(function () {
        if (document.hidden) return;
        var wasAdmin = this.state.admin;
        Promise.all([this.dbFetchBookings(), this.dbFetchMembers(), this.dbCheckAdminSession(), this.dbFetchSettings(), this.dbFetchEquipment(), this.dbFetchCategories()]).then(function (res) {
          CATEGORIES = res[5];
          var next = { bookings: res[0], members: res[1], settings: res[3], equipment: res[4], categories: res[5] };
          // Keep the on-screen admin state honest if the session ended in the background.
          if (wasAdmin && !res[2] && this.state.admin) {
            next.admin = false; next.pendingMembers = []; next.page = 'schedule';
            next.adminNotice = 'Your admin session ended — sign in again to make changes.';
          }
          this.setState(next);
          if (this.state.admin) this.refreshPendingMembers();
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
      this._onResize = function () { if (this.state.fullWeek) this.forceUpdate(); }.bind(this);
      window.addEventListener('resize', this._onResize);
      // A set-password link from an email lands here as ?setpw=<token>.
      var setpw = null;
      try { setpw = new URLSearchParams(window.location.search).get('setpw'); } catch (e) {}
      if (setpw) {
        try { window.history.replaceState(null, '', window.location.pathname); } catch (e) {}
        this.openSetPassword(setpw);
      }
      // Admin-only lists are fetched afterwards, and only if this browser is signed in as admin.
      Promise.all([this.dbFetchBookings(), this.dbFetchMembers(), this.dbCheckAdminSession(), Promise.resolve([]), this.dbFetchSettings(), this.dbFetchEquipment(), this.dbFetchCategories(), this.dbFetchAccount()])
        .then(function (res) {
          CATEGORIES = res[6];
          this.setState({ bookings: res[0], members: res[1], admin: res[2], pendingMembers: res[3], settings: res[4], equipment: res[5], categories: res[6], member: res[7], dbReady: true });
          if (res[2]) this.refreshPendingMembers();
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
      if (prevState.fullWeek !== this.state.fullWeek) document.body.style.overflow = this.state.fullWeek ? 'hidden' : '';
    }
    syncTheme() { document.documentElement.setAttribute('data-theme', this.state.dark ? 'dark' : 'light'); }
    componentWillUnmount() {
      this.stopEgg();
      if (this._activity) ['mousemove', 'mousedown', 'keydown', 'touchstart', 'wheel'].forEach(function (ev) {
        window.removeEventListener(ev, this._activity);
      });
      clearTimeout(this._idleTimer); clearTimeout(this._loadFallback); clearTimeout(this._loadDone); clearTimeout(this._adminErrTimer); clearInterval(this._pollTimer);
      if (this._onResize) window.removeEventListener('resize', this._onResize);
      if (this._cropUrl) URL.revokeObjectURL(this._cropUrl);
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
    // Does booking b have an instance that *starts* on date string ds?
    startsOn(b, ds) {
      if (b.repeat === 'weekly') {
        return ds >= b.date && (!b.repeatUntil || ds <= b.repeatUntil) && (dayNum(ds) - dayNum(b.date)) % 7 === 0;
      }
      return b.date === ds;
    }
    // The pieces of each booking that fall on day ds, clipped to 00:00–24:00.
    // A booking that runs past midnight shows up on every day it touches.
    segmentsOn(list, ds) {
      var out = [];
      var d = this.parse(ds);
      list.forEach(function (b) {
        for (var k = 0, n = extraDays(b); k <= n; k++) {
          if (!this.startsOn(b, k ? this.fmt(this.addDays(d, -k)) : ds)) continue;
          var s = b.startMin - k * 1440, e = b.endMin - k * 1440;
          if (e <= 0 || s >= 1440) continue;
          out.push({ booking: b, date: ds, startMin: Math.max(0, s), endMin: Math.min(1440, e), contBefore: s < 0, contAfter: e > 1440 });
        }
      }, this);
      out.sort(function (a, b) { return a.startMin - b.startMin || a.endMin - b.endMin; });
      return out;
    }
    weekOccurrences() {
      var list = this.state.bookings.filter(function (b) { return b.studio === this.state.studio && !b.pendingApproval; }, this);
      return this.weekDates().map(function (d) { return this.segmentsOn(list, this.fmt(d)); }, this);
    }
    // Start dates to clash-check for a form: just its date for a one-off, or
    // the coming weeks (from today, up to 26) for a weekly slot or request —
    // otherwise a weekly slot could be put on top of a later one-off booking.
    checkDates(form) {
      if (form.repeat !== 'weekly' && !form.repeatRequest) return [form.date];
      var start = dayNum(form.date), today = dayNum(this.fmt(new Date()));
      var first = start >= today ? start : start + Math.ceil((today - start) / 7) * 7;
      var until = form.repeatUntil ? dayNum(form.repeatUntil) : Infinity;
      var out = [], base = this.parse(form.date);
      for (var w = 0; w < 26; w++) {
        var dn = first + w * 7;
        if (dn > until) break;
        out.push(this.fmt(this.addDays(base, dn - start)));
      }
      return out.length ? out : [form.date];
    }
    // The first existing booking this form would sit on top of, or null.
    findClash(form) {
      var list = this.state.bookings.filter(function (b) { return b.studio === form.studio && b.id !== form.id && !b.pendingApproval; });
      var dates = this.checkDates(form);
      for (var i = 0; i < dates.length; i++) {
        var d = this.parse(dates[i]);
        for (var k = 0, n = extraDays(form); k <= n; k++) {
          var ds = this.fmt(this.addDays(d, k));
          var s = form.startMin - k * 1440, e = Math.min(1440, form.endMin - k * 1440);
          var hit = this.segmentsOn(list, ds).find(function (o) { return s < o.endMin && o.startMin < e; });
          if (hit) return { booking: hit.booking, date: ds };
        }
      }
      return null;
    }
    // Has an edit moved the booking from where it already was?
    slotChanged(f) {
      var o = f.orig;
      return !o || o.date !== f.date || o.startMin !== f.startMin || o.endMin !== f.endMin || o.repeat !== f.repeat;
    }
    memberMode() { return !!this.state.member && !this.state.admin; }
    ownsBooking(b) { var m = this.state.member; return !!(m && b && m.email.toLowerCase() === String(b.email).toLowerCase()); }
    // Roadshow: map of equipment id -> the booking already holding it during the form's range.
    itemConflicts(form) {
      var fs = absStart(form), fe = absEnd(form), out = {};
      this.state.bookings.forEach(function (b) {
        if (b.studio !== 3 || b.id === form.id || b.pendingApproval) return;
        if (fs < absEnd(b) && absStart(b) < fe) (b.items || []).forEach(function (i) { if (!out[i]) out[i] = b; });
      });
      return out;
    }
    itemName(id) { var it = this.state.equipment.find(function (x) { return x.id === id; }); return it ? it.name : 'Removed item'; }
    // "Mon 6/10 14:00 → Wed 8/10 10:00" for multi-day bookings, "14:00–15:00" otherwise.
    rangeLabel(b) {
      if (b.endMin <= 1440) return this.minLabel(b.startMin) + '–' + this.minLabel(b.endMin);
      var s = this.parse(b.date), extra = Math.floor((b.endMin - 1) / 1440), e = this.addDays(s, extra);
      var dl = function (x) { return DAYS[(x.getDay() + 6) % 7] + ' ' + x.getDate() + '/' + (x.getMonth() + 1); };
      return dl(s) + ' ' + this.minLabel(b.startMin) + ' → ' + dl(e) + ' ' + this.minLabel(b.endMin - extra * 1440);
    }

    /* ---------- booking modal ---------- */
    gridClick(e, d) {
      var rect = e.currentTarget.getBoundingClientRect();
      var y = e.clientY - rect.top;
      var hourFromTop = (y / PX) + this.firstHour();
      var startMin, endMin;
      if (this.state.studio === 1) {
        var hr = Math.max(0, Math.min(22, Math.round(hourFromTop)));
        startMin = hr * 60 + 10;
        endMin = Math.min(1440, startMin + 60);
      } else {
        var min = Math.round((hourFromTop * 60) / SNAP) * SNAP;
        min = Math.max(0, Math.min(1440 - 30, min));
        startMin = min; endMin = Math.min(1440, min + 30);
      }
      this.openNew(this.state.studio, d, startMin, endMin, []);
    }
    openNew(studio, d, startMin, endMin, items) {
      // Signed-in members always book as themselves.
      var me = this.memberMode() ? this.state.member : null;
      this.setState({
        modal: 'booking', formError: '', registering: false, canOverride: false,
        form: { id: null, studio: studio, title: '', memberId: null, name: me ? me.name : '', email: me ? me.email : '', description: '', admin: this.state.admin, repeat: 'none', repeatRequest: false, category: null, icon: null, items: items, color: null, date: this.fmt(d), startMin: startMin, endMin: endMin, repeatUntil: null, orig: null }
      });
    }
    // Admins can edit anything; a signed-in member can edit their own bookings
    // exactly as if making them fresh. Everyone else gets the read-only view.
    openEdit(o) {
      var b = o.booking;
      if (!this.state.admin && !this.ownsBooking(b)) {
        this.setState({ modal: 'view', viewBooking: b, formError: '' });
        return;
      }
      var cat = b.category ? (categoryOf(b.category) || {}).key : (b.isPodcast ? 'podcast' : null);
      this.setState({
        modal: 'booking', formError: '', registering: false, canOverride: false,
        form: { id: b.id, studio: b.studio, title: b.title, memberId: null, name: b.name, email: b.email, description: b.description || '', admin: b.admin, repeat: b.repeat, repeatRequest: !!b.pendingRepeat, category: cat || null, icon: b.icon || null, items: (b.items || []).slice(), color: b.color || null, date: b.date, startMin: b.startMin, endMin: b.endMin, repeatUntil: b.repeatUntil, orig: { date: b.date, startMin: b.startMin, endMin: b.endMin, repeat: b.repeat } }
      });
    }
    setField(k, v) { this.setState(function (s) { var f = Object.assign({}, s.form); f[k] = v; return { form: f }; }); }
    closeModal() { this.setState({ modal: null, form: null, formError: '', registering: false, regSubmitted: false, saving: false, viewBooking: null, canOverride: false, crop: null }); }

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
        this.setState({ regBusy: false, registering: false, regSubmitted: true, regName: '', regEmail: '' });
      }.bind(this)).catch(function (e) {
        this.setState({ regBusy: false, regError: e.message || 'Could not register — try again.' });
      }.bind(this));
    }

    djWeeklyUsedMin(email, dateStr, excludeId) {
      var wd = (this.parse(dateStr).getDay() + 6) % 7;
      var weekStart = this.stripTime(this.addDays(this.parse(dateStr), -wd));
      var weekEnd = this.addDays(weekStart, 6);
      var used = 0;
      this.state.bookings.forEach(function (b) {
        if (b.studio !== 2 || b.repeat === 'weekly' || b.pendingApproval || b.id === excludeId) return;
        if (b.email.toLowerCase() !== email.toLowerCase()) return;
        var d = this.parse(b.date);
        if (d < weekStart || d > weekEnd) return;
        used += (b.endMin - b.startMin);
      }, this);
      return used;
    }
    validateForm(f) {
      var s = this.state.settings, admin = this.state.admin;
      if (!f.title.trim()) return 'Please enter a booking title.';
      if (!f.name || !f.email || !GENERIC_EMAIL_RE.test(f.email)) return 'Please select who this booking is for.';
      if (f.endMin <= f.startMin) return 'End time must be after start time.';
      var dur = f.endMin - f.startMin;
      if (f.studio !== 3 && !categoryOf(f.category)) return 'Please choose a show type.';
      // Rules about *when* a booking may be placed only apply if the slot is
      // new or has moved — so fixing a title on an older booking always works.
      var moved = this.slotChanged(f);
      if (moved && f.studio === 1 && f.startMin % 60 !== 10) return 'Radio shows start 10 minutes past the hour.';
      if (!admin && moved) {
        var ahead = dayNum(f.date) - dayNum(this.fmt(new Date()));
        if (ahead < 0) return 'You can’t book a date in the past.';
        if (s.maxAdvanceDays && ahead > s.maxAdvanceDays) return 'Bookings can only be made up to ' + s.maxAdvanceDays + ' days ahead.';
        if (f.studio === 1 && (dur % 60 !== 0 || dur < 60 || dur > s.radioMaxHours * 60 || f.endMin > 1440)) return 'Radio shows run for 1 to ' + s.radioMaxHours + ' hours and finish by midnight.';
        if (f.studio === 2 && (dur < s.djMinSlotMin || dur > s.djMaxSlotMin || f.endMin > 1440)) return 'DJ slots must be between ' + s.djMinSlotMin + ' and ' + s.djMaxSlotMin + ' minutes and finish by midnight.';
        if (f.studio === 3 && dur > s.roadshowMaxDays * 1440) return 'Roadshow bookings can last at most ' + s.roadshowMaxDays + ' days.';
      }
      if (!admin && !f.id && f.repeat === 'weekly') return 'Only admins can create repeating bookings.';
      if (f.studio === 3) {
        if (!f.items.length) return 'Pick at least one piece of equipment.';
        var clashes = this.itemConflicts(f);
        var hit = f.items.filter(function (i) { return clashes[i]; });
        if (hit.length) return hit.map(this.itemName, this).join(', ') + ' is already booked for "' + clashes[hit[0]].title + '" at that time.';
      } else if (moved) {
        var c = this.findClash(f);
        if (c) {
          var cd = this.parse(c.date);
          return 'That overlaps “' + c.booking.title + '” (' + c.booking.name + ') on ' + DAYS[(cd.getDay() + 6) % 7] + ' ' + cd.getDate() + '/' + (cd.getMonth() + 1) + ', ' + this.rangeLabel(c.booking) + '.';
        }
      }
      return null;
    }
    saveBooking(overrideRequest) {
      var f = this.state.form;
      var err = this.validateForm(f);
      if (err) return this.setState({ formError: err, canOverride: false });
      var dur = f.endMin - f.startMin;
      var cap = this.state.settings.djWeeklyCapMin;

      var memberRequest = !this.state.admin && !!f.repeatRequest && f.studio !== 3 && f.repeat !== 'weekly';
      var isAdhocDj = f.studio === 2 && !this.state.admin && !memberRequest && f.repeat !== 'weekly' && this.slotChanged(f);
      var overLimit = false;
      if (isAdhocDj) {
        var used = this.djWeeklyUsedMin(f.email, f.date, f.id);
        overLimit = (used + dur) > cap;
        if (overLimit && !overrideRequest) {
          return this.setState({
            formError: 'That would put you over your ' + (cap / 60) + '-hour weekly DJ limit (' + (used / 60) + 'h already booked this week). You can request an admin override instead.',
            canOverride: true
          });
        }
      }

      var rec = { id: f.id || ('b' + Date.now() + Math.floor(Math.random() * 999)), studio: f.studio, title: f.title.trim(), name: f.name.trim(), email: f.email.trim(), description: f.description.trim(), admin: !!f.admin && this.state.admin, repeat: f.studio === 3 ? 'none' : f.repeat, pendingRepeat: memberRequest, category: f.studio === 3 ? null : f.category, isPodcast: f.studio !== 3 && f.category === 'podcast', icon: f.studio === 3 ? null : (f.icon || null), items: f.studio === 3 ? f.items : [], color: f.studio === 3 ? (f.color || null) : null, date: f.date, startMin: f.startMin, endMin: f.endMin, repeatUntil: f.repeatUntil || null, overrideRequest: overLimit && !!overrideRequest };
      this.setState({ saving: true, formError: '', canOverride: false });
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
      if (!this.state.admin && !window.confirm('Cancel “' + f.title + '”' + (f.repeat === 'weekly' ? ' — every week of this slot' : '') + '? This can’t be undone.')) return;
      this.setState({ saving: true });
      var url = this.state.admin ? '/api/admin/bookings/' : '/api/bookings/';
      api('DELETE', url + encodeURIComponent(id)).then(function () {
        this.setState({ saving: false });
        this.persist(this.state.bookings.filter(function (b) { return b.id !== id; }));
        this.closeModal();
      }.bind(this)).catch(function (e) {
        this.setState({ saving: false, formError: 'Could not delete: ' + (e.message || 'try again.') });
      }.bind(this));
    }
    requestCancel(id) {
      this.setState({ saving: true });
      api('POST', '/api/bookings/' + encodeURIComponent(id) + '/request-cancel').then(function (saved) {
        this.setState(function (s) {
          return { saving: false, viewBooking: saved, bookings: s.bookings.map(function (b) { return b.id === id ? saved : b; }) };
        });
      }.bind(this)).catch(function (e) {
        this.setState({ saving: false, formError: e.message || 'Could not send request.' });
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
    approveCancel(id) {
      api('POST', '/api/admin/bookings/' + encodeURIComponent(id) + '/approve-cancel').then(function () {
        this.persist(this.state.bookings.filter(function (x) { return x.id !== id; }));
      }.bind(this)).catch(function (e) { this.flashAdminError('Could not approve: ' + e.message); }.bind(this));
    }
    denyCancel(id) {
      api('POST', '/api/admin/bookings/' + encodeURIComponent(id) + '/deny-cancel').then(function (saved) {
        this.persist(this.state.bookings.map(function (x) { return x.id === id ? saved : x; }));
      }.bind(this)).catch(function (e) { this.flashAdminError('Could not update: ' + e.message); }.bind(this));
    }
    removeMember(id) {
      api('DELETE', '/api/admin/members/' + encodeURIComponent(id)).then(function () {
        this.setState(function (s) { return { members: s.members.filter(function (m) { return m.id !== id; }), adminMembers: s.adminMembers.filter(function (m) { return m.id !== id; }) }; });
      }.bind(this)).catch(function (e) { this.flashAdminError('Could not remove member: ' + e.message); }.bind(this));
    }
    approveMember(id) {
      api('POST', '/api/admin/members/' + encodeURIComponent(id) + '/approve').then(function (m) {
        this.setState(function (s) {
          return {
            pendingMembers: s.pendingMembers.filter(function (x) { return x.id !== id; }),
            members: s.members.concat([m]).sort(function (a, b) { return a.name.localeCompare(b.name); })
          };
        });
        this.refreshPendingMembers();
      }.bind(this)).catch(function (e) { this.flashAdminError('Could not approve: ' + e.message); }.bind(this));
    }
    denyMember(id) {
      api('DELETE', '/api/admin/members/' + encodeURIComponent(id)).then(function () {
        this.setState(function (s) { return { pendingMembers: s.pendingMembers.filter(function (m) { return m.id !== id; }) }; });
      }.bind(this)).catch(function (e) { this.flashAdminError('Could not deny: ' + e.message); }.bind(this));
    }
    approveOverride(id) {
      api('POST', '/api/admin/bookings/' + encodeURIComponent(id) + '/approve-override').then(function (saved) {
        this.persist(this.state.bookings.map(function (x) { return x.id === id ? saved : x; }));
      }.bind(this)).catch(function (e) { this.flashAdminError('Could not approve: ' + e.message); }.bind(this));
    }
    denyOverride(id) {
      api('POST', '/api/admin/bookings/' + encodeURIComponent(id) + '/deny-override').then(function () {
        this.persist(this.state.bookings.filter(function (x) { return x.id !== id; }));
      }.bind(this)).catch(function (e) { this.flashAdminError('Could not deny: ' + e.message); }.bind(this));
    }

    toggleAdmin() {
      if (this.state.admin) { api('POST', '/api/admin/logout').catch(function () {}); this.setState({ admin: false, pendingMembers: [], page: 'schedule' }); }
      else this.setState({ modal: 'login', loginError: '', loginPass: '', adminNotice: '' });
    }
    attemptLogin() {
      var pass = this.state.loginPass;
      if (!pass) return this.setState({ loginError: 'Enter the admin passphrase.' });
      this.setState({ loginBusy: true, loginError: '' });
      api('POST', '/api/admin/login', { passphrase: pass }).then(function () {
        // A re-auth prompt sits on top of an open form — keep that form open.
        var next = { loginBusy: false, admin: true, loginPass: '', reauth: false, adminNotice: '', formError: '' };
        if (this.state.modal === 'login') next.modal = null;
        this.setState(next);
        this.refreshPendingMembers();
      }.bind(this)).catch(function (e) {
        this.setState({ loginBusy: false, loginError: e.message || 'Incorrect passphrase.' });
      }.bind(this));
    }

    /* ---------- show icon: pick → square crop → upload ---------- */
    pickIcon(file) {
      if (!file) return;
      if (!/^image\//.test(file.type)) return this.setState({ formError: 'Please choose an image file.' });
      if (this._cropUrl) URL.revokeObjectURL(this._cropUrl);
      var url = URL.createObjectURL(file);
      this._cropUrl = url;
      var img = new Image();
      img.onload = function () {
        this._cropImg = img;
        var w = img.naturalWidth, ht = img.naturalHeight, s = CROP_VIEW / Math.min(w, ht);
        this.setState({ formError: '', crop: { src: url, w: w, h: ht, zoom: 1, ox: (CROP_VIEW - w * s) / 2, oy: (CROP_VIEW - ht * s) / 2, png: file.type !== 'image/jpeg' } });
      }.bind(this);
      img.onerror = function () { this.setState({ formError: 'Could not read that image.' }); }.bind(this);
      img.src = url;
    }
    cropScale(c) { return CROP_VIEW / Math.min(c.w, c.h) * c.zoom; }
    clampCrop(c) {
      var s = this.cropScale(c);
      c.ox = Math.min(0, Math.max(CROP_VIEW - c.w * s, c.ox));
      c.oy = Math.min(0, Math.max(CROP_VIEW - c.h * s, c.oy));
      return c;
    }
    setCropZoom(z) {
      this.setState(function (st) {
        var c = Object.assign({}, st.crop), s0 = this.cropScale(c);
        // Zoom around the centre of the square so the subject stays put.
        var cx = (CROP_VIEW / 2 - c.ox) / s0, cy = (CROP_VIEW / 2 - c.oy) / s0;
        c.zoom = Math.max(1, Math.min(5, z));
        var s1 = this.cropScale(c);
        c.ox = CROP_VIEW / 2 - cx * s1; c.oy = CROP_VIEW / 2 - cy * s1;
        return { crop: this.clampCrop(c) };
      }.bind(this));
    }
    cropPointerDown(e) {
      var c = this.state.crop;
      this._drag = { x: e.clientX, y: e.clientY, ox: c.ox, oy: c.oy };
      if (e.currentTarget.setPointerCapture) e.currentTarget.setPointerCapture(e.pointerId);
    }
    cropPointerMove(e) {
      var d = this._drag; if (!d) return;
      var c = Object.assign({}, this.state.crop, { ox: d.ox + e.clientX - d.x, oy: d.oy + e.clientY - d.y });
      this.setState({ crop: this.clampCrop(c) });
    }
    cropPointerUp() { this._drag = null; }
    cancelCrop() { this.setState({ crop: null }); }
    confirmCrop() {
      var c = this.state.crop, img = this._cropImg; if (!c || !img) return;
      var s = this.cropScale(c), OUT = 256;
      var canvas = document.createElement('canvas'); canvas.width = OUT; canvas.height = OUT;
      canvas.getContext('2d').drawImage(img, -c.ox / s, -c.oy / s, CROP_VIEW / s, CROP_VIEW / s, 0, 0, OUT, OUT);
      var dataUrl = c.png ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.9);
      this.setState({ iconUploading: true, crop: null });
      api('POST', '/api/icon', { dataUrl: dataUrl }).then(function (d) {
        this.setState({ iconUploading: false });
        this.setField('icon', d.path);
      }.bind(this)).catch(function (e) {
        this.setState({ iconUploading: false, formError: e.message || 'Could not upload image.' });
      }.bind(this));
    }

    /* ---------- admin pages ---------- */
    openPage(p) {
      var next = { page: p, settingsMsg: '', itemMsg: '', itemEdit: null };
      if (p === 'settings') next.settingsDraft = Object.assign({}, this.state.settings);
      this.setState(next);
    }
    saveSettings() {
      var draft = {}, src = this.state.settingsDraft;
      Object.keys(src).forEach(function (k) { draft[k] = Number(src[k]); });
      this.setState({ settingsBusy: true, settingsMsg: '' });
      api('PUT', '/api/admin/settings', draft).then(function (saved) {
        this.setState({ settingsBusy: false, settings: saved, settingsDraft: Object.assign({}, saved), settingsMsg: 'Saved.' });
      }.bind(this)).catch(function (e) {
        this.setState({ settingsBusy: false, settingsMsg: e.message || 'Could not save.' });
      }.bind(this));
    }
    replaceItem(item) {
      this.setState(function (s) {
        var list = s.equipment.filter(function (x) { return x.id !== item.id; }).concat([item]);
        list.sort(function (a, b) { return a.name.localeCompare(b.name); });
        return { equipment: list };
      });
    }
    addItem() {
      var name = this.state.newItemName.trim();
      if (!name) return this.setState({ itemMsg: 'Please enter an item name.' });
      api('POST', '/api/admin/equipment', { name: name, notes: this.state.newItemNotes.trim() }).then(function (item) {
        this.replaceItem(item);
        this.setState({ newItemName: '', newItemNotes: '', itemMsg: '' });
        if (this._newItemInput) this._newItemInput.focus();
      }.bind(this)).catch(function (e) { this.setState({ itemMsg: e.message }); }.bind(this));
    }
    saveItemEdit() {
      var ed = this.state.itemEdit;
      api('PUT', '/api/admin/equipment/' + ed.id, { name: ed.name, notes: ed.notes }).then(function (item) {
        this.replaceItem(item);
        this.setState({ itemEdit: null, itemMsg: '' });
      }.bind(this)).catch(function (e) { this.setState({ itemMsg: e.message }); }.bind(this));
    }
    toggleItemActive(item) {
      api('PUT', '/api/admin/equipment/' + item.id, { active: !item.active }).then(this.replaceItem.bind(this))
        .catch(function (e) { this.setState({ itemMsg: e.message }); }.bind(this));
    }
    deleteItem(item) {
      if (!window.confirm('Delete "' + item.name + '"? Existing Roadshow bookings will no longer list it. To keep the history, retire it instead.')) return;
      api('DELETE', '/api/admin/equipment/' + item.id).then(function () {
        this.setState(function (s) { return { equipment: s.equipment.filter(function (x) { return x.id !== item.id; }) }; });
      }.bind(this)).catch(function (e) { this.setState({ itemMsg: e.message }); }.bind(this));
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
    pendingCancellations() { return this.state.bookings.filter(function (b) { return b.pendingCancel; }); }
    pendingOverrides() { return this.state.bookings.filter(function (b) { return b.pendingApproval; }); }

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
      if (this.memberMode()) {
        return h('div', { className: 'urb-who-box' },
          h('div', { className: 'urb-who-selected' },
            h('div', null, h('div', { className: 'urb-who-name' }, f.name), h('div', { className: 'urb-who-email' }, f.email)),
            h('span', { className: 'urb-tag' }, 'You')
          )
        );
      }
      if (this.state.regSubmitted) {
        return h('div', { className: 'urb-who-box' },
          h('div', { style: { fontWeight: 700, fontSize: '13.5px', marginBottom: '4px' } }, 'Registration sent'),
          h('div', { className: 'urb-row-sub' }, 'Your registration is awaiting admin approval. Once approved, select yourself from the list to book.'),
          h('div', { className: 'urb-register-toggle' },
            h('button', { className: 'urb-link-btn', onClick: function () { this.setState({ regSubmitted: false }); }.bind(this) }, 'Back to member list')
          )
        );
      }
      if (this.state.registering) {
        return h('div', { className: 'urb-who-box' },
          h('div', { className: 'urb-field' }, this.labelEl('Your name'), this.input({ value: this.state.regName, autoFocus: true, onChange: function (e) { this.setState({ regName: e.target.value }); }.bind(this) })),
          h('div', { className: 'urb-field' }, this.labelEl('Bath email'), this.input({ type: 'email', placeholder: 'ab1234@bath.ac.uk', value: this.state.regEmail, onChange: function (e) { this.setState({ regEmail: e.target.value }); }.bind(this), onKeyDown: function (e) { if (e.key === 'Enter') this.submitRegister(); }.bind(this) })),
          this.state.regError ? h('div', { className: 'urb-error' }, this.state.regError) : null,
          h('div', { className: 'urb-actions', style: { marginTop: '10px' } },
            h('button', { className: 'btn btn-ghost btn-md btn-wide', onClick: this.cancelRegister.bind(this) }, 'Cancel'),
            h('button', { className: 'btn btn-primary btn-md btn-wide', disabled: this.state.regBusy, onClick: this.submitRegister.bind(this) }, this.state.regBusy ? 'Registering…' : 'Register')
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
      var look = this.blockLook(b);
      var style = Object.assign({ top: (top + 1) + 'px', height: (height - 2) + 'px', padding: compact ? '2px 7px' : '5px 8px' }, look.style);
      var meta = [];
      if (b.repeat === 'weekly') meta.push(h('span', { key: 'r', title: 'Weekly slot' }, '↻'));
      if (b.pendingRepeat) meta.push(h('span', { key: 'p', title: 'Awaiting approval' }, '⏳'));
      if (b.pendingCancel) meta.push(h('span', { key: 'x', title: 'Cancellation requested' }, '🚫'));
      if (locked) meta.push(h('span', { key: 'l', title: 'Admin booking' }, '🔒'));
      var children = [
        h('div', { key: 'h', className: 'urb-block-head' },
          b.icon ? h('img', { className: 'urb-block-icon', src: b.icon, alt: '' }) : null,
          h('span', { className: 'urb-block-title' }, (o.contBefore ? '↳ ' : '') + b.title),
          meta.length ? h('span', { className: 'urb-block-meta' }, meta) : null
        )
      ];
      if (!compact) {
        children.push(h('div', { key: 't', className: 'urb-block-time' }, (o.contBefore ? '…' : this.minLabel(o.startMin)) + '–' + (o.contAfter ? '…' : this.minLabel(o.endMin))));
        if (height > 60) children.push(h('div', { key: 'n', className: 'urb-block-name' }, b.name));
      }
      return h('div', { key: b.id + o.date + o.startMin, className: look.cls, style: style, onClick: function (e) { e.stopPropagation(); this.openEdit(o); }.bind(this) }, children);
    }
    blockLook(b) {
      var cat = categoryOf(b.category);
      if (cat) {
        return { cls: 'urb-block', style: { background: cat.color, color: this.contrastColor(cat.color), borderColor: 'rgba(0,0,0,.15)' } };
      }
      // Bookings made before show types existed keep their old look.
      var custom = !!b.color;
      var cls = 'urb-block ' + (custom ? '' : (b.admin ? 'urb-block-admin' : 'urb-block-member')) + (b.isPodcast ? ' urb-block-podcast' : '');
      var style = custom ? { background: b.color, color: this.contrastColor(b.color), borderColor: 'rgba(0,0,0,.15)' } : {};
      return { cls: cls, style: style };
    }
    renderGrid() {
      var dates = this.weekDates();
      if (!dates.length) return h('div', { style: { padding: '40px', textAlign: 'center', color: 'var(--dim)' } }, 'Loading…');
      var occ = this.weekOccurrences();
      var todayStr = this.fmt(new Date());
      var H0 = this.firstHour();
      var hours = []; for (var i = H0; i < 24; i++) hours.push(i);

      var isDj = this.state.studio === 2;

      var hdCells = [h('div', { key: 'c', className: 'urb-gutter-cell' })];
      dates.forEach(function (d, i) {
        var isToday = this.fmt(d) === todayStr;
        hdCells.push(h('div', { key: i, ref: isToday ? function (el) { this._todayEl = el; }.bind(this) : null, className: 'urb-day-head' + (isToday ? ' today' : '') },
          h('div', { className: 'urb-day-head-name' }, DAYS[i]),
          h('div', { className: 'urb-day-head-date' }, d.getDate() + '/' + (d.getMonth() + 1))
        ));
      }, this);
      var header = h('div', { className: 'urb-grid-head' }, hdCells);

      // Studio One shows start ten minutes past the hour, so its sidebar labels
      // and the solid guide line both sit at :10. Studio Two runs on a plain
      // on-the-hour grid, so its labels read :00 and the line sits on the hour
      // to line up exactly with the sidebar; Studio One also gets a faint
      // dotted on-the-hour line so the hour boundary itself is still visible
      // across the grid, not just in the sidebar.
      var gutter = h('div', { className: 'urb-gutter' },
        hours.map(function (hr) {
          return h('div', { key: hr, className: 'urb-hour-row', style: { height: PX + 'px' } },
            isDj
              ? h('span', { className: 'urb-hour-label' }, this.hh(hr) + ':00')
              : h('span', { className: 'urb-hour-label', style: { top: ((10 / 60) * PX - 7) + 'px' } }, this.hh(hr) + ':10')
          );
        }, this)
      );
      var gridLines = isDj
        ? hours.map(function (hr) { return h('div', { key: 'hr' + hr, className: 'urb-tenpast-line', style: { top: ((hr - H0) * PX) + 'px' } }); })
        : hours.map(function (hr) { return h('div', { key: 'ten' + hr, className: 'urb-tenpast-line', style: { top: ((hr - H0 + 10 / 60) * PX) + 'px' } }); });
      var onHourLines = isDj ? null : hours.map(function (hr) { return h('div', { key: 'oh' + hr, className: 'urb-onhour-line', style: { top: ((hr - H0) * PX) + 'px' } }); });
      var colEls = dates.map(function (d, i) {
        var isToday = this.fmt(d) === todayStr;
        return h('div', { key: i, className: 'urb-day-col' + (isToday ? ' today' : ''), style: { height: ((24 - H0) * PX) + 'px' }, onClick: function (e) { this.gridClick(e, d); }.bind(this) },
          onHourLines,
          gridLines,
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

    /* ---------- full-week view: all 7 days on one phone screen, normal hours only ---------- */
    renderFullWeek() {
      if (!this.state.fullWeek) return null;
      var s = this.state.settings;
      var H0 = s.normalStartHour, H1 = s.normalEndHour, nHours = H1 - H0;
      var isDj = this.state.studio === 2;
      // Fit the hours into the screen height, but never squash an hour below
      // what a one-line title needs; past that the body scrolls instead.
      var avail = window.innerHeight - 56 - 34 - 6 - (window.innerWidth < 760 ? 66 : 34); // minus the colour key strip
      var px = Math.max(26, Math.floor(avail / nHours));
      var dates = this.weekDates(), occ = this.weekOccurrences(), todayStr = this.fmt(new Date());
      var hours = []; for (var i = H0; i < H1; i++) hours.push(i);

      var cols = dates.map(function (d, i) {
        var ds = this.fmt(d);
        var blocks = occ[i].map(function (o) {
          var s0 = Math.max(o.startMin, H0 * 60), e0 = Math.min(o.endMin, H1 * 60);
          if (e0 <= s0) return null;
          var b = o.booking, look = this.blockLook(b);
          var top = (s0 - H0 * 60) / 60 * px, height = Math.max(14, (e0 - s0) / 60 * px);
          var style = Object.assign({ top: (top + 1) + 'px', height: (height - 2) + 'px' }, look.style);
          return h('div', { key: b.id + o.startMin, className: look.cls + ' urb-fw-block', style: style, onClick: function () { this.openEdit(o); }.bind(this) },
            height >= 30 && b.icon ? h('img', { className: 'urb-fw-icon', src: b.icon, alt: '' }) : null,
            h('div', { className: 'urb-fw-title', style: { WebkitLineClamp: Math.max(1, Math.floor((height - 4) / 12)) } }, b.title)
          );
        }, this);
        return h('div', { key: i, className: 'urb-fw-col' + (ds === todayStr ? ' today' : ''), style: { height: (nHours * px) + 'px' } },
          hours.map(function (hr) {
            return h('div', { key: hr, className: 'urb-fw-line', style: { top: ((hr - H0 + (isDj ? 0 : 10 / 60)) * px) + 'px' } });
          }),
          blocks
        );
      }, this);

      return h('div', { className: 'urb-fw urb-fade' },
        h('div', { className: 'urb-fw-bar' },
          h('button', { className: 'btn btn-icon', onClick: this.prevWeek.bind(this), 'aria-label': 'Previous week' }, '‹'),
          h('div', { className: 'urb-fw-label' },
            h('div', { className: 'urb-fw-studio' }, STUDIO_NAMES[this.state.studio]),
            h('div', { className: 'urb-fw-week' }, this.weekLabelText())
          ),
          h('button', { className: 'btn btn-icon', onClick: this.nextWeek.bind(this), 'aria-label': 'Next week' }, '›'),
          h('button', { className: 'btn btn-sm', onClick: function () { this.setState({ fullWeek: false }); }.bind(this) }, 'Close')
        ),
        h('div', { className: 'urb-fw-head' },
          h('div', { className: 'urb-fw-gutter' }),
          dates.map(function (d, i) {
            return h('div', { key: i, className: 'urb-fw-day' + (this.fmt(d) === todayStr ? ' today' : '') },
              h('div', null, DAYS[i]), h('div', { className: 'urb-fw-date' }, d.getDate()));
          }, this)
        ),
        h('div', { className: 'urb-fw-body' },
          h('div', { className: 'urb-fw-gutter' },
            hours.map(function (hr) {
              return h('div', { key: hr, className: 'urb-fw-hour', style: { height: px + 'px' } },
                h('span', { style: { top: (isDj ? 0 : (10 / 60) * px) + 'px' } }, String(hr)));
            })
          ),
          cols
        ),
        this.renderCategoryKey(true)
      );
    }

    /* ---------- roadshow: equipment × day matrix ---------- */
    renderRoadshow() {
      var dates = this.weekDates();
      if (!dates.length) return null;
      var todayStr = this.fmt(new Date());
      var weekS = dayNum(this.fmt(dates[0])) * 1440, weekE = weekS + 7 * 1440;
      var list = this.state.bookings.filter(function (b) { return b.studio === 3 && !b.pendingApproval; });
      var inWeek = list.filter(function (b) { return absStart(b) < weekE && weekS < absEnd(b); });
      // Retired items stay visible only while they still have bookings in view.
      var items = this.state.equipment.filter(function (it) {
        return it.active || inWeek.some(function (b) { return (b.items || []).indexOf(it.id) >= 0; });
      });
      if (!items.length) {
        return h('div', { className: 'urb-empty' },
          this.state.admin
            ? h('div', null, 'No equipment yet. ', h('button', { className: 'urb-link-btn', onClick: function () { this.openPage('equipment'); }.bind(this) }, 'Add equipment'), ' to start taking Roadshow bookings.')
            : 'No Roadshow equipment has been set up yet.');
      }
      var head = h('tr', null,
        h('th', { className: 'urb-rs-corner' }, 'Equipment'),
        dates.map(function (d, i) {
          return h('th', { key: i, className: 'urb-rs-day' + (this.fmt(d) === todayStr ? ' today' : '') },
            h('div', { className: 'urb-day-head-name' }, DAYS[i]),
            h('div', { className: 'urb-day-head-date' }, d.getDate() + '/' + (d.getMonth() + 1)));
        }, this));
      var rows = items.map(function (it) {
        var mine = inWeek.filter(function (b) { return (b.items || []).indexOf(it.id) >= 0; });
        return h('tr', { key: it.id, className: it.active ? '' : 'retired' },
          h('th', { className: 'urb-rs-item' },
            h('div', { className: 'urb-rs-item-name' }, it.name),
            it.notes ? h('div', { className: 'urb-rs-item-notes' }, it.notes) : null,
            it.active ? null : h('div', { className: 'urb-rs-item-notes' }, 'Retired')),
          dates.map(function (d, i) {
            var ds = this.fmt(d), dS = dayNum(ds) * 1440, dE = dS + 1440;
            var here = mine.filter(function (b) { return absStart(b) < dE && dS < absEnd(b); });
            return h('td', {
              key: i, className: 'urb-rs-cell' + (ds === todayStr ? ' today' : '') + (it.active ? '' : ' disabled'),
              onClick: it.active ? function () { this.openNew(3, d, 9 * 60, 17 * 60, [it.id]); }.bind(this) : null
            }, here.map(function (b) {
              var bs = absStart(b), be = absEnd(b);
              var from = bs > dS ? this.minLabel(bs - dS) : '…', to = be < dE ? this.minLabel(be - dS) : '…';
              var look = this.blockLook(b);
              return h('div', {
                key: b.id, className: look.cls + ' urb-rs-chip', style: look.style,
                onClick: function (e) { e.stopPropagation(); this.openEdit({ booking: b }); }.bind(this)
              },
                h('div', { className: 'urb-block-title' }, b.title),
                h('div', { className: 'urb-block-time' }, from + '–' + to));
            }, this));
          }, this));
      }, this);
      return h('div', { className: 'urb-scroll urb-rs-scroll' },
        h('table', { className: 'urb-rs' }, h('thead', null, head), h('tbody', null, rows)));
    }

    /* ---------- modal ---------- */
    btnClass(kind, wide) {
      var c = 'btn btn-md' + (wide ? ' btn-wide' : '');
      if (kind === 'primary') c += ' btn-primary'; else if (kind === 'danger') c += ' btn-danger'; else c += ' btn-ghost';
      return c;
    }
    renderLogin(onCancel) {
      return h('div', { className: 'urb-overlay urb-overlay-top urb-fade', onClick: onCancel },
        h('div', { className: 'urb-card urb-pop', onClick: function (e) { e.stopPropagation(); } },
          h('div', { className: 'urb-card-head' }, h('span', null, '🔐'), h('div', { className: 'urb-card-head-title' }, 'Admin sign-in')),
          h('div', { className: 'urb-card-body' },
            h('div', { className: 'urb-field' }, this.labelEl('Passphrase'),
              this.input({ type: 'password', value: this.state.loginPass, autoFocus: true, onChange: function (e) { this.setState({ loginPass: e.target.value }); }.bind(this), onKeyDown: function (e) { if (e.key === 'Enter') this.attemptLogin(); }.bind(this) })),
            this.state.loginError ? h('div', { className: 'urb-error' }, this.state.loginError) : null,
            h('div', { className: 'urb-actions', style: { marginTop: '18px' } },
              h('button', { className: this.btnClass('ghost', true), onClick: onCancel }, 'Cancel'),
              h('button', { className: this.btnClass('primary', true), disabled: this.state.loginBusy, onClick: this.attemptLogin.bind(this) }, this.state.loginBusy ? 'Checking…' : 'Sign in')
            )
          )
        )
      );
    }
    renderReauth() {
      if (!this.state.reauth) return null;
      return this.renderLogin(function () { this.setState({ reauth: false, loginError: '' }); }.bind(this));
    }
    renderModal() {
      if (!this.state.modal) return null;
      if (this.state.modal === 'view') return this.renderViewModal();
      if (this.state.modal === 'login') return this.renderLogin(this.closeModal.bind(this));

      var f = this.state.form;
      var isRoadshow = f.studio === 3;
      var isWeekly = this.state.admin ? f.repeat === 'weekly' : !!f.repeatRequest;

      return h('div', { className: 'urb-overlay urb-fade', onClick: this.closeModal.bind(this) },
        h('div', { className: 'urb-card urb-pop', onClick: function (e) { e.stopPropagation(); } },
          h('div', { className: 'urb-card-head' },
            h('span', null, f.id ? '✎' : '＋'),
            h('div', { className: 'urb-card-head-title' }, f.id ? 'Edit booking' : 'New booking'),
            h('div', { style: { flex: 1 } }),
            h('div', { style: { fontSize: '12px', fontWeight: 600, color: '#9cceff' } }, STUDIO_NAMES[f.studio])
          ),
          h('div', { className: 'urb-card-body' },
            h('div', { className: 'urb-field' }, this.labelEl('Title *'), this.input({ value: f.title, placeholder: isRoadshow ? 'e.g. Freshers Fair stall' : 'e.g. Afternoon Session', autoFocus: !f.id, onChange: function (e) { this.setField('title', e.target.value); }.bind(this) })),
            isRoadshow ? null : this.renderCategoryField(f),
            h('div', { className: 'urb-field' }, this.labelEl('Booked by *'), this.renderWho()),
            this.renderTimeFields(f),
            isRoadshow ? this.renderItemPicker(f) : null,
            isRoadshow ? null : this.renderIconField(f),
            h('div', { className: 'urb-field' }, this.labelEl('Description'), h('textarea', { className: 'urb-textarea', value: f.description, rows: 2, placeholder: isRoadshow ? 'Where is it going? Who is collecting it?' : 'Optional notes', onChange: function (e) { this.setField('description', e.target.value); }.bind(this) })),
            isRoadshow ? h('div', { className: 'urb-field' }, this.labelEl('Colour'),
              h('div', { className: 'urb-colors' },
                COLORS.map(function (c) { return h('button', { key: c, className: 'urb-color-dot' + (f.color === c ? ' selected' : ''), style: { background: c }, title: c, onClick: function () { this.setField('color', f.color === c ? null : c); }.bind(this) }); }, this)
              )
            ) : null,
            isRoadshow ? null : (!this.state.admin && f.repeat === 'weekly') ? h('div', { className: 'urb-field' }, this.labelEl('Booking type'),
              h('div', { className: 'urb-row-sub' }, '↻ Weekly slot — changes apply to every week. Ask an admin to stop it repeating.')
            ) : h('div', { className: 'urb-field' }, this.labelEl('Booking type'),
              h('div', { className: 'urb-radio-row' },
                h('label', { className: 'urb-radio' },
                  h('input', { type: 'radio', name: 'btype', checked: !isWeekly, onChange: function () { this.setBookingType(false); }.bind(this) }), 'One-off booking'),
                h('label', { className: 'urb-radio' },
                  h('input', { type: 'radio', name: 'btype', checked: isWeekly, onChange: function () { this.setBookingType(true); }.bind(this) }), 'Weekly Slot')
              )
            ),
            this.state.formError ? h('div', { className: 'urb-error-box' }, this.state.formError) : null,
            h('div', { className: 'urb-actions' },
              f.id ? h('button', { className: this.btnClass('danger'), disabled: this.state.saving, onClick: this.deleteBooking.bind(this) }, this.state.admin ? 'Delete' : 'Cancel booking') : null,
              h('div', { style: { flex: 1 } }),
              h('button', { className: this.btnClass('ghost'), onClick: this.closeModal.bind(this) }, 'Close'),
              this.state.canOverride ? h('button', { className: this.btnClass('ghost'), disabled: this.state.saving, onClick: function () { this.saveBooking(true); }.bind(this) }, 'Request admin override') : null,
              h('button', { className: this.btnClass('primary'), disabled: this.state.saving, onClick: function () { this.saveBooking(false); }.bind(this) }, this.state.saving ? 'Saving…' : (f.id ? 'Save changes' : 'Create booking'))
            )
          )
        )
      );
    }
    setBookingType(weekly) {
      if (this.state.admin) this.setField('repeat', weekly ? 'weekly' : 'none');
      else this.setField('repeatRequest', weekly);
      this.setState({ canOverride: false, formError: '' });
    }
    dayHeading(f) {
      var dObj = this.parse(f.date);
      var dayLabel = DAYS[(dObj.getDay() + 6) % 7] + ' ' + dObj.getDate() + '/' + (dObj.getMonth() + 1) + '/' + dObj.getFullYear();
      return h('div', { style: { fontSize: '13px', fontWeight: 700, color: 'var(--accent)', marginBottom: '12px' } }, '📅 ' + dayLabel);
    }
    renderTimeFields(f) {
      var s = this.state.settings;
      // Admins have no length limit, and Roadshow bookings naturally span days,
      // so both get start/end date + time pickers instead of a fixed duration.
      if (this.state.admin || f.studio === 3) return this.renderRangeFields(f);
      if (f.studio === 1) {
        var startHour = Math.floor((f.startMin - 10) / 60);
        var durHours = (f.endMin - f.startMin) / 60;
        var hourOpts = []; for (var hh = 0; hh < 23; hh++) hourOpts.push(hh);
        var allDur = []; for (var dh = 1; dh <= s.radioMaxHours; dh++) allDur.push(dh);
        var durOpts = allDur.filter(function (d) { return startHour * 60 + 10 + d * 60 <= 1440; });
        return h('div', null, this.dayHeading(f), h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '12px' } },
          h('div', null, this.labelEl('Start'), h('select', {
            className: 'urb-select', value: startHour, onChange: function (e) {
              var hr = +e.target.value; var ns = hr * 60 + 10;
              var fits = allDur.filter(function (d) { return ns + d * 60 <= 1440; });
              var d = fits.indexOf(durHours) >= 0 ? durHours : fits[fits.length - 1];
              this.setState(function (st) { return { form: Object.assign({}, st.form, { startMin: ns, endMin: ns + d * 60 }) }; });
            }.bind(this)
          }, hourOpts.map(function (hr) { return h('option', { key: hr, value: hr }, this.hh(hr) + ':10'); }, this))),
          h('div', null, this.labelEl('Duration'), h('select', {
            className: 'urb-select', value: durHours, onChange: function (e) { this.setField('endMin', f.startMin + (+e.target.value) * 60); }.bind(this)
          }, durOpts.map(function (d) { return h('option', { key: d, value: d }, d + ' hour' + (d > 1 ? 's' : '')); })))
        ));
      }
      var minDur = s.djMinSlotMin, maxDur = s.djMaxSlotMin;
      var startOpts = this.timeOptions(0, 1440 - SNAP);
      var endOpts = this.timeOptions(f.startMin + SNAP, Math.min(1440, f.startMin + maxDur)).filter(function (m) { return m - f.startMin >= minDur || m === 1440; });
      if (!endOpts.length) endOpts = [Math.min(1440, f.startMin + minDur)];
      var usage = null;
      if (!f.repeatRequest) {
        var used = this.djWeeklyUsedMin(f.email || '', f.date, f.id);
        usage = h('div', { className: 'urb-row-sub', style: { marginBottom: '10px' } }, 'DJ time booked this week: ' + (used / 60) + 'h of your ' + (s.djWeeklyCapMin / 60) + 'h limit (plus a separate weekly slot you can request).');
      }
      return h('div', null,
        this.dayHeading(f),
        usage,
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: '10px', alignItems: 'end', marginBottom: '12px' } },
          h('div', null, this.labelEl('Start'), h('select', {
            className: 'urb-select', value: f.startMin, onChange: function (e) {
              var v = +e.target.value;
              var dur = f.endMin - f.startMin;
              dur = Math.min(Math.max(dur, minDur), maxDur);
              var ne = Math.min(1440, Math.max(v + SNAP, v + dur));
              this.setState(function (s) { return { form: Object.assign({}, s.form, { startMin: v, endMin: ne }) }; });
            }.bind(this)
          }, startOpts.map(function (m) { return h('option', { key: m, value: m }, this.minLabel(m)); }, this))),
          h('div', { style: { paddingBottom: '10px', color: 'var(--faint)', fontWeight: 700 } }, '→'),
          h('div', null, this.labelEl('End'), h('select', { className: 'urb-select', value: f.endMin, onChange: function (e) { this.setField('endMin', +e.target.value); }.bind(this) }, endOpts.filter(function (m) { return m > f.startMin; }).map(function (m) { return h('option', { key: m, value: m }, this.minLabel(m)); }, this)))
        )
      );
    }
    // Start date/time → end date/time. endMin is stored relative to the start
    // date, so anything past 1440 rolls over into the following days.
    renderRangeFields(f) {
      var s = this.state.settings;
      var radio = f.studio === 1;
      var extra = Math.floor((f.endMin - 1) / 1440);
      var endTime = f.endMin - extra * 1440;
      var endDate = this.fmt(this.addDays(this.parse(f.date), extra));
      var maxEndDate = (!this.state.admin && f.studio === 3) ? this.fmt(this.addDays(this.parse(f.date), s.roadshowMaxDays)) : undefined;
      var update = function (patch) { this.setState(function (st) { return { form: Object.assign({}, st.form, patch), formError: '', canOverride: false }; }); }.bind(this);

      var startOpts = [], endOpts = [], m;
      if (radio) {
        for (m = 10; m < 1440; m += 60) startOpts.push(m);
        for (m = 10; m < 1440; m += 60) if (extra > 0 || m > f.startMin) endOpts.push(m);
      } else {
        startOpts = this.timeOptions(0, 1440 - SNAP);
        endOpts = this.timeOptions(SNAP, 1440).filter(function (x) { return extra > 0 || x > f.startMin; });
      }
      if (endOpts.indexOf(endTime) < 0) endOpts.push(endTime);
      endOpts.sort(function (a, b) { return a - b; });

      var dur = f.endMin - f.startMin;
      var days = Math.floor(dur / 1440), rem = dur % 1440;
      var durText = (days ? days + ' day' + (days > 1 ? 's' : '') + ' ' : '') + (rem ? Math.floor(rem / 60) + 'h' + (rem % 60 ? ' ' + (rem % 60) + 'm' : '') : '');

      return h('div', { className: 'urb-field' },
        h('div', { className: 'urb-range' },
          h('div', null, this.labelEl('Start date'), this.input({ type: 'date', value: f.date, onChange: function (e) { if (e.target.value) update({ date: e.target.value }); } })),
          h('div', null, this.labelEl('Start time'), h('select', {
            className: 'urb-select', value: f.startMin, onChange: function (e) {
              var v = +e.target.value; update({ startMin: v, endMin: v + dur });
            }
          }, startOpts.map(function (x) { return h('option', { key: x, value: x }, this.minLabel(x)); }, this))),
          h('div', null, this.labelEl('End date'), this.input({
            type: 'date', value: endDate, min: f.date, max: maxEndDate, onChange: function (e) {
              if (!e.target.value) return;
              var ne = Math.max(0, dayNum(e.target.value) - dayNum(f.date));
              var t = endTime;
              if (ne === 0 && t <= f.startMin) t = Math.min(radio ? f.startMin + 60 : 1440, f.startMin + (radio ? 60 : SNAP));
              update({ endMin: ne * 1440 + t });
            }
          })),
          h('div', null, this.labelEl('End time'), h('select', {
            className: 'urb-select', value: endTime, onChange: function (e) { update({ endMin: extra * 1440 + (+e.target.value) }); }
          }, endOpts.map(function (x) { return h('option', { key: x, value: x }, this.minLabel(x)); }, this)))
        ),
        h('div', { className: 'urb-row-sub', style: { marginTop: '6px' } }, dur > 0 ? 'Length: ' + durText : 'End must be after start.')
      );
    }
    renderCategoryField(f) {
      var cat = categoryOf(f.category);
      return h('div', { className: 'urb-field' }, this.labelEl('Show type *'),
        h('div', { className: 'urb-cat-select' },
          h('span', { className: 'urb-cat-dot', style: { background: cat ? cat.color : 'transparent', borderStyle: cat ? 'solid' : 'dashed' } }),
          h('select', { className: 'urb-select', value: f.category || '', onChange: function (e) { this.setField('category', e.target.value || null); this.setState({ formError: '' }); }.bind(this) },
            h('option', { value: '', disabled: true }, 'Select show type…'),
            CATEGORIES.map(function (c) { return h('option', { key: c.key, value: c.key }, c.label + (c.hint ? ' — ' + c.hint : '')); })
          )
        )
      );
    }
    renderCategoryKey(compact) {
      return h('div', { className: 'urb-key' + (compact ? ' compact' : '') },
        CATEGORIES.map(function (c) {
          return h('span', { key: c.key, className: 'urb-key-item', title: c.hint || c.label },
            h('span', { className: 'urb-key-dot', style: { background: c.color } }), c.label);
        })
      );
    }
    renderItemPicker(f) {
      var conflicts = this.itemConflicts(f);
      var items = this.state.equipment.filter(function (it) { return it.active || f.items.indexOf(it.id) >= 0; });
      var toggle = function (id, on) {
        this.setState(function (st) {
          var list = st.form.items.filter(function (x) { return x !== id; });
          if (on) list.push(id);
          return { form: Object.assign({}, st.form, { items: list }), formError: '' };
        });
      }.bind(this);
      return h('div', { className: 'urb-field' }, this.labelEl('Equipment * (' + f.items.length + ' selected)'),
        items.length ? h('div', { className: 'urb-items' }, items.map(function (it) {
          var clash = conflicts[it.id];
          var on = f.items.indexOf(it.id) >= 0;
          return h('label', { key: it.id, className: 'urb-item' + (clash ? ' busy' : '') + (on ? ' on' : '') },
            h('input', { type: 'checkbox', checked: on, disabled: !!clash && !on, onChange: function (e) { toggle(it.id, e.target.checked); } }),
            h('div', { style: { flex: 1, minWidth: 0 } },
              h('div', { className: 'urb-row-title' }, it.name),
              clash ? h('div', { className: 'urb-item-busy' }, 'In use: ' + clash.title + ' (' + clash.name + ')')
                : (it.notes ? h('div', { className: 'urb-row-sub' }, it.notes) : null)
            )
          );
        })) : h('div', { className: 'urb-row-sub' }, 'No equipment has been added yet.')
      );
    }
    renderIconField(f) {
      return h('div', { className: 'urb-field' }, this.labelEl('Show icon'),
        h('div', { className: 'urb-icon-row' },
          f.icon ? h('img', { src: f.icon, className: 'urb-icon-preview', alt: '' }) : h('div', { className: 'urb-icon-preview urb-icon-preview-empty' }, '♪'),
          h('label', { className: 'btn btn-sm btn-ghost urb-file-btn' },
            this.state.iconUploading ? 'Uploading…' : (f.icon ? 'Change image' : 'Upload image'),
            h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', onChange: function (e) { this.pickIcon(e.target.files[0]); e.target.value = ''; }.bind(this) })
          ),
          f.icon ? h('button', { className: 'urb-link-btn', onClick: function () { this.setField('icon', null); }.bind(this) }, 'Remove') : null
        )
      );
    }
    renderCrop() {
      var c = this.state.crop;
      if (!c) return null;
      var s = this.cropScale(c);
      return h('div', { className: 'urb-overlay urb-overlay-top urb-fade', onClick: this.cancelCrop.bind(this) },
        h('div', { className: 'urb-card urb-pop urb-crop-card', onClick: function (e) { e.stopPropagation(); } },
          h('div', { className: 'urb-card-head' }, h('span', null, '✂'), h('div', { className: 'urb-card-head-title' }, 'Crop icon')),
          h('div', { className: 'urb-card-body' },
            h('div', {
              className: 'urb-crop-view', style: { width: CROP_VIEW + 'px', height: CROP_VIEW + 'px' },
              onPointerDown: this.cropPointerDown.bind(this), onPointerMove: this.cropPointerMove.bind(this),
              onPointerUp: this.cropPointerUp.bind(this), onPointerCancel: this.cropPointerUp.bind(this),
              onWheel: function (e) { this.setCropZoom(c.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)); }.bind(this)
            },
              h('img', { src: c.src, alt: '', draggable: false, style: { width: (c.w * s) + 'px', height: (c.h * s) + 'px', transform: 'translate(' + c.ox + 'px,' + c.oy + 'px)' } })
            ),
            h('div', { className: 'urb-crop-zoom' },
              h('span', null, '−'),
              h('input', { type: 'range', min: 1, max: 5, step: 0.01, value: c.zoom, onChange: function (e) { this.setCropZoom(+e.target.value); }.bind(this) }),
              h('span', null, '+')
            ),
            h('div', { className: 'urb-row-sub', style: { textAlign: 'center', marginBottom: '12px' } }, 'Drag to position · slide to zoom'),
            h('div', { className: 'urb-actions' },
              h('button', { className: this.btnClass('ghost', true), onClick: this.cancelCrop.bind(this) }, 'Cancel'),
              h('button', { className: this.btnClass('primary', true), onClick: this.confirmCrop.bind(this) }, 'Use image')
            )
          )
        )
      );
    }

    renderViewModal() {
      var b = this.state.viewBooking;
      if (!b) return null;
      var dObj = this.parse(b.date);
      var dayLabel = DAYS[(dObj.getDay() + 6) % 7] + ' ' + dObj.getDate() + '/' + (dObj.getMonth() + 1);
      return h('div', { className: 'urb-overlay urb-fade', onClick: this.closeModal.bind(this) },
        h('div', { className: 'urb-card urb-pop', onClick: function (e) { e.stopPropagation(); } },
          h('div', { className: 'urb-card-head' },
            b.icon ? h('img', { src: b.icon, className: 'urb-view-icon', alt: '' }) : h('span', { style: { fontSize: '20px' } }, b.studio === 3 ? '🎒' : (b.isPodcast ? '🎙' : '📻')),
            h('div', { className: 'urb-card-head-title' }, b.title)
          ),
          h('div', { className: 'urb-card-body' },
            h('div', { style: { fontSize: '13px', fontWeight: 700, color: 'var(--accent)', marginBottom: '12px' } }, b.endMin > 1440 ? this.rangeLabel(b) : dayLabel + ' · ' + this.rangeLabel(b)),
            categoryOf(b.category) ? h('div', { className: 'urb-field' }, this.labelEl('Show type'),
              h('span', { className: 'urb-key-item' }, h('span', { className: 'urb-key-dot', style: { background: categoryOf(b.category).color } }), categoryOf(b.category).label)) : null,
            h('div', { className: 'urb-field' }, this.labelEl('Booked by'), h('div', { style: { fontWeight: 700, fontSize: '14px' } }, b.name)),
            b.studio === 3 ? h('div', { className: 'urb-field' }, this.labelEl('Equipment'),
              h('ul', { className: 'urb-item-list' }, (b.items || []).map(function (id) { return h('li', { key: id }, this.itemName(id)); }, this))) : null,
            b.description ? h('div', { className: 'urb-field' }, this.labelEl('Description'), h('div', { style: { fontSize: '13px' } }, b.description)) : null,
            h('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '14px' } },
              b.repeat === 'weekly' ? h('span', { className: 'urb-row-sub' }, '↻ Weekly slot') : null,
              b.admin ? h('span', { className: 'urb-row-sub' }, '🔒 Admin booking') : null
            ),
            this.state.member ? null : h('div', { className: 'urb-hint-box' },
              'Is this your booking? ',
              h('button', { className: 'urb-link-btn', onClick: function () { this.openAccount('login'); }.bind(this) }, 'Log in'),
              ' to change or cancel it yourself.'),
            this.state.formError ? h('div', { className: 'urb-error-box' }, this.state.formError) : null,
            h('div', { className: 'urb-actions' },
              h('button', { className: this.btnClass('ghost', true), onClick: this.closeModal.bind(this) }, 'Close'),
              b.pendingCancel
                ? h('button', { className: this.btnClass('ghost', true), disabled: true }, 'Cancellation requested')
                : h('button', { className: this.btnClass('danger', true), disabled: this.state.saving, onClick: function () { this.requestCancel(b.id); }.bind(this) }, 'Request to cancel')
            )
          )
        )
      );
    }

    renderAdminPanel() {
      if (!this.state.admin) return null;
      var reqs = this.pendingRequests();
      var cancels = this.pendingCancellations();
      var overrides = this.pendingOverrides();
      var pendingMembers = this.state.pendingMembers;
      var reqRow = function (b) {
        return h('div', { key: b.id, className: 'urb-req-row' },
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', { className: 'urb-row-title' }, b.title + ' — ' + STUDIO_NAMES[b.studio]),
            h('div', { className: 'urb-row-sub' }, b.name + ' · weekly on ' + DAYS[(this.parse(b.date).getDay() + 6) % 7] + ' ' + this.minLabel(b.startMin) + '–' + this.minLabel(b.endMin))
          ),
          h('button', { className: this.btnClass('primary'), onClick: function () { this.approveRequest(b.id); }.bind(this) }, 'Approve'),
          h('button', { className: this.btnClass('danger'), onClick: function () { this.denyRequest(b.id); }.bind(this) }, 'Deny')
        );
      }.bind(this);
      var cancelRow = function (b) {
        return h('div', { key: b.id, className: 'urb-req-row' },
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', { className: 'urb-row-title' }, b.title + ' — ' + STUDIO_NAMES[b.studio]),
            h('div', { className: 'urb-row-sub' }, b.name + ' · ' + b.date + ' ' + this.rangeLabel(b))
          ),
          h('button', { className: this.btnClass('primary'), onClick: function () { this.approveCancel(b.id); }.bind(this) }, 'Cancel it'),
          h('button', { className: this.btnClass('danger'), onClick: function () { this.denyCancel(b.id); }.bind(this) }, 'Keep it')
        );
      }.bind(this);
      var overrideRow = function (b) {
        return h('div', { key: b.id, className: 'urb-req-row' },
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', { className: 'urb-row-title' }, b.title + ' — ' + STUDIO_NAMES[b.studio]),
            h('div', { className: 'urb-row-sub' }, b.name + ' · ' + b.date + ' ' + this.rangeLabel(b) + ' · over weekly DJ limit')
          ),
          h('button', { className: this.btnClass('primary'), onClick: function () { this.approveOverride(b.id); }.bind(this) }, 'Approve'),
          h('button', { className: this.btnClass('danger'), onClick: function () { this.denyOverride(b.id); }.bind(this) }, 'Deny')
        );
      }.bind(this);
      var pendingMemberRow = function (m) {
        return h('div', { key: m.id, className: 'urb-member-row' },
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', { className: 'urb-row-title' }, m.name),
            h('div', { className: 'urb-row-sub' }, m.email)
          ),
          h('button', { className: this.btnClass('primary'), onClick: function () { this.approveMember(m.id); }.bind(this) }, 'Approve'),
          h('button', { className: this.btnClass('danger'), onClick: function () { this.denyMember(m.id); }.bind(this) }, 'Deny')
        );
      }.bind(this);
      // Sections with something waiting get the full treatment; empty ones
      // collapse into one compact "nothing pending" strip.
      var sections = [
        ['Pending member registrations', 'Member registrations', pendingMembers, pendingMemberRow],
        ['Pending weekly requests', 'Weekly requests', reqs, reqRow],
        ['Pending DJ limit overrides', 'DJ limit overrides', overrides, overrideRow],
        ['Pending cancellations', 'Cancellations', cancels, cancelRow]
      ];
      var full = sections.filter(function (sec) { return sec[2].length; });
      var empty = sections.filter(function (sec) { return !sec[2].length; });

      return h('div', { className: 'urb-admin-panel' },
        h('div', { className: 'urb-admin-title' }, 'Admin'),
        this.state.adminError ? h('div', { className: 'urb-error', style: { marginBottom: '10px' } }, this.state.adminError) : null,
        full.map(function (sec) {
          return h('div', { key: sec[0], className: 'urb-admin-section' },
            h('div', { className: 'urb-row-title', style: { marginBottom: '8px' } }, sec[0] + ' (' + sec[2].length + ')'),
            sec[2].map(sec[3])
          );
        }),
        empty.length ? h('div', { className: 'urb-admin-empty' + (full.length ? '' : ' alone') },
          h('span', { className: 'urb-admin-empty-label' }, full.length ? 'Nothing pending:' : '✓ Nothing pending'),
          full.length ? empty.map(function (sec) { return h('span', { key: sec[0], className: 'urb-tag' }, sec[1]); }) : null
        ) : null
      );
    }
    setMediaMember(m, value) {
      this.setState(function (s) { return { adminMembers: s.adminMembers.map(function (x) { return x.id === m.id ? Object.assign({}, x, { mediaMember: value }) : x; }) }; });
      api('PUT', '/api/admin/members/' + m.id + '/media', { mediaMember: value }).then(function (saved) {
        this.setState(function (s) { return { adminMembers: s.adminMembers.map(function (x) { return x.id === saved.id ? saved : x; }) }; });
      }.bind(this)).catch(function (e) {
        this.flashAdminError('Could not update ' + m.name + ': ' + e.message);
        this.refreshPendingMembers();
      }.bind(this));
    }
    renderMembersPage() {
      var all = this.state.adminMembers;
      var media = all.filter(function (m) { return m.mediaMember; }).length;
      var accounts = all.filter(function (m) { return m.hasAccount; }).length;
      var filter = this.state.memberFilter;
      var shown = all.filter(function (m) { return filter === 'all' || (filter === 'media' ? m.mediaMember : !m.mediaMember); });
      var chip = function (key, label) {
        return h('button', { key: key, className: 'btn btn-sm' + (filter === key ? ' btn-primary' : ''), onClick: function () { this.setState({ memberFilter: key }); }.bind(this) }, label);
      }.bind(this);
      var memberRow = function (m) {
        return h('div', { key: m.id, className: 'urb-member-row' + (m.mediaMember ? ' media' : '') },
          h('div', { style: { flex: '1 1 160px', minWidth: 0 } },
            h('div', { className: 'urb-row-title' }, m.name,
              m.mediaMember ? h('span', { className: 'urb-tag urb-tag-media' }, 'Media member') : null,
              m.hasAccount ? h('span', { className: 'urb-tag', title: 'Has set a password and can edit their own bookings' }, 'Account') : null),
            h('div', { className: 'urb-row-sub urb-break' }, m.email)
          ),
          h('label', { className: 'urb-switch', title: 'Media membership' },
            h('input', { type: 'checkbox', checked: m.mediaMember, onChange: function (e) { this.setMediaMember(m, e.target.checked); }.bind(this) }),
            h('span', { className: 'urb-switch-track' }),
            h('span', { className: 'urb-switch-label' }, 'Media membership')
          ),
          h('button', { className: this.btnClass('danger'), onClick: function () {
            if (window.confirm('Remove ' + m.name + '? Their bookings stay, but they will have to register again to book.')) this.removeMember(m.id);
          }.bind(this) }, 'Remove')
        );
      }.bind(this);
      return h('div', { className: 'urb-admin-panel urb-page-panel' },
        h('div', { className: 'urb-admin-title' }, 'Registered members'),
        h('div', { className: 'urb-stat-row' },
          h('div', { className: 'urb-stat' }, h('b', null, all.length), ' members'),
          h('div', { className: 'urb-stat urb-stat-media' }, h('b', null, media), ' with media membership'),
          h('div', { className: 'urb-stat' }, h('b', null, accounts), ' have an account')
        ),
        h('div', { className: 'urb-row-sub' }, 'New registrations wait under Admin on the Schedule tab until you approve them. “Account” means they have set a password and can edit their own bookings.'),
        this.state.adminError ? h('div', { className: 'urb-error' }, this.state.adminError) : null,
        h('div', { className: 'urb-admin-nav', style: { marginTop: '12px' } }, chip('all', 'All'), chip('media', 'Media members'), chip('nonmedia', 'No media membership')),
        h('div', { className: 'urb-admin-section' },
          shown.length ? shown.map(memberRow) : h('div', { className: 'urb-row-sub' }, all.length ? 'No one matches this filter.' : 'No one has registered yet.')
        )
      );
    }

    /* ---------- show categories (admin) ---------- */
    catDraft(c) { return this.state.catDrafts[c.key] || c; }
    setCatDraft(c, k, v) {
      this.setState(function (s) {
        var d = Object.assign({}, s.catDrafts); d[c.key] = Object.assign({}, d[c.key] || c); d[c.key][k] = v;
        return { catDrafts: d, catMsg: '' };
      });
    }
    saveCategory(c) {
      var d = this.catDraft(c);
      api('PUT', '/api/admin/categories/' + encodeURIComponent(c.key), { label: d.label, color: d.color, hint: d.hint }).then(function (saved) {
        var drafts = Object.assign({}, this.state.catDrafts); delete drafts[c.key];
        this.setState({ catDrafts: drafts });
        this.setCategories(this.state.categories.map(function (x) { return x.key === saved.key ? saved : x; }));
      }.bind(this)).catch(function (e) { this.setState({ catMsg: e.message }); }.bind(this));
    }
    moveCategory(c, dir) {
      api('POST', '/api/admin/categories/' + encodeURIComponent(c.key) + '/move', { dir: dir }).then(this.setCategories.bind(this))
        .catch(function (e) { this.setState({ catMsg: e.message }); }.bind(this));
    }
    deleteCategory(c) {
      var used = this.state.bookings.filter(function (b) { return b.category === c.key; }).length;
      if (!window.confirm('Remove “' + c.label + '”?' + (used ? ' ' + used + ' booking' + (used > 1 ? 's' : '') + ' will become “Other”.' : ''))) return;
      api('DELETE', '/api/admin/categories/' + encodeURIComponent(c.key)).then(function () {
        this.setCategories(this.state.categories.filter(function (x) { return x.key !== c.key; }));
        this.setState(function (s) { return { bookings: s.bookings.map(function (b) { return b.category === c.key ? Object.assign({}, b, { category: 'other', isPodcast: false }) : b; }) }; });
      }.bind(this)).catch(function (e) { this.setState({ catMsg: e.message }); }.bind(this));
    }
    addCategory() {
      var n = this.state.newCat;
      if (!n.label.trim()) return this.setState({ catMsg: 'Give the new show type a name.' });
      api('POST', '/api/admin/categories', n).then(function (c) {
        this.setCategories(this.state.categories.concat([c]));
        this.setState({ newCat: { label: '', color: '#6c7a89', hint: '' }, catMsg: '' });
      }.bind(this)).catch(function (e) { this.setState({ catMsg: e.message }); }.bind(this));
    }
    renderCategoriesPage() {
      var list = this.state.categories;
      var rows = list.map(function (c, i) {
        var d = this.catDraft(c);
        var dirty = d.label !== c.label || d.color !== c.color || (d.hint || '') !== (c.hint || '');
        var used = this.state.bookings.filter(function (b) { return b.category === c.key; }).length;
        return h('div', { key: c.key, className: 'urb-cat-row' },
          h('input', { type: 'color', className: 'urb-color-input', value: d.color, title: 'Colour', onChange: function (e) { this.setCatDraft(c, 'color', e.target.value); }.bind(this) }),
          h('div', { className: 'urb-cat-fields' },
            this.input({ value: d.label, placeholder: 'Name', onChange: function (e) { this.setCatDraft(c, 'label', e.target.value); }.bind(this) }),
            this.input({ value: d.hint || '', placeholder: 'Hint shown in the dropdown (optional)', onChange: function (e) { this.setCatDraft(c, 'hint', e.target.value); }.bind(this) }),
            h('div', { className: 'urb-row-sub' }, used + ' booking' + (used === 1 ? '' : 's') + (c.key === 'other' ? ' · removed types fall back to this one' : ''))
          ),
          h('div', { className: 'urb-cat-actions' },
            h('button', { className: 'btn btn-icon', disabled: i === 0, title: 'Move up', onClick: function () { this.moveCategory(c, -1); }.bind(this) }, '↑'),
            h('button', { className: 'btn btn-icon', disabled: i === list.length - 1, title: 'Move down', onClick: function () { this.moveCategory(c, 1); }.bind(this) }, '↓'),
            dirty ? h('button', { className: this.btnClass('primary'), onClick: function () { this.saveCategory(c); }.bind(this) }, 'Save') : null,
            c.key === 'other' ? null : h('button', { className: this.btnClass('danger'), onClick: function () { this.deleteCategory(c); }.bind(this) }, 'Remove')
          )
        );
      }, this);
      var n = this.state.newCat;
      var setNew = function (k, v) { this.setState(function (s) { var x = Object.assign({}, s.newCat); x[k] = v; return { newCat: x, catMsg: '' }; }); }.bind(this);
      return h('div', { className: 'urb-admin-panel urb-page-panel' },
        h('div', { className: 'urb-admin-title' }, 'Show types & colours'),
        h('div', { className: 'urb-row-sub' }, 'These appear in the booking dropdown and the colour key, in this order. Removing one moves its bookings to “Other”.'),
        this.state.catMsg ? h('div', { className: 'urb-error' }, this.state.catMsg) : null,
        h('div', { className: 'urb-admin-section' }, rows),
        h('div', { className: 'urb-admin-section' },
          h('div', { className: 'urb-row-title', style: { marginBottom: '8px' } }, 'Add a show type'),
          h('div', { className: 'urb-cat-row' },
            h('input', { type: 'color', className: 'urb-color-input', value: n.color, onChange: function (e) { setNew('color', e.target.value); } }),
            h('div', { className: 'urb-cat-fields' },
              this.input({ value: n.label, placeholder: 'Name, e.g. Comedy', onChange: function (e) { setNew('label', e.target.value); }, onKeyDown: function (e) { if (e.key === 'Enter') this.addCategory(); }.bind(this) }),
              this.input({ value: n.hint, placeholder: 'Hint (optional)', onChange: function (e) { setNew('hint', e.target.value); } })
            ),
            h('div', { className: 'urb-cat-actions' }, h('button', { className: this.btnClass('primary'), onClick: this.addCategory.bind(this) }, 'Add'))
          )
        )
      );
    }

    /* ---------- member accounts ---------- */
    // acct.mode: 'login' | 'link' (create account / forgot password) | 'sent' | 'setpw' | 'me'
    openAccount(mode) {
      var email = (this.state.acct && this.state.acct.email) || '';
      this.setState({ modal: null, viewBooking: null, acct: { mode: mode, email: email, password: '', password2: '', busy: false, error: '', message: '' } });
    }
    acctSet(patch) { this.setState(function (s) { return { acct: Object.assign({}, s.acct, patch) }; }); }
    closeAccount() { this.setState({ acct: null }); }
    memberLogin() {
      var a = this.state.acct;
      if (!a.email.trim() || !a.password) return this.acctSet({ error: 'Enter your email and password.' });
      this.acctSet({ busy: true, error: '' });
      api('POST', '/api/account/login', { email: a.email.trim(), password: a.password }).then(function (d) {
        this.setState({ member: d.member, acct: null });
      }.bind(this)).catch(function (e) { this.acctSet({ busy: false, error: e.message }); }.bind(this));
    }
    requestLink() {
      var a = this.state.acct;
      if (!GENERIC_EMAIL_RE.test(a.email.trim())) return this.acctSet({ error: 'Enter the email you registered with.' });
      this.acctSet({ busy: true, error: '' });
      api('POST', '/api/account/request-link', { email: a.email.trim() }).then(function (d) {
        this.acctSet({ busy: false, mode: 'sent', message: d.message });
      }.bind(this)).catch(function (e) { this.acctSet({ busy: false, error: e.message }); }.bind(this));
    }
    openSetPassword(token) {
      this.setState({ acct: { mode: 'setpw', token: token, password: '', password2: '', busy: true, error: '', message: '', info: null } });
      api('GET', '/api/account/link/' + encodeURIComponent(token)).then(function (info) {
        this.acctSet({ busy: false, info: info });
      }.bind(this)).catch(function (e) { this.acctSet({ busy: false, mode: 'link', error: e.message, email: '' }); }.bind(this));
    }
    submitSetPassword() {
      var a = this.state.acct;
      if (a.password.length < 8) return this.acctSet({ error: 'Use at least 8 characters.' });
      if (a.password !== a.password2) return this.acctSet({ error: 'The two passwords don’t match.' });
      this.acctSet({ busy: true, error: '' });
      api('POST', '/api/account/set-password', { token: a.token, password: a.password }).then(function (d) {
        this.setState({ member: d.member, acct: { mode: 'me', welcome: true, email: d.member.email, busy: false, error: '', message: '' } });
      }.bind(this)).catch(function (e) { this.acctSet({ busy: false, error: e.message }); }.bind(this));
    }
    memberLogout() {
      api('POST', '/api/account/logout').catch(function () {});
      this.setState({ member: null, acct: null });
    }
    renderAccount() {
      var a = this.state.acct;
      if (!a) return null;
      var set = this.acctSet.bind(this);
      var close = this.closeAccount.bind(this);
      var emailInput = function (onEnter) {
        return h('div', { className: 'urb-field' }, this.labelEl('Email'),
          this.input({ type: 'email', autoComplete: 'username', autoFocus: true, value: a.email, placeholder: 'ab1234@bath.ac.uk', onChange: function (e) { set({ email: e.target.value, error: '' }); }, onKeyDown: function (e) { if (e.key === 'Enter') onEnter(); } }));
      }.bind(this);
      var title, body;
      if (a.mode === 'login') {
        title = 'Member login';
        body = [
          h('div', { key: 'i', className: 'urb-row-sub', style: { marginBottom: '12px' } }, 'Log in to change or cancel your own bookings. You don’t need an account to book.'),
          h('div', { key: 'e' }, emailInput(this.memberLogin.bind(this))),
          h('div', { key: 'p', className: 'urb-field' }, this.labelEl('Password'),
            this.input({ type: 'password', autoComplete: 'current-password', value: a.password, onChange: function (e) { set({ password: e.target.value, error: '' }); }, onKeyDown: function (e) { if (e.key === 'Enter') this.memberLogin(); }.bind(this) })),
          a.error ? h('div', { key: 'x', className: 'urb-error-box' }, a.error) : null,
          h('div', { key: 'a', className: 'urb-actions' },
            h('button', { className: this.btnClass('ghost', true), onClick: close }, 'Cancel'),
            h('button', { className: this.btnClass('primary', true), disabled: a.busy, onClick: this.memberLogin.bind(this) }, a.busy ? 'Logging in…' : 'Log in')),
          h('div', { key: 'l', className: 'urb-acct-links' },
            h('button', { className: 'urb-link-btn', onClick: function () { set({ mode: 'link', error: '', fresh: true }); } }, 'First time? Create your account'),
            h('button', { className: 'urb-link-btn', onClick: function () { set({ mode: 'link', error: '', fresh: false }); } }, 'Forgot password?'))
        ];
      } else if (a.mode === 'link') {
        title = a.fresh === false ? 'Reset your password' : 'Create your account';
        body = [
          h('div', { key: 'i', className: 'urb-row-sub', style: { marginBottom: '12px' } },
            a.fresh === false ? 'Enter your email and we’ll send you a link to choose a new password.'
              : 'Already registered to book? Enter the same email and we’ll send a link to it so you can choose a password. No need to register again.'),
          h('div', { key: 'e' }, emailInput(this.requestLink.bind(this))),
          a.error ? h('div', { key: 'x', className: 'urb-error-box' }, a.error) : null,
          h('div', { key: 'a', className: 'urb-actions' },
            h('button', { className: this.btnClass('ghost', true), onClick: function () { set({ mode: 'login', error: '' }); } }, 'Back'),
            h('button', { className: this.btnClass('primary', true), disabled: a.busy, onClick: this.requestLink.bind(this) }, a.busy ? 'Sending…' : 'Email me a link'))
        ];
      } else if (a.mode === 'sent') {
        title = 'Check your email';
        body = [
          h('div', { key: 'i', style: { fontSize: '14px', lineHeight: 1.45, marginBottom: '14px' } }, a.message),
          h('div', { key: 'a', className: 'urb-actions' }, h('button', { className: this.btnClass('primary', true), onClick: close }, 'OK'))
        ];
      } else if (a.mode === 'setpw') {
        title = a.info && a.info.hasAccount ? 'Choose a new password' : 'Set up your account';
        body = a.busy && !a.info ? [h('div', { key: 'l', className: 'urb-row-sub' }, 'Checking your link…')] : [
          a.info ? h('div', { key: 'w', className: 'urb-row-sub', style: { marginBottom: '12px' } }, 'Hi ' + a.info.name + ' — choose a password for ' + a.info.email + '.') : null,
          h('div', { key: 'p', className: 'urb-field' }, this.labelEl('New password (8+ characters)'),
            this.input({ type: 'password', autoComplete: 'new-password', autoFocus: true, value: a.password, onChange: function (e) { set({ password: e.target.value, error: '' }); } })),
          h('div', { key: 'p2', className: 'urb-field' }, this.labelEl('Type it again'),
            this.input({ type: 'password', autoComplete: 'new-password', value: a.password2, onChange: function (e) { set({ password2: e.target.value, error: '' }); }, onKeyDown: function (e) { if (e.key === 'Enter') this.submitSetPassword(); }.bind(this) })),
          a.error ? h('div', { key: 'x', className: 'urb-error-box' }, a.error) : null,
          h('div', { key: 'a', className: 'urb-actions' },
            h('button', { className: this.btnClass('ghost', true), onClick: close }, 'Cancel'),
            h('button', { className: this.btnClass('primary', true), disabled: a.busy, onClick: this.submitSetPassword.bind(this) }, a.busy ? 'Saving…' : 'Save password'))
        ];
      } else {
        var m = this.state.member;
        title = a.welcome ? 'You’re all set' : 'Your account';
        body = [
          h('div', { key: 'i', style: { fontSize: '14px', lineHeight: 1.45, marginBottom: '14px' } },
            a.welcome ? 'You’re logged in. Tap any of your bookings on the schedule to change or cancel it.' : 'Logged in as ',
            a.welcome ? null : h('b', null, m ? m.name + ' (' + m.email + ')' : '')),
          h('div', { key: 'a', className: 'urb-actions' },
            a.welcome ? null : h('button', { className: this.btnClass('danger', true), onClick: this.memberLogout.bind(this) }, 'Log out'),
            h('button', { className: this.btnClass('primary', true), onClick: close }, a.welcome ? 'Go to schedule' : 'Close')),
          a.welcome ? null : h('div', { key: 'l', className: 'urb-acct-links' },
            h('button', { className: 'urb-link-btn', onClick: function () { set({ mode: 'link', fresh: false, email: m ? m.email : '' }); } }, 'Change password'))
        ];
      }
      return h('div', { className: 'urb-overlay urb-overlay-top urb-fade', onClick: close },
        h('div', { className: 'urb-card urb-pop', onClick: function (e) { e.stopPropagation(); } },
          h('div', { className: 'urb-card-head' }, h('span', null, '👤'), h('div', { className: 'urb-card-head-title' }, title)),
          h('div', { className: 'urb-card-body' }, body)
        )
      );
    }

    renderSettingsPage() {
      var d = this.state.settingsDraft || this.state.settings;
      var field = function (key, label, unit, help) {
        return h('div', { key: key, className: 'urb-setting' },
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', { className: 'urb-row-title' }, label),
            h('div', { className: 'urb-row-sub' }, help)
          ),
          h('div', { className: 'urb-setting-input' },
            this.input({ type: 'number', min: 0, step: 1, value: d[key], onChange: function (e) {
              var v = e.target.value;
              this.setState(function (s) { var nd = Object.assign({}, s.settingsDraft); nd[key] = v; return { settingsDraft: nd, settingsMsg: '' }; });
            }.bind(this) }),
            h('span', { className: 'urb-row-sub' }, unit)
          )
        );
      }.bind(this);
      var group = function (title, rows) {
        return h('div', { className: 'urb-admin-section' }, h('div', { className: 'urb-settings-group' }, title), rows);
      };
      var ok = this.state.settingsMsg === 'Saved.';
      return h('div', { className: 'urb-admin-panel urb-page-panel' },
        h('div', { className: 'urb-admin-title' }, 'Booking settings'),
        h('div', { className: 'urb-row-sub' }, 'These limits apply to members. Admins can always book any length, at any time.'),
        group('Studio One — Radio', [
          field('radioMaxHours', 'Longest show', 'hours', 'Members pick 1 hour up to this.')
        ]),
        group('Studio Two — DJ', [
          field('djMinSlotMin', 'Shortest slot', 'mins', 'Minimum length of a one-off DJ slot.'),
          field('djMaxSlotMin', 'Longest slot', 'mins', 'Maximum length of a one-off DJ slot.'),
          field('djWeeklyCapMin', 'Weekly allowance', 'mins', 'One-off DJ time per member per week. Over this, they can ask for an override.')
        ]),
        group('Roadshow', [
          field('roadshowMaxDays', 'Longest booking', 'days', 'How long a member can take equipment out for.')
        ]),
        group('All bookings', [
          field('maxAdvanceDays', 'Book ahead limit', 'days', 'How far into the future members can book. 0 = no limit.')
        ]),
        group('Full-week view', [
          field('normalStartHour', 'Day starts', 'hour', 'First hour shown in “View full schedule” (0–23).'),
          field('normalEndHour', 'Day ends', 'hour', 'Last hour shown in “View full schedule” (1–24).')
        ]),
        h('div', { className: 'urb-actions', style: { marginTop: '16px', alignItems: 'center' } },
          h('button', { className: this.btnClass('primary'), disabled: this.state.settingsBusy, onClick: this.saveSettings.bind(this) }, this.state.settingsBusy ? 'Saving…' : 'Save settings'),
          h('button', { className: this.btnClass('ghost'), onClick: function () { this.setState({ settingsDraft: Object.assign({}, this.state.settings), settingsMsg: '' }); }.bind(this) }, 'Reset'),
          this.state.settingsMsg ? h('span', { className: ok ? 'urb-ok' : 'urb-error', style: { marginTop: 0 } }, this.state.settingsMsg) : null
        )
      );
    }
    renderEquipmentPage() {
      var ed = this.state.itemEdit;
      var setEd = function (k, v) { this.setState(function (s) { var n = Object.assign({}, s.itemEdit); n[k] = v; return { itemEdit: n }; }); }.bind(this);
      var rows = this.state.equipment.map(function (it) {
        if (ed && ed.id === it.id) {
          return h('div', { key: it.id, className: 'urb-member-row urb-item-edit' },
            this.input({ value: ed.name, autoFocus: true, placeholder: 'Name', onChange: function (e) { setEd('name', e.target.value); }, onKeyDown: function (e) { if (e.key === 'Enter') this.saveItemEdit(); }.bind(this) }),
            this.input({ value: ed.notes, placeholder: 'Notes (optional)', onChange: function (e) { setEd('notes', e.target.value); }, onKeyDown: function (e) { if (e.key === 'Enter') this.saveItemEdit(); }.bind(this) }),
            h('div', { className: 'urb-actions', style: { marginTop: 0 } },
              h('button', { className: this.btnClass('primary'), onClick: this.saveItemEdit.bind(this) }, 'Save'),
              h('button', { className: this.btnClass('ghost'), onClick: function () { this.setState({ itemEdit: null }); }.bind(this) }, 'Cancel'))
          );
        }
        return h('div', { key: it.id, className: 'urb-member-row' + (it.active ? '' : ' retired') },
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', { className: 'urb-row-title' }, it.name, it.active ? null : h('span', { className: 'urb-tag' }, 'Retired')),
            it.notes ? h('div', { className: 'urb-row-sub' }, it.notes) : null
          ),
          h('button', { className: this.btnClass('ghost'), onClick: function () { this.setState({ itemEdit: { id: it.id, name: it.name, notes: it.notes } }); }.bind(this) }, 'Edit'),
          h('button', { className: this.btnClass('ghost'), onClick: function () { this.toggleItemActive(it); }.bind(this) }, it.active ? 'Retire' : 'Restore'),
          h('button', { className: this.btnClass('danger'), onClick: function () { this.deleteItem(it); }.bind(this) }, 'Delete')
        );
      }, this);
      return h('div', { className: 'urb-admin-panel urb-page-panel' },
        h('div', { className: 'urb-admin-title' }, 'Roadshow equipment'),
        h('div', { className: 'urb-row-sub' }, 'Each item here can be booked out on the Roadshow tab. Add every individual piece separately (e.g. “Mic 1”, “Mic 2”) so it can be tracked.'),
        h('div', { className: 'urb-admin-section' },
          h('div', { className: 'urb-add-item' },
            this.input({ ref: function (el) { this._newItemInput = el; }.bind(this), value: this.state.newItemName, placeholder: 'Item name, e.g. SM58 Mic #3', onChange: function (e) { this.setState({ newItemName: e.target.value }); }.bind(this), onKeyDown: function (e) { if (e.key === 'Enter') this.addItem(); }.bind(this) }),
            this.input({ value: this.state.newItemNotes, placeholder: 'Notes (optional)', onChange: function (e) { this.setState({ newItemNotes: e.target.value }); }.bind(this), onKeyDown: function (e) { if (e.key === 'Enter') this.addItem(); }.bind(this) }),
            h('button', { className: this.btnClass('primary'), onClick: this.addItem.bind(this) }, 'Add item')
          ),
          this.state.itemMsg ? h('div', { className: 'urb-error', style: { marginBottom: '8px' } }, this.state.itemMsg) : null
        ),
        h('div', { className: 'urb-admin-section' },
          h('div', { className: 'urb-row-title', style: { marginBottom: '8px' } }, 'Items (' + this.state.equipment.length + ')'),
          rows.length ? rows : h('div', { className: 'urb-row-sub' }, 'Nothing added yet.')
        )
      );
    }

    /* ---------- top level ---------- */
    render() {
      var studio = this.state.studio;
      var studioName = STUDIO_NAMES[studio];
      var studioDesc = studio === 1 ? 'Radio Studio' : (studio === 2 ? 'DJ Booth' : 'Equipment for events — tap a cell to book an item');
      var idleAnim = this.state.idle && this.state.loadPhase === 'done';
      var page = this.state.admin ? this.state.page : 'schedule';

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
            h('div', { className: 'urb-header-actions' },
              this.state.member
                ? h('button', { className: 'btn btn-md', onClick: function () { this.openAccount('me'); }.bind(this) }, '👤 ' + this.state.member.name.split(' ')[0])
                : h('button', { className: 'btn btn-md', onClick: function () { this.openAccount('login'); }.bind(this) }, '👤 Member login'),
              h('button', { className: 'btn btn-md' + (this.state.admin ? ' btn-primary' : ''), onClick: this.toggleAdmin.bind(this) }, this.state.admin ? '✓ Admin — exit' : '🔓 Admin')
            )
          ),

          h('div', { className: 'db-banner ' + (this.state.dbError ? 'error' : (!this.state.dbReady ? 'pending' : 'ok')) }, this.state.dbError || 'Connecting…'),
          this.state.adminNotice ? h('div', { className: 'db-banner error' }, this.state.adminNotice) : null,

          this.state.admin ? h('div', { className: 'urb-admin-nav' },
            [['schedule', 'Schedule'], ['members', 'Members'], ['categories', 'Show types'], ['settings', 'Settings'], ['equipment', 'Equipment']].map(function (p) {
              return h('button', { key: p[0], className: 'btn btn-sm' + (page === p[0] ? ' btn-primary' : ''), onClick: function () { this.openPage(p[0]); }.bind(this) }, p[1]);
            }, this)
          ) : null,

          page === 'members' ? this.renderMembersPage() : null,
          page === 'categories' ? this.renderCategoriesPage() : null,
          page === 'settings' ? this.renderSettingsPage() : null,
          page === 'equipment' ? this.renderEquipmentPage() : null,

          page === 'schedule' ? h('div', null,
            h('div', { className: 'urb-tabs' },
              [[1, 'STUDIO ONE', 'Live Radio'], [2, 'STUDIO TWO', 'DJ Studio'], [3, 'ROADSHOW', 'Equipment']].map(function (t) {
                return h('button', { key: t[0], className: 'urb-tab' + (studio === t[0] ? ' active' : ''), onClick: function () { this.setState({ studio: t[0] }); }.bind(this) },
                  h('span', { className: 'urb-tab-title' }, t[1]), h('span', { className: 'urb-tab-sub' }, t[2]));
              }, this)
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
                studio !== 3 ? h('button', { className: 'btn btn-sm', onClick: function () { this.setState({ fullWeek: true }); }.bind(this) }, '▦ View full schedule') : null
              ),
              h('div', { className: 'urb-studio-head' },
                h('div', { className: 'urb-studio-name' }, studioName),
                h('div', { className: 'urb-studio-desc' }, studioDesc)
              ),
              studio !== 3 ? this.renderCategoryKey(false) : null,
              studio === 3 ? this.renderRoadshow() : this.renderGrid()
            )
          ) : null,

          h('div', { className: 'urb-footer' }, 'Toby Gilday 2026')
        ),

        this.renderFullWeek(),
        this.renderModal(),
        this.renderCrop(),
        this.renderAccount(),
        this.renderReauth(),
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
