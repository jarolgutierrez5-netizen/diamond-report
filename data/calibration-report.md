# Model Calibration Report

Generated 2026-09-21 20:00 UTC by the weekly calibration-report workflow.
Re-run any of these locally any time: `node scripts/analyze-<name>-matchups.mjs`.

## HR Threats

```
══════════════════════════════════════════════════════════════════════
HR THREATS CALIBRATION REPORT
══════════════════════════════════════════════════════════════════════
Total captured: 455  |  Graded (win/loss): 447  |  Pending: 8
Overall actual hit rate: 73/447 = 16.3%

Score calibration (predicted HR% bucket vs actual hit rate):
  Bucket                           N   Actual hit%   Avg predicted%
  18%                              1          0.0%            18.0%
  19%                              4          0.0%            19.0%
  20-21%                           1          0.0%            20.0%
  25-29%                          16         37.5%            27.4%
  30%+                           425         15.8%            64.9%

  Score < 22%: 0.0% actual (n=6)  vs  Score >= 22%: 16.6% actual (n=441)
  z = -1.09 (not conventionally significant at this sample size)

Picks with live client score snapshot: 447/447

Live client score calibration (what users actually see):
  Bucket                           N   Actual hit%   Avg predicted%
  18%                             96          7.3%            14.4%
  19%                              9          0.0%            19.0%
  20-21%                          19         10.5%            20.5%
  22-24%                          31         22.6%            23.1%
  25-29%                          94         20.2%            27.2%
  30%+                           198         19.2%            34.9%

  Live score < 22%: 7.3% actual (n=124)  vs  Live score >= 22%: 19.8% actual (n=323)
  z = -3.22 (statistically significant difference, p<0.05)

Score source breakdown: 447/447 picks have hrScoreSource recorded
  logistic   n=    6   actual hit rate: 0.0%
  legacy     n=  441   actual hit rate: 16.6%

isOnFire: TRUE 16.3% (n=443)  vs  FALSE 25.0% (n=4)
  (below the 20-per-side sample floor — too thin to read as signal yet, treat as noise-risk)

isFavorable: TRUE 18.3% (n=120)  vs  FALSE 15.6% (n=327)
  z = 0.69 (not conventionally significant at this sample size)

isDrought: TRUE 20.0% (n=5)  vs  FALSE 16.3% (n=442)
  (below the 20-per-side sample floor — too thin to read as signal yet, treat as noise-risk)

isDue: TRUE 25.0% (n=4)  vs  FALSE 16.3% (n=443)
  (below the 20-per-side sample floor — too thin to read as signal yet, treat as noise-risk)

hasNearHR: TRUE 20.5% (n=190)  vs  FALSE 13.2% (n=257)
  z = 2.06 (statistically significant difference, p<0.05)

Picks with platoon-split data: 444/447
  platoonFavorable: TRUE 17.6% (n=233)  vs  FALSE 15.2% (n=211)
  z = 0.69 (not conventionally significant at this sample size)

Picks with Matchup Edge data: 245/447

Matchup Edge calibration (predicted grade vs actual hit rate):
  Bucket                           N   Actual hit%   Avg predicted%
  Weak (<45)                       3          0.0%            43.0%
  Neutral (45-63)                 58         22.4%            57.3%
  Strong (64-77)                 123         19.5%            71.0%
  Excellent (78+)                 61         26.2%            82.4%

  Matchup Edge < 64: 21.3% actual (n=61)  vs  Matchup Edge >= 64: 21.7% actual (n=184)
  z = -0.07 (not conventionally significant at this sample size)

Picks with pitcher-matchup data: 447/447

By opposing pitcher HR/9 allowed:
  Bucket                           N   Actual hit%
  <0.9 HR/9                      109         17.4%
  0.9-1.2 HR/9                   110         16.4%
  1.2+ HR/9                      228         15.8%

By opposing pitcher WHIP:
  Bucket                           N   Actual hit%
  <1.15 WHIP                     112         18.8%
  1.15-1.35 WHIP                 182         14.3%
  1.35+ WHIP                     153         17.0%

By park factor:
  Bucket                           N   Actual hit%
  Pitcher park (<97)             124         19.4%
  Neutral park (97-103)          221         16.7%
  Hitter park (104-119)           82         13.4%
  Extreme hitter park (120+)      20          5.0%

Picks with 2-strike suppression data: 274/447

By opposing pitcher 2-strike hard-hit suppression:
  Bucket                           N   Actual hit%
  Suppresses hard (<=-5pp)        58         20.7%
  Neutral (-5 to +5pp)           215         19.5%
  Gets hit harder (5pp+)           1          0.0%

Picks with batter AB-total data: 447/447

By batter season AB total:
  Bucket                           N   Actual hit%
  <150 AB (part-time)             24          4.2%
  150-350 AB (platoon/bench)     144         11.8%
  350+ AB (everyday)             279         19.7%

══════════════════════════════════════════════════════════════════════
```

## K Props

```
══════════════════════════════════════════════════════════════════════
K PROPS CALIBRATION REPORT
══════════════════════════════════════════════════════════════════════
Total captured: 1747  |  Graded: 1725  |  Pending: 22
Overall OVER hit rate: 938/1725 = 54.4%  (0 pushes)

Edge calibration (projK - line bucket vs actual OVER hit rate):
  Bucket                 N    OVER hit%
  <0.5                 255        48.2%
  0.5-1.0              653        50.8%
  1.0-1.5              665        60.5%
  1.5-2.0              118        55.9%
  2.0+                  34        44.1%

  Edge < 1.0: 50.1% actual (n=908)  vs  Edge >= 1.0: 59.1% actual (n=817)
  z = -3.75 (statistically significant difference, p<0.05)

By line source:
  Bucket                 N    OVER hit%
  model               1288        56.1%
  sportsbook           437        49.2%

Miss diagnosis (731/787 losses with performance data):
  Short outing (pulled early, never got the look): 368 (50.3%)
  Full outing, just didn't miss enough bats: 363 (49.7%)

Picks with matchup snapshot data: 1541/1725

By pitcher K/9:
  Bucket                 N    OVER hit%
  <7 K/9               377        59.7%
  7-9 K/9              633        54.2%
  9+ K/9               531        47.6%

By opponent lineup K-rate:
  Bucket                 N    OVER hit%
  Low-K lineup (<20%)    52        57.7%
  Avg lineup (20-25%)  1460        52.9%
  High-K lineup (25%+)    29        62.1%

Avg season K% by batting-order spot (n=228 lineups):
  Spot 1: 20.5%
  Spot 2: 20.9%
  Spot 3: 20.6%
  Spot 4: 22.0%
  Spot 5: 21.6%
  Spot 6: 22.1%
  Spot 7: 23.4%
  Spot 8: 23.0%
  Spot 9: 23.3%

══════════════════════════════════════════════════════════════════════
```

## Diamond Report Pick (game winner)

```
══════════════════════════════════════════════════════════════════════
DIAMOND REPORT PICK (GAME WINNER) CALIBRATION REPORT
══════════════════════════════════════════════════════════════════════
Total captured: 852  |  Graded: 843  |  Pending: 9
Overall pick hit rate: 477/843 = 56.6%  (0 pushes)

Confidence calibration (pickPct bucket vs actual hit rate):
  Bucket                 N   Actual hit%
  50-54%               490         54.5%
  55-59%               316         58.5%
  60-64%                37         67.6%

  pickPct < 60%: 56.1% actual (n=806)  vs  pickPct >= 60%: 67.6% actual (n=37)
  z = -1.38 (not conventionally significant at this sample size)

Picks with matchup snapshot data: 755/843

By starting-pitcher ERA gap:
  Bucket                 N   Actual hit%
  ERA gap <0.3         103         56.3%
  ERA gap 0.3-1.0      203         51.2%
  ERA gap 1.0+         449         59.0%

By team record gap:
  Bucket                 N   Actual hit%
  Record gap <5pt      291         52.2%
  Record gap 5-15pt    398         58.8%
  Record gap 15pt+      66         62.1%

By day/night:
  Bucket                 N   Actual hit%
  Day game             234         56.0%
  Night game           521         56.8%

══════════════════════════════════════════════════════════════════════
```
