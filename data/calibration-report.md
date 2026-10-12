# Model Calibration Report

Generated 2026-10-12 22:30 UTC by the weekly calibration-report workflow.
Re-run any of these locally any time: `node scripts/analyze-<name>-matchups.mjs`.

## HR Threats

```
══════════════════════════════════════════════════════════════════════
HR THREATS CALIBRATION REPORT
══════════════════════════════════════════════════════════════════════
Total captured: 641  |  Graded (win/loss): 630  |  Pending: 11
Overall actual hit rate: 92/630 = 14.6%

Score calibration (predicted HR% bucket vs actual hit rate):
  Bucket                           N   Actual hit%   Avg predicted%
  18%                              1          0.0%            18.0%
  19%                              4          0.0%            19.0%
  20-21%                           1          0.0%            20.0%
  25-29%                          16         37.5%            27.4%
  30%+                           608         14.1%            64.8%

  Score < 22%: 0.0% actual (n=6)  vs  Score >= 22%: 14.7% actual (n=624)
  z = -1.02 (not conventionally significant at this sample size)

Picks with live client score snapshot: 630/630

Live client score calibration (what users actually see):
  Bucket                           N   Actual hit%   Avg predicted%
  18%                            274          9.1%            12.8%
  19%                              9          0.0%            19.0%
  20-21%                          19         10.5%            20.5%
  22-24%                          32         21.9%            23.2%
  25-29%                          97         19.6%            27.2%
  30%+                           199         19.6%            34.9%

  Live score < 22%: 8.9% actual (n=302)  vs  Live score >= 22%: 19.8% actual (n=328)
  z = -3.86 (statistically significant difference, p<0.05)

Score source breakdown: 630/630 picks have hrScoreSource recorded
  logistic   n=    6   actual hit rate: 0.0%
  legacy     n=  624   actual hit rate: 14.7%

isOnFire: TRUE 14.5% (n=626)  vs  FALSE 25.0% (n=4)
  (below the 20-per-side sample floor — too thin to read as signal yet, treat as noise-risk)

isFavorable: TRUE 17.4% (n=161)  vs  FALSE 13.6% (n=469)
  z = 1.16 (not conventionally significant at this sample size)

isDrought: TRUE 20.0% (n=5)  vs  FALSE 14.6% (n=625)
  (below the 20-per-side sample floor — too thin to read as signal yet, treat as noise-risk)

isDue: TRUE 25.0% (n=4)  vs  FALSE 14.5% (n=626)
  (below the 20-per-side sample floor — too thin to read as signal yet, treat as noise-risk)

hasNearHR: TRUE 18.7% (n=262)  vs  FALSE 11.7% (n=368)
  z = 2.46 (statistically significant difference, p<0.05)

Picks with platoon-split data: 627/630
  platoonFavorable: TRUE 16.7% (n=312)  vs  FALSE 12.7% (n=315)
  z = 1.40 (not conventionally significant at this sample size)

Picks with Matchup Edge data: 359/630

Matchup Edge calibration (predicted grade vs actual hit rate):
  Bucket                           N   Actual hit%   Avg predicted%
  Weak (<45)                       5          0.0%            40.8%
  Neutral (45-63)                103         16.5%            57.6%
  Strong (64-77)                 167         17.4%            71.0%
  Excellent (78+)                 84         23.8%            82.3%

  Matchup Edge < 64: 15.7% actual (n=108)  vs  Matchup Edge >= 64: 19.5% actual (n=251)
  z = -0.85 (not conventionally significant at this sample size)

Picks with pitcher-matchup data: 630/630

By opposing pitcher HR/9 allowed:
  Bucket                           N   Actual hit%
  <0.9 HR/9                      166         13.3%
  0.9-1.2 HR/9                   161         14.9%
  1.2+ HR/9                      303         15.2%

By opposing pitcher WHIP:
  Bucket                           N   Actual hit%
  <1.15 WHIP                     189         14.3%
  1.15-1.35 WHIP                 245         13.5%
  1.35+ WHIP                     196         16.3%

By park factor:
  Bucket                           N   Actual hit%
  Pitcher park (<97)             176         16.5%
  Neutral park (97-103)          311         15.4%
  Hitter park (104-119)          119         11.8%
  Extreme hitter park (120+)      24          4.2%

Picks with 2-strike suppression data: 389/630

By opposing pitcher 2-strike hard-hit suppression:
  Bucket                           N   Actual hit%
  Suppresses hard (<=-5pp)        84         17.9%
  Neutral (-5 to +5pp)           304         17.1%
  Gets hit harder (5pp+)           1          0.0%

Picks with batter AB-total data: 630/630

By batter season AB total:
  Bucket                           N   Actual hit%
  <150 AB (part-time)             30          6.7%
  150-350 AB (platoon/bench)     182         10.4%
  350+ AB (everyday)             418         17.0%

══════════════════════════════════════════════════════════════════════
```

## K Props

```
══════════════════════════════════════════════════════════════════════
K PROPS CALIBRATION REPORT
══════════════════════════════════════════════════════════════════════
Total captured: 1953  |  Graded: 1931  |  Pending: 22
Overall OVER hit rate: 1027/1931 = 53.2%  (0 pushes)

Edge calibration (projK - line bucket vs actual OVER hit rate):
  Bucket                 N    OVER hit%
  <0.5                 270        47.0%
  0.5-1.0              752        49.9%
  1.0-1.5              748        58.7%
  1.5-2.0              123        55.3%
  2.0+                  38        47.4%

  Edge < 1.0: 49.1% actual (n=1022)  vs  Edge >= 1.0: 57.8% actual (n=909)
  z = -3.80 (statistically significant difference, p<0.05)

By line source:
  Bucket                 N    OVER hit%
  model               1467        54.6%
  sportsbook           464        48.7%

Miss diagnosis (848/904 losses with performance data):
  Short outing (pulled early, never got the look): 457 (53.9%)
  Full outing, just didn't miss enough bats: 391 (46.1%)

Picks with matchup snapshot data: 1747/1931

By pitcher K/9:
  Bucket                 N    OVER hit%
  <7 K/9               412        58.0%
  7-9 K/9              719        53.7%
  9+ K/9               616        46.3%

By opponent lineup K-rate:
  Bucket                 N    OVER hit%
  Low-K lineup (<20%)    60        51.7%
  Avg lineup (20-25%)  1649        52.1%
  High-K lineup (25%+)    38        52.6%

Avg season K% by batting-order spot (n=257 lineups):
  Spot 1: 20.7%
  Spot 2: 21.0%
  Spot 3: 20.8%
  Spot 4: 21.9%
  Spot 5: 21.9%
  Spot 6: 22.2%
  Spot 7: 23.6%
  Spot 8: 23.1%
  Spot 9: 23.7%

══════════════════════════════════════════════════════════════════════
```

## Diamond Report Pick (game winner)

```
══════════════════════════════════════════════════════════════════════
DIAMOND REPORT PICK (GAME WINNER) CALIBRATION REPORT
══════════════════════════════════════════════════════════════════════
Total captured: 952  |  Graded: 943  |  Pending: 9
Overall pick hit rate: 536/943 = 56.8%  (0 pushes)

Confidence calibration (pickPct bucket vs actual hit rate):
  Bucket                 N   Actual hit%
  50-54%               548         54.7%
  55-59%               353         59.2%
  60-64%                42         64.3%

  pickPct < 60%: 56.5% actual (n=901)  vs  pickPct >= 60%: 64.3% actual (n=42)
  z = -1.00 (not conventionally significant at this sample size)

Picks with matchup snapshot data: 855/943

By starting-pitcher ERA gap:
  Bucket                 N   Actual hit%
  ERA gap <0.3         124         58.1%
  ERA gap 0.3-1.0      232         51.7%
  ERA gap 1.0+         499         58.9%

By team record gap:
  Bucket                 N   Actual hit%
  Record gap <5pt      323         52.0%
  Record gap 5-15pt    432         58.6%
  Record gap 15pt+      91         62.6%

By day/night:
  Bucket                 N   Actual hit%
  Day game             265         57.7%
  Night game           590         56.4%

══════════════════════════════════════════════════════════════════════
```
