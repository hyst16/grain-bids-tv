# grain-bids-tv

TV-optimized cash grain bids for PosterBooking, one full-screen board per location.
A GitHub Action scrapes Frontier Cooperative's BrightSign pages every 10 minutes and
commits `data/grain-bids.json`; GitHub Pages serves the display.

## TV URLs

Point each PosterBooking screen at its location's URL:

| Location | URL |
|---|---|
| Schuyler | https://hyst16.github.io/grain-bids-tv/schuyler/ |
| Yanka | https://hyst16.github.io/grain-bids-tv/yanka/ |
| Cedar Bluffs | https://hyst16.github.io/grain-bids-tv/cedar-bluffs/ |
| North Bend | https://hyst16.github.io/grain-bids-tv/north-bend/ |
| Syracuse | https://hyst16.github.io/grain-bids-tv/syracuse/ |
| Elmwood | https://hyst16.github.io/grain-bids-tv/elmwood/ |
| Tarnov | https://hyst16.github.io/grain-bids-tv/tarnov/ |
| Prague | https://hyst16.github.io/grain-bids-tv/prague/ |
| Adams | https://hyst16.github.io/grain-bids-tv/adams/ |
| Osceola | https://hyst16.github.io/grain-bids-tv/osceola/ |
| Brainard | https://hyst16.github.io/grain-bids-tv/brainard/ |
| Ceresco | https://hyst16.github.io/grain-bids-tv/ceresco/ |

The site root (https://hyst16.github.io/grain-bids-tv/) lists all of them.
`?loc=<id>` on the root URL also works.

## What each board shows

One panel per crop, side by side (Corn | Soybeans | Wheat …), listing **every delivery
period** the Frontier page lists: delivery month, futures contract, futures change
(cents, ▲/▼), basis, and cash price. Text automatically scales to the largest size
that fits the screen, so a 1-crop location is big and a 17-row location still fits.

The page is laid out on a fixed 1920×1080 stage scaled to the screen, so the top bar
("Last updated") and bottom bar (StoneX / delayed / CME notices) are never cropped.

## How it works

| File | Purpose |
|---|---|
| `scraper.js` | Reads the StoneX table (`#stonex-Futures-detailed-datatable`) from each location page, writes `data/grain-bids.json`, and generates each `<id>/index.html` |
| `.github/workflows/update-grain-bids.yml` | Runs the scraper every 10 min and commits changes |
| `app.js`, `styles.css`, `index.html` | The display. Location pages are tiny shells that load these shared files |

### Reliability behavior
- **One location fails** → its board keeps the last good prices with a red "Showing last known prices" notice.
- **All locations fail** → the Action run fails (GitHub emails the repo owner) and screens keep the old data.
- **Data older than 75 min** → the top bar turns red and reads "⚠ Data stale".
- **Screen can't reach GitHub** → keeps showing the last loaded prices with a "Connection issue" notice.
- The scraper only commits when prices change, plus a heartbeat every 30 min so "Last updated" stays current overnight.
- Screens re-fetch data every 10 minutes and fully reload every 6 hours.

## One-time setup
1. **Settings → Actions → General → Workflow permissions** → **Read and write permissions** → Save.
2. **Settings → Pages** → Source **Deploy from a branch**, Branch **main**, folder **/ (root)** → Save.
3. **Actions → Update Grain Bids → Run workflow** to test it immediately.

## Common changes
- **Add/remove a location:** edit `TARGETS` in `scraper.js`. The next run creates its `<id>/` page.
- **New crop / color:** add a `CROP_NAME_MAP` entry in `scraper.js`, a `--crop-*` color and `.crop-*` class in `styles.css`, and the key in `cropClassMap` in `app.js`.
- **Stale threshold:** `STALE_MINUTES` in `app.js` (keep it well above `HEARTBEAT_MINUTES` in `scraper.js`).
- **Scrape frequency:** the `cron` line in the workflow.

## Running locally
Needs Node 20+ and Python (for the static server).
```bash
npm install
node scraper.js
python -m http.server 8000
```
Then open http://localhost:8000/schuyler/.

## Troubleshooting
- **"Prices unavailable" / Action logs show `bid table not found`:** Frontier changed their page markup. Update `parsePage()` in `scraper.js`.
- **Action fails on `git push`:** workflow permissions aren't read/write (setup step 1), or branch protection on `main` blocks the bot.
- **Scheduled runs stopped:** GitHub disables scheduled workflows after 60 days with no repo activity. Re-enable on the Actions tab.
