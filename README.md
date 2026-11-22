# FrontLineQ

Frontlines — single-file HTML OSINT site (PWA), hosted on Netlify.

- `index.html` — the whole site
- `sw.js`, `manifest.webmanifest`, icons — offline / installable app
- `data.json`, `auto.json` — copies of the data shipped with the site (fallback only)
- `_headers`, `netlify.toml` — Netlify settings (no build step)

The live data is NOT read from here but from the separate repo **holamaamor/frontlineq-data**
(`data.json` written by the editor's PUBLISH button, `auto.json` written by the daily scheduled task).

**Every push to `main` is a Netlify production deploy and costs 15 of the 300 free monthly credits.**
Push to this repo only when the site code itself changes; data updates go to `frontlineq-data`.
