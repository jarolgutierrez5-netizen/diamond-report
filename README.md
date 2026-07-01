# Diamond Report DIE Live Production

## v6.5 — Pitcher Report Mobile/Tablet Card Stability Fix

This production patch is based on the v6.4 Live Pitcher Lineup Mobile Stability Fix package.

### Fixed
- Replaced the Pitcher Report table-expansion layout on mobile and tablet with a stable card-based layout.
- Fixed the remaining mobile/tablet glitch where **Batting Lineup & Matchups** could flash open and then disappear.
- Kept the desktop Pitcher Report table unchanged because desktop was already working correctly.
- Preserved lineup cache, live refresh logic, matchup buttons, K prop updates, and HR Potential feed behavior.
- Added safer mobile/tablet expand panel display logic so opened lineups stay visible after refresh/re-render events.

### Deployment
Replace only `index.html` for this patch.

Do not update `data/`, `scripts/`, or `.github/`.
