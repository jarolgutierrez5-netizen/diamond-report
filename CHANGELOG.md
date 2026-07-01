# Changelog

## v6.4 — Live Pitcher Report Lineup Mobile Stability Fix
- Fixed Pitcher Report expanded lineup blank/glitch behavior on mobile.
- Removed the risky mobile `contain: layout paint` behavior from lineup expansion panels.
- Added stable rehydration for expanded Batting Lineup & Matchups rows after refreshes and re-renders.
- Added a reusable Pitcher Report table wrapper class for safer horizontal scrolling.
- Preserved v6.3 Props tab responsive layout optimization.

## v6.3 — Props Tab Responsive Layout Optimization
- Applied requested Props tab two-row dashboard layout.
- HR Potential and K's Today now stay side by side.
- HR's Today and HRs Completed From Projection now stay side by side below.
- Added cross-device responsive overrides for mobile, tablet, laptop, and desktop.
- Preserved v6.2 live Pitcher Report lineup/matchup hotfix.
