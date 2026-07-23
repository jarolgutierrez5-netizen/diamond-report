# Model Calibration Report

Generated 2026-07-23 02:13 UTC by the weekly calibration-report workflow.
Re-run any of these locally any time: `node scripts/analyze-<name>-matchups.mjs`.

## HR Threats

```
══════════════════════════════════════════════════════════════════════
HR THREATS CALIBRATION REPORT
══════════════════════════════════════════════════════════════════════
Total captured: 560  |  Graded (win/loss): 500  |  Pending: 60
Overall actual hit rate: 67/500 = 13.4%

Score calibration (predicted HR% bucket vs actual hit rate):
  Bucket               N   Actual hit%   Avg predicted%
  18%                110         17.3%            18.0%
  19%                 69         13.0%            19.0%
  20-21%             135         14.1%            20.5%
  22-24%             105          8.6%            22.8%
  25-29%              57         12.3%            26.1%
  30%+                24         16.7%            33.1%

  Score < 22%: 15.0% actual (n=314)  vs  Score >= 22%: 10.8% actual (n=186)
  z = 1.34 (not conventionally significant at this sample size)

isOnFire: TRUE 16.0% (n=75)  vs  FALSE 45.5% (n=11)
  (below the 20-per-side sample floor — too thin to read as signal yet, treat as noise-risk)

isFavorable: TRUE 23.1% (n=39)  vs  FALSE 17.0% (n=47)
  z = 0.70 (not conventionally significant at this sample size)

isDrought: TRUE 38.5% (n=13)  vs  FALSE 16.4% (n=73)
  (below the 20-per-side sample floor — too thin to read as signal yet, treat as noise-risk)

isDue: TRUE 44.4% (n=9)  vs  FALSE 16.9% (n=77)
  (below the 20-per-side sample floor — too thin to read as signal yet, treat as noise-risk)

Picks with pitcher-matchup data: 45/500

By opposing pitcher HR/9 allowed:
  Bucket               N   Actual hit%
  <0.9 HR/9            6         16.7%
  0.9-1.2 HR/9        11         27.3%
  1.2+ HR/9           28         14.3%

By opposing pitcher WHIP:
  Bucket               N   Actual hit%
  <1.15 WHIP           9         11.1%
  1.15-1.35 WHIP       6         50.0%
  1.35+ WHIP          30         13.3%

By park factor:
  Bucket               N   Actual hit%
  Pitcher park (<97)    12          0.0%
  Neutral park        10         30.0%
  Hitter park (103+)    23         21.7%

══════════════════════════════════════════════════════════════════════
```

## K Props

```
══════════════════════════════════════════════════════════════════════
K PROPS CALIBRATION REPORT
══════════════════════════════════════════════════════════════════════
Total captured: 251  |  Graded: 212  |  Pending: 39
Overall OVER hit rate: 130/212 = 61.3%  (0 pushes)

Edge calibration (projK - line bucket vs actual OVER hit rate):
  Bucket                 N    OVER hit%
  <0.5                  12        50.0%
  0.5-1.0               79        50.6%
  1.0-1.5              105        68.6%
  1.5-2.0               14        78.6%
  2.0+                   2        50.0%

  Edge < 1.0: 50.5% actual (n=91)  vs  Edge >= 1.0: 69.4% actual (n=121)
  z = -2.79 (statistically significant difference, p<0.05)

By line source:
  Bucket                 N    OVER hit%
  model                188        62.8%
  sportsbook            24        50.0%

Miss diagnosis (26/82 losses with performance data):
  Short outing (pulled early, never got the look): 13 (50.0%)
  Full outing, just didn't miss enough bats: 13 (50.0%)

Picks with matchup snapshot data: 28/212

By pitcher K/9:
  Bucket                 N    OVER hit%
  <7 K/9                 5        40.0%
  7-9 K/9               14        57.1%
  9+ K/9                 9        33.3%

By opponent lineup K-rate:
  Bucket                 N    OVER hit%
  Avg lineup (20-25%)    28        46.4%

══════════════════════════════════════════════════════════════════════
```

## Elite Picks

```
══════════════════════════════════════════════════════════════════════
ELITE PICKS CALIBRATION REPORT
══════════════════════════════════════════════════════════════════════
Total captured (all markets): 562

──────────────────────────────────────────────────────────────────────
Market: HR  (captured: 348, graded: 298, pending: 50)
  Overall actual hit rate: 37/298 = 12.4%

  Score calibration:
  Bucket               N   Actual hit%   Avg predicted%
  <20%               107         15.9%            16.7%
  20-29%             180         10.0%            22.5%
  30-39%              10         20.0%            32.5%
  40-49%               1          0.0%            43.0%
  Below median score (<20.8%): 14.2% actual (n=148)  vs  At/above median: 10.7% actual (n=150)
  z = 0.92 (not conventionally significant at this sample size)
  isFavorable: TRUE 15.0% (n=20)  vs  FALSE 12.0% (n=25)
  z = 0.29 (not conventionally significant at this sample size)
  isHot: TRUE 11.6% (n=43)  vs  FALSE 50.0% (n=2)
  (below the 20-per-side sample floor — too thin to read as signal yet, treat as noise-risk)
  isDrought: TRUE 50.0% (n=2)  vs  FALSE 11.6% (n=43)
  (below the 20-per-side sample floor — too thin to read as signal yet, treat as noise-risk)
  isDue: TRUE 50.0% (n=2)  vs  FALSE 11.6% (n=43)
  (below the 20-per-side sample floor — too thin to read as signal yet, treat as noise-risk)

  By opposing pitcher HR/9 allowed:
  Bucket               N   Actual hit%
  <0.9 HR/9           10         10.0%
  0.9-1.2 HR/9        15         20.0%
  1.2+ HR/9           20         10.0%

──────────────────────────────────────────────────────────────────────
Market: HITS  (captured: 47, graded: 42, pending: 5)
  Overall actual hit rate: 18/42 = 42.9%

  Score calibration:
  Bucket               N   Actual hit%   Avg predicted%
  50%+                42         42.9%            73.6%
  Below median score (<73.6%): 38.9% actual (n=18)  vs  At/above median: 45.8% actual (n=24)
  z = -0.45 (not conventionally significant at this sample size)
  isFavorable: TRUE 50.0% (n=4)  vs  FALSE 0.0% (n=1)
  (below the 20-per-side sample floor — too thin to read as signal yet, treat as noise-risk)
  isDrought: TRUE 50.0% (n=2)  vs  FALSE 33.3% (n=3)
  (below the 20-per-side sample floor — too thin to read as signal yet, treat as noise-risk)
  isDue: TRUE 100.0% (n=1)  vs  FALSE 25.0% (n=4)
  (below the 20-per-side sample floor — too thin to read as signal yet, treat as noise-risk)
  (5/42 graded picks have matchup-snapshot data — need 20+ for a pitcher-profile breakdown)

──────────────────────────────────────────────────────────────────────
Market: RBIS  (captured: 45, graded: 40, pending: 5)
  Overall actual hit rate: 13/40 = 32.5%

  Score calibration:
  Bucket               N   Actual hit%   Avg predicted%
  30-39%               2          0.0%            35.5%
  40-49%              25         32.0%            44.8%
  50%+                13         38.5%            65.2%
  Below median score (<51.0%): 29.6% actual (n=27)  vs  At/above median: 38.5% actual (n=13)
  z = -0.56 (not conventionally significant at this sample size)
  isFavorable: TRUE 50.0% (n=2)  vs  FALSE 33.3% (n=3)
  (below the 20-per-side sample floor — too thin to read as signal yet, treat as noise-risk)
  (5/40 graded picks have matchup-snapshot data — need 20+ for a pitcher-profile breakdown)

──────────────────────────────────────────────────────────────────────
Market: TB  (captured: 41, graded: 36, pending: 5)
  Overall actual hit rate: 9/36 = 25.0%

  Score calibration:
  Bucket               N   Actual hit%   Avg predicted%
  20-29%               1          0.0%            26.0%
  40-49%              27         29.6%            47.0%
  50%+                 8         12.5%            51.5%
  Below median score (<47.4%): 17.6% actual (n=17)  vs  At/above median: 31.6% actual (n=19)
  z = -0.96 (not conventionally significant at this sample size)
  isFavorable: TRUE 0.0% (n=2)  vs  FALSE 33.3% (n=3)
  (below the 20-per-side sample floor — too thin to read as signal yet, treat as noise-risk)
  isDrought: TRUE 0.0% (n=1)  vs  FALSE 25.0% (n=4)
  (below the 20-per-side sample floor — too thin to read as signal yet, treat as noise-risk)
  (5/36 graded picks have matchup-snapshot data — need 20+ for a pitcher-profile breakdown)

──────────────────────────────────────────────────────────────────────
Market: SB  (captured: 41, graded: 36, pending: 5)
  Overall actual hit rate: 4/36 = 11.1%

  Score calibration:
  Bucket               N   Actual hit%   Avg predicted%
  <20%                 3         33.3%            16.3%
  20-29%              20          0.0%            23.6%
  30-39%               9         33.3%            34.7%
  40-49%               3          0.0%            46.0%
  50%+                 1          0.0%            52.0%
  Below median score (<28.4%): 4.5% actual (n=22)  vs  At/above median: 21.4% actual (n=14)
  z = -1.57 (not conventionally significant at this sample size)
  isFavorable: TRUE 0.0% (n=1)  vs  FALSE 25.0% (n=4)
  (below the 20-per-side sample floor — too thin to read as signal yet, treat as noise-risk)
  isDrought: TRUE 0.0% (n=2)  vs  FALSE 33.3% (n=3)
  (below the 20-per-side sample floor — too thin to read as signal yet, treat as noise-risk)
  (5/36 graded picks have matchup-snapshot data — need 20+ for a pitcher-profile breakdown)

──────────────────────────────────────────────────────────────────────
Market: HRRBI  (captured: 40, graded: 35, pending: 5)
  Overall actual hit rate: 14/35 = 40.0%

  Score calibration:
  Bucket               N   Actual hit%   Avg predicted%
  50%+                35         40.0%            67.2%
  Below median score (<67.2%): 30.8% actual (n=26)  vs  At/above median: 66.7% actual (n=9)
  z = -1.89 (not conventionally significant at this sample size)
  isFavorable: TRUE 0.0% (n=3)  vs  FALSE 0.0% (n=2)
  (below the 20-per-side sample floor — too thin to read as signal yet, treat as noise-risk)
  isHot: TRUE 0.0% (n=4)  vs  FALSE 0.0% (n=1)
  (below the 20-per-side sample floor — too thin to read as signal yet, treat as noise-risk)
  isDrought: TRUE 0.0% (n=1)  vs  FALSE 0.0% (n=4)
  (below the 20-per-side sample floor — too thin to read as signal yet, treat as noise-risk)
  isDue: TRUE 0.0% (n=1)  vs  FALSE 0.0% (n=4)
  (below the 20-per-side sample floor — too thin to read as signal yet, treat as noise-risk)
  (5/35 graded picks have matchup-snapshot data — need 20+ for a pitcher-profile breakdown)

══════════════════════════════════════════════════════════════════════
```

## Diamond Report Pick (game winner)

```
══════════════════════════════════════════════════════════════════════
DIAMOND REPORT PICK (GAME WINNER) CALIBRATION REPORT
══════════════════════════════════════════════════════════════════════
Total captured: 120  |  Graded: 101  |  Pending: 19
Overall pick hit rate: 57/101 = 56.4%  (0 pushes)

Confidence calibration (pickPct bucket vs actual hit rate):
  Bucket                 N   Actual hit%
  50-54%                69         55.1%
  55-59%                29         55.2%
  60-64%                 3        100.0%

  pickPct < 60%: 55.1% actual (n=98)  vs  pickPct >= 60%: 100.0% actual (n=3)
  z = -1.54 (not conventionally significant at this sample size)

Picks with matchup snapshot data: 13/101
  (need at least 20 graded picks with matchup data for a meaningful breakdown — check back after more picks are captured and graded)

══════════════════════════════════════════════════════════════════════
```
