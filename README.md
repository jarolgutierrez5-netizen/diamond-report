# ⚾ Diamond Report — MLB Analytics Dashboard

A live MLB analytics dashboard pulling real-time data from the official MLB Stats API.

## Features

- **Live Scores** — auto-refreshes every 30 seconds with inning-by-inning updates
- **Standings** — full AL/NL standings with PCT and games back
- **Pitcher Report** — today's probable starters with IP, BF, FIP, AVG, WHIP, ISO, SLG, HR, HR/9, TB — sortable by any column
- **Batting Lineup & Matchups** — expand any pitcher to see the opposing lineup with HR probability, last 10 game HR totals, live HR highlights, and batter vs pitcher analysis
- **Schedule** — upcoming games

## Data Sources

All data is pulled live from the [MLB Stats API](https://statsapi.mlb.com) — no API key required.

## Deployment

### GitHub + Netlify (recommended)

1. Push this repo to GitHub
2. Go to [netlify.com](https://netlify.com) → New site → Import from GitHub
3. Select this repo — no build settings needed, just deploy
4. Done! Your site will be live at `your-site.netlify.app`

### GitHub Pages

1. Push to GitHub
2. Go to repo **Settings → Pages**
3. Set source to `main` branch, `/ (root)`
4. Live at `yourusername.github.io/diamond-report`

## Updating

Any time the dashboard is updated:
1. Replace `index.html` in the GitHub repo
2. Netlify / GitHub Pages auto-deploys within ~30 seconds

## Notes

- The Batter vs Pitcher matchup modal (⚔) requires the Claude.ai sandbox for AI features — all other features work on any host
- All times shown in CDT (America/Chicago timezone)
