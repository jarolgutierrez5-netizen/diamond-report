# Diamond Intelligence Engine (DIE)

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
