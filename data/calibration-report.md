# Model Calibration Report

Generated 2026-08-03 17:20 UTC by the weekly calibration-report workflow.
Re-run any of these locally any time: `node scripts/analyze-<name>-matchups.mjs`.

## HR Threats

```
══════════════════════════════════════════════════════════════════════
HR THREATS CALIBRATION REPORT
══════════════════════════════════════════════════════════════════════
Total captured: 1176  |  Graded (win/loss): 1149  |  Pending: 27
Overall actual hit rate: 157/1149 = 13.7%

Score calibration (predicted HR% bucket vs actual hit rate):
  Bucket                           N   Actual hit%   Avg predicted%
  18%                            259         15.4%            18.0%
  19%                            200         16.0%            19.0%
  20-21%                         304         11.8%            20.4%
  22-24%                         214         10.7%            22.8%
  25-29%                         119         15.1%            26.4%
  30%+                            53         15.1%            33.2%

  Score < 22%: 14.2% actual (n=763)  vs  Score >= 22%: 12.7% actual (n=386)
  z = 0.68 (not conventionally significant at this sample size)

Picks with live client score snapshot: 572/1149

Live client score calibration (what users actually see):
  Bucket                           N   Actual hit%   Avg predicted%
  18%                             70         10.0%            17.4%
  19%                             62         14.5%            19.0%
  20-21%                         121         14.0%            20.5%
  22-24%                         153         13.1%            22.9%
  25-29%                         103         19.4%            26.5%
  30%+                            63         14.3%            33.9%

  Live score < 22%: 13.0% actual (n=253)  vs  Live score >= 22%: 15.4% actual (n=319)
  z = -0.79 (not conventionally significant at this sample size)

isOnFire: TRUE 14.4% (n=630)  vs  FALSE 15.2% (n=105)
  z = -0.21 (not conventionally significant at this sample size)

isFavorable: TRUE 14.7% (n=273)  vs  FALSE 14.5% (n=462)
  z = 0.06 (not conventionally significant at this sample size)

isDrought: TRUE 14.6% (n=123)  vs  FALSE 14.5% (n=612)
  z = 0.03 (not conventionally significant at this sample size)

isDue: TRUE 16.2% (n=74)  vs  FALSE 14.4% (n=661)
  z = 0.43 (not conventionally significant at this sample size)

hasNearHR: TRUE 16.2% (n=179)  vs  FALSE 14.4% (n=291)
  z = 0.52 (not conventionally significant at this sample size)

Picks with platoon-split data: 566/1149
  platoonFavorable: TRUE 15.0% (n=314)  vs  FALSE 13.1% (n=252)
  z = 0.64 (not conventionally significant at this sample size)

Picks with Matchup Edge data: 526/1149

Matchup Edge calibration (predicted grade vs actual hit rate):
  Bucket                           N   Actual hit%   Avg predicted%
  Weak (<45)                      49         14.3%            38.5%
  Neutral (45-63)                213         12.7%            56.1%
  Strong (64-77)                 201         17.4%            69.8%
  Excellent (78+)                 63         12.7%            83.3%

  Matchup Edge < 64: 13.0% actual (n=262)  vs  Matchup Edge >= 64: 16.3% actual (n=264)
  z = -1.07 (not conventionally significant at this sample size)

Picks with pitcher-matchup data: 694/1149

By opposing pitcher HR/9 allowed:
  Bucket                           N   Actual hit%
  <0.9 HR/9                      104         17.3%
  0.9-1.2 HR/9                   140         16.4%
  1.2+ HR/9                      450         12.7%

By opposing pitcher WHIP:
  Bucket                           N   Actual hit%
  <1.15 WHIP                     134         14.9%
  1.15-1.35 WHIP                 248         15.7%
  1.35+ WHIP                     312         12.5%

By park factor:
  Bucket                           N   Actual hit%
  Pitcher park (<97)             247         15.0%
  Neutral park (97-103)          297         13.8%
  Hitter park (104-119)          124         10.5%
  Extreme hitter park (120+)      26         26.9%

Picks with 2-strike suppression data: 547/1149

By opposing pitcher 2-strike hard-hit suppression:
  Bucket                           N   Actual hit%
  Suppresses hard (<=-5pp)        98         12.2%
  Neutral (-5 to +5pp)           440         13.9%
  Gets hit harder (5pp+)           9          0.0%

══════════════════════════════════════════════════════════════════════
```

## K Props

```
══════════════════════════════════════════════════════════════════════
K PROPS CALIBRATION REPORT
══════════════════════════════════════════════════════════════════════
Total captured: 563  |  Graded: 537  |  Pending: 26
Overall OVER hit rate: 294/537 = 54.7%  (0 pushes)

Edge calibration (projK - line bucket vs actual OVER hit rate):
  Bucket                 N    OVER hit%
  <0.5                 130        45.4%
  0.5-1.0              162        51.9%
  1.0-1.5              194        63.4%
  1.5-2.0               39        56.4%
  2.0+                  12        50.0%

  Edge < 1.0: 49.0% actual (n=292)  vs  Edge >= 1.0: 61.6% actual (n=245)
  z = -2.94 (statistically significant difference, p<0.05)

By line source:
  Bucket                 N    OVER hit%
  model                320        58.4%
  sportsbook           217        49.3%

Miss diagnosis (187/243 losses with performance data):
  Short outing (pulled early, never got the look): 87 (46.5%)
  Full outing, just didn't miss enough bats: 100 (53.5%)

Picks with matchup snapshot data: 353/537

By pitcher K/9:
  Bucket                 N    OVER hit%
  <7 K/9                82        54.9%
  7-9 K/9              139        51.1%
  9+ K/9               132        46.2%

By opponent lineup K-rate:
  Bucket                 N    OVER hit%
  Low-K lineup (<20%)    13        61.5%
  Avg lineup (20-25%)   337        50.1%
  High-K lineup (25%+)     3         0.0%

Avg season K% by batting-order spot (n=59 lineups):
  Spot 1: 20.5%
  Spot 2: 20.2%
  Spot 3: 20.9%
  Spot 4: 21.9%
  Spot 5: 20.6%
  Spot 6: 21.4%
  Spot 7: 24.2%
  Spot 8: 21.7%
  Spot 9: 21.9%

══════════════════════════════════════════════════════════════════════
```

## Diamond Report Pick (game winner)

```
══════════════════════════════════════════════════════════════════════
DIAMOND REPORT PICK (GAME WINNER) CALIBRATION REPORT
══════════════════════════════════════════════════════════════════════
Total captured: 269  |  Graded: 257  |  Pending: 12
Overall pick hit rate: 134/257 = 52.1%  (0 pushes)

Confidence calibration (pickPct bucket vs actual hit rate):
  Bucket                 N   Actual hit%
  50-54%               154         51.3%
  55-59%                93         51.6%
  60-64%                10         70.0%

  pickPct < 60%: 51.4% actual (n=247)  vs  pickPct >= 60%: 70.0% actual (n=10)
  z = -1.15 (not conventionally significant at this sample size)

Picks with matchup snapshot data: 169/257

By starting-pitcher ERA gap:
  Bucket                 N   Actual hit%
  ERA gap <0.3          20         60.0%
  ERA gap 0.3-1.0       44         43.2%
  ERA gap 1.0+         105         50.5%

By team record gap:
  Bucket                 N   Actual hit%
  Record gap <5pt       75         44.0%
  Record gap 5-15pt     78         53.8%
  Record gap 15pt+      16         56.3%

By day/night:
  Bucket                 N   Actual hit%
  Day game              62         50.0%
  Night game           107         49.5%

══════════════════════════════════════════════════════════════════════
```
