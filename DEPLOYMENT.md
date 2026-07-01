# Deployment — v6.4 Live Pitcher Report Lineup Mobile Stability Fix

## Deployment Type
Index-only live production patch.

## Upload / Replace
- index.html

## Do Not Replace
- data/
- scripts/
- .github/

## After Upload
1. Commit the updated `index.html`.
2. Wait for GitHub Pages deployment.
3. Hard refresh the live site.
4. Test Pitcher Report on mobile by tapping **Batting Lineup & Matchups**.
5. Confirm the lineup stays visible after opening and after sorting/refreshing.
6. Spot-check Props tab to confirm the v6.3 responsive layout remains intact.
