# Model Calibration Report

Generated 2026-08-17 15:43 UTC by the weekly calibration-report workflow.
Re-run any of these locally any time: `node scripts/analyze-<name>-matchups.mjs`.

## HR Threats

```
══════════════════════════════════════════════════════════════════════
HR THREATS CALIBRATION REPORT
══════════════════════════════════════════════════════════════════════
Total captured: 1322  |  Graded (win/loss): 1315  |  Pending: 7
Overall actual hit rate: 174/1315 = 13.2%

Score calibration (predicted HR% bucket vs actual hit rate):
  Bucket                           N   Actual hit%   Avg predicted%
  18%                            318         14.8%            18.0%
  19%                            221         14.5%            19.0%
  20-21%                         339         11.8%            20.4%
  22-24%                         243         11.5%            22.8%
  25-29%                         134         14.2%            26.4%
  30%+                            60         13.3%            33.1%

  Score < 22%: 13.6% actual (n=878)  vs  Score >= 22%: 12.6% actual (n=437)
  z = 0.49 (not conventionally significant at this sample size)

Picks with live client score snapshot: 738/1315

Live client score calibration (what users actually see):
  Bucket                           N   Actual hit%   Avg predicted%
  18%                            115         12.2%            16.9%
  19%                             68         13.2%            19.0%
  20-21%                         154         13.6%            20.5%
  22-24%                         191         11.5%            22.9%
  25-29%                         133         17.3%            26.4%
  30%+                            77         13.0%            33.7%

  Live score < 22%: 13.1% actual (n=337)  vs  Live score >= 22%: 13.7% actual (n=401)
  z = -0.26 (not conventionally significant at this sample size)

Score source breakdown: 31/1315 picks have hrScoreSource recorded
  logistic   n=   31   actual hit rate: 19.4%

isOnFire: TRUE 13.8% (n=775)  vs  FALSE 13.5% (n=126)
  z = 0.10 (not conventionally significant at this sample size)

isFavorable: TRUE 13.0% (n=316)  vs  FALSE 14.2% (n=585)
  z = -0.50 (not conventionally significant at this sample size)

isDrought: TRUE 12.6% (n=151)  vs  FALSE 14.0% (n=750)
  z = -0.46 (not conventionally significant at this sample size)

isDue: TRUE 13.5% (n=89)  vs  FALSE 13.8% (n=812)
  z = -0.08 (not conventionally significant at this sample size)

hasNearHR: TRUE 14.9% (n=228)  vs  FALSE 13.2% (n=408)
  z = 0.59 (not conventionally significant at this sample size)

Picks with platoon-split data: 726/1315
  platoonFavorable: TRUE 14.5% (n=406)  vs  FALSE 11.9% (n=320)
  z = 1.04 (not conventionally significant at this sample size)

Picks with Matchup Edge data: 691/1315

Matchup Edge calibration (predicted grade vs actual hit rate):
  Bucket                           N   Actual hit%   Avg predicted%
  Weak (<45)                      62         14.5%            38.5%
  Neutral (45-63)                286         10.8%            56.0%
  Strong (64-77)                 258         16.3%            70.0%
  Excellent (78+)                 85         14.1%            83.3%

  Matchup Edge < 64: 11.5% actual (n=348)  vs  Matchup Edge >= 64: 15.7% actual (n=343)
  z = -1.63 (not conventionally significant at this sample size)

Picks with pitcher-matchup data: 860/1315

By opposing pitcher HR/9 allowed:
  Bucket                           N   Actual hit%
  <0.9 HR/9                      131         15.3%
  0.9-1.2 HR/9                   177         16.4%
  1.2+ HR/9                      552         12.0%

By opposing pitcher WHIP:
  Bucket                           N   Actual hit%
  <1.15 WHIP                     164         17.1%
  1.15-1.35 WHIP                 317         13.6%
  1.35+ WHIP                     379         11.6%

By park factor:
  Bucket                           N   Actual hit%
  Pitcher park (<97)             264         14.4%
  Neutral park (97-103)          378         14.0%
  Hitter park (104-119)          187          8.0%
  Extreme hitter park (120+)      31         29.0%

Picks with 2-strike suppression data: 711/1315

By opposing pitcher 2-strike hard-hit suppression:
  Bucket                           N   Actual hit%
  Suppresses hard (<=-5pp)       133         15.8%
  Neutral (-5 to +5pp)           569         12.1%
  Gets hit harder (5pp+)           9          0.0%

Picks with batter AB-total data: 31/1315

By batter season AB total:
  Bucket                           N   Actual hit%
  <150 AB (part-time)              1          0.0%
  150-350 AB (platoon/bench)      17          5.9%
  350+ AB (everyday)              13         38.5%

══════════════════════════════════════════════════════════════════════
```

## K Props

```
══════════════════════════════════════════════════════════════════════
K PROPS CALIBRATION REPORT
══════════════════════════════════════════════════════════════════════
Total captured: 890  |  Graded: 856  |  Pending: 34
Overall OVER hit rate: 469/856 = 54.8%  (0 pushes)

Edge calibration (projK - line bucket vs actual OVER hit rate):
  Bucket                 N    OVER hit%
  <0.5                 175        46.3%
  0.5-1.0              286        52.8%
  1.0-1.5              318        60.7%
  1.5-2.0               59        61.0%
  2.0+                  18        44.4%

  Edge < 1.0: 50.3% actual (n=461)  vs  Edge >= 1.0: 60.0% actual (n=395)
  z = -2.84 (statistically significant difference, p<0.05)

By line source:
  Bucket                 N    OVER hit%
  model                566        57.6%
  sportsbook           290        49.3%

Miss diagnosis (331/387 losses with performance data):
  Short outing (pulled early, never got the look): 154 (46.5%)
  Full outing, just didn't miss enough bats: 177 (53.5%)

Picks with matchup snapshot data: 672/856

By pitcher K/9:
  Bucket                 N    OVER hit%
  <7 K/9               154        59.1%
  7-9 K/9              281        53.4%
  9+ K/9               237        46.8%

By opponent lineup K-rate:
  Bucket                 N    OVER hit%
  Low-K lineup (<20%)    25        52.0%
  Avg lineup (20-25%)   640        52.7%
  High-K lineup (25%+)     7        28.6%

Avg season K% by batting-order spot (n=91 lineups):
  Spot 1: 20.0%
  Spot 2: 20.7%
  Spot 3: 20.2%
  Spot 4: 22.0%
  Spot 5: 21.1%
  Spot 6: 21.5%
  Spot 7: 23.7%
  Spot 8: 21.2%
  Spot 9: 22.2%

══════════════════════════════════════════════════════════════════════
```

## Diamond Report Pick (game winner)

```
══════════════════════════════════════════════════════════════════════
DIAMOND REPORT PICK (GAME WINNER) CALIBRATION REPORT
══════════════════════════════════════════════════════════════════════
Total captured: 430  |  Graded: 415  |  Pending: 15
Overall pick hit rate: 213/415 = 51.3%  (0 pushes)

Confidence calibration (pickPct bucket vs actual hit rate):
  Bucket                 N   Actual hit%
  50-54%               252         53.2%
  55-59%               147         47.6%
  60-64%                16         56.3%

  pickPct < 60%: 51.1% actual (n=399)  vs  pickPct >= 60%: 56.3% actual (n=16)
  z = -0.40 (not conventionally significant at this sample size)

Picks with matchup snapshot data: 327/415

By starting-pitcher ERA gap:
  Bucket                 N   Actual hit%
  ERA gap <0.3          44         56.8%
  ERA gap 0.3-1.0       78         39.7%
  ERA gap 1.0+         205         52.2%

By team record gap:
  Bucket                 N   Actual hit%
  Record gap <5pt      143         42.7%
  Record gap 5-15pt    152         55.3%
  Record gap 15pt+      32         56.3%

By day/night:
  Bucket                 N   Actual hit%
  Day game             114         49.1%
  Night game           213         50.2%

══════════════════════════════════════════════════════════════════════
```
