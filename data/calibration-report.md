# Model Calibration Report

Generated 2026-10-26 20:33 UTC by the weekly calibration-report workflow.
Re-run any of these locally any time: `node scripts/analyze-<name>-matchups.mjs`.

## HR Threats

```
══════════════════════════════════════════════════════════════════════
HR THREATS CALIBRATION REPORT
══════════════════════════════════════════════════════════════════════
Total captured: 690  |  Graded (win/loss): 683  |  Pending: 7
Overall actual hit rate: 94/683 = 13.8%

Score calibration (predicted HR% bucket vs actual hit rate):
  Bucket                           N   Actual hit%   Avg predicted%
  18%                              1          0.0%            18.0%
  19%                              4          0.0%            19.0%
  20-21%                           1          0.0%            20.0%
  25-29%                          16         37.5%            27.4%
  30%+                           661         13.3%            64.3%

  Score < 22%: 0.0% actual (n=6)  vs  Score >= 22%: 13.9% actual (n=677)
  z = -0.98 (not conventionally significant at this sample size)

Picks with live client score snapshot: 683/683

Live client score calibration (what users actually see):
  Bucket                           N   Actual hit%   Avg predicted%
  18%                            327          8.3%            12.7%
  19%                              9          0.0%            19.0%
  20-21%                          19         10.5%            20.5%
  22-24%                          32         21.9%            23.2%
  25-29%                          97         19.6%            27.2%
  30%+                           199         19.6%            34.9%

  Live score < 22%: 8.2% actual (n=355)  vs  Live score >= 22%: 19.8% actual (n=328)
  z = -4.41 (statistically significant difference, p<0.05)

Score source breakdown: 683/683 picks have hrScoreSource recorded
  logistic   n=    6   actual hit rate: 0.0%
  legacy     n=  677   actual hit rate: 13.9%

isOnFire: TRUE 13.7% (n=679)  vs  FALSE 25.0% (n=4)
  (below the 20-per-side sample floor — too thin to read as signal yet, treat as noise-risk)

isFavorable: TRUE 17.4% (n=161)  vs  FALSE 12.6% (n=522)
  z = 1.53 (not conventionally significant at this sample size)

isDrought: TRUE 20.0% (n=5)  vs  FALSE 13.7% (n=678)
  (below the 20-per-side sample floor — too thin to read as signal yet, treat as noise-risk)

isDue: TRUE 25.0% (n=4)  vs  FALSE 13.7% (n=679)
  (below the 20-per-side sample floor — too thin to read as signal yet, treat as noise-risk)

hasNearHR: TRUE 17.7% (n=282)  vs  FALSE 11.0% (n=401)
  z = 2.52 (statistically significant difference, p<0.05)

Picks with platoon-split data: 680/683
  platoonFavorable: TRUE 16.3% (n=325)  vs  FALSE 11.5% (n=355)
  z = 1.80 (not conventionally significant at this sample size)

Picks with Matchup Edge data: 398/683

Matchup Edge calibration (predicted grade vs actual hit rate):
  Bucket                           N   Actual hit%   Avg predicted%
  Weak (<45)                      11          0.0%            40.7%
  Neutral (45-63)                123         14.6%            56.7%
  Strong (64-77)                 180         16.1%            70.9%
  Excellent (78+)                 84         23.8%            82.3%

  Matchup Edge < 64: 13.4% actual (n=134)  vs  Matchup Edge >= 64: 18.6% actual (n=264)
  z = -1.29 (not conventionally significant at this sample size)

Picks with pitcher-matchup data: 683/683

By opposing pitcher HR/9 allowed:
  Bucket                           N   Actual hit%
  <0.9 HR/9                      182         13.2%
  0.9-1.2 HR/9                   179         13.4%
  1.2+ HR/9                      322         14.3%

By opposing pitcher WHIP:
  Bucket                           N   Actual hit%
  <1.15 WHIP                     220         13.2%
  1.15-1.35 WHIP                 262         12.6%
  1.35+ WHIP                     201         15.9%

By park factor:
  Bucket                           N   Actual hit%
  Pitcher park (<97)             205         15.1%
  Neutral park (97-103)          321         15.0%
  Hitter park (104-119)          133         10.5%
  Extreme hitter park (120+)      24          4.2%

Picks with 2-strike suppression data: 428/683

By opposing pitcher 2-strike hard-hit suppression:
  Bucket                           N   Actual hit%
  Suppresses hard (<=-5pp)        93         16.1%
  Neutral (-5 to +5pp)           334         15.9%
  Gets hit harder (5pp+)           1          0.0%

Picks with batter AB-total data: 683/683

By batter season AB total:
  Bucket                           N   Actual hit%
  <150 AB (part-time)             30          6.7%
  150-350 AB (platoon/bench)     210          9.5%
  350+ AB (everyday)             443         16.3%

══════════════════════════════════════════════════════════════════════
```

## K Props

```
══════════════════════════════════════════════════════════════════════
K PROPS CALIBRATION REPORT
══════════════════════════════════════════════════════════════════════
Total captured: 1973  |  Graded: 1953  |  Pending: 20
Overall OVER hit rate: 1033/1953 = 52.9%  (0 pushes)

Edge calibration (projK - line bucket vs actual OVER hit rate):
  Bucket                 N    OVER hit%
  <0.5                 277        47.3%
  0.5-1.0              756        49.6%
  1.0-1.5              754        58.5%
  1.5-2.0              126        54.0%
  2.0+                  40        45.0%

  Edge < 1.0: 49.0% actual (n=1033)  vs  Edge >= 1.0: 57.3% actual (n=920)
  z = -3.67 (statistically significant difference, p<0.05)

By line source:
  Bucket                 N    OVER hit%
  model               1471        54.5%
  sportsbook           482        48.1%

Miss diagnosis (864/920 losses with performance data):
  Short outing (pulled early, never got the look): 470 (54.4%)
  Full outing, just didn't miss enough bats: 394 (45.6%)

Picks with matchup snapshot data: 1769/1953

By pitcher K/9:
  Bucket                 N    OVER hit%
  <7 K/9               415        58.1%
  7-9 K/9              727        53.2%
  9+ K/9               627        45.9%

By opponent lineup K-rate:
  Bucket                 N    OVER hit%
  Low-K lineup (<20%)    61        52.5%
  Avg lineup (20-25%)  1670        51.7%
  High-K lineup (25%+)    38        52.6%

Avg season K% by batting-order spot (n=258 lineups):
  Spot 1: 20.7%
  Spot 2: 20.9%
  Spot 3: 20.7%
  Spot 4: 22.0%
  Spot 5: 21.9%
  Spot 6: 22.1%
  Spot 7: 23.5%
  Spot 8: 23.2%
  Spot 9: 23.7%

══════════════════════════════════════════════════════════════════════
```

## Diamond Report Pick (game winner)

```
══════════════════════════════════════════════════════════════════════
DIAMOND REPORT PICK (GAME WINNER) CALIBRATION REPORT
══════════════════════════════════════════════════════════════════════
Total captured: 962  |  Graded: 953  |  Pending: 9
Overall pick hit rate: 542/953 = 56.9%  (0 pushes)

Confidence calibration (pickPct bucket vs actual hit rate):
  Bucket                 N   Actual hit%
  50-54%               554         54.9%
  55-59%               357         59.1%
  60-64%                42         64.3%

  pickPct < 60%: 56.5% actual (n=911)  vs  pickPct >= 60%: 64.3% actual (n=42)
  z = -0.99 (not conventionally significant at this sample size)

Picks with matchup snapshot data: 865/953

By starting-pitcher ERA gap:
  Bucket                 N   Actual hit%
  ERA gap <0.3         127         59.1%
  ERA gap 0.3-1.0      234         51.3%
  ERA gap 1.0+         504         58.9%

By team record gap:
  Bucket                 N   Actual hit%
  Record gap <5pt      324         51.9%
  Record gap 5-15pt    432         58.6%
  Record gap 15pt+      98         63.3%

By day/night:
  Bucket                 N   Actual hit%
  Day game             267         57.7%
  Night game           598         56.5%

══════════════════════════════════════════════════════════════════════
```
