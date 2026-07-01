# Deployment — v6.5 Pitcher Report Mobile/Tablet Card Stability Fix

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
4. Test Pitcher Report on iPhone/mobile by tapping **Batting Lineup & Matchups**.
5. Test Pitcher Report on tablet/iPad by tapping **Batting Lineup & Matchups**.
6. Confirm desktop still shows the normal table layout.
7. Spot-check Props tab to confirm the v6.3 responsive layout remains intact.
