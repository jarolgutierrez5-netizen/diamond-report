# Model Calibration Report

Generated 2026-09-07 19:13 UTC by the weekly calibration-report workflow.
Re-run any of these locally any time: `node scripts/analyze-<name>-matchups.mjs`.

## HR Threats

```
══════════════════════════════════════════════════════════════════════
HR THREATS CALIBRATION REPORT
══════════════════════════════════════════════════════════════════════
Total captured: 300  |  Graded (win/loss): 292  |  Pending: 8
Overall actual hit rate: 38/292 = 13.0%

Score calibration (predicted HR% bucket vs actual hit rate):
  Bucket                           N   Actual hit%   Avg predicted%
  18%                              1          0.0%            18.0%
  19%                              4          0.0%            19.0%
  20-21%                           1          0.0%            20.0%
  25-29%                          16         37.5%            27.4%
  30%+                           270         11.9%            61.2%

  Score < 22%: 0.0% actual (n=6)  vs  Score >= 22%: 13.3% actual (n=286)
  z = -0.96 (not conventionally significant at this sample size)

Picks with live client score snapshot: 292/292

Live client score calibration (what users actually see):
  Bucket                           N   Actual hit%   Avg predicted%
  18%                             95          7.4%            14.3%
  19%                              9          0.0%            19.0%
  20-21%                          14          7.1%            20.4%
  22-24%                          29         20.7%            23.1%
  25-29%                          47         14.9%            27.1%
  30%+                            98         17.3%            34.4%

  Live score < 22%: 6.8% actual (n=118)  vs  Live score >= 22%: 17.2% actual (n=174)
  z = -2.61 (statistically significant difference, p<0.05)

Score source breakdown: 292/292 picks have hrScoreSource recorded
  logistic   n=    6   actual hit rate: 0.0%
  legacy     n=  286   actual hit rate: 13.3%

isOnFire: TRUE 12.8% (n=288)  vs  FALSE 25.0% (n=4)
  (below the 20-per-side sample floor — too thin to read as signal yet, treat as noise-risk)

isFavorable: TRUE 13.4% (n=67)  vs  FALSE 12.9% (n=225)
  z = 0.12 (not conventionally significant at this sample size)

isDrought: TRUE 20.0% (n=5)  vs  FALSE 12.9% (n=287)
  (below the 20-per-side sample floor — too thin to read as signal yet, treat as noise-risk)

isDue: TRUE 25.0% (n=4)  vs  FALSE 12.8% (n=288)
  (below the 20-per-side sample floor — too thin to read as signal yet, treat as noise-risk)

hasNearHR: TRUE 13.9% (n=101)  vs  FALSE 12.6% (n=191)
  z = 0.31 (not conventionally significant at this sample size)

Picks with platoon-split data: 289/292
  platoonFavorable: TRUE 14.4% (n=139)  vs  FALSE 12.0% (n=150)
  z = 0.60 (not conventionally significant at this sample size)

Picks with Matchup Edge data: 98/292

Matchup Edge calibration (predicted grade vs actual hit rate):
  Bucket                           N   Actual hit%   Avg predicted%
  Weak (<45)                       1          0.0%            42.0%
  Neutral (45-63)                 25         24.0%            57.2%
  Strong (64-77)                  49         20.4%            70.7%
  Excellent (78+)                 23         21.7%            82.9%

  Matchup Edge < 64: 23.1% actual (n=26)  vs  Matchup Edge >= 64: 20.8% actual (n=72)
  z = 0.24 (not conventionally significant at this sample size)

Picks with pitcher-matchup data: 292/292

By opposing pitcher HR/9 allowed:
  Bucket                           N   Actual hit%
  <0.9 HR/9                       76         14.5%
  0.9-1.2 HR/9                    80         13.8%
  1.2+ HR/9                      136         11.8%

By opposing pitcher WHIP:
  Bucket                           N   Actual hit%
  <1.15 WHIP                      83         16.9%
  1.15-1.35 WHIP                 114         11.4%
  1.35+ WHIP                      95         11.6%

By park factor:
  Bucket                           N   Actual hit%
  Pitcher park (<97)              89         16.9%
  Neutral park (97-103)          136         11.0%
  Hitter park (104-119)           54         14.8%
  Extreme hitter park (120+)      13          0.0%

Picks with 2-strike suppression data: 127/292

By opposing pitcher 2-strike hard-hit suppression:
  Bucket                           N   Actual hit%
  Suppresses hard (<=-5pp)        29         17.2%
  Neutral (-5 to +5pp)            97         16.5%
  Gets hit harder (5pp+)           1          0.0%

Picks with batter AB-total data: 292/292

By batter season AB total:
  Bucket                           N   Actual hit%
  <150 AB (part-time)             24          4.2%
  150-350 AB (platoon/bench)     122         11.5%
  350+ AB (everyday)             146         15.8%

══════════════════════════════════════════════════════════════════════
```

## K Props

```
══════════════════════════════════════════════════════════════════════
K PROPS CALIBRATION REPORT
══════════════════════════════════════════════════════════════════════
Total captured: 1429  |  Graded: 1405  |  Pending: 24
Overall OVER hit rate: 768/1405 = 54.7%  (0 pushes)

Edge calibration (projK - line bucket vs actual OVER hit rate):
  Bucket                 N    OVER hit%
  <0.5                 252        48.4%
  0.5-1.0              508        52.6%
  1.0-1.5              515        60.0%
  1.5-2.0               97        57.7%
  2.0+                  33        42.4%

  Edge < 1.0: 51.2% actual (n=760)  vs  Edge >= 1.0: 58.8% actual (n=645)
  z = -2.84 (statistically significant difference, p<0.05)

By line source:
  Bucket                 N    OVER hit%
  model                977        57.0%
  sportsbook           428        49.3%

Miss diagnosis (581/637 losses with performance data):
  Short outing (pulled early, never got the look): 280 (48.2%)
  Full outing, just didn't miss enough bats: 301 (51.8%)

Picks with matchup snapshot data: 1221/1405

By pitcher K/9:
  Bucket                 N    OVER hit%
  <7 K/9               305        59.3%
  7-9 K/9              494        53.6%
  9+ K/9               422        48.6%

By opponent lineup K-rate:
  Bucket                 N    OVER hit%
  Low-K lineup (<20%)    38        57.9%
  Avg lineup (20-25%)  1166        53.1%
  High-K lineup (25%+)    17        58.8%

Avg season K% by batting-order spot (n=150 lineups):
  Spot 1: 20.4%
  Spot 2: 21.0%
  Spot 3: 20.5%
  Spot 4: 21.6%
  Spot 5: 21.4%
  Spot 6: 22.2%
  Spot 7: 24.0%
  Spot 8: 21.8%
  Spot 9: 22.5%

══════════════════════════════════════════════════════════════════════
```

## Diamond Report Pick (game winner)

```
══════════════════════════════════════════════════════════════════════
DIAMOND REPORT PICK (GAME WINNER) CALIBRATION REPORT
══════════════════════════════════════════════════════════════════════
Total captured: 693  |  Graded: 683  |  Pending: 10
Overall pick hit rate: 379/683 = 55.5%  (0 pushes)

Confidence calibration (pickPct bucket vs actual hit rate):
  Bucket                 N   Actual hit%
  50-54%               397         54.9%
  55-59%               260         55.8%
  60-64%                26         61.5%

  pickPct < 60%: 55.3% actual (n=657)  vs  pickPct >= 60%: 61.5% actual (n=26)
  z = -0.63 (not conventionally significant at this sample size)

Picks with matchup snapshot data: 595/683

By starting-pitcher ERA gap:
  Bucket                 N   Actual hit%
  ERA gap <0.3          83         55.4%
  ERA gap 0.3-1.0      157         49.7%
  ERA gap 1.0+         355         57.7%

By team record gap:
  Bucket                 N   Actual hit%
  Record gap <5pt      235         52.3%
  Record gap 5-15pt    309         56.6%
  Record gap 15pt+      51         60.8%

By day/night:
  Bucket                 N   Actual hit%
  Day game             193         54.9%
  Night game           402         55.5%

══════════════════════════════════════════════════════════════════════
```
