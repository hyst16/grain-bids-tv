// Grain bids TV display.
//   /<location-id>/      -> full-screen board for one location (e.g. /schuyler/)
//   /?loc=<location-id>  -> same thing
//   /                    -> directory of location links (for setting up PosterBooking)
(function () {
  'use strict';

  var REFRESH_MS = 600000;                 // re-fetch data every 10 minutes
  var RELOAD_MS = 6 * 60 * 60 * 1000;      // full reload every 6 hours to pick up code changes
  // The scraper writes at least every 30 min (HEARTBEAT_MINUTES); allow for GitHub cron delays.
  var STALE_MINUTES = 75;
  var TZ = 'America/Chicago';
  var FS_MIN = 0.5;
  var FS_MAX = 1.8;

  var cropClassMap = {
    corn: 'crop-corn', soy: 'crop-soy', wheat: 'crop-wheat', milo: 'crop-milo',
    oats: 'crop-oats', barley: 'crop-barley', beans: 'crop-beans'
  };
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // Resolve data/ relative to this script so location subfolders work too.
  var scriptSrc = document.currentScript && document.currentScript.src;
  var DATA_URL = new URL('data/grain-bids.json', scriptSrc || location.href).href;
  var SITE_ROOT = new URL('./', scriptSrc || location.href).href;

  var locationId = document.body.getAttribute('data-location') ||
    new URLSearchParams(location.search).get('loc') || '';

  var lastPayload = null;
  var fetchFailed = false;
  var ui = {};

  // ---------- Helpers ----------
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function fmtTime(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return '—';
    var time = d.toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
    var day = d.toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' });
    return time + ' CT · ' + day;
  }

  function ym(s) {
    var m = /^(\d{4})-(\d{2})/.exec(s || '');
    return m ? { y: m[1].slice(2), m: MONTHS[parseInt(m[2], 10) - 1] } : null;
  }

  // "2026-10-01".."2026-10-31" -> "Oct '26";  "2026-10-01".."2026-11-30" -> "Oct–Nov '26"
  function fmtDelivery(start, end) {
    var a = ym(start), b = ym(end);
    if (!a) return '—';
    if (!b || (a.y === b.y && a.m === b.m)) return a.m + " '" + a.y;
    if (a.y === b.y) return a.m + '–' + b.m + " '" + a.y;
    return a.m + " '" + a.y + '–' + b.m + " '" + b.y;
  }

  // Futures change in $/bu -> cents: 0.03 -> "▲ 3¢", -0.0675 -> "▼ 6.75¢"
  function fmtChange(v) {
    if (typeof v !== 'number' || !isFinite(v)) return { text: '—', cls: '' };
    var s = String(Math.round(Math.abs(v) * 10000) / 100) + '¢';
    if (v > 0) return { text: '▲ ' + s, cls: 'up' };
    if (v < 0) return { text: '▼ ' + s, cls: 'down' };
    return { text: 'UNCH', cls: '' };
  }

  function fmtBasis(v) {
    if (typeof v !== 'number' || !isFinite(v)) return '—';
    return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(2);
  }

  function fmtCash(v, fallback) {
    return typeof v === 'number' && isFinite(v) ? '$' + v.toFixed(2) : (fallback || '—');
  }

  // ---------- Stage (fixed 1920x1080, scaled to the screen) ----------
  function buildStage() {
    var stage = el('div');
    stage.id = 'stage';

    var top = el('header', 'top-bar');
    var title = el('div', 'title');
    ui.locName = el('span', 'title-main', 'Grain Bids');
    title.appendChild(ui.locName);
    title.appendChild(el('span', 'title-sub', 'Cash Bids · Frontier Cooperative'));
    top.appendChild(title);
    var upd = el('div', 'updated');
    upd.appendChild(el('span', 'updated-label', 'Last updated'));
    ui.updatedTime = el('span', 'updated-time', 'Loading…');
    upd.appendChild(ui.updatedTime);
    top.appendChild(upd);

    ui.board = el('main', 'board');
    var bottom = el('footer', 'bottom-bar');
    ui.notices = el('div', 'notices');
    bottom.appendChild(ui.notices);

    stage.appendChild(top);
    stage.appendChild(ui.board);
    stage.appendChild(bottom);
    document.body.appendChild(stage);
    ui.stage = stage;
    ui.topBar = top;
  }

  function fitStage() {
    var s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    var x = (window.innerWidth - 1920 * s) / 2;
    var y = (window.innerHeight - 1080 * s) / 2;
    ui.stage.style.transform = 'translate(' + x + 'px,' + y + 'px) scale(' + s + ')';
  }

  // Largest text scale at which no panel overflows (binary search).
  function fitBoard() {
    var panels = ui.board.querySelectorAll('.crop-panel');
    function fits() {
      for (var i = 0; i < panels.length; i++) {
        var p = panels[i];
        if (p.scrollHeight > p.clientHeight + 1 || p.scrollWidth > p.clientWidth + 1) return false;
      }
      return true;
    }
    ui.stage.style.removeProperty('--row-h');
    var lo = FS_MIN, hi = FS_MAX;
    for (var i = 0; i < 12; i++) {
      var mid = (lo + hi) / 2;
      ui.stage.style.setProperty('--fs', mid);
      if (fits()) lo = mid; else hi = mid;
    }
    ui.stage.style.setProperty('--fs', lo);

    // Text is usually width-bound; spread rows over the leftover height so panels don't end half-empty.
    // Same row height in every panel so the delivery months line up across crops.
    var maxRows = 0, avail = Infinity;
    for (var j = 0; j < panels.length; j++) {
      var p = panels[j];
      var rows = p.querySelectorAll('tbody tr').length;
      maxRows = Math.max(maxRows, rows);
      var used = p.querySelector('.crop-head').offsetHeight + p.querySelector('thead').offsetHeight;
      avail = Math.min(avail, p.clientHeight - used);
    }
    if (maxRows && isFinite(avail)) {
      ui.stage.style.setProperty('--row-h', Math.floor(avail / maxRows) + 'px');
    }
  }

  // ---------- Location board ----------
  function cropRows(c) {
    if (c.bids && c.bids.length) return c.bids;
    // Older payloads without the full list: show the single summary price.
    return [{ deliveryStart: c.deliveryStart, deliveryEnd: c.deliveryEnd, basisMonth: c.basisMonth,
      futuresChange: c.futuresChange, basis: c.basis, cash: c.cash, price: c.price }];
  }

  function renderPanel(c) {
    var panel = el('section', 'crop-panel ' + (cropClassMap[c.color] || 'crop-other'));
    var head = el('h2', 'crop-head');
    head.appendChild(el('span', null, c.name));
    if (c.location) head.appendChild(el('span', 'crop-location', c.location));
    panel.appendChild(head);

    var table = el('table', 'bids');
    var thead = el('thead');
    var hr = el('tr');
    ['Delivery', 'Futures', 'Change', 'Basis', 'Cash'].forEach(function (h) { hr.appendChild(el('th', null, h)); });
    thead.appendChild(hr);
    table.appendChild(thead);

    var tbody = el('tbody');
    cropRows(c).forEach(function (b) {
      var tr = el('tr');
      tr.appendChild(el('td', 'c-delivery', fmtDelivery(b.deliveryStart, b.deliveryEnd)));
      tr.appendChild(el('td', 'c-futures', b.basisMonth || '—'));
      var chg = fmtChange(b.futuresChange);
      tr.appendChild(el('td', 'c-change ' + chg.cls, chg.text));
      tr.appendChild(el('td', 'c-basis', fmtBasis(b.basis)));
      tr.appendChild(el('td', 'c-cash', fmtCash(b.cash, b.price)));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    panel.appendChild(table);
    return panel;
  }

  function renderLocation(payload, loc) {
    document.title = loc.label + ' · Grain Bids';
    ui.locName.textContent = loc.label;
    ui.board.innerHTML = '';

    var crops = loc.crops || [];
    var cols = Math.min(Math.max(crops.length, 1), 3);
    ui.board.style.gridTemplateColumns = 'repeat(' + cols + ', minmax(0, 1fr))';
    ui.board.style.gridTemplateRows = 'repeat(' + Math.max(Math.ceil(crops.length / cols), 1) + ', minmax(0, 1fr))';
    crops.forEach(function (c) { ui.board.appendChild(renderPanel(c)); });
    if (!crops.length) ui.board.appendChild(el('div', 'board-message', 'No bids posted for this location.'));

    renderUpdated(payload);
    var notices = (loc.notices || []).filter(function (n) { return n && n !== 'Waiting for update'; });
    if (!notices.length) notices = ['Data provided by StoneX. All prices delayed 10 minutes.'];
    var warn = [];
    if (fetchFailed) warn.push('Connection issue — showing last loaded prices');
    if (loc.ok === false) warn.push(loc.lastSuccessAt ? 'Showing last known prices' : 'Prices unavailable');
    renderNotices(warn, notices);
    fitBoard();
  }

  // ---------- Directory (site root) ----------
  function renderDirectory(payload) {
    document.body.classList.add('directory-mode');
    ui.locName.textContent = 'Grain Bids';
    ui.board.innerHTML = '';
    var locs = payload.locations || [];
    var cols = locs.length > 24 ? 6 : 4;
    ui.board.style.gridTemplateColumns = 'repeat(' + cols + ', minmax(0, 1fr))';
    ui.board.style.gridTemplateRows = 'repeat(' + Math.max(Math.ceil(locs.length / cols), 1) + ', minmax(0, 1fr))';
    locs.forEach(function (l) {
      var a = el('a', 'dir-link');
      a.href = SITE_ROOT + l.id + '/';
      a.title = SITE_ROOT + l.id + '/';
      a.appendChild(el('span', 'dir-name', l.label));
      ui.board.appendChild(a);
    });
    renderUpdated(payload);
    renderNotices(fetchFailed ? ['Connection issue'] : [],
      ['Each location has its own TV URL: ' + SITE_ROOT + '<location>/']);
  }

  function renderNotFound(payload) {
    ui.locName.textContent = 'Unknown location';
    ui.board.innerHTML = '';
    ui.board.style.gridTemplateColumns = '1fr';
    ui.board.appendChild(el('div', 'board-message', 'No location "' + locationId + '" in the feed.'));
    renderUpdated(payload);
    renderNotices([], []);
  }

  // ---------- Shared bars ----------
  function renderUpdated(payload) {
    var ts = payload && payload.generatedAt;
    ui.updatedTime.textContent = ts ? fmtTime(ts) : '—';
    var ageMin = ts ? (Date.now() - Date.parse(ts)) / 60000 : Infinity;
    ui.topBar.classList.toggle('is-stale', !(ageMin < STALE_MINUTES));
  }

  function renderNotices(warnings, notices) {
    ui.notices.innerHTML = '';
    warnings.forEach(function (n) { ui.notices.appendChild(el('span', 'notice warn', n)); });
    notices.forEach(function (n) { ui.notices.appendChild(el('span', 'notice', n)); });
  }

  function render(payload) {
    if (!locationId) return renderDirectory(payload);
    var loc = (payload.locations || []).filter(function (l) { return l.id === locationId; })[0];
    if (!loc) return renderNotFound(payload);
    renderLocation(payload, loc);
  }

  // ---------- Data ----------
  function loadData() {
    // Cache-buster: GitHub Pages serves JSON with a 10-minute max-age.
    fetch(DATA_URL + '?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (payload) {
        fetchFailed = false;
        lastPayload = payload;
        render(payload);
      })
      .catch(function (err) {
        console.error('Failed to load grain bids:', err);
        fetchFailed = true;
        if (lastPayload) return render(lastPayload);
        ui.board.innerHTML = '';
        ui.board.appendChild(el('div', 'board-message', 'Unable to load grain bids. Retrying…'));
        renderUpdated(null);
        renderNotices(['Connection issue'], []);
      });
  }

  buildStage();
  window.addEventListener('resize', fitStage);
  fitStage();
  loadData();
  setInterval(loadData, REFRESH_MS);
  // Re-check staleness every minute even between fetches.
  setInterval(function () { if (lastPayload) renderUpdated(lastPayload); }, 60000);
  setTimeout(function () { location.reload(); }, RELOAD_MS);
})();
