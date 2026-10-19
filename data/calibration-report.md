# Model Calibration Report

Generated 2026-10-19 20:36 UTC by the weekly calibration-report workflow.
Re-run any of these locally any time: `node scripts/analyze-<name>-matchups.mjs`.

## HR Threats

```
══════════════════════════════════════════════════════════════════════
HR THREATS CALIBRATION REPORT
══════════════════════════════════════════════════════════════════════
Total captured: 675  |  Graded (win/loss): 668  |  Pending: 7
Overall actual hit rate: 94/668 = 14.1%

Score calibration (predicted HR% bucket vs actual hit rate):
  Bucket                           N   Actual hit%   Avg predicted%
  18%                              1          0.0%            18.0%
  19%                              4          0.0%            19.0%
  20-21%                           1          0.0%            20.0%
  25-29%                          16         37.5%            27.4%
  30%+                           646         13.6%            64.4%

  Score < 22%: 0.0% actual (n=6)  vs  Score >= 22%: 14.2% actual (n=662)
  z = -1.00 (not conventionally significant at this sample size)

Picks with live client score snapshot: 668/668

Live client score calibration (what users actually see):
  Bucket                           N   Actual hit%   Avg predicted%
  18%                            312          8.7%            12.7%
  19%                              9          0.0%            19.0%
  20-21%                          19         10.5%            20.5%
  22-24%                          32         21.9%            23.2%
  25-29%                          97         19.6%            27.2%
  30%+                           199         19.6%            34.9%

  Live score < 22%: 8.5% actual (n=340)  vs  Live score >= 22%: 19.8% actual (n=328)
  z = -4.19 (statistically significant difference, p<0.05)

Score source breakdown: 668/668 picks have hrScoreSource recorded
  logistic   n=    6   actual hit rate: 0.0%
  legacy     n=  662   actual hit rate: 14.2%

isOnFire: TRUE 14.0% (n=664)  vs  FALSE 25.0% (n=4)
  (below the 20-per-side sample floor — too thin to read as signal yet, treat as noise-risk)

isFavorable: TRUE 17.4% (n=161)  vs  FALSE 13.0% (n=507)
  z = 1.39 (not conventionally significant at this sample size)

isDrought: TRUE 20.0% (n=5)  vs  FALSE 14.0% (n=663)
  (below the 20-per-side sample floor — too thin to read as signal yet, treat as noise-risk)

isDue: TRUE 25.0% (n=4)  vs  FALSE 14.0% (n=664)
  (below the 20-per-side sample floor — too thin to read as signal yet, treat as noise-risk)

hasNearHR: TRUE 18.1% (n=276)  vs  FALSE 11.2% (n=392)
  z = 2.52 (statistically significant difference, p<0.05)

Picks with platoon-split data: 665/668
  platoonFavorable: TRUE 16.6% (n=320)  vs  FALSE 11.9% (n=345)
  z = 1.73 (not conventionally significant at this sample size)

Picks with Matchup Edge data: 383/668

Matchup Edge calibration (predicted grade vs actual hit rate):
  Bucket                           N   Actual hit%   Avg predicted%
  Weak (<45)                      10          0.0%            40.6%
  Neutral (45-63)                117         15.4%            56.9%
  Strong (64-77)                 172         16.9%            71.0%
  Excellent (78+)                 84         23.8%            82.3%

  Matchup Edge < 64: 14.2% actual (n=127)  vs  Matchup Edge >= 64: 19.1% actual (n=256)
  z = -1.20 (not conventionally significant at this sample size)

Picks with pitcher-matchup data: 668/668

By opposing pitcher HR/9 allowed:
  Bucket                           N   Actual hit%
  <0.9 HR/9                      177         13.6%
  0.9-1.2 HR/9                   175         13.7%
  1.2+ HR/9                      316         14.6%

By opposing pitcher WHIP:
  Bucket                           N   Actual hit%
  <1.15 WHIP                     210         13.8%
  1.15-1.35 WHIP                 258         12.8%
  1.35+ WHIP                     200         16.0%

By park factor:
  Bucket                           N   Actual hit%
  Pitcher park (<97)             200         15.5%
  Neutral park (97-103)          321         15.0%
  Hitter park (104-119)          123         11.4%
  Extreme hitter park (120+)      24          4.2%

Picks with 2-strike suppression data: 413/668

By opposing pitcher 2-strike hard-hit suppression:
  Bucket                           N   Actual hit%
  Suppresses hard (<=-5pp)        89         16.9%
  Neutral (-5 to +5pp)           323         16.4%
  Gets hit harder (5pp+)           1          0.0%

Picks with batter AB-total data: 668/668

By batter season AB total:
  Bucket                           N   Actual hit%
  <150 AB (part-time)             30          6.7%
  150-350 AB (platoon/bench)     205          9.8%
  350+ AB (everyday)             433         16.6%

══════════════════════════════════════════════════════════════════════
```

## K Props

```
══════════════════════════════════════════════════════════════════════
K PROPS CALIBRATION REPORT
══════════════════════════════════════════════════════════════════════
Total captured: 1967  |  Graded: 1947  |  Pending: 20
Overall OVER hit rate: 1032/1947 = 53.0%  (0 pushes)

Edge calibration (projK - line bucket vs actual OVER hit rate):
  Bucket                 N    OVER hit%
  <0.5                 274        47.4%
  0.5-1.0              755        49.7%
  1.0-1.5              753        58.6%
  1.5-2.0              125        54.4%
  2.0+                  40        45.0%

  Edge < 1.0: 49.1% actual (n=1029)  vs  Edge >= 1.0: 57.4% actual (n=918)
  z = -3.68 (statistically significant difference, p<0.05)

By line source:
  Bucket                 N    OVER hit%
  model               1470        54.5%
  sportsbook           477        48.4%

Miss diagnosis (859/915 losses with performance data):
  Short outing (pulled early, never got the look): 466 (54.2%)
  Full outing, just didn't miss enough bats: 393 (45.8%)

Picks with matchup snapshot data: 1763/1947

By pitcher K/9:
  Bucket                 N    OVER hit%
  <7 K/9               414        58.0%
  7-9 K/9              725        53.4%
  9+ K/9               624        46.2%

By opponent lineup K-rate:
  Bucket                 N    OVER hit%
  Low-K lineup (<20%)    61        52.5%
  Avg lineup (20-25%)  1664        51.9%
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
Total captured: 959  |  Graded: 950  |  Pending: 9
Overall pick hit rate: 539/950 = 56.7%  (0 pushes)

Confidence calibration (pickPct bucket vs actual hit rate):
  Bucket                 N   Actual hit%
  50-54%               553         54.8%
  55-59%               355         58.9%
  60-64%                42         64.3%

  pickPct < 60%: 56.4% actual (n=908)  vs  pickPct >= 60%: 64.3% actual (n=42)
  z = -1.01 (not conventionally significant at this sample size)

Picks with matchup snapshot data: 862/950

By starting-pitcher ERA gap:
  Bucket                 N   Actual hit%
  ERA gap <0.3         126         58.7%
  ERA gap 0.3-1.0      234         51.3%
  ERA gap 1.0+         502         58.8%

By team record gap:
  Bucket                 N   Actual hit%
  Record gap <5pt      324         51.9%
  Record gap 5-15pt    432         58.6%
  Record gap 15pt+      96         62.5%

By day/night:
  Bucket                 N   Actual hit%
  Day game             267         57.7%
  Night game           595         56.3%

══════════════════════════════════════════════════════════════════════
```
