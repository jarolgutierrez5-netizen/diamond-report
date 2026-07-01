# Changelog

## v6.2 Live Production Pitcher Report Lineup Glitch Fix

- Fixed Pitcher Report glitch when opening **Batting Lineup & Matchups**.
- Normalized expanded Pitcher Report row IDs to preserve open panels across re-renders.
- Added request token protection to prevent stale lineup requests from overwriting active panels.
- Disabled duplicate lineup fetch stacking on mobile/iPhone taps.
- Added mobile CSS containment for expanded lineup panels.
- Deployment type: Index-only hotfix for live production.


## v6.1 Emergency No-Tracker Fix

- Removed Tracker tab from public navigation.
- Removed Tracker section from `index.html`.
- Disabled public Tracker engine execution.
- Added emergency guard for cached Tracker tab state.
