# Model Calibration Report

Generated 2026-08-31 20:51 UTC by the weekly calibration-report workflow.
Re-run any of these locally any time: `node scripts/analyze-<name>-matchups.mjs`.

## HR Threats

```
══════════════════════════════════════════════════════════════════════
HR THREATS CALIBRATION REPORT
══════════════════════════════════════════════════════════════════════
Total captured: 222  |  Graded (win/loss): 183  |  Pending: 39
Overall actual hit rate: 23/183 = 12.6%

Score calibration (predicted HR% bucket vs actual hit rate):
  Bucket                           N   Actual hit%   Avg predicted%
  18%                              1          0.0%            18.0%
  19%                              4          0.0%            19.0%
  20-21%                           1          0.0%            20.0%
  25-29%                          16         37.5%            27.4%
  30%+                           161         10.6%            58.0%

  Score < 22%: 0.0% actual (n=6)  vs  Score >= 22%: 13.0% actual (n=177)
  z = -0.94 (not conventionally significant at this sample size)

Picks with live client score snapshot: 183/183

Live client score calibration (what users actually see):
  Bucket                           N   Actual hit%   Avg predicted%
  18%                             76          9.2%            14.3%
  19%                              7          0.0%            19.0%
  20-21%                           8         12.5%            20.5%
  22-24%                          16         12.5%            23.1%
  25-29%                          27         14.8%            27.3%
  30%+                            49         18.4%            34.1%

  Live score < 22%: 8.8% actual (n=91)  vs  Live score >= 22%: 16.3% actual (n=92)
  z = -1.53 (not conventionally significant at this sample size)

Score source breakdown: 183/183 picks have hrScoreSource recorded
  logistic   n=    6   actual hit rate: 0.0%
  legacy     n=  177   actual hit rate: 13.0%

isOnFire: TRUE 12.3% (n=179)  vs  FALSE 25.0% (n=4)
  (below the 20-per-side sample floor — too thin to read as signal yet, treat as noise-risk)

isFavorable: TRUE 14.0% (n=43)  vs  FALSE 12.1% (n=140)
  z = 0.31 (not conventionally significant at this sample size)

isDrought: TRUE 20.0% (n=5)  vs  FALSE 12.4% (n=178)
  (below the 20-per-side sample floor — too thin to read as signal yet, treat as noise-risk)

isDue: TRUE 25.0% (n=4)  vs  FALSE 12.3% (n=179)
  (below the 20-per-side sample floor — too thin to read as signal yet, treat as noise-risk)

hasNearHR: TRUE 17.5% (n=57)  vs  FALSE 10.3% (n=126)
  z = 1.37 (not conventionally significant at this sample size)

Picks with platoon-split data: 181/183
  platoonFavorable: TRUE 14.8% (n=81)  vs  FALSE 11.0% (n=100)
  z = 0.77 (not conventionally significant at this sample size)

Picks with Matchup Edge data: 33/183

Matchup Edge calibration (predicted grade vs actual hit rate):
  Bucket                           N   Actual hit%   Avg predicted%
  Weak (<45)                       1          0.0%            42.0%
  Neutral (45-63)                  9         22.2%            57.7%
  Strong (64-77)                  17         35.3%            72.0%
  Excellent (78+)                  6         16.7%            81.5%

  Matchup Edge < 64: 20.0% actual (n=10)  vs  Matchup Edge >= 64: 30.4% actual (n=23)
  z = -0.62 (not conventionally significant at this sample size)

Picks with pitcher-matchup data: 183/183

By opposing pitcher HR/9 allowed:
  Bucket                           N   Actual hit%
  <0.9 HR/9                       49         14.3%
  0.9-1.2 HR/9                    44         13.6%
  1.2+ HR/9                       90         11.1%

By opposing pitcher WHIP:
  Bucket                           N   Actual hit%
  <1.15 WHIP                      51         13.7%
  1.15-1.35 WHIP                  70         11.4%
  1.35+ WHIP                      62         12.9%

By park factor:
  Bucket                           N   Actual hit%
  Pitcher park (<97)              62         21.0%
  Neutral park (97-103)           87          8.0%
  Hitter park (104-119)           28         10.7%
  Extreme hitter park (120+)       6          0.0%

Picks with 2-strike suppression data: 62/183

By opposing pitcher 2-strike hard-hit suppression:
  Bucket                           N   Actual hit%
  Suppresses hard (<=-5pp)        15         13.3%
  Neutral (-5 to +5pp)            47         14.9%

Picks with batter AB-total data: 183/183

By batter season AB total:
  Bucket                           N   Actual hit%
  <150 AB (part-time)             18          5.6%
  150-350 AB (platoon/bench)      80         13.8%
  350+ AB (everyday)              85         12.9%

══════════════════════════════════════════════════════════════════════
```

## K Props

```
══════════════════════════════════════════════════════════════════════
K PROPS CALIBRATION REPORT
══════════════════════════════════════════════════════════════════════
Total captured: 1263  |  Graded: 1224  |  Pending: 39
Overall OVER hit rate: 677/1224 = 55.3%  (0 pushes)

Edge calibration (projK - line bucket vs actual OVER hit rate):
  Bucket                 N    OVER hit%
  <0.5                 175        46.3%
  0.5-1.0              458        52.6%
  1.0-1.5              486        60.5%
  1.5-2.0               87        60.9%
  2.0+                  18        44.4%

  Edge < 1.0: 50.9% actual (n=633)  vs  Edge >= 1.0: 60.1% actual (n=591)
  z = -3.23 (statistically significant difference, p<0.05)

By line source:
  Bucket                 N    OVER hit%
  model                934        57.2%
  sportsbook           290        49.3%

Miss diagnosis (491/547 losses with performance data):
  Short outing (pulled early, never got the look): 234 (47.7%)
  Full outing, just didn't miss enough bats: 257 (52.3%)

Picks with matchup snapshot data: 1040/1224

By pitcher K/9:
  Bucket                 N    OVER hit%
  <7 K/9               253        62.5%
  7-9 K/9              427        54.1%
  9+ K/9               360        47.5%

By opponent lineup K-rate:
  Bucket                 N    OVER hit%
  Low-K lineup (<20%)    32        53.1%
  Avg lineup (20-25%)   995        53.9%
  High-K lineup (25%+)    13        53.8%

Avg season K% by batting-order spot (n=119 lineups):
  Spot 1: 20.3%
  Spot 2: 21.0%
  Spot 3: 20.3%
  Spot 4: 21.9%
  Spot 5: 21.3%
  Spot 6: 21.7%
  Spot 7: 23.8%
  Spot 8: 21.4%
  Spot 9: 22.4%

══════════════════════════════════════════════════════════════════════
```

## Diamond Report Pick (game winner)

```
══════════════════════════════════════════════════════════════════════
DIAMOND REPORT PICK (GAME WINNER) CALIBRATION REPORT
══════════════════════════════════════════════════════════════════════
Total captured: 612  |  Graded: 594  |  Pending: 18
Overall pick hit rate: 325/594 = 54.7%  (0 pushes)

Confidence calibration (pickPct bucket vs actual hit rate):
  Bucket                 N   Actual hit%
  50-54%               345         53.9%
  55-59%               226         54.9%
  60-64%                23         65.2%

  pickPct < 60%: 54.3% actual (n=571)  vs  pickPct >= 60%: 65.2% actual (n=23)
  z = -1.03 (not conventionally significant at this sample size)

Picks with matchup snapshot data: 506/594

By starting-pitcher ERA gap:
  Bucket                 N   Actual hit%
  ERA gap <0.3          70         54.3%
  ERA gap 0.3-1.0      136         47.8%
  ERA gap 1.0+         300         57.3%

By team record gap:
  Bucket                 N   Actual hit%
  Record gap <5pt      206         49.5%
  Record gap 5-15pt    255         56.9%
  Record gap 15pt+      45         62.2%

By day/night:
  Bucket                 N   Actual hit%
  Day game             175         54.9%
  Night game           331         54.1%

══════════════════════════════════════════════════════════════════════
```
