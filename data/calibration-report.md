# Model Calibration Report

Generated 2026-11-09 23:47 UTC by the weekly calibration-report workflow.
Re-run any of these locally any time: `node scripts/analyze-<name>-matchups.mjs`.

## HR Threats

```
══════════════════════════════════════════════════════════════════════
HR THREATS CALIBRATION REPORT
══════════════════════════════════════════════════════════════════════
Total captured: 699  |  Graded (win/loss): 697  |  Pending: 2
Overall actual hit rate: 94/697 = 13.5%

Score calibration (predicted HR% bucket vs actual hit rate):
  Bucket                           N   Actual hit%   Avg predicted%
  18%                              1          0.0%            18.0%
  19%                              4          0.0%            19.0%
  20-21%                           1          0.0%            20.0%
  25-29%                          16         37.5%            27.4%
  30%+                           675         13.0%            64.2%

  Score < 22%: 0.0% actual (n=6)  vs  Score >= 22%: 13.6% actual (n=691)
  z = -0.97 (not conventionally significant at this sample size)

Picks with live client score snapshot: 697/697

Live client score calibration (what users actually see):
  Bucket                           N   Actual hit%   Avg predicted%
  18%                            341          7.9%            12.7%
  19%                              9          0.0%            19.0%
  20-21%                          19         10.5%            20.5%
  22-24%                          32         21.9%            23.2%
  25-29%                          97         19.6%            27.2%
  30%+                           199         19.6%            34.9%

  Live score < 22%: 7.9% actual (n=369)  vs  Live score >= 22%: 19.8% actual (n=328)
  z = -4.61 (statistically significant difference, p<0.05)

Score source breakdown: 697/697 picks have hrScoreSource recorded
  logistic   n=    6   actual hit rate: 0.0%
  legacy     n=  691   actual hit rate: 13.6%

isOnFire: TRUE 13.4% (n=693)  vs  FALSE 25.0% (n=4)
  (below the 20-per-side sample floor — too thin to read as signal yet, treat as noise-risk)

isFavorable: TRUE 17.3% (n=162)  vs  FALSE 12.3% (n=535)
  z = 1.62 (not conventionally significant at this sample size)

isDrought: TRUE 20.0% (n=5)  vs  FALSE 13.4% (n=692)
  (below the 20-per-side sample floor — too thin to read as signal yet, treat as noise-risk)

isDue: TRUE 25.0% (n=4)  vs  FALSE 13.4% (n=693)
  (below the 20-per-side sample floor — too thin to read as signal yet, treat as noise-risk)

hasNearHR: TRUE 17.4% (n=288)  vs  FALSE 10.8% (n=409)
  z = 2.51 (statistically significant difference, p<0.05)

Picks with platoon-split data: 694/697
  platoonFavorable: TRUE 16.1% (n=329)  vs  FALSE 11.2% (n=365)
  z = 1.87 (not conventionally significant at this sample size)

Picks with Matchup Edge data: 406/697

Matchup Edge calibration (predicted grade vs actual hit rate):
  Bucket                           N   Actual hit%   Avg predicted%
  Weak (<45)                      12          0.0%            40.5%
  Neutral (45-63)                128         14.1%            56.8%
  Strong (64-77)                 182         15.9%            70.9%
  Excellent (78+)                 84         23.8%            82.3%

  Matchup Edge < 64: 12.9% actual (n=140)  vs  Matchup Edge >= 64: 18.4% actual (n=266)
  z = -1.44 (not conventionally significant at this sample size)

Picks with pitcher-matchup data: 697/697

By opposing pitcher HR/9 allowed:
  Bucket                           N   Actual hit%
  <0.9 HR/9                      187         12.8%
  0.9-1.2 HR/9                   179         13.4%
  1.2+ HR/9                      331         13.9%

By opposing pitcher WHIP:
  Bucket                           N   Actual hit%
  <1.15 WHIP                     224         12.9%
  1.15-1.35 WHIP                 272         12.1%
  1.35+ WHIP                     201         15.9%

By park factor:
  Bucket                           N   Actual hit%
  Pitcher park (<97)             219         14.2%
  Neutral park (97-103)          321         15.0%
  Hitter park (104-119)          133         10.5%
  Extreme hitter park (120+)      24          4.2%

Picks with 2-strike suppression data: 437/697

By opposing pitcher 2-strike hard-hit suppression:
  Bucket                           N   Actual hit%
  Suppresses hard (<=-5pp)        98         15.3%
  Neutral (-5 to +5pp)           338         15.7%
  Gets hit harder (5pp+)           1          0.0%

Picks with batter AB-total data: 697/697

By batter season AB total:
  Bucket                           N   Actual hit%
  <150 AB (part-time)             30          6.7%
  150-350 AB (platoon/bench)     212          9.4%
  350+ AB (everyday)             455         15.8%

══════════════════════════════════════════════════════════════════════
```

## K Props

```
══════════════════════════════════════════════════════════════════════
K PROPS CALIBRATION REPORT
══════════════════════════════════════════════════════════════════════
Total captured: 1977  |  Graded: 1959  |  Pending: 18
Overall OVER hit rate: 1034/1959 = 52.8%  (0 pushes)

Edge calibration (projK - line bucket vs actual OVER hit rate):
  Bucket                 N    OVER hit%
  <0.5                 278        47.1%
  0.5-1.0              758        49.6%
  1.0-1.5              755        58.4%
  1.5-2.0              127        53.5%
  2.0+                  41        43.9%

  Edge < 1.0: 48.9% actual (n=1036)  vs  Edge >= 1.0: 57.1% actual (n=923)
  z = -3.61 (statistically significant difference, p<0.05)

By line source:
  Bucket                 N    OVER hit%
  model               1473        54.4%
  sportsbook           486        47.9%

Miss diagnosis (869/925 losses with performance data):
  Short outing (pulled early, never got the look): 473 (54.4%)
  Full outing, just didn't miss enough bats: 396 (45.6%)

Picks with matchup snapshot data: 1775/1959

By pitcher K/9:
  Bucket                 N    OVER hit%
  <7 K/9               415        58.1%
  7-9 K/9              730        53.2%
  9+ K/9               630        45.7%

By opponent lineup K-rate:
  Bucket                 N    OVER hit%
  Low-K lineup (<20%)    61        52.5%
  Avg lineup (20-25%)  1676        51.6%
  High-K lineup (25%+)    38        52.6%

Avg season K% by batting-order spot (n=259 lineups):
  Spot 1: 20.7%
  Spot 2: 20.9%
  Spot 3: 20.8%
  Spot 4: 21.9%
  Spot 5: 21.8%
  Spot 6: 22.1%
  Spot 7: 23.6%
  Spot 8: 23.2%
  Spot 9: 23.7%

══════════════════════════════════════════════════════════════════════
```

## Diamond Report Pick (game winner)

```
══════════════════════════════════════════════════════════════════════
DIAMOND REPORT PICK (GAME WINNER) CALIBRATION REPORT
══════════════════════════════════════════════════════════════════════
Total captured: 964  |  Graded: 956  |  Pending: 8
Overall pick hit rate: 543/956 = 56.8%  (0 pushes)

Confidence calibration (pickPct bucket vs actual hit rate):
  Bucket                 N   Actual hit%
  50-54%               557         54.8%
  55-59%               357         59.1%
  60-64%                42         64.3%

  pickPct < 60%: 56.5% actual (n=914)  vs  pickPct >= 60%: 64.3% actual (n=42)
  z = -1.00 (not conventionally significant at this sample size)

Picks with matchup snapshot data: 868/956

By starting-pitcher ERA gap:
  Bucket                 N   Actual hit%
  ERA gap <0.3         129         58.1%
  ERA gap 0.3-1.0      234         51.3%
  ERA gap 1.0+         505         59.0%

By team record gap:
  Bucket                 N   Actual hit%
  Record gap <5pt      324         51.9%
  Record gap 5-15pt    432         58.6%
  Record gap 15pt+     101         62.4%

By day/night:
  Bucket                 N   Actual hit%
  Day game             267         57.7%
  Night game           601         56.4%

══════════════════════════════════════════════════════════════════════
```
