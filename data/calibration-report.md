# Model Calibration Report

Generated 2026-10-05 22:03 UTC by the weekly calibration-report workflow.
Re-run any of these locally any time: `node scripts/analyze-<name>-matchups.mjs`.

## HR Threats

```
══════════════════════════════════════════════════════════════════════
HR THREATS CALIBRATION REPORT
══════════════════════════════════════════════════════════════════════
Total captured: 595  |  Graded (win/loss): 584  |  Pending: 11
Overall actual hit rate: 89/584 = 15.2%

Score calibration (predicted HR% bucket vs actual hit rate):
  Bucket                           N   Actual hit%   Avg predicted%
  18%                              1          0.0%            18.0%
  19%                              4          0.0%            19.0%
  20-21%                           1          0.0%            20.0%
  25-29%                          16         37.5%            27.4%
  30%+                           562         14.8%            65.1%

  Score < 22%: 0.0% actual (n=6)  vs  Score >= 22%: 15.4% actual (n=578)
  z = -1.04 (not conventionally significant at this sample size)

Picks with live client score snapshot: 584/584

Live client score calibration (what users actually see):
  Bucket                           N   Actual hit%   Avg predicted%
  18%                            228          9.6%            13.0%
  19%                              9          0.0%            19.0%
  20-21%                          19         10.5%            20.5%
  22-24%                          32         21.9%            23.2%
  25-29%                          97         19.6%            27.2%
  30%+                           199         19.6%            34.9%

  Live score < 22%: 9.4% actual (n=256)  vs  Live score >= 22%: 19.8% actual (n=328)
  z = -3.48 (statistically significant difference, p<0.05)

Score source breakdown: 584/584 picks have hrScoreSource recorded
  logistic   n=    6   actual hit rate: 0.0%
  legacy     n=  578   actual hit rate: 15.4%

isOnFire: TRUE 15.2% (n=580)  vs  FALSE 25.0% (n=4)
  (below the 20-per-side sample floor — too thin to read as signal yet, treat as noise-risk)

isFavorable: TRUE 17.1% (n=158)  vs  FALSE 14.6% (n=426)
  z = 0.76 (not conventionally significant at this sample size)

isDrought: TRUE 20.0% (n=5)  vs  FALSE 15.2% (n=579)
  (below the 20-per-side sample floor — too thin to read as signal yet, treat as noise-risk)

isDue: TRUE 25.0% (n=4)  vs  FALSE 15.2% (n=580)
  (below the 20-per-side sample floor — too thin to read as signal yet, treat as noise-risk)

hasNearHR: TRUE 19.0% (n=247)  vs  FALSE 12.5% (n=337)
  z = 2.18 (statistically significant difference, p<0.05)

Picks with platoon-split data: 581/584
  platoonFavorable: TRUE 16.8% (n=298)  vs  FALSE 13.8% (n=283)
  z = 1.00 (not conventionally significant at this sample size)

Picks with Matchup Edge data: 349/584

Matchup Edge calibration (predicted grade vs actual hit rate):
  Bucket                           N   Actual hit%   Avg predicted%
  Weak (<45)                       5          0.0%            40.8%
  Neutral (45-63)                 97         17.5%            57.5%
  Strong (64-77)                 164         17.7%            70.9%
  Excellent (78+)                 83         24.1%            82.3%

  Matchup Edge < 64: 16.7% actual (n=102)  vs  Matchup Edge >= 64: 19.8% actual (n=247)
  z = -0.69 (not conventionally significant at this sample size)

Picks with pitcher-matchup data: 584/584

By opposing pitcher HR/9 allowed:
  Bucket                           N   Actual hit%
  <0.9 HR/9                      145         13.8%
  0.9-1.2 HR/9                   153         15.7%
  1.2+ HR/9                      286         15.7%

By opposing pitcher WHIP:
  Bucket                           N   Actual hit%
  <1.15 WHIP                     160         15.6%
  1.15-1.35 WHIP                 231         13.9%
  1.35+ WHIP                     193         16.6%

By park factor:
  Bucket                           N   Actual hit%
  Pitcher park (<97)             162         17.3%
  Neutral park (97-103)          287         16.0%
  Hitter park (104-119)          111         12.6%
  Extreme hitter park (120+)      24          4.2%

Picks with 2-strike suppression data: 379/584

By opposing pitcher 2-strike hard-hit suppression:
  Bucket                           N   Actual hit%
  Suppresses hard (<=-5pp)        82         18.3%
  Neutral (-5 to +5pp)           296         17.6%
  Gets hit harder (5pp+)           1          0.0%

Picks with batter AB-total data: 584/584

By batter season AB total:
  Bucket                           N   Actual hit%
  <150 AB (part-time)             29          6.9%
  150-350 AB (platoon/bench)     162         11.1%
  350+ AB (everyday)             393         17.6%

══════════════════════════════════════════════════════════════════════
```

## K Props

```
══════════════════════════════════════════════════════════════════════
K PROPS CALIBRATION REPORT
══════════════════════════════════════════════════════════════════════
Total captured: 1931  |  Graded: 1909  |  Pending: 22
Overall OVER hit rate: 1020/1909 = 53.4%  (0 pushes)

Edge calibration (projK - line bucket vs actual OVER hit rate):
  Bucket                 N    OVER hit%
  <0.5                 263        47.9%
  0.5-1.0              745        50.1%
  1.0-1.5              744        58.9%
  1.5-2.0              122        54.9%
  2.0+                  35        45.7%

  Edge < 1.0: 49.5% actual (n=1008)  vs  Edge >= 1.0: 57.8% actual (n=901)
  z = -3.64 (statistically significant difference, p<0.05)

By line source:
  Bucket                 N    OVER hit%
  model               1462        54.8%
  sportsbook           447        49.0%

Miss diagnosis (833/889 losses with performance data):
  Short outing (pulled early, never got the look): 442 (53.1%)
  Full outing, just didn't miss enough bats: 391 (46.9%)

Picks with matchup snapshot data: 1725/1909

By pitcher K/9:
  Bucket                 N    OVER hit%
  <7 K/9               411        58.2%
  7-9 K/9              713        53.9%
  9+ K/9               601        46.6%

By opponent lineup K-rate:
  Bucket                 N    OVER hit%
  Low-K lineup (<20%)    60        51.7%
  Avg lineup (20-25%)  1627        52.4%
  High-K lineup (25%+)    38        52.6%

Avg season K% by batting-order spot (n=256 lineups):
  Spot 1: 20.7%
  Spot 2: 21.0%
  Spot 3: 20.8%
  Spot 4: 21.9%
  Spot 5: 21.9%
  Spot 6: 22.2%
  Spot 7: 23.6%
  Spot 8: 23.1%
  Spot 9: 23.6%

══════════════════════════════════════════════════════════════════════
```

## Diamond Report Pick (game winner)

```
══════════════════════════════════════════════════════════════════════
DIAMOND REPORT PICK (GAME WINNER) CALIBRATION REPORT
══════════════════════════════════════════════════════════════════════
Total captured: 941  |  Graded: 932  |  Pending: 9
Overall pick hit rate: 531/932 = 57.0%  (0 pushes)

Confidence calibration (pickPct bucket vs actual hit rate):
  Bucket                 N   Actual hit%
  50-54%               540         55.0%
  55-59%               350         59.1%
  60-64%                42         64.3%

  pickPct < 60%: 56.6% actual (n=890)  vs  pickPct >= 60%: 64.3% actual (n=42)
  z = -0.98 (not conventionally significant at this sample size)

Picks with matchup snapshot data: 844/932

By starting-pitcher ERA gap:
  Bucket                 N   Actual hit%
  ERA gap <0.3         120         58.3%
  ERA gap 0.3-1.0      229         52.0%
  ERA gap 1.0+         495         59.0%

By team record gap:
  Bucket                 N   Actual hit%
  Record gap <5pt      321         52.0%
  Record gap 5-15pt    432         58.6%
  Record gap 15pt+      83         65.1%

By day/night:
  Bucket                 N   Actual hit%
  Day game             263         57.8%
  Night game           581         56.6%

══════════════════════════════════════════════════════════════════════
```
