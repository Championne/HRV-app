# HRV-app

Heartrate and RHV app

# HRV Live – phone app for the Polar H10 (Bluefy on iPhone)

A static web app (plain HTML/JS/CSS, no build step, no libraries, no CDNs, no analytics, **no network
calls unless the optional Vita feed is switched on**) that shows live heart rate and HRV from a Polar H10 chest strap over Web Bluetooth.
It's built for the **Bluefy** browser on iPhone, because Safari on iPhone has no Web Bluetooth.

## What it does
- **Connect strap** opens the Bluetooth picker (`namePrefix: 'Polar'`, services `heart_rate` + `battery_service`),
  then subscribes to Heart Rate Measurement 0x2A37 and parses HR plus RR intervals (flags bit 4, 1/1024 s units).
  It also reads the battery level if the strap offers it.
- Live view: HR, RMSSD (rolling 60 s), SDNN, ln RMSSD, pNN50, a 0–100 HRV score gauge (ln RMSSD × 15.4,
  generic bands), an RR tachogram (last 2 min, artefacts shown as red dots), the session timer, beats and reconnects.
  HRV refreshes every 2 s.
- Artefact filter, identical to the laptop tool `polar_hrv.py`: RR intervals outside 300–2000 ms are dropped,
  then any beat >20 % off the median of its ±5 neighbours.
- Auto-reconnect when the strap drops out (`gattserverdisconnected`), with backoff of 1 s → 2 → 4 … up to 30 s.
  A session keeps running through drops and counts the reconnects.
- Screen Wake Lock while connected, where the browser supports it. The page also tells him to turn on
  Bluefy's keep-awake setting.
- Sessions are stored in IndexedDB on the phone, autosaved every 15 s and when the app goes to the background.
  If the app is killed mid-session, that session is closed at its last beat on the next launch.
- Export: **CSV** has one row per beat, with the laptop tool's columns `time,elapsed_s,hr_bpm,rr_ms,contact`.
  **JSON** is the summary, with the laptop `sessions.csv` fields: start, duration_min, device, mean/min/max HR, rmssd_ms,
  ln_rmssd, sdnn_ms, pnn50_pct, beats, clean_beats, reconnects. Export uses the iOS share sheet (`navigator.share`)
  and falls back to a file download.
- Works offline after the first load (manifest + service worker caching the app shell; no data is ever cached or sent).
- If the browser has no Web Bluetooth, it shows "open this page in Bluefy" and disables Connect.
- Simulation: `index.html?simulate=1` uses a fake strap. Optional `&speed=10` runs time faster, and `&drop=50`
  forces a link drop every 50 simulated seconds to exercise reconnect.

## Vita feed (optional, off by default)
While a session is recording, the app sends one **reading every 2 minutes** to a **private** GitHub repository
(default `Championne/hrv-sessions`) so Vita can follow a fasting window, plus a **full summary** when the session stops.
With no token, or with the switch off, the app makes no network calls and behaves exactly as before.

- Reading (one JSON line appended to `live/YYYY-MM-DD.jsonl`, local date):
  `ts` (ISO with UTC offset), `session_id`, `hr_avg_2min`, `hr_min`, `hr_max` (since the previous reading),
  `rmssd_ms`, `sdnn_ms`, `ln_rmssd`, `score`, `zone` (last 60 s, same as the live screen; score/zone null until
  20 clean beats), `clean_beats`, `artefacts` (since the previous reading), `contact`.
- Summary (`sessions/YYYY-MM-DD_HHMMSS.json`): session_id, start, end, duration_s/min, hr_mean/min/max, rmssd_ms,
  sdnn_ms, ln_rmssd, pnn50_pct, score, zone, beats, clean_beats, artefacts, reconnects, device.
- **Raw RR / per-beat data never leaves the phone.**
- Writes use the GitHub REST contents API (`Authorization: Bearer <token>`, `Accept: application/vnd.github+json`):
  GET the file (sha + content) → append → PUT with the sha; created on 404; retried once on a 409/422 sha
  conflict. Lines already in the file are skipped, so a retried send can't duplicate a reading.
- Offline queue: unsent readings/summaries are kept in `localStorage` and sent in order on the next tick or when
  the `online` event fires. Consecutive readings for the same day go in one commit.
- Privacy guard: before the first send (and in **Test connection**) the app checks the repo; it refuses to send to a
  **public** repo.
- Status line under the session timer: `Feed off` · `Synced HH:MM` · `Offline – N queued` · `Feed error: …`.
- Bluefy must stay in the foreground with the screen on: iOS pauses web pages in the background, so nothing is
  sent (or measured) while the page is suspended.

**Settings tab:** GitHub token (password field), repository, **Test connection** (GET the repo, shows ok / error and
warns if it is public), the on/off switch, and **Remove token**. The token is stored **only in this browser's
localStorage** on the phone. It is never logged and never written to any repository.

**Making the token (fine-grained, ~2 min):** github.com → Settings → Developer settings → Personal access tokens →
**Fine-grained tokens** → Generate new token.
1. Name: `HRV phone feed`. Expiration: **90 days**. Resource owner: Championne.
2. Repository access: **Only select repositories** → `hrv-sessions`.
3. Repository permissions: **Contents → Read and write**. (Metadata → Read-only is added automatically.) Nothing else.
4. Generate, copy the `github_pat_…` token, paste it into the app's Settings → Token, tap **Test connection**,
   then switch the feed on. Renew it before it expires; revoke it on GitHub any time.

**How Vita reads it:** the latest lines of today's `live/YYYY-MM-DD.jsonl` (and `sessions/*.json`) in the private repo.

**Before connecting:** close Elite HRV and any Polar app that holds the strap. A strap only talks to one app at a time.

## Files
```
index.html             UI (strict Content-Security-Policy: only 'self')
css/app.css            dark, phone-first styles
js/hrv.js              pure functions: 0x2A37 parser, artefact filter, RMSSD/SDNN/pNN50, score, CSV/summary
js/app.js              Bluetooth, reconnect, live UI, sessions, export, wake lock, feed wiring + Settings
js/feed.js             Vita feed: reading/summary builders, GitHub contents API client, offline queue
js/store.js            IndexedDB
js/sim.js              simulation (fake Web Bluetooth device)
js/charts.js           canvas gauge + tachogram
manifest.webmanifest, sw.js, icons/
.nojekyll              empty; GitHub Pages serves the folder as-is (no Jekyll)
tests/hrv.test.js      unit tests (node --test), incl. cross-check against /workspace/polar-hrv/polar_hrv.py
tests/feed.test.js     unit tests for the feed (mocked fetch): readings, JSONL append, 409 retry, queue, public-repo guard
tests/e2e.mjs          headless Chromium test in simulate mode (incl. the feed against a mocked GitHub API), writes screenshots/
```

## Testing
```
node --test tests/                                                # unit tests
PW_DIR=/workspace/hrv-test-tools/node_modules node tests/e2e.mjs  # e2e (playwright installed outside this folder)
```
To try it locally: `python3 -m http.server 8642` in this folder, then open
`http://127.0.0.1:8642/index.html?simulate=1&speed=10`.
In simulation mode only, `&feedInterval=<ms>` shortens the 2-minute feed interval for testing.

## Deploying (steps only – NOT done; needs Gert Jan's OK and his own account)
Web Bluetooth and service workers need **HTTPS**. Both options below are free static hosts. Only this code is
uploaded; health data never leaves the phone.

**GitHub Pages**
1. Create a GitHub account (or use his), then a new repository, e.g. `hrv-live` (public is required for free Pages).
2. Upload the contents of this folder (`tests/`, `screenshots/` and `package.json` are optional) and commit to `main`.
3. Repository → Settings → Pages → Source: "Deploy from a branch", Branch `main`, folder `/ (root)` → Save.
4. After about a minute the app is at `https://<user>.github.io/hrv-live/`. Open that URL in Bluefy.

This repository is the project site [https://championne.github.io/HRV-app/](https://championne.github.io/HRV-app/).
Paths in `index.html`, `manifest.webmanifest` (`start_url` `./index.html`, `scope` `./`) and `sw.js` are relative
to that subpath, and the empty `.nojekyll` file keeps Pages from processing the site with Jekyll.

**Cloudflare Pages**
1. Create a Cloudflare account → Workers & Pages → Create → Pages → "Upload assets" (direct upload, no Git needed).
2. Name the project (e.g. `hrv-live`) and drag in this folder.
3. Deploy. The app is at `https://hrv-live.pages.dev/`. Open it in Bluefy.
   (CLI alternative: `npx wrangler pages deploy . --project-name hrv-live` after `wrangler login`.)

**On the iPhone:** install Bluefy (free) → open the URL → allow Bluetooth → Connect strap → pick "Polar H10 …".
To update the app later, bump `VERSION` in `sw.js` so phones fetch the new files.

## Not yet verified
- Real BLE on the iPhone in Bluefy (picker, notifications, battery read, reconnect after walking out of range,
  behaviour with the screen locked or Bluefy in the background). iOS usually suspends background pages, so
  **keep Bluefy in the foreground with the screen on** while recording.
- Whether Bluefy supports the Wake Lock API, `navigator.share` with files, and downloads. The CSV/JSON export
  has a download fallback, but how it behaves inside Bluefy is untested.
- IndexedDB persistence in Bluefy over days and weeks: export sessions regularly.
