/*
 * URB Listen Live widget
 * ----------------------
 * Drop-in player for other websites. Put an empty element with
 * id="urb-listen-live" on the page and load this script; it fills that element
 * with a player that streams URB live and shows what's on now (from the
 * booking site's Studio One schedule), using the show's icon or the URB logo.
 *
 * Optional settings, set before the script loads:
 *   window.URB_LISTEN_LIVE = { target: 'urb-listen-live', theme: 'light' | 'dark' };
 *
 * Plain ES5 on purpose — it runs on whatever site embeds it.
 */
(function () {
  'use strict';
  if (window.__urbListenLiveLoaded) return;
  window.__urbListenLiveLoaded = true;

  var STREAMS = [
    'https://urb-ice.bath.ac.uk/urb/320.mp3',
    'https://urb-ice.bath.ac.uk/urb/128.mp3' // fallback if the 320 mount fails
  ];
  var REFRESH_MS = 60000;

  var cfg = window.URB_LISTEN_LIVE || {};
  var targetId = cfg.target || 'urb-listen-live';
  // Where this script (and the booking site) lives, so paths like /assets/logo.png resolve.
  var origin = 'https://urb-booking.co.uk';
  try {
    var me = document.currentScript;
    if (me && me.src) origin = new URL(me.src).origin;
  } catch (e) {}
  function abs(path) { return !path ? null : /^https?:/.test(path) ? path : origin + path; }

  // Fonts must be declared on the page itself (not inside the shadow root) to load.
  function addFonts() {
    if (document.getElementById('urb-ll-fonts')) return;
    var st = document.createElement('style');
    st.id = 'urb-ll-fonts';
    st.textContent =
      "@font-face{font-family:'URB Futura';src:url('" + origin + "/fonts/futura-500.ttf') format('truetype');font-weight:500;font-display:swap;}" +
      "@font-face{font-family:'URB Futura';src:url('" + origin + "/fonts/futura-800.ttf') format('truetype');font-weight:800;font-display:swap;}";
    document.head.appendChild(st);
  }

  var CSS = [
    /* Fill whatever box the host gives us: full width, and full height if it has one. */
    ':host{all:initial;display:block;width:100%;height:100%;}',
    '.card{--brand:#542f7b;--ink:#542f7b;--dim:#6f5a88;--bg:#ffffff;--line:#d9cdea;--accent:#7b4fb0;--chip:#f3eef9;--art-bg:#ffffff;',
    '  display:flex;align-items:stretch;box-sizing:border-box;width:100%;height:100%;min-height:96px;',
    '  background:var(--bg);border:1px solid var(--line);border-radius:0;overflow:hidden;container-type:inline-size;',
    "  font-family:'URB Futura','Futura','Futura PT',Helvetica,Arial,sans-serif;color:var(--ink);box-shadow:0 2px 10px rgba(84,47,123,.10);cursor:pointer;",
    '  -webkit-tap-highlight-color:transparent;user-select:none;}',
    '.card.dark{--ink:#efe6fa;--dim:#b9a6cf;--bg:#1d1029;--line:#3d2758;--accent:#b894e0;--chip:#2d1b40;--art-bg:#2a1840;box-shadow:0 2px 10px rgba(0,0,0,.4);}',
    '.card:focus-visible{outline:3px solid var(--accent);outline-offset:2px;}',
    /* square artwork on the left: as tall as the player, always square */
    '.art{position:relative;flex:none;align-self:stretch;width:96px;background:var(--art-bg);border-right:1px solid var(--line);}',
    '.art img{position:absolute;inset:0;display:block;width:100%;height:100%;object-fit:cover;}',
    '.art img.logo{object-fit:contain;padding:6%;box-sizing:border-box;}',
    /* play/pause sits in the corner so the artwork stays visible */
    '.play{position:absolute;inset:0;display:flex;align-items:flex-end;justify-content:flex-end;padding:6px;transition:background .15s;}',
    '.card:hover .play{background:rgba(84,47,123,.10);}',
    '.btn{width:34px;height:34px;border-radius:0;background:var(--brand);display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(0,0,0,.3);transition:transform .12s;}',
    '.card.dark .btn{background:#7b4fb0;}',
    '.card:hover .btn{transform:scale(1.08);}',
    '.btn svg{width:16px;height:16px;fill:#fff;}',
    '.spin{width:14px;height:14px;border:3px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:spin .8s linear infinite;}',
    '@keyframes spin{to{transform:rotate(360deg);}}',
    /* text — grows a little with the width of the container */
    '.info{flex:1;min-width:0;padding:10px 16px;display:flex;flex-direction:column;justify-content:center;gap:4px;}',
    '.badge{display:inline-flex;align-items:center;gap:6px;align-self:flex-start;font-size:clamp(10.5px,1.6cqw,13px);font-weight:800;letter-spacing:.09em;text-transform:uppercase;color:#fff;background:var(--brand);padding:3px 8px 2px;border-radius:0;}',
    '.card.dark .badge{background:#7b4fb0;}',
    '.badge.off{background:var(--chip) !important;color:var(--dim);}',
    '.dot{width:6px;height:6px;border-radius:50%;background:#fff;animation:pulse 1.6s ease-in-out infinite;}',
    '@keyframes pulse{0%,100%{opacity:1;}50%{opacity:.3;}}',
    '.title{font-size:clamp(16px,3.4cqw,28px);font-weight:800;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '.sub{font-size:clamp(12.5px,2.1cqw,17px);font-weight:500;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '.err{color:#c0392b;}',
    '.card.dark .err{color:#ff8a80;}',
    /* equaliser shown while playing */
    '.eq{display:none;align-items:flex-end;gap:2px;height:14px;margin-left:4px;}',
    '.card.playing .eq{display:inline-flex;}',
    '.eq i{display:block;width:3px;background:currentColor;animation:eq 1s ease-in-out infinite;}',
    '.eq i:nth-child(2){animation-delay:-.4s;}.eq i:nth-child(3){animation-delay:-.7s;}',
    '@keyframes eq{0%,100%{height:3px;}50%{height:14px;}}',
    '@media (prefers-reduced-motion:reduce){.dot,.eq i,.spin{animation:none;}}',
    '@container (max-width:340px){.card{min-height:80px;}.info{padding:8px 12px;}}'
  ].join('\n');

  var ICON_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>';
  var ICON_PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';

  function el(tag, cls, parent) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (parent) parent.appendChild(n);
    return n;
  }

  function mount(host) {
    if (host.__urbLL) return;
    host.__urbLL = true;
    addFonts();

    var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    var style = el('style', null, root);
    style.textContent = CSS;

    var theme = cfg.theme || host.getAttribute('data-theme') || 'light';
    var card = el('div', 'card' + (theme === 'dark' ? ' dark' : ''), root);
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');

    var art = el('div', 'art', card);
    var img = el('img', 'logo', art);
    img.alt = '';
    img.src = abs('/assets/listen-logo.png');
    var overlay = el('div', 'play', art);
    var btn = el('div', 'btn', overlay);

    var info = el('div', 'info', card);
    var badge = el('div', 'badge', info);
    var title = el('div', 'title', info);
    var sub = el('div', 'sub', info);

    var audio = new Audio();
    audio.preload = 'none';
    var state = 'idle';       // idle | loading | playing | error
    var streamIdx = 0;
    var now = { live: null, next: null };

    function setBadge(live) {
      badge.className = 'badge' + (live ? '' : ' off');
      badge.innerHTML = live
        ? '<span class="dot"></span>On now<span class="eq"><i></i><i></i><i></i></span>'
        : 'Listen live<span class="eq"><i></i><i></i><i></i></span>';
    }

    function render() {
      var live = now.live;
      var labelTitle = live ? live.title : 'Automation Playlist';
      // Square on the left: the show's own icon if it has one, otherwise the URB logo.
      var art = live && live.image ? abs(live.image) : abs('/assets/listen-logo.png');
      if (img.getAttribute('src') !== art) {
        img.src = art;
        img.className = live && live.image ? '' : 'logo';
      }
      setBadge(!!live);
      if (live) {
        title.textContent = live.title;
        sub.textContent = 'with ' + live.presenter + ' · ' + live.start + '–' + live.end;
      } else {
        // Nothing booked in Studio One: the automated playlist is on air.
        title.textContent = 'Automation Playlist';
        sub.textContent = 'Curated by our URB DJs';
      }
      if (state === 'error') {
        sub.textContent = 'Stream unavailable — tap to try again';
        sub.className = 'sub err';
      } else {
        sub.className = 'sub';
      }
      card.className = 'card' + (theme === 'dark' ? ' dark' : '') + (state === 'playing' ? ' playing' : '');
      btn.innerHTML = state === 'loading' ? '<div class="spin"></div>' : state === 'playing' ? ICON_PAUSE : ICON_PLAY;
      var label = (state === 'playing' ? 'Pause URB live' : 'Play URB live') + ': ' + labelTitle;
      card.setAttribute('aria-label', label);
      card.title = label;
      updateMediaSession();
    }

    // Lock screen / headphone controls on phones.
    function updateMediaSession() {
      if (!('mediaSession' in navigator) || !window.MediaMetadata) return;
      var live = now.live;
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: live ? live.title : 'Automation Playlist',
          artist: live ? live.presenter : 'Curated by our URB DJs',
          album: 'URB live',
          artwork: [{ src: live && live.image ? abs(live.image) : abs('/assets/listen-logo.png'), sizes: '512x512' }]
        });
      } catch (e) {}
    }

    function refresh() {
      var x = new XMLHttpRequest();
      x.open('GET', origin + '/api/now');
      x.onload = function () {
        if (x.status !== 200) return;
        try { now = JSON.parse(x.responseText); render(); } catch (e) {}
      };
      x.send();
    }

    function play() {
      state = 'loading'; render();
      // Fresh URL each time so we join the live stream now, not replay an old buffer.
      audio.src = STREAMS[streamIdx] + '?t=' + Date.now();
      var p = audio.play();
      if (p && p.catch) p.catch(function () { if (state === 'loading') { state = 'idle'; render(); } });
    }
    function stop() {
      audio.pause();
      audio.removeAttribute('src'); // stop downloading the stream
      audio.load();
      state = 'idle'; render();
    }
    function toggle() {
      if (state === 'playing' || state === 'loading') stop();
      else { streamIdx = 0; play(); }
    }

    audio.addEventListener('playing', function () { state = 'playing'; render(); });
    audio.addEventListener('waiting', function () { if (state === 'playing') { state = 'loading'; render(); } });
    audio.addEventListener('error', function () {
      if (state === 'idle') return; // error from clearing src in stop()
      if (streamIdx < STREAMS.length - 1) { streamIdx++; play(); return; }
      state = 'error'; render();
    });

    card.addEventListener('click', toggle);
    card.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.setActionHandler('play', function () { if (state !== 'playing') play(); });
        navigator.mediaSession.setActionHandler('pause', stop);
        navigator.mediaSession.setActionHandler('stop', stop);
      } catch (e) {}
    }

    // Keep the artwork exactly square: as wide as the player is tall, whatever
    // size the host container makes it.
    function fitArt() { var ht = card.clientHeight; if (ht) art.style.width = ht + 'px'; }
    if (window.ResizeObserver) new ResizeObserver(fitArt).observe(card);
    else window.addEventListener('resize', fitArt);

    render();
    fitArt();
    refresh();
    setInterval(function () { if (!document.hidden) refresh(); }, REFRESH_MS);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
  }

  // Site builders often add blocks after the page loads, so keep looking for a while.
  function find() {
    var host = document.getElementById(targetId);
    if (host) { mount(host); return true; }
    return false;
  }
  if (!find()) {
    var tries = 0;
    var timer = setInterval(function () {
      if (find() || ++tries > 60) clearInterval(timer);
    }, 250);
  }
})();
