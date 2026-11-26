# FrontLineQ

Frontlines — single-file HTML OSINT site (PWA), published from GitHub (this repo's `main`).

- `index.html` — the whole site
- `sw.js`, `manifest.webmanifest`, icons — offline / installable app
- `data.json`, `auto.json` — copies of the data shipped with the site (fallback only)
- `_headers`, `netlify.toml` — legacy Netlify settings, no longer used (no build step)

The live data is NOT read from here but from the separate repo **holamaamor/frontlineq-data**
(`data.json` written by the editor's PUBLISH button, `auto.json` written by the daily scheduled task).

Work happens only through GitHub: the site is published from `main` of this repo.
Push to this repo when the site code itself changes; data updates go to `frontlineq-data`.
