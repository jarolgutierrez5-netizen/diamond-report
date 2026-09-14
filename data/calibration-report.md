# Model Calibration Report

Generated 2026-09-14 19:51 UTC by the weekly calibration-report workflow.
Re-run any of these locally any time: `node scripts/analyze-<name>-matchups.mjs`.

## HR Threats

```
══════════════════════════════════════════════════════════════════════
HR THREATS CALIBRATION REPORT
══════════════════════════════════════════════════════════════════════
Total captured: 377  |  Graded (win/loss): 369  |  Pending: 8
Overall actual hit rate: 58/369 = 15.7%

Score calibration (predicted HR% bucket vs actual hit rate):
  Bucket                           N   Actual hit%   Avg predicted%
  18%                              1          0.0%            18.0%
  19%                              4          0.0%            19.0%
  20-21%                           1          0.0%            20.0%
  25-29%                          16         37.5%            27.4%
  30%+                           347         15.0%            63.6%

  Score < 22%: 0.0% actual (n=6)  vs  Score >= 22%: 16.0% actual (n=363)
  z = -1.07 (not conventionally significant at this sample size)

Picks with live client score snapshot: 369/369

Live client score calibration (what users actually see):
  Bucket                           N   Actual hit%   Avg predicted%
  18%                             96          7.3%            14.4%
  19%                              9          0.0%            19.0%
  20-21%                          15          6.7%            20.4%
  22-24%                          31         22.6%            23.1%
  25-29%                          71         21.1%            27.1%
  30%+                           147         19.0%            34.5%

  Live score < 22%: 6.7% actual (n=120)  vs  Live score >= 22%: 20.1% actual (n=249)
  z = -3.32 (statistically significant difference, p<0.05)

Score source breakdown: 369/369 picks have hrScoreSource recorded
  logistic   n=    6   actual hit rate: 0.0%
  legacy     n=  363   actual hit rate: 16.0%

isOnFire: TRUE 15.6% (n=365)  vs  FALSE 25.0% (n=4)
  (below the 20-per-side sample floor — too thin to read as signal yet, treat as noise-risk)

isFavorable: TRUE 15.7% (n=89)  vs  FALSE 15.7% (n=280)
  z = 0.00 (not conventionally significant at this sample size)

isDrought: TRUE 20.0% (n=5)  vs  FALSE 15.7% (n=364)
  (below the 20-per-side sample floor — too thin to read as signal yet, treat as noise-risk)

isDue: TRUE 25.0% (n=4)  vs  FALSE 15.6% (n=365)
  (below the 20-per-side sample floor — too thin to read as signal yet, treat as noise-risk)

hasNearHR: TRUE 21.0% (n=143)  vs  FALSE 12.4% (n=226)
  z = 2.21 (statistically significant difference, p<0.05)

Picks with platoon-split data: 366/369
  platoonFavorable: TRUE 16.1% (n=180)  vs  FALSE 15.6% (n=186)
  z = 0.14 (not conventionally significant at this sample size)

Picks with Matchup Edge data: 167/369

Matchup Edge calibration (predicted grade vs actual hit rate):
  Bucket                           N   Actual hit%   Avg predicted%
  Weak (<45)                       3          0.0%            43.0%
  Neutral (45-63)                 41         24.4%            57.3%
  Strong (64-77)                  85         22.4%            70.8%
  Excellent (78+)                 38         23.7%            82.3%

  Matchup Edge < 64: 22.7% actual (n=44)  vs  Matchup Edge >= 64: 22.8% actual (n=123)
  z = -0.01 (not conventionally significant at this sample size)

Picks with pitcher-matchup data: 369/369

By opposing pitcher HR/9 allowed:
  Bucket                           N   Actual hit%
  <0.9 HR/9                       90         14.4%
  0.9-1.2 HR/9                    95         16.8%
  1.2+ HR/9                      184         15.8%

By opposing pitcher WHIP:
  Bucket                           N   Actual hit%
  <1.15 WHIP                     102         18.6%
  1.15-1.35 WHIP                 143         13.3%
  1.35+ WHIP                     124         16.1%

By park factor:
  Bucket                           N   Actual hit%
  Pitcher park (<97)             103         19.4%
  Neutral park (97-103)          181         15.5%
  Hitter park (104-119)           72         13.9%
  Extreme hitter park (120+)      13          0.0%

Picks with 2-strike suppression data: 200/369

By opposing pitcher 2-strike hard-hit suppression:
  Bucket                           N   Actual hit%
  Suppresses hard (<=-5pp)        41         22.0%
  Neutral (-5 to +5pp)           158         19.6%
  Gets hit harder (5pp+)           1          0.0%

Picks with batter AB-total data: 369/369

By batter season AB total:
  Bucket                           N   Actual hit%
  <150 AB (part-time)             24          4.2%
  150-350 AB (platoon/bench)     134         12.7%
  350+ AB (everyday)             211         19.0%

══════════════════════════════════════════════════════════════════════
```

## K Props

```
══════════════════════════════════════════════════════════════════════
K PROPS CALIBRATION REPORT
══════════════════════════════════════════════════════════════════════
Total captured: 1594  |  Graded: 1559  |  Pending: 35
Overall OVER hit rate: 844/1559 = 54.1%  (0 pushes)

Edge calibration (projK - line bucket vs actual OVER hit rate):
  Bucket                 N    OVER hit%
  <0.5                 255        48.2%
  0.5-1.0              573        51.0%
  1.0-1.5              592        59.6%
  1.5-2.0              105        58.1%
  2.0+                  34        44.1%

  Edge < 1.0: 50.1% actual (n=828)  vs  Edge >= 1.0: 58.7% actual (n=731)
  z = -3.39 (statistically significant difference, p<0.05)

By line source:
  Bucket                 N    OVER hit%
  model               1122        56.1%
  sportsbook           437        49.2%

Miss diagnosis (659/715 losses with performance data):
  Short outing (pulled early, never got the look): 324 (49.2%)
  Full outing, just didn't miss enough bats: 335 (50.8%)

Picks with matchup snapshot data: 1375/1559

By pitcher K/9:
  Bucket                 N    OVER hit%
  <7 K/9               335        59.4%
  7-9 K/9              562        53.0%
  9+ K/9               478        48.1%

By opponent lineup K-rate:
  Bucket                 N    OVER hit%
  Low-K lineup (<20%)    45        55.6%
  Avg lineup (20-25%)  1306        52.7%
  High-K lineup (25%+)    24        58.3%

Avg season K% by batting-order spot (n=195 lineups):
  Spot 1: 20.7%
  Spot 2: 21.0%
  Spot 3: 20.7%
  Spot 4: 21.8%
  Spot 5: 21.7%
  Spot 6: 22.2%
  Spot 7: 23.8%
  Spot 8: 22.4%
  Spot 9: 22.9%

══════════════════════════════════════════════════════════════════════
```

## Diamond Report Pick (game winner)

```
══════════════════════════════════════════════════════════════════════
DIAMOND REPORT PICK (GAME WINNER) CALIBRATION REPORT
══════════════════════════════════════════════════════════════════════
Total captured: 776  |  Graded: 760  |  Pending: 16
Overall pick hit rate: 425/760 = 55.9%  (0 pushes)

Confidence calibration (pickPct bucket vs actual hit rate):
  Bucket                 N   Actual hit%
  50-54%               439         54.4%
  55-59%               288         56.9%
  60-64%                33         66.7%

  pickPct < 60%: 55.4% actual (n=727)  vs  pickPct >= 60%: 66.7% actual (n=33)
  z = -1.27 (not conventionally significant at this sample size)

Picks with matchup snapshot data: 672/760

By starting-pitcher ERA gap:
  Bucket                 N   Actual hit%
  ERA gap <0.3          91         54.9%
  ERA gap 0.3-1.0      181         50.8%
  ERA gap 1.0+         400         58.3%

By team record gap:
  Bucket                 N   Actual hit%
  Record gap <5pt      265         52.5%
  Record gap 5-15pt    349         57.6%
  Record gap 15pt+      58         60.3%

By day/night:
  Bucket                 N   Actual hit%
  Day game             219         55.3%
  Night game           453         56.1%

══════════════════════════════════════════════════════════════════════
```
