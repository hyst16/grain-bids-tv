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
const SITE_URL = 'https://hyst16.github.io/grain-bids-tv/';

const OUT_DIR = path.join(__dirname, 'data');
const OUT_FILE = path.join(OUT_DIR, 'grain-bids.json');
const TARGETS_FILE = path.join(OUT_DIR, 'targets.json');

// Write at least this often even when prices are unchanged, so the
// frontend's stale-data check keeps passing overnight and on weekends.
// Must stay well under STALE_MINUTES in app.js.
const HEARTBEAT_MINUTES = 30;

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

    // Preferred: read the widget inside Frontier's page (it may only load there).
    // Scroll it into view in case it lazy-loads.
    let frame = null;
    try {
      await iframe.scrollIntoViewIfNeeded().catch(() => {});
      frame = await iframe.contentFrame();
      if (!frame) throw new Error('iframe has no content frame');
      await waitForRows(frame, 45000);
    } catch (err) {
      annotate('warning', `Widget did not load inside Frontier's page (${err.message}); opening it directly.`);
      frame = page;
      await page.goto(widgetUrl, { waitUntil: 'domcontentloaded', timeout: 60000, referer: SOURCE_PAGE });
      await waitForRows(page, 60000);
    }

    const widget = await frame.evaluate(bids.extractWidget);
    if (!widget.groups.length) throw new Error('widget rendered no locations (markup may have changed)');
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

// Strip fields that change every run so we only commit real changes.
function fingerprint(payload) {
  return JSON.stringify((payload?.locations || []).map(l => ({ id: l.id, ok: l.ok, notices: l.notices, crops: l.crops })));
}

function writeLocationPages(pages) {
  for (const p of pages) {
    const file = path.join(__dirname, p.id, 'index.html');
    const html = bids.locationPageHtml(p);
    let current = null;
    try { current = fs.readFileSync(file, 'utf8'); } catch {}
    if (current === html) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, html);
    console.log(`Wrote ${p.id}/index.html`);
  }
}

function writeOutput(payload, previous) {
  const prevAgeMin = previous?.generatedAt ? (Date.now() - Date.parse(previous.generatedAt)) / 60000 : Infinity;
  if (previous && fingerprint(previous) === fingerprint(payload) && prevAgeMin < HEARTBEAT_MINUTES) {
    console.log(`No changes; last write ${prevAgeMin.toFixed(0)} min ago. Not rewriting.`);
    return;
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2) + '\n');
  const targets = payload.locations.map(l => ({ id: l.id, label: l.label, sources: l.sources, url: SITE_URL + l.id + '/' }));
  fs.writeFileSync(TARGETS_FILE, JSON.stringify(targets, null, 2) + '\n');
  console.log(`Wrote ${OUT_FILE} (${payload.locations.length} pages)`);
}

async function main() {
  const previous = readPrevious();
  const prevById = new Map((previous?.locations || []).map(l => [l.id, l]));
  const now = new Date().toISOString();

  let widget;
  try {
    widget = await scrapeWidget();
  } catch (err) {
    annotate('error', `Scraping the cash bids widget failed: ${err.message}`);
    // Keep showing the last good prices, flagged, and fail the run so GitHub emails the owner.
    if (previous) {
      const flagged = previous.locations.map(l => ({ ...l, ok: false, error: err.message }));
      writeOutput({ generatedAt: previous.generatedAt, locations: flagged }, null);
    }
    process.exit(1);
  }

  const pages = bids.buildPages(widget, todayCentral());
  const locations = pages.map(p => {
    if (p.ok) {
      console.log(`ok   ${p.id.padEnd(20)} ${p.crops.map(c => `${c.name} x${c.bids.length}`).join(', ')}`);
      return { ...p, lastSuccessAt: now };
    }
    const prev = prevById.get(p.id);
    console.error(`WARN ${p.id.padEnd(20)} missing from widget: ${p.missing.join(', ') || 'no bids'}` +
      (prev?.lastSuccessAt ? ' (keeping last good data)' : ''));
    return prev?.lastSuccessAt ? { ...prev, ok: false, missing: p.missing } : { ...p, lastSuccessAt: null };
  });

  // Pages whose locations disappeared from the widget keep their last data (flagged) so screens don't go blank.
  const current = new Set(locations.map(l => l.id));
  for (const prev of previous?.locations || []) {
    if (!current.has(prev.id) && prev.lastSuccessAt && prev.sources) {
      console.error(`WARN ${prev.id.padEnd(20)} no longer in widget (keeping last good data)`);
      locations.push({ ...prev, ok: false });
    }
  }
  locations.sort((a, b) => a.label.localeCompare(b.label));

  writeLocationPages(locations);
  writeOutput({ generatedAt: now, sourceUpdated: widget.updated || null, locations }, previous);
  const bad = locations.filter(l => !l.ok).map(l => l.id);
  annotate(bad.length ? 'warning' : 'notice',
    `Scraped ${widget.groups.length} widget locations into ${locations.length} pages` +
    (bad.length ? `; not current: ${bad.join(', ')}` : '') + `. Widget updated ${widget.updated || '?'}.`);
}

main().catch(err => {
  annotate('error', err.stack || err.message);
  process.exit(1);
});
