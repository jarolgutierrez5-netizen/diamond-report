# Diamond Report DIE Live Production

## v6.4 — Live Pitcher Report Lineup Mobile Stability Fix

This live-production patch is based on the provided v6.3 Live Props Responsive Optimization package.

### Fixed
- Fixed the Pitcher Report mobile glitch where tapping **Batting Lineup & Matchups** could briefly show the lineup and then leave the expanded area blank.
- Reworked the expanded lineup panel CSS to avoid iPhone Safari rendering issues caused by aggressive layout containment.
- Added safer expanded-row restore logic so open lineup panels survive table refreshes, sorting, and live re-renders.
- Preserved expanded lineup state while live data refreshes in the background.
- Kept the v6.3 Props tab responsive layout optimization intact.

### Deployment
Replace only `index.html` for this patch.

Do not update `data/`, `scripts/`, or `.github/`.
