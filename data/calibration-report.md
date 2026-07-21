# Model Calibration Report

Generated 2026-07-21 04:15 UTC by the weekly calibration-report workflow.
Re-run any of these locally any time: `node scripts/analyze-<name>-matchups.mjs`.

## HR Threats

```
══════════════════════════════════════════════════════════════════════
HR THREATS CALIBRATION REPORT
══════════════════════════════════════════════════════════════════════
Total captured: 416  |  Graded (win/loss): 362  |  Pending: 54
Overall actual hit rate: 41/362 = 11.3%

Score calibration (predicted HR% bucket vs actual hit rate):
  Bucket               N   Actual hit%   Avg predicted%
  18%                 73         16.4%            18.0%
  19%                 51         13.7%            19.0%
  20-21%             100         13.0%            20.4%
  22-24%              81          6.2%            22.8%
  25-29%              42          7.1%            26.0%
  30%+                15          6.7%            33.5%

  Score < 22%: 14.3% actual (n=224)  vs  Score >= 22%: 6.5% actual (n=138)
  z = 2.26 (statistically significant difference, p<0.05)

Picks with pitcher-matchup data: 0/362
  (need at least 20 graded picks with pitcher data for a meaningful breakdown — check back after more picks are captured and graded)

══════════════════════════════════════════════════════════════════════
```

## K Props

```
══════════════════════════════════════════════════════════════════════
K PROPS CALIBRATION REPORT
══════════════════════════════════════════════════════════════════════
Total captured: 186  |  Graded: 154  |  Pending: 32
Overall OVER hit rate: 98/154 = 63.6%  (0 pushes)

Edge calibration (projK - line bucket vs actual OVER hit rate):
  Bucket                 N    OVER hit%
  0.5-1.0               63        55.6%
  1.0-1.5               83        67.5%
  1.5-2.0                8        87.5%

  Edge < 1.0: 55.6% actual (n=63)  vs  Edge >= 1.0: 69.2% actual (n=91)
  z = -1.73 (not conventionally significant at this sample size)

Picks with matchup snapshot data: 0/154
  (need at least 20 graded picks with matchup data for a meaningful breakdown — check back after more picks are captured and graded)

══════════════════════════════════════════════════════════════════════
```

## Elite Picks

```
══════════════════════════════════════════════════════════════════════
ELITE PICKS CALIBRATION REPORT
══════════════════════════════════════════════════════════════════════
Total captured (all markets): 417

──────────────────────────────────────────────────────────────────────
Market: HR  (captured: 253, graded: 208, pending: 45)
  Overall actual hit rate: 23/208 = 11.1%

  Score calibration:
  Bucket               N   Actual hit%   Avg predicted%
  <20%                64         15.6%            16.8%
  20-29%             135          8.9%            22.5%
  30-39%               8         12.5%            32.1%
  40-49%               1          0.0%            43.0%
  Below median score (<21.2%): 14.3% actual (n=119)  vs  At/above median: 6.7% actual (n=89)
  z = 1.72 (not conventionally significant at this sample size)
  (0/208 graded picks have matchup-snapshot data — need 20+ for a pitcher-profile breakdown)

──────────────────────────────────────────────────────────────────────
Market: HITS  (captured: 37, graded: 32, pending: 5)
  Overall actual hit rate: 14/32 = 43.8%

  Score calibration:
  Bucket               N   Actual hit%   Avg predicted%
  50%+                32         43.8%            73.3%
  Below median score (<73.3%): 33.3% actual (n=15)  vs  At/above median: 52.9% actual (n=17)
  z = -1.12 (not conventionally significant at this sample size)
  (0/32 graded picks have matchup-snapshot data — need 20+ for a pitcher-profile breakdown)

──────────────────────────────────────────────────────────────────────
Market: RBIS  (captured: 35, graded: 30, pending: 5)
  Overall actual hit rate: 10/30 = 33.3%

  Score calibration:
  Bucket               N   Actual hit%   Avg predicted%
  30-39%               2          0.0%            35.5%
  40-49%              15         33.3%            44.4%
  50%+                13         38.5%            65.2%
  Below median score (<52.8%): 29.4% actual (n=17)  vs  At/above median: 38.5% actual (n=13)
  z = -0.52 (not conventionally significant at this sample size)
  (0/30 graded picks have matchup-snapshot data — need 20+ for a pitcher-profile breakdown)

──────────────────────────────────────────────────────────────────────
Market: TB  (captured: 31, graded: 26, pending: 5)
  Overall actual hit rate: 7/26 = 26.9%

  Score calibration:
  Bucket               N   Actual hit%   Avg predicted%
  20-29%               1          0.0%            26.0%
  40-49%              18         33.3%            46.7%
  50%+                 7         14.3%            51.7%
  Below median score (<47.3%): 16.7% actual (n=12)  vs  At/above median: 35.7% actual (n=14)
  z = -1.09 (not conventionally significant at this sample size)
  (0/26 graded picks have matchup-snapshot data — need 20+ for a pitcher-profile breakdown)

──────────────────────────────────────────────────────────────────────
Market: SB  (captured: 31, graded: 26, pending: 5)
  Overall actual hit rate: 3/26 = 11.5%

  Score calibration:
  Bucket               N   Actual hit%   Avg predicted%
  <20%                 1          0.0%            13.0%
  20-29%              16          0.0%            23.3%
  30-39%               7         42.9%            34.3%
  40-49%               1          0.0%            47.0%
  50%+                 1          0.0%            52.0%
  Below median score (<27.8%): 0.0% actual (n=17)  vs  At/above median: 33.3% actual (n=9)
  z = -2.53 (statistically significant difference, p<0.05)
  (0/26 graded picks have matchup-snapshot data — need 20+ for a pitcher-profile breakdown)

──────────────────────────────────────────────────────────────────────
Market: HRRBI  (captured: 30, graded: 25, pending: 5)
  Overall actual hit rate: 11/25 = 44.0%

  Score calibration:
  Bucket               N   Actual hit%   Avg predicted%
  50%+                25         44.0%            68.3%
  Below median score (<68.3%): 31.3% actual (n=16)  vs  At/above median: 66.7% actual (n=9)
  z = -1.71 (not conventionally significant at this sample size)
  (0/25 graded picks have matchup-snapshot data — need 20+ for a pitcher-profile breakdown)

══════════════════════════════════════════════════════════════════════
```

## Diamond Report Pick (game winner)

```
══════════════════════════════════════════════════════════════════════
DIAMOND REPORT PICK (GAME WINNER) CALIBRATION REPORT
══════════════════════════════════════════════════════════════════════
Total captured: 90  |  Graded: 73  |  Pending: 17
Overall pick hit rate: 41/73 = 56.2%  (0 pushes)

Confidence calibration (pickPct bucket vs actual hit rate):
  Bucket                 N   Actual hit%
  50-54%                49         55.1%
  55-59%                22         54.5%
  60-64%                 2        100.0%

  pickPct < 60%: 54.9% actual (n=71)  vs  pickPct >= 60%: 100.0% actual (n=2)
  z = -1.27 (not conventionally significant at this sample size)

Picks with matchup snapshot data: 0/73
  (need at least 20 graded picks with matchup data for a meaningful breakdown — check back after more picks are captured and graded)

══════════════════════════════════════════════════════════════════════
```
