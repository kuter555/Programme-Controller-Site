/*
 * URB Show of the Week page (/show-of-the-week)
 * ---------------------------------------------
 * The week's 3 shortlisted shows: listen to their recordings, swap shows by hand,
 * choose the winner and download its logo. Talks to /api/sotw/*.
 */
(function () {
  'use strict';
  var h = React.createElement;
  var DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var POLL_MS = 30000;

  function api(method, url, body) {
    return fetch(url, {
      method: method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
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
  function parts(ds) { var p = ds.split('-').map(Number); return new Date(Date.UTC(p[0], p[1] - 1, p[2])); }
  function dayLabel(ds) { var d = parts(ds); return DAYS[(d.getUTCDay() + 6) % 7] + ' ' + d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()]; }
  function shortDate(d) { return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()]; }
  function hhmm(m) { m = ((m % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); }
  function weekRange(week) { var a = parts(week); return shortDate(a) + ' – ' + shortDate(new Date(a.getTime() + 6 * 86400000)); }
  function weekLabel(w) { return w.isThis ? 'This week' : w.isNext ? 'Next week' : weekRange(w.week); }
  function expiryLabel(iso) { var d = new Date(iso); return d.getDate() + ' ' + MONTHS[d.getMonth()]; }

  class ShowOfTheWeek extends React.Component {
    constructor(props) {
      super(props);
      var dark = false;
      try { dark = window.matchMedia('(prefers-color-scheme: dark)').matches; } catch (e) {}
      this.state = {
        dark: dark, signedIn: null, admin: false, passwordSet: false, pass: '', loginError: '', loginBusy: false,
        weeks: null, week: null, candidates: [], busy: false, err: '', newPass: '', passMsg: ''
      };
      api.onAuthLost = function () { this.setState({ signedIn: false, admin: false, loginError: 'Please sign in again.' }); }.bind(this);
    }
    componentDidMount() {
      this.syncTheme();
      api('GET', '/api/sotw/session').then(this.onSession.bind(this))
        .catch(function () { this.setState({ signedIn: false, loginError: 'Can’t reach the server.' }); }.bind(this));
      this._poll = setInterval(function () { if (this.state.signedIn && !document.hidden) this.loadWeeks(); }.bind(this), POLL_MS);
    }
    componentWillUnmount() { clearInterval(this._poll); }
    componentDidUpdate() { this.syncTheme(); }
    syncTheme() { document.documentElement.setAttribute('data-theme', this.state.dark ? 'dark' : 'light'); }
    onSession(d) {
      this.setState({ signedIn: d.signedIn, admin: d.admin, passwordSet: d.passwordSet });
      if (d.signedIn) this.loadWeeks();
    }
    loadWeeks() { return api('GET', '/api/sotw/weeks').then(this.setWeeks.bind(this)).catch(function (e) { this.setState({ err: e.message }); }.bind(this)); }
    setWeeks(weeks) {
      var cur = this.state.week;
      if (!cur || !weeks.some(function (w) { return w.week === cur; })) {
        var preferred = weeks.filter(function (w) { return w.isThis && w.picks.length; })[0] || weeks.filter(function (w) { return w.isNext; })[0] || weeks[0];
        cur = preferred ? preferred.week : null;
      }
      var changed = cur !== this.state.week;
      this.setState({ weeks: weeks, week: cur });
      if (changed || !this.state.candidates.length) this.loadCandidates(cur);
    }
    loadCandidates(week) {
      if (!week) return;
      api('GET', '/api/sotw/weeks/' + week + '/candidates').then(function (c) { this.setState({ candidates: c }); }.bind(this)).catch(function () {});
    }
    openWeek(week) { this.setState({ week: week, candidates: [] }); this.loadCandidates(week); }
    act(method, url, body) {
      this.setState({ busy: true, err: '' });
      return api(method, url, body).then(function (weeks) { this.setState({ busy: false }); this.setWeeks(weeks); this.loadCandidates(this.state.week); }.bind(this))
        .catch(function (e) { this.setState({ busy: false, err: e.message }); }.bind(this));
    }
    signIn(e) {
      e.preventDefault();
      this.setState({ loginBusy: true, loginError: '' });
      api('POST', '/api/sotw/login', { password: this.state.pass }).then(function (d) {
        this.setState({ loginBusy: false, pass: '' });
        this.onSession(d);
      }.bind(this)).catch(function (err) { this.setState({ loginBusy: false, loginError: err.message }); }.bind(this));
    }
    signOut() {
      api('POST', '/api/sotw/logout').catch(function () {});
      this.setState({ signedIn: false, admin: false, weeks: null, week: null });
    }
    savePassword() {
      var next = this.state.newPass;
      this.setState({ passMsg: '' });
      api('PUT', '/api/sotw/password', { password: next }).then(function (d) {
        this.setState({ passwordSet: d.passwordSet, newPass: '', passMsg: d.passwordSet ? 'Saved. Give this to the team; anyone already signed in with the old one will need the new one.' : 'Removed. Only the admin passphrase opens this page now.' });
      }.bind(this)).catch(function (e) { this.setState({ passMsg: e.message }); }.bind(this));
    }

    /* ---------- pieces ---------- */
    renderStatus(p) {
      var slot = dayLabel(p.date) + ', ' + hhmm(p.recFromMin) + '–' + hhmm(p.recToMin);
      switch (p.status) {
        case 'scheduled': return h('div', { className: 'sotw-status' }, 'Will record ' + slot);
        case 'recording': return h('div', { className: 'sotw-status sotw-live' }, h('span', { className: 'sotw-dot' }), 'Recording now, until ' + hhmm(p.recToMin));
        case 'ready': return h('div', null,
          h('audio', { className: 'sotw-audio', controls: true, preload: 'none', src: '/api/sotw/picks/' + p.id + '/audio' }),
          h('div', { className: 'sotw-status' }, 'Recorded ' + slot + '. Deleted on ' + expiryLabel(p.expires) + '.'),
          p.partialMinutes != null ? h('div', { className: 'urb-warn-box' }, 'Only about ' + p.partialMinutes + ' minutes were captured' + (p.error ? ' (' + p.error + ')' : '') + '.') : null);
        case 'missed': return h('div', { className: 'urb-warn-box' }, 'Not recorded: its slot (' + slot + ') had already passed.');
        case 'failed': return h('div', { className: 'urb-warn-box' }, 'The recording failed' + (p.error ? ' (' + p.error + ')' : '') + '.');
        case 'off_schedule': return h('div', { className: 'urb-warn-box' }, 'This show has left the schedule. Swap it for another.');
        case 'expired': return h('div', { className: 'sotw-status' }, 'The recording has been deleted (kept for 2 weeks).');
        default: return null;
      }
    }
    renderPick(p, w) {
      var taken = w.picks.map(function (x) { return x.bookingId; });
      var options = this.state.candidates.filter(function (c) { return taken.indexOf(c.id) < 0; });
      return h('div', { key: p.id, className: 'sotw-card' + (p.chosen ? ' chosen' : '') },
        h('div', { className: 'sotw-head' },
          h('img', { className: 'sotw-logo', src: p.logo, alt: '' }),
          h('div', { style: { minWidth: 0, flex: 1 } },
            p.chosen ? h('div', { className: 'sotw-badge' }, '★ Show of the Week') : null,
            h('div', { className: 'sotw-title' }, p.title),
            h('div', { className: 'urb-row-sub' }, p.presenter),
            h('div', { className: 'urb-row-sub' }, dayLabel(p.date) + ', ' + hhmm(p.startMin) + '–' + hhmm(p.endMin)),
            p.category ? h('span', { className: 'urb-key-item', style: { marginTop: '4px' } }, h('span', { className: 'urb-key-dot', style: { background: p.color } }), p.category) : null
          )
        ),
        this.renderStatus(p),
        h('div', { className: 'sotw-actions' },
          h('button', { className: 'btn btn-md ' + (p.chosen ? 'btn-ghost' : 'btn-primary'), disabled: this.state.busy, onClick: function () { this.act('POST', '/api/sotw/picks/' + p.id + '/choose', { chosen: !p.chosen }); }.bind(this) }, p.chosen ? 'Un-choose' : 'Choose this show'),
          p.chosen ? h('a', { className: 'btn btn-md btn-primary sotw-link', href: '/api/sotw/picks/' + p.id + '/logo', download: '' }, '⬇ Download logo') : null
        ),
        p.chosen && !p.ownLogo ? h('div', { className: 'sotw-status' }, 'This show has no logo of its own, so this is the default URB one.') : null,
        h('select', {
          className: 'urb-select sotw-swap', value: '', disabled: this.state.busy,
          onChange: function (e) {
            var id = e.target.value; if (!id) return;
            if (p.hasAudio && !window.confirm('Swapping deletes the recording of “' + p.title + '”. Carry on?')) return;
            this.act('POST', '/api/sotw/weeks/' + w.week + '/picks', { bookingId: id, replacePickId: p.id });
          }.bind(this)
        },
          h('option', { value: '' }, 'Swap for another show…'),
          options.map(function (c) { return h('option', { key: c.id, value: c.id }, c.title + ' (' + dayLabel(c.date) + ', ' + hhmm(c.startMin) + ')' + (c.canRecord ? '' : ' — already aired')); })
        )
      );
    }
    renderWeek(w) {
      var taken = w.picks.map(function (x) { return x.bookingId; });
      var options = this.state.candidates.filter(function (c) { return taken.indexOf(c.id) < 0; });
      var filler = w.picks.length < 3;
      return h('div', null,
        h('div', { className: 'sotw-weekbar' },
          h('div', null,
            h('div', { className: 'sotw-weektitle' }, weekRange(w.week)),
            h('div', { className: 'urb-row-sub' }, w.manual ? 'Edited by hand, so the automatic draw won’t change this week.' : 'Drawn automatically.')
          ),
          h('button', {
            className: 'btn btn-md', disabled: this.state.busy,
            onClick: function () {
              if (window.confirm('Draw again at random? Shows already recorded, being recorded or chosen are kept.')) this.act('POST', '/api/sotw/weeks/' + w.week + '/redraw');
            }.bind(this)
          }, '↻ Re-draw')
        ),
        this.state.err ? h('div', { className: 'urb-error-box' }, this.state.err) : null,
        h('div', { className: 'sotw-grid' }, w.picks.map(function (p) { return this.renderPick(p, w); }, this)),
        filler ? h('div', { className: 'sotw-card sotw-add' },
          h('div', { className: 'urb-row-title' }, w.picks.length ? 'Add another show' : 'No shows shortlisted for this week'),
          h('div', { className: 'urb-row-sub', style: { marginBottom: '8px' } }, options.length ? 'Pick one by hand, or use Re-draw.' : 'Nothing is booked in Studio One that week yet. The site keeps checking.'),
          options.length ? h('select', {
            className: 'urb-select', value: '', disabled: this.state.busy,
            onChange: function (e) { if (e.target.value) this.act('POST', '/api/sotw/weeks/' + w.week + '/picks', { bookingId: e.target.value }); }.bind(this)
          },
            h('option', { value: '' }, 'Add a show…'),
            options.map(function (c) { return h('option', { key: c.id, value: c.id }, c.title + ' (' + dayLabel(c.date) + ', ' + hhmm(c.startMin) + ')' + (c.canRecord ? '' : ' — already aired')); })
          ) : null
        ) : null
      );
    }
    renderPassword() {
      if (!this.state.admin) return null;
      return h('div', { className: 'urb-admin-panel urb-page-panel' },
        h('div', { className: 'urb-admin-title' }, 'Team password'),
        h('div', { className: 'urb-row-sub', style: { marginBottom: '10px' } }, this.state.passwordSet
          ? 'A password is set. The team uses it to open this page, and it doesn’t give them admin access. Only admins see this box.'
          : 'No team password yet, so only the admin passphrase opens this page. Set one to let the team in without giving them admin access.'),
        h('div', { className: 'sys-btns' },
          h('input', { className: 'urb-input sys-grow', type: 'password', autoComplete: 'new-password', placeholder: 'New password (8+ characters)', value: this.state.newPass, onChange: function (e) { this.setState({ newPass: e.target.value, passMsg: '' }); }.bind(this) }),
          h('button', { className: 'btn btn-md btn-primary', disabled: !this.state.newPass, onClick: this.savePassword.bind(this) }, 'Save password'),
          this.state.passwordSet ? h('button', { className: 'btn btn-md btn-danger', onClick: function () { if (window.confirm('Remove the team password? The team will be signed out.')) { this.setState({ newPass: '' }, this.savePassword.bind(this)); } }.bind(this) }, 'Remove') : null
        ),
        this.state.passMsg ? h('div', { className: 'sys-help' }, this.state.passMsg) : null
      );
    }
    render() {
      var s = this.state;
      if (s.signedIn === null) return h('div', { className: 'urb-page' });
      if (!s.signedIn) {
        return h('div', { className: 'urb-page' },
          h('div', { className: 'urb-wrap sotw-login' },
            h('form', { className: 'urb-card', onSubmit: this.signIn.bind(this) },
              h('div', { className: 'urb-card-head' }, h('span', null, '★'), h('div', { className: 'urb-card-head-title' }, 'Show of the Week')),
              h('div', { className: 'urb-card-body' },
                h('div', { className: 'urb-field' }, h('div', { className: 'urb-label' }, 'Password'),
                  h('input', { className: 'urb-input', type: 'password', autoComplete: 'current-password', autoFocus: true, value: s.pass, onChange: function (e) { this.setState({ pass: e.target.value }); }.bind(this) })),
                s.loginError ? h('div', { className: 'urb-error-box' }, s.loginError) : null,
                h('button', { className: 'btn btn-md btn-primary', style: { width: '100%' }, disabled: s.loginBusy || !s.pass, type: 'submit' }, s.loginBusy ? 'Checking…' : 'Sign in')
              )
            )
          )
        );
      }
      var weeks = s.weeks || [];
      var current = weeks.filter(function (w) { return w.week === s.week; })[0];
      return h('div', { className: 'urb-page' },
        h('div', { className: 'urb-wrap' },
          h('div', { className: 'urb-header' },
            h('div', null,
              h('div', { className: 'urb-brand-title' }, 'Show of the Week'),
              h('div', { className: 'urb-brand-sub' }, 'Three shows drawn every Sunday. Listen back, then choose one.')
            ),
            h('div', { className: 'urb-spacer' }),
            h('div', { className: 'urb-header-actions' },
              h('button', { className: 'btn btn-md', onClick: function () { this.setState({ dark: !s.dark }); }.bind(this) }, s.dark ? '☀ Light' : '☾ Dark'),
              h('button', { className: 'btn btn-md', onClick: this.signOut.bind(this) }, 'Sign out')
            )
          ),
          h('div', { className: 'urb-admin-nav' }, weeks.map(function (w) {
            return h('button', { key: w.week, className: 'btn btn-sm' + (w.week === s.week ? ' btn-primary' : ''), onClick: function () { this.openWeek(w.week); }.bind(this) },
              weekLabel(w) + (w.picks.some(function (p) { return p.chosen; }) ? ' ★' : ''));
          }, this)),
          s.weeks === null ? h('div', { className: 'urb-empty' }, 'Loading…') : current ? this.renderWeek(current) : h('div', { className: 'urb-empty' }, 'The first draw hasn’t happened yet. It appears here within a few minutes.'),
          this.renderPassword()
        )
      );
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    ReactDOM.createRoot(document.getElementById('root')).render(h(ShowOfTheWeek));
  });
})();
