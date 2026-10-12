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
`north-bend`, `nebraska-city`, `sire-cb`, `st-mary`, `tecumseh-north`.
**Yanka and David City - Elevator share one board:** `yanka-david-city`.

The site root (https://hyst16.github.io/grain-bids-tv/) lists every location, and
`data/targets.json` has the full list with URLs. Every location in Frontier's cash bids
widget gets a page automatically, including new ones.

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

### Reliability behavior
- **A location drops out of the widget** → its board keeps the last good prices with a red "Showing last known prices" notice.
- **The widget can't be read** → the Action run fails (GitHub emails the repo owner) and screens keep the old data.
- **Data older than 30 min** → the top bar turns red and reads "⚠ Data stale".
- **Screen can't reach GitHub** → keeps showing the last loaded prices with a "Connection issue" notice.
- The scraper saves on every successful run, so "Last updated" is the time of the last check.

### What triggers the scraper
GitHub's own `schedule` trigger is unreliable (runs can be late or skipped entirely), so an
external cron service (cron-job.org) calls GitHub's `workflow_dispatch` API every 10 minutes
using a fine-grained token limited to this repo's Actions. The `schedule` stays as a backup.
If that token expires, runs stop and the TVs show "Data stale"; create a new token and paste it
into the cron-job.org job's `Authorization` header.
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
