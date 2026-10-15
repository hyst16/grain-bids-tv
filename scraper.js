// Scrapes Frontier Cooperative's cash bids (a StoneX widget on /grain/cash-bids) and writes
// data/grain-bids.json plus one /<page-id>/index.html per TV page.
// The widget renders client-side, so this drives a headless Chromium via Playwright.
// Run: node scraper.js   (after `npm install` and `npx playwright install chromium`)

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const bids = require('./lib/bids');

const SOURCE_PAGE = 'https://www.frontiercooperative.com/grain/cash-bids';
const WIDGET_IFRAME = 'iframe[src*="stonehedge.stonex.com/component/bids"]';
// Widget columns, by the class names extractWidget() reads.
const WIDGET_COLS = 'date,month,change,basis,cash';
const SITE_URL = 'https://hyst16.github.io/grain-bids-tv/';

const OUT_DIR = path.join(__dirname, 'data');
const OUT_FILE = path.join(OUT_DIR, 'grain-bids.json');
const TARGETS_FILE = path.join(OUT_DIR, 'targets.json');
const HEALTH_FILE = path.join(OUT_DIR, 'health.json');

// A location that stops posting bids (or leaves the widget) keeps showing its last prices,
// flagged, for this long; after that its page is removed. New locations appear immediately.
const KEEP_LAST_KNOWN_HOURS = 24;

function todayCentral() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
}

// GitHub shows these as annotations on the run summary (readable without signing in).
const annotate = (level, msg) => console.log(`::${level}::${String(msg).replace(/\r?\n/g, ' | ')}`);

// Wait for widget rows to exist in `frame`, then until their count holds steady for 3 seconds.
async function waitForRows(frame, timeout) {
  await frame.waitForSelector('.bid-group .bid-table-row', { state: 'attached', timeout });
  let last = -1;
  let stable = 0;
  for (let i = 0; i < 30 && stable < 3; i++) {
    const n = await frame.locator('.bid-table-row').count();
    stable = n === last ? stable + 1 : 0;
    last = n;
    await frame.waitForTimeout(1000);
  }
}

async function scrapeWidget() {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      // Central time so the widget's "Updated" timestamp matches Nebraska.
      timezoneId: 'America/Chicago',
      locale: 'en-US',
      viewport: { width: 1600, height: 1200 },
      // Headless Chromium's default UA says "HeadlessChrome", which some sites block.
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    await page.goto(SOURCE_PAGE, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const iframe = await page.waitForSelector(WIDGET_IFRAME, { state: 'attached', timeout: 30000 });
    const widgetUrl = await iframe.getAttribute('src');
    if (!widgetUrl) throw new Error('cash bids widget iframe has no src');

    // Frontier's page decides which columns its widget shows (on 2026-10-15 it dropped the
    // delivery dates and futures month). Keep their widget key and options, but always ask
    // for the full set of columns the TV boards display.
    const fullUrl = new URL(widgetUrl, SOURCE_PAGE);
    fullUrl.searchParams.set('cols', WIDGET_COLS);

    let frame = page;
    try {
      await page.goto(fullUrl.href, { waitUntil: 'domcontentloaded', timeout: 60000, referer: SOURCE_PAGE });
      await waitForRows(page, 60000);
    } catch (err) {
      // Fallback: read the widget as embedded on Frontier's page, with whatever columns it has.
      annotate('warning', `Widget did not load directly (${err.message}); reading it inside Frontier's page.`);
      await page.goto(SOURCE_PAGE, { waitUntil: 'domcontentloaded', timeout: 60000 });
      const embedded = await page.waitForSelector(WIDGET_IFRAME, { state: 'attached', timeout: 30000 });
      await embedded.scrollIntoViewIfNeeded().catch(() => {});
      frame = await embedded.contentFrame();
      if (!frame) throw new Error('iframe has no content frame');
      await waitForRows(frame, 45000);
    }

    const widget = await frame.evaluate(bids.extractWidget);
    if (!widget.groups.length) throw new Error('widget rendered no locations (markup may have changed)');
    const rows = widget.groups.flatMap(g => g.tables.flatMap(t => t.rows));
    widget.missingColumns = ['date', 'month', 'change', 'basis', 'cash'].filter(c => rows.length && rows.every(r => !r[c]));
    widget.usedFallback = frame !== page;
    return widget;
  } catch (err) {
    // Note what the page looked like when it failed, for the annotation.
    try {
      const pages = browser.contexts().flatMap(c => c.pages());
      const p = pages[pages.length - 1];
      if (p) err.message += ` [at ${p.url().slice(0, 120)}; text: ${(await p.innerText('body')).slice(0, 300)}]`;
    } catch {}
    throw err;
  } finally {
    await browser.close();
  }
}

function readPrevious() {
  try {
    return JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
  } catch {
    return null;
  }
}

// Create/refresh each published page's /<id>/index.html, and remove generated pages that are
// no longer published (locations that stopped posting bids or left the widget).
function syncLocationPages(locations, allowRemovals) {
  const keep = new Set(locations.map(l => l.id));
  for (const l of locations) {
    const file = path.join(__dirname, l.id, 'index.html');
    const html = bids.locationPageHtml(l);
    let current = null;
    try { current = fs.readFileSync(file, 'utf8'); } catch {}
    if (current === html) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, html);
    console.log(`Wrote ${l.id}/index.html`);
  }
  if (!allowRemovals) return;
  for (const entry of fs.readdirSync(__dirname, { withFileTypes: true })) {
    if (!entry.isDirectory() || keep.has(entry.name)) continue;
    const file = path.join(__dirname, entry.name, 'index.html');
    let html = '';
    try { html = fs.readFileSync(file, 'utf8'); } catch { continue; }
    if (!html.includes(bids.GENERATED_MARKER)) continue;  // never touch folders we didn't create
    fs.rmSync(path.join(__dirname, entry.name), { recursive: true, force: true });
    console.log(`Removed ${entry.name}/ (no longer posting bids)`);
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

// data/health.json: what the workflow uses to open (and later close) an alert issue.
function writeHealth(now, problems, summary) {
  writeJson(HEALTH_FILE, { checkedAt: now, ok: problems.length === 0, problems, summary });
  for (const p of problems) annotate('warning', p);
}

async function main() {
  const previous = readPrevious();
  const prevById = new Map((previous?.locations || []).map(l => [l.id, l]));
  const now = new Date().toISOString();
  const problems = [];

  let widget;
  try {
    widget = await scrapeWidget();
  } catch (err) {
    // Screens keep the last good prices; their "Data stale" warning appears after 30 minutes.
    writeHealth(now, [`Could not read Frontier's cash bids widget: ${err.message}`], null);
    annotate('error', `Scraping the cash bids widget failed: ${err.message}`);
    process.exit(1);
  }

  if (widget.missingColumns.length) {
    problems.push(`The widget no longer provides the ${widget.missingColumns.join(', ')} column(s); boards show reduced detail.`);
  }
  if (widget.usedFallback) {
    problems.push('The full-column widget did not load, so data came from the widget embedded on Frontier\'s page.');
  }

  const pages = bids.buildPages(widget, todayCentral());
  const graceMs = KEEP_LAST_KNOWN_HOURS * 3600 * 1000;
  const recent = l => l?.lastSuccessAt && Date.now() - Date.parse(l.lastSuccessAt) < graceMs;
  const locations = [];
  const hidden = [];

  for (const p of pages) {
    const prev = prevById.get(p.id);
    if (p.ok) {
      if (!prev) console.log(`NEW  ${p.id}`);
      console.log(`ok   ${p.id.padEnd(20)} ${p.crops.map(c => `${c.name} x${c.bids.length}`).join(', ')}`);
      locations.push({ ...p, lastSuccessAt: now });
    } else if (recent(prev)) {
      // Briefly missing or blank: keep the last good prices (flagged) rather than dropping the page.
      console.warn(`WARN ${p.id.padEnd(20)} no bids right now (keeping last good data)`);
      locations.push({ ...prev, ok: false, brand: p.brand });
    } else {
      hidden.push(p.label);
    }
  }
  // Locations that vanished from the widget entirely: same grace period. Pages retired from
  // config (e.g. a combined board whose locations are all still in the widget) go right away.
  const seen = new Set(pages.map(p => p.id));
  const widgetNames = new Set(widget.groups.map(g => bids.clean(g.name)));
  for (const prev of previous?.locations || []) {
    if (seen.has(prev.id) || !prev.sources) continue;
    if (prev.sources.every(s => widgetNames.has(s))) continue;
    if (recent(prev)) {
      console.warn(`WARN ${prev.id.padEnd(20)} not in widget (keeping last good data)`);
      locations.push({ ...prev, ok: false });
    } else {
      hidden.push(prev.label);
    }
  }
  locations.sort((a, b) => a.label.localeCompare(b.label));

  // Sanity check before removing anything: a half-rendered widget must not wipe out pages.
  const prevCount = (previous?.locations || []).filter(l => l.ok).length;
  const liveCount = locations.filter(l => l.ok).length;
  const looksPartial = prevCount >= 10 && liveCount < prevCount * 0.75;
  if (looksPartial) {
    problems.push(`Only ${liveCount} locations have bids now, down from ${prevCount}; not removing any pages until this recovers.`);
  }

  syncLocationPages(locations, !looksPartial);
  writeJson(OUT_FILE, { generatedAt: now, sourceUpdated: widget.updated || null, locations });
  writeJson(TARGETS_FILE, locations.map(l => ({ id: l.id, label: l.label, sources: l.sources, url: SITE_URL + l.id + '/' })));

  const summary = `${widget.groups.length} widget locations, ${locations.length} pages` +
    (hidden.length ? `; hidden (no bids): ${hidden.join(', ')}` : '') + `. Widget updated ${widget.updated || '?'}.`;
  writeHealth(now, problems, summary);
  annotate('notice', summary);
}

main().catch(err => {
  annotate('error', err.stack || err.message);
  process.exit(1);
});
