// Scrapes Frontier Cooperative BrightSign pages and writes data/grain-bids.json.
// Each page has one StoneX table (#stonex-Futures-detailed-datatable) with columns:
//   Name | Delivery Start | Delivery End | Basis Month | Fut. Chg | Basis | Cash Price
// Run: node scraper.js   (Node 20+, uses built-in fetch)

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const BASE = 'https://www.frontiercooperative.com/brightsign-pages/';
const TARGETS = [
  { id: 'schuyler', label: 'Schuyler' },
  { id: 'yanka', label: 'Yanka' },
  { id: 'cedar-bluffs', label: 'Cedar Bluffs' },
  { id: 'north-bend', label: 'North Bend' },
  { id: 'syracuse', label: 'Syracuse' },
  { id: 'elmwood', label: 'Elmwood' },
  { id: 'tarnov', label: 'Tarnov' },
  { id: 'prague', label: 'Prague' },
  { id: 'adams', label: 'Adams' },
  { id: 'osceola', label: 'Osceola' },
  { id: 'brainard', label: 'Brainard' },
  { id: 'ceresco', label: 'Ceresco' },
].map(t => ({ ...t, url: BASE + t.id }));

// First matching pattern wins. `color` must have a matching .crop-<color> class in styles.css.
const CROP_NAME_MAP = [
  { re: /^corn/i, name: 'Corn', color: 'corn' },
  { re: /soy/i, name: 'Soybeans', color: 'soy' },
  { re: /wheat.*hrw|hrw/i, name: 'HRW Wheat', color: 'wheat' },
  { re: /wheat/i, name: 'Wheat', color: 'wheat' },
  { re: /milo|sorghum/i, name: 'Milo', color: 'milo' },
  { re: /oats/i, name: 'Oats', color: 'oats' },
  { re: /barley/i, name: 'Barley', color: 'barley' },
  { re: /beans/i, name: 'Beans', color: 'beans' },
];

const OUT_DIR = path.join(__dirname, 'data');
const OUT_FILE = path.join(OUT_DIR, 'grain-bids.json');
const TARGETS_FILE = path.join(OUT_DIR, 'targets.json');

// Write at least this often even when prices are unchanged, so the
// frontend's stale-data check keeps passing overnight and on weekends.
// Must stay well under STALE_MINUTES in app.js.
const HEARTBEAT_MINUTES = 30;
const REQUEST_DELAY_MS = 750;
const TIMEOUT_MS = 20000;

const sleep = ms => new Promise(r => setTimeout(r, ms));
// Collapse whitespace; also drops the space cheerio leaves before punctuation after a link ("StoneX .").
const clean = s => (s || '').replace(/\s+/g, ' ').replace(/\s+([.,;:])/g, '$1').trim();
const num = s => {
  const n = parseFloat(String(s).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

function normalizeCrop(raw) {
  const hit = CROP_NAME_MAP.find(m => m.re.test(raw));
  return hit ? { name: hit.name, color: hit.color } : { name: raw, color: 'other' };
}

// Today's date in Central time as YYYY-MM-DD, for picking the nearest delivery period.
function todayCentral() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
}

async function fetchHtml(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'grain-bids-tv/1.0 (+https://github.com/hyst16/grain-bids-tv)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function parsePage(html) {
  const $ = cheerio.load(html);
  const table = $('#stonex-Futures-detailed-datatable');
  if (!table.length) throw new Error('bid table not found (page markup may have changed)');

  const bids = [];
  table.find('tbody tr').each((_, tr) => {
    const c = $(tr).find('td').map((__, td) => clean($(td).text())).get();
    if (c.length < 7 || !c[0]) return;
    const cash = num(c[6]);
    if (cash === null) return;
    bids.push({
      crop: c[0],
      deliveryStart: c[1],
      deliveryEnd: c[2],
      basisMonth: c[3],
      futuresChange: num(c[4]),
      basis: num(c[5]),
      cash,
    });
  });
  if (!bids.length) throw new Error('bid table had no usable rows');

  const disclaimer = table.closest('.stonex-cashbid-detail-locationwise')
    .find('.stonex-cashbid-detailed-locationwise-disclaimer');
  const sourceUpdated = clean(disclaimer.find('.stonex-cashbid-detailed-locationwise-lastupdateddate').text())
    .replace(/^Last Updated\s*/i, '');

  // The disclaimer text minus the "Last Updated" label, e.g.
  // "Data provided by StoneX. All prices delayed 10 minutes."
  const dc = disclaimer.clone();
  dc.find('label').remove();
  const notices = [];
  const text = clean(dc.text());
  if (text) notices.push(text);
  if (disclaimer.find('a[href*="cmegroup"]').length) notices.push('Market data: CME Group');

  return { bids, sourceUpdated, notices, label: clean(table.find('.stonexcashbid_locationname').text()) };
}

// One entry per crop. The top-level fields summarize the nearest delivery period that
// hasn't ended; `bids` holds every row the page lists (what the TV board displays).
function buildCrops(bids) {
  const today = todayCentral();
  const byCrop = new Map();
  for (const b of bids) {
    const key = b.crop;
    if (!byCrop.has(key)) byCrop.set(key, []);
    byCrop.get(key).push(b);
  }
  const crops = [];
  for (const [raw, rows] of byCrop) {
    rows.sort((a, b) => a.deliveryStart.localeCompare(b.deliveryStart));
    const spot = rows.find(r => !r.deliveryEnd || r.deliveryEnd >= today) || rows[rows.length - 1];
    const { name, color } = normalizeCrop(raw);
    crops.push({
      name,
      color,
      price: '$' + spot.cash.toFixed(2),
      source: 'Frontier',
      cash: spot.cash,
      basis: spot.basis,
      futuresChange: spot.futuresChange,
      basisMonth: spot.basisMonth,
      deliveryStart: spot.deliveryStart,
      deliveryEnd: spot.deliveryEnd,
      bids: rows,
    });
  }
  return crops;
}

// Each location gets its own TV URL: /<id>/index.html. They're tiny shells that load the shared app.
function locationPage(t) {
  const label = t.label.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${label} · Grain Bids</title>
  <link rel="stylesheet" href="../styles.css">
</head>
<!-- Generated by scraper.js. Edit TARGETS there, not this file. -->
<body data-location="${t.id}">
  <script src="../app.js"></script>
</body>
</html>
`;
}

function writeLocationPages() {
  for (const t of TARGETS) {
    const file = path.join(__dirname, t.id, 'index.html');
    const html = locationPage(t);
    let current = null;
    try { current = fs.readFileSync(file, 'utf8'); } catch {}
    if (current === html) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, html);
    console.log(`Wrote ${t.id}/index.html`);
  }
}

function readPrevious() {
  try {
    return JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
  } catch {
    return null;
  }
}

// Strip fields that change every run so we only commit real changes.
function fingerprint(payload) {
  return JSON.stringify((payload?.locations || []).map(l => ({
    id: l.id, ok: l.ok, notices: l.notices, crops: (l.crops || []).map(c => ({ ...c })),
  })));
}

async function main() {
  writeLocationPages();
  const previous = readPrevious();
  const prevById = new Map((previous?.locations || []).map(l => [l.id, l]));
  const now = new Date().toISOString();
  const locations = [];
  let failures = 0;

  for (const [i, t] of TARGETS.entries()) {
    if (i) await sleep(REQUEST_DELAY_MS);
    try {
      const { bids, sourceUpdated, notices } = parsePage(await fetchHtml(t.url));
      const crops = buildCrops(bids);
      locations.push({
        id: t.id, label: t.label, url: t.url, ok: true,
        notices, sourceUpdated, lastSuccessAt: now, crops,
      });
      console.log(`ok   ${t.id.padEnd(14)} ${crops.map(c => `${c.name} ${c.price}`).join(', ')}`);
    } catch (err) {
      failures++;
      const prev = prevById.get(t.id);
      console.error(`FAIL ${t.id.padEnd(14)} ${err.message}${prev?.lastSuccessAt ? ' (keeping last good data)' : ''}`);
      // Keep the last good prices rather than blanking the card on a single failed fetch.
      locations.push(prev?.lastSuccessAt
        ? { ...prev, label: t.label, url: t.url, ok: false, error: err.message }
        : {
            id: t.id, label: t.label, url: t.url, ok: false, error: err.message,
            notices: [], sourceUpdated: null, lastSuccessAt: null,
            crops: [
              { name: 'Corn', color: 'corn', price: '—', source: 'Frontier' },
              { name: 'Soybeans', color: 'soy', price: '—', source: 'Frontier' },
            ],
          });
    }
  }

  const payload = { generatedAt: now, locations };

  const prevAgeMin = previous?.generatedAt ? (Date.now() - Date.parse(previous.generatedAt)) / 60000 : Infinity;
  if (previous && fingerprint(previous) === fingerprint(payload) && prevAgeMin < HEARTBEAT_MINUTES) {
    console.log(`No changes; last write ${prevAgeMin.toFixed(0)} min ago. Not rewriting.`);
  } else {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2) + '\n');
    fs.writeFileSync(TARGETS_FILE, JSON.stringify(TARGETS, null, 2) + '\n');
    console.log(`Wrote ${OUT_FILE} (${locations.length} locations, ${failures} failed)`);
  }

  // Fail the Action (so you get an email) only if every location failed.
  if (failures === TARGETS.length) {
    console.error('All locations failed.');
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { parsePage, buildCrops, normalizeCrop };
