# Model Calibration Report

Generated 2026-08-10 16:11 UTC by the weekly calibration-report workflow.
Re-run any of these locally any time: `node scripts/analyze-<name>-matchups.mjs`.

## HR Threats

```
══════════════════════════════════════════════════════════════════════
HR THREATS CALIBRATION REPORT
══════════════════════════════════════════════════════════════════════
Total captured: 1306  |  Graded (win/loss): 1299  |  Pending: 7
Overall actual hit rate: 172/1299 = 13.2%

Score calibration (predicted HR% bucket vs actual hit rate):
  Bucket                           N   Actual hit%   Avg predicted%
  18%                            302         14.9%            18.0%
  19%                            221         14.5%            19.0%
  20-21%                         339         11.8%            20.4%
  22-24%                         243         11.5%            22.8%
  25-29%                         134         14.2%            26.4%
  30%+                            60         13.3%            33.1%

  Score < 22%: 13.6% actual (n=862)  vs  Score >= 22%: 12.6% actual (n=437)
  z = 0.50 (not conventionally significant at this sample size)

Picks with live client score snapshot: 722/1299

Live client score calibration (what users actually see):
  Bucket                           N   Actual hit%   Avg predicted%
  18%                             99         12.1%            17.1%
  19%                             68         13.2%            19.0%
  20-21%                         154         13.6%            20.5%
  22-24%                         191         11.5%            22.9%
  25-29%                         133         17.3%            26.4%
  30%+                            77         13.0%            33.7%

  Live score < 22%: 13.1% actual (n=321)  vs  Live score >= 22%: 13.7% actual (n=401)
  z = -0.25 (not conventionally significant at this sample size)

Score source breakdown: 15/1299 picks have hrScoreSource recorded
  logistic   n=   15   actual hit rate: 26.7%

isOnFire: TRUE 13.8% (n=759)  vs  FALSE 13.5% (n=126)
  z = 0.10 (not conventionally significant at this sample size)

isFavorable: TRUE 13.1% (n=314)  vs  FALSE 14.2% (n=571)
  z = -0.47 (not conventionally significant at this sample size)

isDrought: TRUE 12.6% (n=151)  vs  FALSE 14.0% (n=734)
  z = -0.47 (not conventionally significant at this sample size)

isDue: TRUE 13.5% (n=89)  vs  FALSE 13.8% (n=796)
  z = -0.09 (not conventionally significant at this sample size)

hasNearHR: TRUE 14.9% (n=221)  vs  FALSE 13.3% (n=399)
  z = 0.57 (not conventionally significant at this sample size)

Picks with platoon-split data: 710/1299
  platoonFavorable: TRUE 14.3% (n=399)  vs  FALSE 12.2% (n=311)
  z = 0.80 (not conventionally significant at this sample size)

Picks with Matchup Edge data: 675/1299

Matchup Edge calibration (predicted grade vs actual hit rate):
  Bucket                           N   Actual hit%   Avg predicted%
  Weak (<45)                      59         15.3%            38.4%
  Neutral (45-63)                279         11.1%            56.1%
  Strong (64-77)                 254         16.1%            70.0%
  Excellent (78+)                 83         13.3%            83.4%

  Matchup Edge < 64: 11.8% actual (n=338)  vs  Matchup Edge >= 64: 15.4% actual (n=337)
  z = -1.36 (not conventionally significant at this sample size)

Picks with pitcher-matchup data: 844/1299

By opposing pitcher HR/9 allowed:
  Bucket                           N   Actual hit%
  <0.9 HR/9                      129         15.5%
  0.9-1.2 HR/9                   172         16.3%
  1.2+ HR/9                      543         12.0%

By opposing pitcher WHIP:
  Bucket                           N   Actual hit%
  <1.15 WHIP                     160         17.5%
  1.15-1.35 WHIP                 305         13.4%
  1.35+ WHIP                     379         11.6%

By park factor:
  Bucket                           N   Actual hit%
  Pitcher park (<97)             264         14.4%
  Neutral park (97-103)          362         14.1%
  Hitter park (104-119)          187          8.0%
  Extreme hitter park (120+)      31         29.0%

Picks with 2-strike suppression data: 695/1299

By opposing pitcher 2-strike hard-hit suppression:
  Bucket                           N   Actual hit%
  Suppresses hard (<=-5pp)       125         15.2%
  Neutral (-5 to +5pp)           561         12.3%
  Gets hit harder (5pp+)           9          0.0%

Picks with batter AB-total data: 15/1299
  (need at least 20 graded picks with batter AB-total data for a meaningful breakdown — check back after more picks are captured and graded under the new field)

══════════════════════════════════════════════════════════════════════
```

## K Props

```
══════════════════════════════════════════════════════════════════════
K PROPS CALIBRATION REPORT
══════════════════════════════════════════════════════════════════════
Total captured: 705  |  Graded: 672  |  Pending: 33
Overall OVER hit rate: 362/672 = 53.9%  (0 pushes)

Edge calibration (projK - line bucket vs actual OVER hit rate):
  Bucket                 N    OVER hit%
  <0.5                 175        46.3%
  0.5-1.0              205        51.2%
  1.0-1.5              230        61.3%
  1.5-2.0               44        61.4%
  2.0+                  18        44.4%

  Edge < 1.0: 48.9% actual (n=380)  vs  Edge >= 1.0: 60.3% actual (n=292)
  z = -2.92 (statistically significant difference, p<0.05)

By line source:
  Bucket                 N    OVER hit%
  model                382        57.3%
  sportsbook           290        49.3%

Miss diagnosis (254/310 losses with performance data):
  Short outing (pulled early, never got the look): 119 (46.9%)
  Full outing, just didn't miss enough bats: 135 (53.1%)

Picks with matchup snapshot data: 488/672

By pitcher K/9:
  Bucket                 N    OVER hit%
  <7 K/9               115        55.7%
  7-9 K/9              198        52.0%
  9+ K/9               175        44.6%

By opponent lineup K-rate:
  Bucket                 N    OVER hit%
  Low-K lineup (<20%)    16        62.5%
  Avg lineup (20-25%)   467        49.9%
  High-K lineup (25%+)     5        40.0%

Avg season K% by batting-order spot (n=69 lineups):
  Spot 1: 20.6%
  Spot 2: 20.2%
  Spot 3: 21.0%
  Spot 4: 21.9%
  Spot 5: 20.5%
  Spot 6: 21.4%
  Spot 7: 23.9%
  Spot 8: 21.9%
  Spot 9: 22.0%

══════════════════════════════════════════════════════════════════════
```

## Diamond Report Pick (game winner)

```
══════════════════════════════════════════════════════════════════════
DIAMOND REPORT PICK (GAME WINNER) CALIBRATION REPORT
══════════════════════════════════════════════════════════════════════
Total captured: 340  |  Graded: 324  |  Pending: 16
Overall pick hit rate: 167/324 = 51.5%  (0 pushes)

Confidence calibration (pickPct bucket vs actual hit rate):
  Bucket                 N   Actual hit%
  50-54%               195         51.8%
  55-59%               115         49.6%
  60-64%                14         64.3%

  pickPct < 60%: 51.0% actual (n=310)  vs  pickPct >= 60%: 64.3% actual (n=14)
  z = -0.98 (not conventionally significant at this sample size)

Picks with matchup snapshot data: 236/324

By starting-pitcher ERA gap:
  Bucket                 N   Actual hit%
  ERA gap <0.3          27         63.0%
  ERA gap 0.3-1.0       61         39.3%
  ERA gap 1.0+         148         51.4%

By team record gap:
  Bucket                 N   Actual hit%
  Record gap <5pt      100         40.0%
  Record gap 5-15pt    113         58.4%
  Record gap 15pt+      23         47.8%

By day/night:
  Bucket                 N   Actual hit%
  Day game              83         48.2%
  Night game           153         50.3%

══════════════════════════════════════════════════════════════════════
```
