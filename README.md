# Diamond Intelligence Engine (DIE)

## v6.2 Live Production Pitcher Report Lineup Glitch Fix

Production hotfix for the public no-tracker build.

### v6.2 Changes
- Fixed Pitcher Report visual glitch when tapping **Batting Lineup & Matchups**.
- Normalized pitcher row IDs so expanded lineup panels stay stable after refresh/re-render.
- Prevented overlapping lineup fetches from stacking on iPhone/mobile.
- Added stale-request protection so background lineup refreshes cannot overwrite the active opened panel.
- Added mobile containment styles for expanded lineup panels to reduce layout jump and horizontal overflow.

### Deployment
Replace only:
- `index.html`

Optional documentation files:
- `README.md`
- `CHANGELOG.md`

---

## v6.1 Emergency No-Tracker Fix

Emergency public build with the Tracker removed from `index.html`.

### Changes
- Removed public Tracker navigation tab.
- Removed Tracker page/section markup.
- Disabled the browser-side Tracker engine from the public index.
- Added a small safety guard to remove any cached Tracker UI reference if a browser had previously opened it.

### Notes
- This does not delete repository data/workflows unless you remove them separately.
- Live public UI should only show Live Scores, Pitcher Report, Props, and Upcoming Games.
