# Diamond Intelligence Engine (DIE)
## Version 5.7 — K's Today First-Load Fix

Diamond Intelligence Engine (DIE) is a professional MLB analytics platform designed to combine live MLB data, advanced baseball metrics, historical tracking, and prediction intelligence into one clean, responsive web experience.

The long-term goal is to make DIE a centralized prediction engine for Home Run, Strikeout, Moneyline, and Over/Under analysis, with a Tracker that learns from completed predictions and improves future projections.

---

## Version 5.7 Changes

### K's Today First-Load Fix
- Fixed **K's Today** in the Props tab so it initializes and populates on the first page load without requiring a manual reload.
- Added a lightweight retry helper for K's Today when MLB schedule/boxscore data is still warming up.
- Added K's Today to the Props background refresh cycle so it stays current alongside HR Potential and HRs Today.
- Preserved the Tracker tab layout and behavior.

---

## Previous Version 5.6 Changes
### First-Load Fixes
- Fixed **HRs Completed from Projection** so it no longer requires a page reload to populate correctly.
- Fixed **Pitcher Report** so it warms and populates correctly on first page load.
- Added a coordinated first-load bootstrap so key modules initialize in the correct order.
- Delayed the first live-score refresh until after all page modules are fully registered.
- Re-runs HR completion matching after HR Potential finishes loading so completed projected HRs can be detected immediately.

### Stability Improvements
- Reduced first-load race conditions between:
  - Live Scores
  - HRs Today
  - HR Potential
  - HRs Completed from Projection
  - Pitcher Report
  - K's Today
  - Tracker-dependent data
- Warm-loads Pitcher Report data in the background so opening the tab feels immediate.
- Preserves the Tracker tab layout and functionality.

---

## Previous Version 5.5 Changes

### Font Enhancement Update
- Increased font sizes throughout the application for improved readability.
- Enhanced player name visibility.
- Increased font sizes in major sections, tables, cards, buttons, labels, and general statistics.
- Tracker tab intentionally left unchanged.

---

## Diamond Intelligence Engine Vision

DIE is being built as more than a sports picks website. The platform is evolving into a self-learning baseball intelligence engine where every module contributes to one centralized prediction system.

Future engine components include:

### Prediction Engine
Generates projections for:
- Home Run potential
- Strikeout props
- Moneyline picks
- Over/Under game totals

### Learning Engine
Uses the Tracker to measure:
- Daily accuracy
- All-time accuracy
- Team trends
- Pitcher tendencies
- Player prediction results
- Model strengths and weaknesses

### Confidence Engine
Every prediction should eventually include:
- Confidence score
- Risk level
- Data agreement percentage
- Explanation of the strongest factors

### Situational Intelligence
Planned factors include:
- Weather
- Ballpark factors
- Umpire tendencies
- Bullpen fatigue
- Lineup changes
- Rest days
- Travel schedules
- Pitch mix
- Exit velocity
- Barrel rate
- Hard-hit percentage
- Expected statistics
- Platoon advantages

---

## Planned Data Sources

- Baseball Savant
- FanGraphs
- Baseball Reference
- StatMuse
- Brooks Baseball
- Baseball Prospectus
- MLB Stats API
- Weather APIs
- Sportsbook odds APIs
- Injury reports
- Umpire data
- Market movement data

---

## Development Standards

Every future release should include:
- Incremented version number
- Updated README.md
- Updated changelog when applicable
- ZIP package output
- Mobile-first testing
- Tablet and desktop review
- Performance-conscious changes
- Preservation of existing working features unless intentionally changed

---

## Current Version

**Version:** 5.7  
**Status:** Active Development  
**Latest Update:** First-load data initialization fix for HRs Completed from Projection and Pitcher Report.

© 2026 Diamond Intelligence Engine (DIE)
