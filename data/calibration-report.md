# Model Calibration Report

Generated 2026-08-24 15:57 UTC by the weekly calibration-report workflow.
Re-run any of these locally any time: `node scripts/analyze-<name>-matchups.mjs`.

## HR Threats

```
══════════════════════════════════════════════════════════════════════
HR THREATS CALIBRATION REPORT
══════════════════════════════════════════════════════════════════════
Total captured: 0  |  Graded (win/loss): 0  |  Pending: 0

No graded picks yet — nothing to analyze.
```

## K Props

```
══════════════════════════════════════════════════════════════════════
K PROPS CALIBRATION REPORT
══════════════════════════════════════════════════════════════════════
Total captured: 1075  |  Graded: 1044  |  Pending: 31
Overall OVER hit rate: 566/1044 = 54.2%  (0 pushes)

Edge calibration (projK - line bucket vs actual OVER hit rate):
  Bucket                 N    OVER hit%
  <0.5                 175        46.3%
  0.5-1.0              378        52.6%
  1.0-1.5              400        58.8%
  1.5-2.0               73        58.9%
  2.0+                  18        44.4%

  Edge < 1.0: 50.6% actual (n=553)  vs  Edge >= 1.0: 58.2% actual (n=491)
  z = -2.47 (statistically significant difference, p<0.05)

By line source:
  Bucket                 N    OVER hit%
  model                754        56.1%
  sportsbook           290        49.3%

Miss diagnosis (422/478 losses with performance data):
  Short outing (pulled early, never got the look): 200 (47.4%)
  Full outing, just didn't miss enough bats: 222 (52.6%)

Picks with matchup snapshot data: 860/1044

By pitcher K/9:
  Bucket                 N    OVER hit%
  <7 K/9               202        59.9%
  7-9 K/9              362        51.9%
  9+ K/9               296        47.3%

By opponent lineup K-rate:
  Bucket                 N    OVER hit%
  Low-K lineup (<20%)    31        51.6%
  Avg lineup (20-25%)   819        52.3%
  High-K lineup (25%+)    10        50.0%

Avg season K% by batting-order spot (n=110 lineups):
  Spot 1: 20.3%
  Spot 2: 20.9%
  Spot 3: 20.2%
  Spot 4: 21.9%
  Spot 5: 21.1%
  Spot 6: 21.7%
  Spot 7: 23.4%
  Spot 8: 21.3%
  Spot 9: 22.3%

══════════════════════════════════════════════════════════════════════
```

## Diamond Report Pick (game winner)

```
══════════════════════════════════════════════════════════════════════
DIAMOND REPORT PICK (GAME WINNER) CALIBRATION REPORT
══════════════════════════════════════════════════════════════════════
Total captured: 521  |  Graded: 507  |  Pending: 14
Overall pick hit rate: 278/507 = 54.8%  (0 pushes)

Confidence calibration (pickPct bucket vs actual hit rate):
  Bucket                 N   Actual hit%
  50-54%               295         54.2%
  55-59%               193         55.4%
  60-64%                19         57.9%

  pickPct < 60%: 54.7% actual (n=488)  vs  pickPct >= 60%: 57.9% actual (n=19)
  z = -0.27 (not conventionally significant at this sample size)

Picks with matchup snapshot data: 419/507

By starting-pitcher ERA gap:
  Bucket                 N   Actual hit%
  ERA gap <0.3          58         56.9%
  ERA gap 0.3-1.0      107         48.6%
  ERA gap 1.0+         254         56.3%

By team record gap:
  Bucket                 N   Actual hit%
  Record gap <5pt      176         49.4%
  Record gap 5-15pt    207         58.0%
  Record gap 15pt+      36         58.3%

By day/night:
  Bucket                 N   Actual hit%
  Day game             143         53.1%
  Night game           276         55.1%

══════════════════════════════════════════════════════════════════════
```
