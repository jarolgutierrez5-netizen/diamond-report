# Model Calibration Report

Generated 2026-09-28 21:15 UTC by the weekly calibration-report workflow.
Re-run any of these locally any time: `node scripts/analyze-<name>-matchups.mjs`.

## HR Threats

```
══════════════════════════════════════════════════════════════════════
HR THREATS CALIBRATION REPORT
══════════════════════════════════════════════════════════════════════
Total captured: 530  |  Graded (win/loss): 528  |  Pending: 2
Overall actual hit rate: 82/528 = 15.5%

Score calibration (predicted HR% bucket vs actual hit rate):
  Bucket                           N   Actual hit%   Avg predicted%
  18%                              1          0.0%            18.0%
  19%                              4          0.0%            19.0%
  20-21%                           1          0.0%            20.0%
  25-29%                          16         37.5%            27.4%
  30%+                           506         15.0%            65.3%

  Score < 22%: 0.0% actual (n=6)  vs  Score >= 22%: 15.7% actual (n=522)
  z = -1.06 (not conventionally significant at this sample size)

Picks with live client score snapshot: 528/528

Live client score calibration (what users actually see):
  Bucket                           N   Actual hit%   Avg predicted%
  18%                            172          8.7%            13.3%
  19%                              9          0.0%            19.0%
  20-21%                          19         10.5%            20.5%
  22-24%                          32         21.9%            23.2%
  25-29%                          97         19.6%            27.2%
  30%+                           199         19.6%            34.9%

  Live score < 22%: 8.5% actual (n=200)  vs  Live score >= 22%: 19.8% actual (n=328)
  z = -3.48 (statistically significant difference, p<0.05)

Score source breakdown: 528/528 picks have hrScoreSource recorded
  logistic   n=    6   actual hit rate: 0.0%
  legacy     n=  522   actual hit rate: 15.7%

isOnFire: TRUE 15.5% (n=524)  vs  FALSE 25.0% (n=4)
  (below the 20-per-side sample floor — too thin to read as signal yet, treat as noise-risk)

isFavorable: TRUE 17.0% (n=153)  vs  FALSE 14.9% (n=375)
  z = 0.59 (not conventionally significant at this sample size)

isDrought: TRUE 20.0% (n=5)  vs  FALSE 15.5% (n=523)
  (below the 20-per-side sample floor — too thin to read as signal yet, treat as noise-risk)

isDue: TRUE 25.0% (n=4)  vs  FALSE 15.5% (n=524)
  (below the 20-per-side sample floor — too thin to read as signal yet, treat as noise-risk)

hasNearHR: TRUE 19.3% (n=223)  vs  FALSE 12.8% (n=305)
  z = 2.04 (statistically significant difference, p<0.05)

Picks with platoon-split data: 525/528
  platoonFavorable: TRUE 16.9% (n=278)  vs  FALSE 14.2% (n=247)
  z = 0.86 (not conventionally significant at this sample size)

Picks with Matchup Edge data: 318/528

Matchup Edge calibration (predicted grade vs actual hit rate):
  Bucket                           N   Actual hit%   Avg predicted%
  Weak (<45)                       5          0.0%            40.8%
  Neutral (45-63)                 85         17.6%            57.5%
  Strong (64-77)                 150         18.0%            70.9%
  Excellent (78+)                 78         25.6%            82.2%

  Matchup Edge < 64: 16.7% actual (n=90)  vs  Matchup Edge >= 64: 20.6% actual (n=228)
  z = -0.80 (not conventionally significant at this sample size)

Picks with pitcher-matchup data: 528/528

By opposing pitcher HR/9 allowed:
  Bucket                           N   Actual hit%
  <0.9 HR/9                      121         15.7%
  0.9-1.2 HR/9                   137         14.6%
  1.2+ HR/9                      270         15.9%

By opposing pitcher WHIP:
  Bucket                           N   Actual hit%
  <1.15 WHIP                     129         17.8%
  1.15-1.35 WHIP                 210         13.3%
  1.35+ WHIP                     189         16.4%

By park factor:
  Bucket                           N   Actual hit%
  Pitcher park (<97)             148         18.2%
  Neutral park (97-103)          259         15.8%
  Hitter park (104-119)           97         13.4%
  Extreme hitter park (120+)      24          4.2%

Picks with 2-strike suppression data: 348/528

By opposing pitcher 2-strike hard-hit suppression:
  Bucket                           N   Actual hit%
  Suppresses hard (<=-5pp)        76         18.4%
  Neutral (-5 to +5pp)           271         18.1%
  Gets hit harder (5pp+)           1          0.0%

Picks with batter AB-total data: 528/528

By batter season AB total:
  Bucket                           N   Actual hit%
  <150 AB (part-time)             28          7.1%
  150-350 AB (platoon/bench)     153         11.8%
  350+ AB (everyday)             347         17.9%

══════════════════════════════════════════════════════════════════════
```

## K Props

```
══════════════════════════════════════════════════════════════════════
K PROPS CALIBRATION REPORT
══════════════════════════════════════════════════════════════════════
Total captured: 1897  |  Graded: 1879  |  Pending: 18
Overall OVER hit rate: 1005/1879 = 53.5%  (0 pushes)

Edge calibration (projK - line bucket vs actual OVER hit rate):
  Bucket                 N    OVER hit%
  <0.5                 255        48.2%
  0.5-1.0              735        49.9%
  1.0-1.5              735        58.9%
  1.5-2.0              120        55.8%
  2.0+                  34        44.1%

  Edge < 1.0: 49.5% actual (n=990)  vs  Edge >= 1.0: 57.9% actual (n=889)
  z = -3.66 (statistically significant difference, p<0.05)

By line source:
  Bucket                 N    OVER hit%
  model               1442        54.8%
  sportsbook           437        49.2%

Miss diagnosis (818/874 losses with performance data):
  Short outing (pulled early, never got the look): 429 (52.4%)
  Full outing, just didn't miss enough bats: 389 (47.6%)

Picks with matchup snapshot data: 1695/1879

By pitcher K/9:
  Bucket                 N    OVER hit%
  <7 K/9               408        58.1%
  7-9 K/9              704        53.8%
  9+ K/9               583        46.7%

By opponent lineup K-rate:
  Bucket                 N    OVER hit%
  Low-K lineup (<20%)    58        51.7%
  Avg lineup (20-25%)  1599        52.4%
  High-K lineup (25%+)    38        52.6%

Avg season K% by batting-order spot (n=254 lineups):
  Spot 1: 20.8%
  Spot 2: 20.9%
  Spot 3: 20.8%
  Spot 4: 21.9%
  Spot 5: 21.8%
  Spot 6: 22.2%
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
Total captured: 924  |  Graded: 917  |  Pending: 7
Overall pick hit rate: 520/917 = 56.7%  (0 pushes)

Confidence calibration (pickPct bucket vs actual hit rate):
  Bucket                 N   Actual hit%
  50-54%               533         55.0%
  55-59%               342         58.5%
  60-64%                42         64.3%

  pickPct < 60%: 56.3% actual (n=875)  vs  pickPct >= 60%: 64.3% actual (n=42)
  z = -1.01 (not conventionally significant at this sample size)

Picks with matchup snapshot data: 829/917

By starting-pitcher ERA gap:
  Bucket                 N   Actual hit%
  ERA gap <0.3         117         58.1%
  ERA gap 0.3-1.0      224         52.2%
  ERA gap 1.0+         488         58.4%

By team record gap:
  Bucket                 N   Actual hit%
  Record gap <5pt      320         51.9%
  Record gap 5-15pt    432         58.6%
  Record gap 15pt+      77         66.2%

By day/night:
  Bucket                 N   Actual hit%
  Day game             256         57.8%
  Night game           573         56.2%

══════════════════════════════════════════════════════════════════════
```
