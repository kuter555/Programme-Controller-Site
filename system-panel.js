/*
 * URB System page (/system)
 * -------------------------
 * For whoever looks after the site: health checks, backups and restore, the
 * yearly 1 September reset and past schedules, data retention / privacy
 * requests, the activity log, and handover notes. Talks to /api/system/*.
 */
(function () {
  'use strict';
  var h = React.createElement;

  var TABS = [
    ['overview', 'Health'],
    ['backups', 'Backups'],
    ['reset', 'Yearly reset & archives'],
    ['privacy', 'Data & privacy'],
    ['log', 'Activity log'],
    ['settings', 'Settings'],
    ['handover', 'Handover']
  ];
  var LOG_TYPES = [
    ['', 'Everything'], ['booking.', 'Bookings'], ['member.', 'Members'], ['admin.', 'Admin sign-ins'],
    ['backup.', 'Backups & restores'], ['reset.', 'Yearly reset'], ['retention.', 'Data clean-up'], ['privacy.', 'Privacy requests'],
    ['health.', 'Health warnings'], ['error.', 'Errors'], ['config.', 'Config changes'], ['settings.', 'Booking limits'],
    ['category.', 'Show types'], ['equipment.', 'Equipment'], ['server.', 'Server start/stop']
  ];
  var STUDIOS = { 1: 'Studio One', 2: 'Studio Two', 3: 'Roadshow' };
  var WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function api(method, url, body, headers) {
    var isFile = body && typeof Blob !== 'undefined' && body instanceof Blob;
    return fetch(url, {
      method: method,
      credentials: 'same-origin',
      headers: Object.assign(body && !isFile ? { 'Content-Type': 'application/json' } : {}, headers || {}),
      body: body ? (isFile ? body : JSON.stringify(body)) : undefined
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          if (data.authLost && api.onAuthLost) api.onAuthLost();
          var err = new Error(data.error || ('Request failed (' + res.status + ')'));
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }
  function when(iso) {
    if (!iso) return 'never';
    var d = new Date(iso);
    return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function ago(iso) {
    if (!iso) return 'never';
    var hrs = (Date.now() - new Date(iso)) / 3600000;
    return hrs < 1 ? 'just now' : hrs < 48 ? Math.round(hrs) + ' h ago' : Math.round(hrs / 24) + ' days ago';
  }
  function kb(n) { return n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
  function hhmm(m) { m = ((m % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); }
  function saveBlob(name, text) {
    var url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    var a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1000);
  }
  var STATUS_LABEL = { ok: 'OK', warn: 'Check', fail: 'Problem', unknown: 'Unknown' };

  class SystemPage extends React.Component {
    constructor(props) {
      super(props);
      var dark = false;
      try { dark = window.matchMedia('(prefers-color-scheme: dark)').matches; } catch (e) {}
      var tab = (window.location.hash || '').slice(1);
      this.state = {
        dark: dark, signedIn: null, pass: '', loginError: '', loginBusy: false,
        tab: TABS.some(function (t) { return t[0] === tab; }) ? tab : 'overview',
        ov: null, busy: '', msg: '', err: '',
        backups: null, archives: null, archive: null, retention: null, retentionDraft: null,
        person: null, personEmail: '',
        log: [], logMore: false, logFilter: { q: '', type: '', from: '', to: '' }, openLog: null,
        cfgDraft: null, handoverDraft: null, passDraft: { current: '', next: '', again: '' },
        uploadFile: null, confirm: null
      };
      api.onAuthLost = function () { this.setState({ signedIn: false, loginError: 'Your session ended — sign in again.' }); }.bind(this);
    }
    componentDidMount() {
      this.syncTheme();
      api('GET', '/api/admin/session').then(function (d) {
        this.setState({ signedIn: !!d.admin });
        if (d.admin) this.loadTab(this.state.tab);
      }.bind(this)).catch(function () { this.setState({ signedIn: false, loginError: 'Can’t reach the server.' }); }.bind(this));
    }
    componentDidUpdate() { this.syncTheme(); }
    syncTheme() { document.documentElement.setAttribute('data-theme', this.state.dark ? 'dark' : 'light'); }

    /* ---------- loading ---------- */
    flash(msg, isErr) {
      clearTimeout(this._msgTimer);
      this.setState(isErr ? { err: msg, msg: '' } : { msg: msg, err: '' });
      this._msgTimer = setTimeout(function () { this.setState({ msg: '', err: '' }); }.bind(this), isErr ? 9000 : 5000);
    }
    fail(e) { this.setState({ busy: '' }); this.flash(e.message, true); }
    loadOverview() { return api('GET', '/api/system/overview').then(function (ov) { this.setState({ ov: ov }); }.bind(this)); }
    loadTab(tab) {
      var p = this.loadOverview();
      if (tab === 'backups') p = p.then(function () { return api('GET', '/api/system/backups'); }).then(function (b) { this.setState({ backups: b }); }.bind(this));
      if (tab === 'reset') p = p.then(function () { return api('GET', '/api/system/archives'); }).then(function (a) { this.setState({ archives: a }); }.bind(this));
      if (tab === 'privacy') p = p.then(function () { return api('GET', '/api/system/retention/preview'); }).then(function (r) { this.setState({ retention: r }); }.bind(this));
      if (tab === 'log') p = p.then(function () { return this.loadLog(false); }.bind(this));
      p.catch(this.fail.bind(this));
    }
    openTab(tab) {
      window.location.hash = tab;
      this.setState({ tab: tab, archive: null, person: null });
      this.loadTab(tab);
    }
    loadLog(more) {
      var f = this.state.logFilter;
      var q = new URLSearchParams();
      ['q', 'type', 'from', 'to'].forEach(function (k) { if (f[k]) q.set(k, f[k]); });
      q.set('limit', '100');
      if (more && this.state.log.length) q.set('before', this.state.log[this.state.log.length - 1].id);
      return api('GET', '/api/system/log?' + q.toString()).then(function (rows) {
        this.setState(function (s) { return { log: more ? s.log.concat(rows) : rows, logMore: rows.length === 100 }; });
      }.bind(this));
    }

    /* ---------- sign in ---------- */
    signIn(e) {
      if (e) e.preventDefault();
      this.setState({ loginBusy: true, loginError: '' });
      api('POST', '/api/admin/login', { passphrase: this.state.pass, from: 'system' }).then(function () {
        this.setState({ signedIn: true, pass: '', loginBusy: false });
        this.loadTab(this.state.tab);
      }.bind(this)).catch(function (e) { this.setState({ loginBusy: false, loginError: e.message }); }.bind(this));
    }
    signOut() { api('POST', '/api/admin/logout').then(function () { this.setState({ signedIn: false, ov: null }); }.bind(this)); }

    /* ---------- confirm-with-passphrase dialog ---------- */
    // opts: { title, body, button, typeWord, run(passphrase) -> Promise }
    ask(opts) { this.setState({ confirm: Object.assign({ pass: '', typed: '', error: '', busy: false }, opts) }); }
    renderConfirm() {
      var c = this.state.confirm;
      if (!c) return null;
      var set = function (patch) { this.setState(function (s) { return { confirm: Object.assign({}, s.confirm, patch) }; }); }.bind(this);
      var ready = c.pass && (!c.typeWord || c.typed.trim().toUpperCase() === c.typeWord);
      var go = function (e) {
        e.preventDefault();
        if (!ready || c.busy) return;
        set({ busy: true, error: '' });
        c.run(c.pass).then(function () { this.setState({ confirm: null }); }.bind(this))
          .catch(function (err) { set({ busy: false, error: err.message }); });
      }.bind(this);
      return h('div', { className: 'urb-overlay urb-fade', onClick: function () { if (!c.busy) this.setState({ confirm: null }); }.bind(this) },
        h('form', { className: 'urb-card urb-pop', onClick: function (e) { e.stopPropagation(); }, onSubmit: go },
          h('div', { className: 'urb-card-head' + (c.danger ? ' sys-head-danger' : '') }, h('div', { className: 'urb-card-head-title' }, c.title)),
          h('div', { className: 'urb-card-body' },
            h('div', { className: 'sys-p' }, c.body),
            c.typeWord ? h('div', { className: 'urb-field' }, h('div', { className: 'urb-label' }, 'Type ' + c.typeWord + ' to confirm'),
              h('input', { className: 'urb-input', value: c.typed, autoFocus: true, onChange: function (e) { set({ typed: e.target.value }); } })) : null,
            h('div', { className: 'urb-field' }, h('div', { className: 'urb-label' }, 'Admin passphrase'),
              h('input', { className: 'urb-input', type: 'password', value: c.pass, autoFocus: !c.typeWord, autoComplete: 'current-password', onChange: function (e) { set({ pass: e.target.value }); } })),
            c.error ? h('div', { className: 'urb-error' }, c.error) : null,
            h('div', { className: 'urb-actions' },
              h('button', { type: 'button', className: 'btn btn-md btn-ghost', disabled: c.busy, onClick: function () { this.setState({ confirm: null }); }.bind(this) }, 'Cancel'),
              h('button', { type: 'submit', className: 'btn btn-md ' + (c.danger ? 'btn-danger-solid' : 'btn-primary'), disabled: !ready || c.busy }, c.busy ? 'Working…' : c.button)
            )
          )
        )
      );
    }

    /* ---------- actions ---------- */
    runChecks() {
      this.setState({ busy: 'checks' });
      api('POST', '/api/system/health/run').then(function () { return this.loadOverview(); }.bind(this))
        .then(function () { this.setState({ busy: '' }); this.flash('Health checks finished.'); }.bind(this)).catch(this.fail.bind(this));
    }
    backupNow() {
      this.setState({ busy: 'backup' });
      api('POST', '/api/system/backups').then(function (b) {
        this.setState({ busy: '' }); this.flash('Backup ' + b.name + ' made and verified.'); this.loadTab('backups');
      }.bind(this)).catch(this.fail.bind(this));
    }
    restoreBackup(name) {
      this.ask({
        title: 'Restore this backup?', danger: true, button: 'Restore', typeWord: 'RESTORE',
        body: h('span', null, 'The schedule, members, show types, equipment and settings will be replaced with the copy in ', h('b', null, name),
          '. Anything changed since then is lost — but a backup of the site as it is right now is taken first, so this can be undone by restoring that. The activity log and archives are kept.'),
        run: function (pass) {
          return api('POST', '/api/system/backups/' + encodeURIComponent(name) + '/restore', { passphrase: pass }).then(function (r) {
            this.flash('Restored: ' + (r.counts.bookings || 0) + ' bookings, ' + (r.counts.members || 0) + ' members. The previous state was saved as ' + r.safety + '.');
            this.loadTab('backups');
          }.bind(this));
        }.bind(this)
      });
    }
    restoreUpload() {
      var file = this.state.uploadFile;
      if (!file) return;
      this.ask({
        title: 'Restore from this file?', danger: true, button: 'Upload & restore', typeWord: 'RESTORE',
        body: h('span', null, 'Everything on the site will be replaced with the contents of ', h('b', null, file.name), ' (' + kb(file.size) + '). A backup of the current state is taken first.'),
        run: function (pass) {
          return api('POST', '/api/system/restore-upload', file, { 'Content-Type': 'application/octet-stream', 'X-Confirm-Passphrase': pass, 'X-Filename': file.name.replace(/[^\x20-\x7e]/g, '_') }).then(function (r) {
            this.setState({ uploadFile: null });
            this.flash('Restored: ' + (r.counts.bookings || 0) + ' bookings, ' + (r.counts.members || 0) + ' members, ' + r.images + ' images. The previous state was saved as ' + r.safety + '.');
            this.loadTab('backups');
          }.bind(this));
        }.bind(this)
      });
    }
    saveConfig(patch, okMsg) {
      this.setState({ busy: 'config' });
      return api('PUT', '/api/system/config', patch).then(function () { return this.loadOverview(); }.bind(this))
        .then(function () { this.setState({ busy: '', cfgDraft: null, handoverDraft: null }); this.flash(okMsg || 'Saved.'); }.bind(this))
        .catch(this.fail.bind(this));
    }
    clearNow() {
      var ov = this.state.ov;
      this.ask({
        title: 'Clear the schedule now?', danger: true, button: 'Clear schedule', typeWord: 'CLEAR',
        body: 'Every booking that starts before today — including weekly shows that started before today — is moved into an archive and taken off the schedule. Bookings for today onwards stay. A backup is taken first, and the archive has an Undo button. ' +
          (ov && ov.config.reset.clearMedia ? 'Media membership will also be switched off for everyone.' : ''),
        run: function (pass) {
          return api('POST', '/api/system/reset', { passphrase: pass, clearMedia: ov && ov.config.reset.clearMedia }).then(function (r) {
            this.flash(r.count + ' bookings archived and cleared.'); this.loadTab('reset');
          }.bind(this));
        }.bind(this)
      });
    }
    undoArchive(a) {
      this.ask({
        title: 'Undo the "' + a.label + '" reset?', button: 'Put bookings back',
        body: 'The ' + a.bookingCount + ' bookings in this archive go back on the schedule (any that are already there are left alone). The archive copy is kept, marked as undone.',
        run: function (pass) {
          return api('POST', '/api/system/archives/' + a.id + '/undo', { passphrase: pass }).then(function (r) {
            this.flash(r.restored + ' bookings put back.'); this.loadTab('reset');
          }.bind(this));
        }.bind(this)
      });
    }
    openArchive(a) {
      api('GET', '/api/system/archives/' + a.id).then(function (full) { this.setState({ archive: full }); }.bind(this)).catch(this.fail.bind(this));
    }
    runRetention() {
      this.ask({
        title: 'Run the data clean-up now?', danger: true, button: 'Run clean-up',
        body: 'Everything listed under “What the next clean-up will remove” is removed now, instead of tonight. A backup is taken first.',
        run: function (pass) {
          return api('POST', '/api/system/retention/run', { passphrase: pass }).then(function () {
            this.flash('Clean-up done.'); this.loadTab('privacy');
          }.bind(this));
        }.bind(this)
      });
    }
    findPerson(e) {
      if (e) e.preventDefault();
      api('POST', '/api/system/person/find', { email: this.state.personEmail }).then(function (p) { this.setState({ person: p }); }.bind(this)).catch(this.fail.bind(this));
    }
    erasePerson() {
      var p = this.state.person;
      this.ask({
        title: 'Erase this person’s data?', danger: true, button: 'Erase', typeWord: 'ERASE',
        body: 'Their member record is deleted, and their name and email are removed from ' + p.bookings.length + ' bookings, ' + p.archived.length + ' archived bookings and ' + p.log.length + ' log entries. Shows stay on the schedule as “Former presenter”. Older backups still hold the data until they rotate out (at most about a year).',
        run: function (pass) {
          return api('POST', '/api/system/person/erase', { email: p.email, passphrase: pass }).then(function (r) {
            this.setState({ person: null, personEmail: '' }); this.flash(r.summary + '.');
          }.bind(this));
        }.bind(this)
      });
    }
    changePassphrase(e) {
      e.preventDefault();
      var d = this.state.passDraft;
      if (d.next !== d.again) return this.flash('The two new passphrases don’t match.', true);
      api('POST', '/api/system/passphrase', { current: d.current, next: d.next }).then(function () {
        this.setState({ passDraft: { current: '', next: '', again: '' } });
        this.flash('Passphrase changed. Every other admin has been signed out — tell them the new one.');
      }.bind(this)).catch(this.fail.bind(this));
    }

    /* ---------- bits ---------- */
    panel(title, children, extra) {
      return h('div', { className: 'urb-admin-panel' },
        h('div', { className: 'urb-page-title-row' }, h('div', { className: 'urb-admin-title' }, title), extra || null),
        children);
    }
    btn(label, onClick, kind, busyKey) {
      var busy = busyKey && this.state.busy === busyKey;
      return h('button', { className: 'btn btn-md ' + (kind === 'primary' ? 'btn-primary' : kind === 'danger' ? 'btn-danger' : 'btn-ghost'), disabled: !!busy, onClick: onClick }, busy ? 'Working…' : label);
    }
    link(label, href) { return h('a', { className: 'btn btn-md btn-ghost urb-download', href: href }, label); }
    dot(status) { return h('span', { className: 'sys-dot sys-' + status, title: STATUS_LABEL[status] }); }
    help(text) { return h('div', { className: 'sys-help' }, text); }

    /* ---------- tabs ---------- */
    renderOverview() {
      var ov = this.state.ov;
      if (!ov) return this.panel('Health', h('div', { className: 'urb-row-sub' }, 'Loading…'));
      var checks = ov.health.checks || [];
      var fails = checks.filter(function (c) { return c.status === 'fail'; }), warns = checks.filter(function (c) { return c.status === 'warn'; });
      var order = { fail: 0, warn: 1, unknown: 2, ok: 3 };
      var sorted = checks.slice().sort(function (a, b) { return order[a.status] - order[b.status]; });
      return h(React.Fragment, null,
        h('div', { className: 'sys-summary sys-' + (fails.length ? 'fail' : warns.length ? 'warn' : 'ok') },
          h('div', { className: 'sys-summary-title' }, fails.length ? fails.length + ' problem' + (fails.length > 1 ? 's' : '') + ' need fixing' : warns.length ? 'Working, with ' + warns.length + ' thing' + (warns.length > 1 ? 's' : '') + ' to check' : checks.length ? 'Everything looks healthy' : 'Not checked yet'),
          h('div', { className: 'urb-row-sub' }, 'Checks run every 6 hours by themselves. Last run: ' + when(ov.health.at) + '.')
        ),
        ov.recovery ? h('div', { className: 'db-banner error' }, ov.recovery.message) : null,
        this.panel('Checks', h(React.Fragment, null,
          sorted.map(function (c) {
            return h('div', { key: c.id, className: 'sys-check' },
              this.dot(c.status),
              h('div', { style: { flex: 1, minWidth: 0 } },
                h('div', { className: 'urb-row-title' }, c.title, h('span', { className: 'sys-badge sys-' + c.status }, STATUS_LABEL[c.status])),
                h('div', { className: 'urb-row-sub urb-break' }, c.detail),
                c.help ? h('div', { className: 'sys-fix' }, 'What to do: ' + c.help) : null
              )
            );
          }, this)
        ), this.btn('Run checks now', this.runChecks.bind(this), 'primary', 'checks')),
        this.panel('At a glance', h('div', { className: 'sys-grid' },
          this.fact('Bookings on the schedule', ov.counts.bookings),
          this.fact('Members', ov.counts.members + (ov.counts.pendingMembers ? ' (+' + ov.counts.pendingMembers + ' waiting)' : '')),
          this.fact('Last backup', ov.lastBackup ? ago(ov.lastBackup.at) : 'never'),
          this.fact('Next schedule reset', ov.reset.enabled ? ov.reset.nextLabel + ' (' + ov.reset.daysUntil + ' days)' : 'switched off'),
          this.fact('Past schedules archived', ov.counts.archives),
          this.fact('Activity log entries', ov.counts.logEntries),
          this.fact('Server running since', when(ov.server.startedAt)),
          this.fact('Node.js', ov.server.node)
        ))
      );
    }
    fact(label, value) { return h('div', { className: 'sys-fact' }, h('div', { className: 'urb-label' }, label), h('div', { className: 'sys-fact-value' }, String(value))); }

    renderBackups() {
      var ov = this.state.ov, list = this.state.backups;
      return h(React.Fragment, null,
        this.panel('Keep a copy somewhere else', h(React.Fragment, null,
          h('div', { className: 'sys-p' }, 'The server backs itself up every night, but those backups live on the same server. ',
            h('b', null, 'Once a month, download a portable backup'), ' and put it in the society’s shared drive. It holds everything — schedule, members, settings, archives, the activity log and every show image — and can rebuild the site on a brand-new server.'),
          h('div', { className: 'urb-row-sub', style: { marginBottom: 10 } }, 'Last downloaded: ' + (ov ? when(ov.lastOffsiteDownload) : '…')),
          h('div', { className: 'sys-btns' },
            this.link('⬇ Download portable backup', '/api/system/bundle'),
            this.link('⬇ Readable export (JSON)', '/api/system/export.json')
          ),
          this.help('The readable export can be opened in any text editor, so the data isn’t lost even if this website stops existing.')
        )),
        this.panel('Backups on the server', h(React.Fragment, null,
          h('div', { className: 'sys-p' }, 'Made every night at 03:00 and checked straight away. Kept: every night for 14 days, then weekly for 8 weeks, then monthly for a year. A backup is also taken before every restore, reset and erase. If the database is ever lost or damaged, the site puts the newest good backup back by itself when it starts.'),
          ov ? h('div', { className: 'urb-row-sub urb-break', style: { marginBottom: 10 } }, 'Folder: ' + ov.server.backupDir + (ov.server.mirrorDir ? ' · second copy: ' + ov.server.mirrorDir : ' · no second backup folder set (BACKUP_MIRROR_DIR)')) : null,
          !list ? h('div', { className: 'urb-row-sub' }, 'Loading…') : !list.length ? h('div', { className: 'urb-row-sub' }, 'No backups yet.') :
            h('div', { className: 'sys-table-wrap' }, h('table', { className: 'sys-table' },
              h('thead', null, h('tr', null, ['Taken', 'Type', 'Size', 'Check', ''].map(function (x, i) { return h('th', { key: i }, x); }))),
              h('tbody', null, list.map(function (b) {
                return h('tr', { key: b.name },
                  h('td', null, b.date + ' ' + b.time.slice(0, 5)),
                  h('td', null, { daily: 'Nightly', manual: 'By hand', 'pre-restore': 'Before restore', 'pre-reset': 'Before reset', 'pre-erase': 'Before erase' }[b.kind] || b.kind),
                  h('td', null, kb(b.size)),
                  h('td', null, b.verified ? h('span', { className: 'urb-ok' }, '✓ OK') : h('span', { className: 'urb-error-inline' }, '✗ damaged')),
                  h('td', { className: 'sys-td-actions' },
                    h('a', { className: 'btn btn-sm urb-download', href: '/api/system/backups/' + encodeURIComponent(b.name) + '/download' }, 'Download'),
                    b.verified ? h('button', { className: 'btn btn-sm btn-danger', onClick: function () { this.restoreBackup(b.name); }.bind(this) }, 'Restore') : null)
                );
              }, this))
            )),
          h('div', { className: 'sys-btns', style: { marginTop: 10 } }, this.btn('Back up now', this.backupNow.bind(this), 'primary', 'backup'))
        )),
        this.panel('Restore from a file', h(React.Fragment, null,
          h('div', { className: 'sys-p' }, 'Use this to bring the site back from a portable backup (.urbbackup) or a database backup (.db) — for example after moving to a new server.'),
          h('div', { className: 'sys-btns' },
            h('input', { type: 'file', accept: '.urbbackup,.db,application/octet-stream', className: 'sys-file', onChange: function (e) { this.setState({ uploadFile: e.target.files[0] || null }); }.bind(this) }),
            h('button', { className: 'btn btn-md btn-danger', disabled: !this.state.uploadFile, onClick: this.restoreUpload.bind(this) }, 'Restore from file…')
          )
        ))
      );
    }

    renderReset() {
      var ov = this.state.ov;
      if (this.state.archive) return this.renderArchive(this.state.archive);
      var rs = ov && ov.reset;
      return h(React.Fragment, null,
        this.panel('Yearly reset — every 1 September', !rs ? h('div', { className: 'urb-row-sub' }, 'Loading…') : h(React.Fragment, null,
          h('div', { className: 'sys-p' }, 'At 04:00 on 1 September the schedule clears itself for the new academic year. Everything that started before then — including weekly shows — is saved into an archive below (with a backup taken first), and anything already booked for September onwards stays. If the server is off on the day, it does it as soon as it’s back on.'),
          h('div', { className: 'sys-grid' },
            this.fact('Next reset', rs.enabled ? rs.nextLabel + ' at 04:00' : 'switched off'),
            this.fact('Days to go', rs.enabled ? rs.daysUntil : '—'),
            this.fact('Will be archived as', rs.willArchiveAs),
            this.fact('Last reset', rs.lastResetYear ? '1 Sep ' + rs.lastResetYear : '—')
          ),
          h('label', { className: 'sys-toggle' }, h('input', { type: 'checkbox', checked: rs.enabled, onChange: function (e) { this.saveConfig({ reset: { enabled: e.target.checked } }, e.target.checked ? 'Yearly reset switched on.' : 'Yearly reset switched OFF.'); }.bind(this) }),
            h('span', null, h('b', null, 'Clear the schedule automatically every 1 September'))),
          h('label', { className: 'sys-toggle' }, h('input', { type: 'checkbox', checked: rs.clearMedia, onChange: function (e) { this.saveConfig({ reset: { clearMedia: e.target.checked } }); }.bind(this) }),
            h('span', null, h('b', null, 'Also switch off everyone’s media membership'), h('span', { className: 'urb-row-sub' }, ' — so members have to be re-approved each year. Their accounts stay.'))),
          h('div', { className: 'sys-btns', style: { marginTop: 12 } }, this.btn('Clear the schedule now…', this.clearNow.bind(this), 'danger'))
        )),
        this.panel('Past schedules', !this.state.archives ? h('div', { className: 'urb-row-sub' }, 'Loading…') : !this.state.archives.length ? h('div', { className: 'urb-row-sub' }, 'Nothing archived yet — the first archive appears after the next reset.') :
          this.state.archives.map(function (a) {
            return h('div', { key: a.id, className: 'urb-member-row' },
              h('div', { style: { flex: 1, minWidth: 0 } },
                h('div', { className: 'urb-row-title' }, a.label + (a.undoneAt ? ' (undone)' : '')),
                h('div', { className: 'urb-row-sub' }, a.bookingCount + ' bookings · archived ' + when(a.createdAt) + ' · ' + a.reason)),
              h('button', { className: 'btn btn-sm btn-ghost', onClick: function () { this.openArchive(a); }.bind(this) }, 'View'),
              h('a', { className: 'btn btn-sm urb-download', href: '/api/system/archives/' + a.id + '/csv' }, 'Spreadsheet'),
              a.undoneAt ? null : h('button', { className: 'btn btn-sm btn-danger', onClick: function () { this.undoArchive(a); }.bind(this) }, 'Undo')
            );
          }, this))
      );
    }
    renderArchive(a) {
      var data = a.data || { bookings: [] };
      var cats = {}; (data.categories || []).forEach(function (c) { cats[c.key] = c; });
      var byStudio = {};
      data.bookings.forEach(function (b) { (byStudio[b.studio] = byStudio[b.studio] || []).push(b); });
      var dow = function (ds) { return new Date(ds + 'T12:00').getDay(); };
      return this.panel('Archive: ' + a.label, h(React.Fragment, null,
        h('div', { className: 'urb-row-sub', style: { marginBottom: 10 } }, a.bookingCount + ' bookings that started before ' + data.cutoff + ' · archived ' + when(a.createdAt) + (a.undoneAt ? ' · undone ' + when(a.undoneAt) : '')),
        Object.keys(byStudio).sort().map(function (st) {
          var list = byStudio[st].slice().sort(function (x, y) {
            if ((x.repeat === 'weekly') !== (y.repeat === 'weekly')) return x.repeat === 'weekly' ? -1 : 1;
            return x.repeat === 'weekly' ? ((dow(x.date) + 6) % 7) - ((dow(y.date) + 6) % 7) || x.startMin - y.startMin : (x.date < y.date ? -1 : x.date > y.date ? 1 : x.startMin - y.startMin);
          });
          return h('div', { key: st, style: { marginBottom: 14 } },
            h('div', { className: 'urb-settings-group' }, STUDIOS[st] || 'Studio ' + st),
            h('div', { className: 'sys-table-wrap' }, h('table', { className: 'sys-table' },
              h('thead', null, h('tr', null, ['When', 'Show', 'Presenter', 'Type'].map(function (x) { return h('th', { key: x }, x); }))),
              h('tbody', null, list.map(function (b) {
                var c = cats[b.category];
                return h('tr', { key: b.id },
                  h('td', { className: 'sys-nowrap' }, (b.repeat === 'weekly' ? 'Every ' + WEEKDAYS[dow(b.date)] + ' from ' + b.date : WEEKDAYS[dow(b.date)] + ' ' + b.date) + ' · ' + hhmm(b.startMin) + '–' + hhmm(b.endMin)),
                  h('td', null, b.title),
                  h('td', null, b.name),
                  h('td', null, c ? h('span', { className: 'sys-cat' }, h('i', { style: { background: c.color } }), c.label) : '')
                );
              }))
            ))
          );
        }),
        h('div', { className: 'sys-btns' },
          h('button', { className: 'btn btn-md btn-ghost', onClick: function () { this.setState({ archive: null }); }.bind(this) }, '← Back'),
          this.link('⬇ Spreadsheet (CSV)', '/api/system/archives/' + a.id + '/csv'))
      ));
    }

    renderPrivacy() {
      var ov = this.state.ov, r = this.state.retention;
      if (!ov) return this.panel('Data & privacy', h('div', { className: 'urb-row-sub' }, 'Loading…'));
      var d = this.state.retentionDraft || ov.config.retention;
      var rule = function (key, label, unit, help) {
        return h('div', { key: key, className: 'urb-setting' },
          h('div', { style: { flex: 1, minWidth: 0 } }, h('div', { className: 'urb-row-title' }, label), h('div', { className: 'urb-row-sub' }, help)),
          h('div', { className: 'urb-setting-input' },
            h('input', { className: 'urb-input', type: 'number', min: 0, step: 1, value: d[key], onChange: function (e) {
              var v = e.target.value;
              this.setState(function (s) { var nd = Object.assign({}, s.retentionDraft || s.ov.config.retention); nd[key] = v; return { retentionDraft: nd }; });
            }.bind(this) }),
            h('span', { className: 'urb-row-sub' }, unit))
        );
      }.bind(this);
      var saveRules = function () {
        var out = {}; Object.keys(d).forEach(function (k) { out[k] = Number(d[k]); });
        this.saveConfig({ retention: out }, 'Retention rules saved.').then(function () { return api('GET', '/api/system/retention/preview'); }).then(function (x) { if (x) this.setState({ retention: x }); }.bind(this));
      }.bind(this);
      var p = this.state.person;
      return h(React.Fragment, null,
        this.panel('How long personal data is kept', h(React.Fragment, null,
          h('div', { className: 'sys-p' }, 'The site only keeps people’s details for as long as it needs them. These rules run by themselves every night. Set any of them to 0 to switch it off.'),
          rule('emailMonths', 'Remove email addresses from finished bookings', 'months', 'After a show’s last date. The show itself stays in the history. Also blanks emails and IP addresses in old activity-log entries.'),
          rule('nameMonths', 'Remove presenter names from finished bookings', 'months', 'Names become “Former presenter”, in archives too.'),
          rule('inactiveMemberMonths', 'Delete members who haven’t been active', 'months', 'No bookings or requests in that time.'),
          rule('pendingMemberDays', 'Delete registrations nobody approved', 'days', 'Sign-ups still waiting for an admin.'),
          rule('orphanImageDays', 'Delete show images that aren’t used', 'days', 'Uploaded but never saved with a show, or replaced.'),
          h('div', { className: 'sys-btns' }, this.btn('Save rules', saveRules, 'primary', 'config')),
          this.help('Backups are kept for at most about a year and then deleted, so personal data in them also expires. Last clean-up: ' + (ov.lastRetention ? when(ov.lastRetention.at) + ' — ' + ov.lastRetention.summary : 'not run yet') + '.')
        )),
        this.panel('What the next clean-up will remove', !r ? h('div', { className: 'urb-row-sub' }, 'Loading…') : h(React.Fragment, null,
          h('ul', { className: 'sys-list' },
            h('li', null, (r.bookingEmails + r.archiveEmails) + ' booking email addresses'),
            h('li', null, (r.bookingNames + r.archiveNames) + ' presenter names'),
            h('li', null, r.inactiveMembers.length + ' inactive members' + (r.inactiveMembers.length ? ': ' + r.inactiveMembers.map(function (m) { return m.name + ' (last active ' + m.lastActive + ')'; }).join(', ') : '')),
            h('li', null, r.pendingMembers.length + ' unapproved registrations' + (r.pendingMembers.length ? ': ' + r.pendingMembers.map(function (m) { return m.name; }).join(', ') : '')),
            h('li', null, r.images.length + ' unused images'),
            h('li', null, r.logEntries + ' old log entries to anonymise')
          ),
          h('div', { className: 'sys-btns' }, this.btn('Run clean-up now…', this.runRetention.bind(this), 'danger'))
        )),
        this.panel('Someone asks what data we hold, or to be deleted', h(React.Fragment, null,
          h('div', { className: 'sys-p' }, 'Under UK GDPR people can ask for a copy of their data (reply within a month) or for it to be erased. Search by their email address.'),
          h('form', { className: 'sys-btns', onSubmit: this.findPerson.bind(this) },
            h('input', { className: 'urb-input sys-grow', type: 'email', placeholder: 'name@bath.ac.uk', value: this.state.personEmail, onChange: function (e) { this.setState({ personEmail: e.target.value, person: null }); }.bind(this) }),
            h('button', { className: 'btn btn-md btn-primary', type: 'submit', disabled: !this.state.personEmail.trim() }, 'Search')
          ),
          p ? h('div', { className: 'sys-person' },
            h('div', { className: 'urb-row-title' }, p.member ? p.member.name + ' — ' + (p.member.approved ? 'member since ' + p.member.created_at.slice(0, 10) : 'registration waiting for approval') : 'Not a registered member'),
            h('ul', { className: 'sys-list' },
              h('li', null, p.bookings.length + ' bookings on the current schedule'),
              h('li', null, p.archived.length + ' bookings in past-schedule archives'),
              h('li', null, p.log.length + ' activity-log entries mention them')
            ),
            h('div', { className: 'sys-btns' },
              h('button', { className: 'btn btn-md btn-ghost', onClick: function () { saveBlob('urb-data-' + p.email.replace(/[^a-z0-9]+/gi, '-') + '.json', JSON.stringify(p, null, 2)); }.bind(this) }, '⬇ Download their data'),
              (p.member || p.bookings.length || p.archived.length || p.log.length) ? h('button', { className: 'btn btn-md btn-danger', onClick: this.erasePerson.bind(this) }, 'Erase their data…') : null
            )
          ) : null
        ))
      );
    }

    renderLog() {
      var f = this.state.logFilter;
      var setF = function (patch) { this.setState(function (s) { return { logFilter: Object.assign({}, s.logFilter, patch) }; }, function () { this.loadLog(false).catch(this.fail.bind(this)); }.bind(this)); }.bind(this);
      var q = new URLSearchParams(); ['q', 'type', 'from', 'to'].forEach(function (k) { if (f[k]) q.set(k, f[k]); });
      return this.panel('Activity log', h(React.Fragment, null,
        h('div', { className: 'sys-p' }, 'Everything anyone has done on the site — bookings, approvals, deletions, sign-ins, settings — plus what the server did by itself (backups, clean-ups, resets, warnings, errors). Nothing can be deleted from here. Deleted bookings keep a full copy in their entry.'),
        h('div', { className: 'sys-filters' },
          h('input', { className: 'urb-input', placeholder: 'Search…', value: f.q, onChange: function (e) { var v = e.target.value; clearTimeout(this._qTimer); this.setState(function (s) { return { logFilter: Object.assign({}, s.logFilter, { q: v }) }; }); this._qTimer = setTimeout(function () { this.loadLog(false).catch(this.fail.bind(this)); }.bind(this), 350); }.bind(this) }),
          h('select', { className: 'urb-select', value: f.type, onChange: function (e) { setF({ type: e.target.value }); } }, LOG_TYPES.map(function (t) { return h('option', { key: t[0], value: t[0] }, t[1]); })),
          h('input', { className: 'urb-input', type: 'date', value: f.from, title: 'From', onChange: function (e) { setF({ from: e.target.value }); } }),
          h('input', { className: 'urb-input', type: 'date', value: f.to, title: 'To', onChange: function (e) { setF({ to: e.target.value }); } }),
          h('a', { className: 'btn btn-md btn-ghost urb-download', href: '/api/system/log.csv?' + q.toString() }, '⬇ CSV')
        ),
        !this.state.log.length ? h('div', { className: 'urb-row-sub' }, 'Nothing found.') :
          h('div', { className: 'sys-log' }, this.state.log.map(function (r) {
            var open = this.state.openLog === r.id;
            var kind = r.action.split('.')[0];
            return h('div', { key: r.id, className: 'sys-log-row' + (kind === 'error' ? ' is-error' : r.action === 'health.fail' ? ' is-error' : r.action === 'health.warn' ? ' is-warn' : '') },
              h('div', { className: 'sys-log-when' }, when(r.at)),
              h('div', { style: { flex: 1, minWidth: 0 } },
                h('div', { className: 'sys-log-summary urb-break' }, r.summary),
                h('div', { className: 'urb-row-sub urb-break' }, r.actor + ' · ' + r.action,
                  r.details ? h('button', { className: 'sys-linkbtn', onClick: function () { this.setState({ openLog: open ? null : r.id }); }.bind(this) }, open ? 'hide details' : 'details') : null),
                open ? h('pre', { className: 'sys-pre' }, JSON.stringify(r.details, null, 2)) : null
              )
            );
          }, this)),
        this.state.logMore ? h('div', { className: 'sys-btns', style: { marginTop: 10 } }, this.btn('Load older entries', function () { this.loadLog(true).catch(this.fail.bind(this)); }.bind(this))) : null
      ));
    }

    renderSettings() {
      var ov = this.state.ov;
      if (!ov) return this.panel('Settings', h('div', { className: 'urb-row-sub' }, 'Loading…'));
      var d = this.state.cfgDraft || { publicUrl: ov.config.publicUrl, streams: ov.config.streams.join('\n') };
      var setD = function (patch) { this.setState({ cfgDraft: Object.assign({}, d, patch) }); }.bind(this);
      var origin = ov.config.publicUrl;
      var pd = this.state.passDraft;
      var setP = function (patch) { this.setState({ passDraft: Object.assign({}, pd, patch) }); }.bind(this);
      return h(React.Fragment, null,
        this.panel('Addresses', h(React.Fragment, null,
          h('div', { className: 'urb-field' }, h('div', { className: 'urb-label' }, 'Public address of this site'),
            h('input', { className: 'urb-input', value: d.publicUrl, onChange: function (e) { setD({ publicUrl: e.target.value }); } }),
            this.help('Used by the health checks (domain expiry, DNS, HTTPS certificate). If the site moves to a new domain, change it here.')),
          h('div', { className: 'urb-field' }, h('div', { className: 'urb-label' }, 'Live stream addresses (one per line, best first)'),
            h('textarea', { className: 'urb-textarea', rows: 3, value: d.streams, onChange: function (e) { setD({ streams: e.target.value }); } }),
            this.help('The Listen Live player tries these in order. If the stream server moves, change them here — every website with the player picks up the change within a minute, without anyone editing those sites.')),
          h('div', { className: 'sys-btns' }, this.btn('Save', function () { this.saveConfig({ publicUrl: d.publicUrl, streams: d.streams.split(/\s+/).filter(Boolean) }, 'Addresses saved.'); }.bind(this), 'primary', 'config'))
        )),
        this.panel('Embed codes', h(React.Fragment, null,
          h('div', { className: 'sys-p' }, 'Paste these into other websites. They use the address above — if the domain changes, sites using the old codes need the new ones.'),
          h('div', { className: 'urb-label' }, 'Listen Live player'),
          h('pre', { className: 'sys-pre' }, '<div id="urb-listen-live"></div>\n<script src="' + origin + '/listen-live.js" async></script>'),
          h('div', { className: 'urb-label' }, 'Public schedule'),
          h('pre', { className: 'sys-pre' }, '<iframe src="' + origin + '/" style="width:100%;height:900px;border:0"></iframe>\n<!-- one studio only: ' + origin + '/?studio=1 · force a theme: ?theme=light -->'),
          h('div', { className: 'urb-label' }, 'Uptime monitor (e.g. UptimeRobot, free)'),
          h('pre', { className: 'sys-pre' }, origin + '/api/health'),
          this.help('Point a free uptime monitor at that address and it will email you if the site goes down — the one thing this page can’t do, because when the site is down, so is this page.')
        )),
        this.panel('Change the admin passphrase', h('form', { onSubmit: this.changePassphrase.bind(this) },
          h('div', { className: 'sys-p' }, 'Everyone else is signed out when it changes. If nobody knows the passphrase, someone with access to the server can set a new one in the .env file and restart (see HANDOVER.md).'),
          h('div', { className: 'sys-pass-grid' },
            h('input', { className: 'urb-input', type: 'password', placeholder: 'Current passphrase', autoComplete: 'current-password', value: pd.current, onChange: function (e) { setP({ current: e.target.value }); } }),
            h('input', { className: 'urb-input', type: 'password', placeholder: 'New passphrase (10+ characters)', autoComplete: 'new-password', value: pd.next, onChange: function (e) { setP({ next: e.target.value }); } }),
            h('input', { className: 'urb-input', type: 'password', placeholder: 'New passphrase again', autoComplete: 'new-password', value: pd.again, onChange: function (e) { setP({ again: e.target.value }); } })
          ),
          h('div', { className: 'sys-btns', style: { marginTop: 10 } }, h('button', { type: 'submit', className: 'btn btn-md btn-primary', disabled: !pd.current || !pd.next }, 'Change passphrase'))
        ))
      );
    }

    renderHandover() {
      var ov = this.state.ov;
      if (!ov) return this.panel('Handover', h('div', { className: 'urb-row-sub' }, 'Loading…'));
      var d = this.state.handoverDraft || ov.config.handover;
      var set = function (k, v) { var nd = Object.assign({}, d); nd[k] = v; this.setState({ handoverDraft: nd }); }.bind(this);
      var field = function (k, label, ph) {
        return h('div', { key: k, className: 'urb-field' }, h('div', { className: 'urb-label' }, label),
          h('input', { className: 'urb-input', value: d[k], placeholder: ph, onChange: function (e) { set(k, e.target.value); } }));
      };
      var s = ov.server;
      return h(React.Fragment, null,
        this.panel('Notes for whoever runs this next', h(React.Fragment, null,
          h('div', { className: 'sys-p' }, 'Write down what the next person will need. This is saved in the database, so it’s in every backup. Never put passwords here — say where they’re kept instead.'),
          field('owner', 'Who looks after the site now', 'e.g. Station Manager 2026–27 — name, email'),
          field('hosting', 'Where the server is hosted, and who pays', 'e.g. DigitalOcean droplet, billed to the URB card, login in the committee password manager'),
          field('domain', 'Domain registrar', 'e.g. Namecheap — account under urb@…, auto-renew on'),
          field('domainRenews', 'Domain renewal date', 'e.g. 14 March every year'),
          field('stream', 'Who runs the live stream server', 'e.g. University IT — urb-ice.bath.ac.uk'),
          h('div', { className: 'urb-field' }, h('div', { className: 'urb-label' }, 'Anything else'),
            h('textarea', { className: 'urb-textarea', rows: 6, value: d.notes, placeholder: 'Quirks, contacts, what to do each year…', onChange: function (e) { set('notes', e.target.value); } })),
          h('div', { className: 'sys-btns' }, this.btn('Save notes', function () { this.saveConfig({ handover: d }, 'Handover notes saved.'); }.bind(this), 'primary', 'config'))
        )),
        this.panel('Where things are on the server', h('div', { className: 'sys-grid' },
          this.fact('Server name', s.hostname),
          this.fact('Operating system', s.platform),
          this.fact('Site files', s.appDir),
          this.fact('Database & images', s.dataDir),
          this.fact('Backups', s.backupDir),
          this.fact('Second backup copy', s.mirrorDir || 'not set'),
          this.fact('Node.js', s.node)
        )),
        this.panel('If something breaks', h('ul', { className: 'sys-list' },
          h('li', null, h('b', null, 'Bookings vanished or look wrong: '), 'Backups tab → restore last night’s backup. The current state is saved first, so it’s safe to try.'),
          h('li', null, h('b', null, 'Site won’t load at all: '), 'Check the domain hasn’t expired (registrar), then ask whoever has server access to restart it — HANDOVER.md has the exact commands.'),
          h('li', null, h('b', null, 'Server lost completely: '), 'Set up a new one (HANDOVER.md), open /system, and restore the latest portable backup from the shared drive.'),
          h('li', null, h('b', null, 'Nobody knows the passphrase: '), 'Someone with server access edits ADMIN_PASSPHRASE in .env and restarts the site.'),
          h('li', null, h('b', null, 'Listen Live player silent: '), 'Health tab shows whether the stream answers. If it moved, change the stream address on the Settings tab.')
        ))
      );
    }

    renderSignIn() {
      return h('div', { className: 'urb-admin-panel sys-signin' },
        h('form', { onSubmit: this.signIn.bind(this) },
          h('div', { className: 'urb-admin-title' }, 'Sign in'),
          h('div', { className: 'sys-p' }, 'This page is for whoever looks after the site. Use the admin passphrase.'),
          h('input', { className: 'urb-input', type: 'password', autoFocus: true, autoComplete: 'current-password', placeholder: 'Admin passphrase', value: this.state.pass, onChange: function (e) { this.setState({ pass: e.target.value }); }.bind(this) }),
          this.state.loginError ? h('div', { className: 'urb-error', style: { marginTop: 8 } }, this.state.loginError) : null,
          h('div', { className: 'sys-btns', style: { marginTop: 10 } }, h('button', { className: 'btn btn-md btn-primary', type: 'submit', disabled: !this.state.pass || this.state.loginBusy }, this.state.loginBusy ? 'Signing in…' : 'Sign in'))
        )
      );
    }

    render() {
      var tab = this.state.tab;
      var ov = this.state.ov;
      var problems = ov ? (ov.health.checks || []).filter(function (c) { return c.status === 'fail'; }).length : 0;
      var body = this.state.signedIn === null ? null : !this.state.signedIn ? this.renderSignIn() : h(React.Fragment, null,
        h('div', { className: 'urb-admin-nav' }, TABS.map(function (t) {
          return h('button', { key: t[0], className: 'btn btn-sm' + (tab === t[0] ? ' btn-primary' : ''), onClick: function () { this.openTab(t[0]); }.bind(this) },
            t[1], t[0] === 'overview' && problems ? h('span', { className: 'sys-count' }, problems) : null);
        }, this)),
        this.state.msg ? h('div', { className: 'db-banner sys-okbanner' }, this.state.msg) : null,
        this.state.err ? h('div', { className: 'db-banner error' }, this.state.err) : null,
        tab === 'overview' ? this.renderOverview() : null,
        tab === 'backups' ? this.renderBackups() : null,
        tab === 'reset' ? this.renderReset() : null,
        tab === 'privacy' ? this.renderPrivacy() : null,
        tab === 'log' ? this.renderLog() : null,
        tab === 'settings' ? this.renderSettings() : null,
        tab === 'handover' ? this.renderHandover() : null
      );
      return h('div', { className: 'urb-page sys-page' },
        h('div', { className: 'urb-wrap' },
          h('div', { className: 'urb-toprow' },
            h('a', { className: 'btn btn-sm urb-download', href: '/book' }, '← Booking site'),
            h('div', { className: 'urb-spacer' }),
            h('button', { className: 'btn btn-sm', onClick: function () { this.setState(function (s) { return { dark: !s.dark }; }); }.bind(this) }, this.state.dark ? '☀ Light' : '☾ Dark'),
            this.state.signedIn ? h('button', { className: 'btn btn-sm', onClick: this.signOut.bind(this) }, 'Sign out') : null
          ),
          h('div', { className: 'urb-header' },
            h('img', { className: 'urb-logo', src: '/assets/logo.png', alt: 'URB' }),
            h('div', null,
              h('div', { className: 'urb-brand-title' }, 'URB System'),
              h('div', { className: 'urb-brand-sub' }, 'Health checks, backups, the yearly reset, privacy and the activity log')
            )
          ),
          body,
          h('div', { className: 'urb-footer' }, 'URB Studio Booking · System')
        ),
        this.renderConfirm()
      );
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    ReactDOM.createRoot(document.getElementById('root')).render(h(SystemPage));
  });
})();
