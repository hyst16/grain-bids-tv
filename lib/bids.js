// Turns the StoneX cash-bids widget into per-page TV data.
// No dependencies; loads in Node (scraper.js) and in a browser (for testing).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GrainBids = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Pages that merge several StoneX locations into one board. Every other
  // location in the widget automatically gets its own page.
  var COMBINED_PAGES = [
    { id: 'yanka-david-city', label: 'Yanka & David City', sources: ['Yanka', 'David City - Elevator'] },
  ];

  // Optional display-name overrides, keyed by the StoneX location name.
  var LABELS = {};

  // Locations that aren't Frontier's: their boards don't show Frontier branding.
  var NON_FRONTIER = ['Sire CB', 'AGP - David City'];

  // First matching pattern wins; list order is also the panel order on a board.
  // `color` must have a matching .crop-<color> class in styles.css.
  var CROP_NAME_MAP = [
    { re: /^corn/i, name: 'Corn', color: 'corn' },
    { re: /soy/i, name: 'Soybeans', color: 'soy' },
    { re: /wheat.*hrw|hrw/i, name: 'HRW Wheat', color: 'wheat' },
    { re: /wheat/i, name: 'Wheat', color: 'wheat' },
    { re: /milo|sorghum/i, name: 'Milo', color: 'milo' },
    { re: /oats/i, name: 'Oats', color: 'oats' },
    { re: /barley/i, name: 'Barley', color: 'barley' },
    { re: /beans/i, name: 'Beans', color: 'beans' },
  ];

  // Collapse whitespace; drop the space left before punctuation after a link ("StoneX .").
  function clean(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').replace(/\s+([.,;:])/g, '$1').trim();
  }

  function num(s) {
    var n = parseFloat(String(s).replace(/[^0-9.\-]/g, ''));
    return isFinite(n) ? n : null;
  }

  function slug(s) {
    return clean(s).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  // "10/01/26-10/31/26" -> ["2026-10-01", "2026-10-31"]
  function parseRange(s) {
    var m = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s*-\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(String(s));
    if (!m) return [null, null];
    function iso(mo, d, y) {
      return (y.length === 2 ? '20' + y : y) + '-' + ('0' + mo).slice(-2) + '-' + ('0' + d).slice(-2);
    }
    return [iso(m[1], m[2], m[3]), iso(m[4], m[5], m[6])];
  }

  // "Oct 26" -> ["2026-10-01", "2026-10-31"]; fallback when a row has no date range.
  var MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  function parseMonthLabel(s) {
    var m = /^([A-Za-z]{3})[a-z]*\.?\s+'?(\d{2}|\d{4})$/.exec(clean(s));
    var mi = m ? MONTHS.indexOf(m[1].toLowerCase()) : -1;
    if (mi < 0) return [null, null];
    var y = m[2].length === 2 ? 2000 + parseInt(m[2], 10) : parseInt(m[2], 10);
    var last = new Date(Date.UTC(y, mi + 1, 0)).getUTCDate();
    var mm = ('0' + (mi + 1)).slice(-2);
    return [y + '-' + mm + '-01', y + '-' + mm + '-' + ('0' + last).slice(-2)];
  }

  function cropInfo(raw) {
    for (var i = 0; i < CROP_NAME_MAP.length; i++) {
      if (CROP_NAME_MAP[i].re.test(raw)) return { name: CROP_NAME_MAP[i].name, color: CROP_NAME_MAP[i].color, order: i };
    }
    return { name: clean(raw), color: 'other', order: CROP_NAME_MAP.length };
  }

  // Runs inside the widget page (Playwright page.evaluate), so it may only use the DOM.
  function extractWidget() {
    var squash = function (s) { return (s || '').replace(/\s+/g, ' ').replace(/\s+([.,;:])/g, '$1').trim(); };
    var groups = Array.prototype.map.call(document.querySelectorAll('.bid-group'), function (g) {
      var nameEl = g.querySelector('.bid-group-name');
      return {
        name: squash(nameEl && nameEl.textContent),
        tables: Array.prototype.map.call(g.querySelectorAll('.bid-table'), function (t) {
          var cropEl = t.querySelector('.bid-table-name');
          return {
            crop: squash(cropEl && cropEl.textContent),
            rows: Array.prototype.map.call(t.querySelectorAll('.bid-table-row'), function (r) {
              var cell = function (c) { var e = r.querySelector('.' + c); return squash(e && e.textContent); };
              // `name` is the delivery-period label ("Oct 26") that Frontier's own embed shows
              // when it doesn't request the `date` column.
              return { date: cell('date'), name: cell('name'), month: cell('month'), change: cell('change'), basis: cell('basis'), cash: cell('cash') };
            }),
          };
        }),
      };
    });
    var text = document.body.innerText;
    var updated = /Updated\s+(\d{1,2}\/\d{1,2}\/\d{2,4}\s+\d{1,2}:\d{2}\s*[AP]M)/i.exec(text);
    var notice = /Data provided by[^\n]*/i.exec(text);
    return {
      groups: groups,
      updated: updated ? updated[1] : null,
      notice: notice ? squash(notice[0]) : null,
      cme: /cme/i.test(document.body.innerHTML),
    };
  }

  function buildCrop(rawCrop, rows, today, sourceSuffix) {
    var info = cropInfo(rawCrop);
    var bids = [];
    rows.forEach(function (r) {
      var cash = num(r.cash);
      if (cash === null) return;
      var range = parseRange(r.date);
      if (!range[0]) range = parseMonthLabel(r.name);
      bids.push({
        crop: clean(rawCrop),
        deliveryStart: range[0],
        deliveryEnd: range[1],
        delivery: clean(r.date || r.name),
        basisMonth: clean(r.month),
        futuresChange: num(r.change),
        basis: num(r.basis),
        cash: cash,
      });
    });
    bids.sort(function (a, b) { return String(a.deliveryStart).localeCompare(String(b.deliveryStart)); });
    // Summary fields describe the nearest delivery period that hasn't ended.
    var spot = bids.filter(function (b) { return !b.deliveryEnd || b.deliveryEnd >= today; })[0] || bids[bids.length - 1];
    var crop = {
      name: sourceSuffix ? info.name + ' · ' + sourceSuffix : info.name,
      color: info.color,
      order: info.order,
      price: spot ? '$' + spot.cash.toFixed(2) : '—',
      source: 'Frontier',
      bids: bids,
    };
    if (spot) {
      crop.cash = spot.cash;
      crop.basis = spot.basis;
      crop.futuresChange = spot.futuresChange;
      crop.basisMonth = spot.basisMonth;
      crop.deliveryStart = spot.deliveryStart;
      crop.deliveryEnd = spot.deliveryEnd;
    }
    return crop;
  }

  // The list of pages to publish, given the location names in the widget.
  function planPages(locationNames) {
    var names = locationNames.map(clean);
    var used = {};
    var pages = COMBINED_PAGES.map(function (c) {
      c.sources.forEach(function (s) { used[s] = true; });
      return { id: c.id, label: c.label, sources: c.sources.slice() };
    });
    names.forEach(function (n) {
      if (!n || used[n]) return;
      used[n] = true;
      pages.push({ id: slug(n), label: LABELS[n] || n, sources: [n] });
    });
    pages.sort(function (a, b) { return a.label.localeCompare(b.label); });
    return pages;
  }

  // widget: output of extractWidget(). today: "YYYY-MM-DD" in Central time.
  // Returns one entry per page; `ok` is false when any source location is missing.
  function buildPages(widget, today) {
    var byName = {};
    widget.groups.forEach(function (g) { byName[clean(g.name)] = g; });
    var notices = [];
    if (widget.notice) notices.push(widget.notice);
    if (widget.cme) notices.push('Market data: CME Group');

    return planPages(widget.groups.map(function (g) { return g.name; })).map(function (p) {
      var found = p.sources.filter(function (s) { return byName[s]; });
      var tables = [];
      found.forEach(function (s) {
        byName[s].tables.forEach(function (t) { tables.push({ source: s, table: t }); });
      });
      // Combined pages: if two sources carry the same crop, label each with its location.
      var seen = {};
      tables.forEach(function (x) { var n = cropInfo(x.table.crop).name; seen[n] = (seen[n] || 0) + 1; });
      var crops = tables.map(function (x) {
        var dup = seen[cropInfo(x.table.crop).name] > 1;
        var crop = buildCrop(x.table.crop, x.table.rows, today, dup ? x.source : null);
        if (p.sources.length > 1) crop.location = x.source;  // shown on combined boards
        return crop;
      }).filter(function (c) { return c.bids.length; });
      crops.sort(function (a, b) { return a.order - b.order; });
      crops.forEach(function (c) { delete c.order; });

      return {
        id: p.id,
        label: p.label,
        sources: p.sources,
        brand: p.sources.every(function (s) { return NON_FRONTIER.indexOf(s) >= 0; }) ? 'none' : 'frontier',
        // false when a source is missing or the location posts no prices (e.g. "--" cash).
        ok: found.length === p.sources.length && crops.length > 0,
        missing: p.sources.filter(function (s) { return !byName[s]; }),
        notices: notices.slice(),
        sourceUpdated: widget.updated || null,
        crops: crops,
      };
    });
  }

  // Marks folders the scraper may create and delete. Older pages carry the same text.
  var GENERATED_MARKER = 'Generated by scraper.js.';

  // Each page gets its own TV URL: /<id>/index.html, a tiny shell that loads the shared app.
  function locationPageHtml(page) {
    var label = String(page.label).replace(/[&<>"]/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch];
    });
    return '<!doctype html>\n' +
      '<html lang="en">\n' +
      '<head>\n' +
      '  <meta charset="utf-8">\n' +
      '  <meta name="viewport" content="width=device-width, initial-scale=1">\n' +
      '  <title>' + label + ' &middot; Grain Bids</title>\n' +
      '  <link rel="stylesheet" href="../styles.css">\n' +
      '</head>\n' +
      '<!-- ' + GENERATED_MARKER + ' Edit COMBINED_PAGES / LABELS in lib/bids.js, not this file. -->\n' +
      '<body data-location="' + page.id + '">\n' +
      '  <script src="../app.js"></script>\n' +
      '</body>\n' +
      '</html>\n';
  }

  return {
    COMBINED_PAGES: COMBINED_PAGES,
    LABELS: LABELS,
    NON_FRONTIER: NON_FRONTIER,
    GENERATED_MARKER: GENERATED_MARKER,
    clean: clean,
    slug: slug,
    parseRange: parseRange,
    parseMonthLabel: parseMonthLabel,
    extractWidget: extractWidget,
    planPages: planPages,
    buildPages: buildPages,
    locationPageHtml: locationPageHtml,
  };
});
