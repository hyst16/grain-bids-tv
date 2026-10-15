# grain-bids-tv

TV-optimized cash grain bids for PosterBooking, one full-screen board per location.
A GitHub Action reads Frontier Cooperative's [cash bids](https://www.frontiercooperative.com/grain/cash-bids)
every 10 minutes and commits `data/grain-bids.json`; GitHub Pages serves the display.

## TV URLs

Each location has its own URL:

```
https://hyst16.github.io/grain-bids-tv/<location>/
```

`<location>` is the location name in lowercase with dashes, for example `schuyler`, `cedar-bluffs`,
`north-bend`, `nebraska-city`, `sire-cb`, `agp-david-city`, `adm-columbus`.
**Yanka and David City - Elevator share one board:** `yanka-david-city`.

The site root (https://hyst16.github.io/grain-bids-tv/) lists every location, and
`data/targets.json` has the full list with URLs.

Pages follow Frontier's cash bids widget automatically:
- **New location** in the widget → its page appears on the next run.
- **Location stops posting bids** (cash shows `--`) or leaves the widget → its board keeps the
  last good prices, flagged "Showing last known prices", for 24 hours; then its page is removed.
  A location that has never posted bids gets no page.

Frontier locations show the Frontier logo and tagline. Locations listed in `NON_FRONTIER` in
`lib/bids.js` (Sire CB, AGP - David City) get the same board without Frontier branding.

## What each board shows

One panel per crop, side by side (Corn | Soybeans | HRW Wheat), listing **every delivery
period**: delivery month, futures month, futures change (cents, ▲/▼), basis, and cash
price. Text automatically scales to the largest size that fits the screen. On combined
boards each panel is labelled with the location its bids come from.

The page is laid out on a fixed 1920×1080 stage scaled to the screen, so the top bar
("Last updated") and bottom bar (StoneX / delayed / CME notices) are never cropped.

## How it works

Frontier's cash bids page embeds a StoneX widget that renders in the browser, so the
scraper opens it in headless Chromium (Playwright) and reads the rendered tables.

| File | Purpose |
|---|---|
| `scraper.js` | Opens the widget, writes `data/grain-bids.json` and `data/targets.json`, and generates each `<id>/index.html` |
| `lib/bids.js` | Widget extraction and page-building logic, plus `COMBINED_PAGES` and `LABELS` config |
| `.github/workflows/update-grain-bids.yml` | Runs the scraper every 10 min and commits changes |
| `app.js`, `styles.css`, `index.html` | The display. Location pages are tiny shells that load these shared files |

### Branding
Colors, type and logo follow the Frontier brand guide: charcoal `#242223` and gold `#ca9d3b`
with the reversed (white) logo in `assets/frontier-logo-reversed.svg`, extracted as vector art
from the guide. Brand fonts are Bison (headings) and Avenir Next (body); they're commercial, so
the pages use them when available and otherwise Bebas Neue and Nunito Sans from Google Fonts.
If Frontier has web licenses for Bison/Avenir, add the font files and `@font-face` rules to
`styles.css` and they'll be picked up automatically. Crop colors are unchanged.

### Alerts
Every run writes `data/health.json`. If it reports a problem two rounds in a row (widget
unreadable, columns missing, many locations suddenly gone), the workflow opens an issue titled
**"Grain bids scraper needs attention"** (GitHub emails the repo owner), keeps it updated, and
closes it automatically when the scraper recovers.

### Reliability behavior
- **A location drops out of the widget** → its board keeps the last good prices with a red "Showing last known prices" notice (for 24 hours).
- **The widget can't be read** → screens keep the old data, and the alert issue opens after two failed rounds.
- **Frontier changes which columns their page shows** → no effect: the scraper always requests the full columns itself.
- **The widget renders only part of the list** → no pages are removed that round, and the alert issue opens.
- **Data older than 30 min** → the top bar turns red and reads "⚠ Data stale".
- **Screen can't reach GitHub** → keeps showing the last loaded prices with a "Connection issue" notice.
- The scraper saves on every successful run, so "Last updated" is the time of the last check.

### What triggers the scraper
GitHub's own `schedule` trigger is unreliable (runs can be late or skipped for hours), so the
workflow doesn't rely on it. One run stays open and scrapes every 10 minutes (at :00, :10, :20…)
for about 5h40m, then starts its own replacement. The 30-minute `schedule` and code pushes also
start a loop, so it recovers on its own if a loop ever stops; while a loop is running, those
extra runs exit after a few seconds. To restart it by hand: **Actions → Update Grain Bids → Run workflow**.

Code changes pushed while a loop is running are picked up on its next round (each round pulls
`main` first). Changes to `package.json` or the workflow file take effect on the next loop.
- Screens re-fetch data every 10 minutes and fully reload every 6 hours.

## One-time setup
1. **Settings → Actions → General → Workflow permissions** → **Read and write permissions** → Save.
2. **Settings → Pages** → Source **Deploy from a branch**, Branch **main**, folder **/ (root)** → Save.
3. **Actions → Update Grain Bids → Run workflow** to test it immediately.

## Common changes
- **Combine locations onto one board:** add an entry to `COMBINED_PAGES` in `lib/bids.js`.
- **Rename how a location displays:** add it to `LABELS` in `lib/bids.js` (e.g. `'Tecumsech': 'Tecumseh'`).
  This also changes its URL, so update PosterBooking.
- **New crop / color:** add a `CROP_NAME_MAP` entry in `lib/bids.js`, a `--crop-*` color and `.crop-*` class in `styles.css`, and the key in `cropClassMap` in `app.js`.
- **Stale threshold:** `STALE_MINUTES` in `app.js`.
- **Scrape frequency:** the `cron` line in the workflow.

## Running locally
Needs Node 20+ and Python (for the static server).
```bash
npm install
npx playwright install chromium
node scraper.js
python -m http.server 8000
```
Then open http://localhost:8000/schuyler/.

## Troubleshooting
- **Action logs show `widget rendered no locations` or a timeout:** Frontier or StoneX changed the widget. Update `extractWidget()` in `lib/bids.js` (it reads `.bid-group`, `.bid-table`, `.bid-table-row`).
- **Action fails on `git push`:** workflow permissions aren't read/write (setup step 1), or branch protection on `main` blocks the bot.
- **Scheduled runs stopped:** GitHub disables scheduled workflows after 60 days with no repo activity. Re-enable on the Actions tab.
