#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// HR Threats calibration report — reads the graded picks already sitting in
// data/tracker.json's market.hrThreat[] (see update-tracker.mjs's
// captureHRThreatToday/gradeHRThreatPending) and checks whether the model's
// predicted HR probability ("score") actually tracks the real outcome rate.
//
// Pure local analysis, no network calls — safe to run any time (locally or
// as a manual workflow_dispatch) to check in on calibration as more graded
// picks accumulate, especially the pitcher-matchup fields (pitcherId,
// pitcherHr9, pitcherAvgAllowed, pitcherWhip, batterOPS/ISO, parkFactor,
// windFactor, temperatureFactor) added alongside this script — those are
// only present on picks captured after that change shipped, so the
// pitcher-side breakdowns below will be empty/thin until enough of those
// accumulate; the score-calibration and tag breakdowns work on the full
// history immediately. Also tracks pitcher2kSuppressionDelta, the exploratory
// "Pitcher IQ" / 2-strike hard-hit suppression signal (see
// scripts/sync-pitcher-2k-suppression.mjs) — recorded purely for this report
// to eventually judge whether it's worth wiring into HR Probability itself;
// it isn't used in scoring anywhere yet.
// ─────────────────────────────────────────────────────────────────────────

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRACKER_PATH = path.join(__dirname, '..', 'data', 'tracker.json');

function pct(n) { return (n * 100).toFixed(1) + '%'; }

function bucketStats(rows, bucketFn, labelOrder, scoreField = 'score') {
  const buckets = new Map();
  for (const r of rows) {
    const b = bucketFn(r);
    if (b == null) continue;
    if (!buckets.has(b)) buckets.set(b, { wins: 0, total: 0, scoreSum: 0 });
    const e = buckets.get(b);
    e.total++;
    if (r.result === 'win') e.wins++;
    if (Number.isFinite(r[scoreField])) e.scoreSum += r[scoreField];
  }
  const order = labelOrder || [...buckets.keys()];
  return order
    .filter(b => buckets.has(b))
    .map(b => {
      const e = buckets.get(b);
      return { bucket: b, n: e.total, hitRate: e.wins / e.total, avgPredicted: e.scoreSum / e.total / 100 };
    });
}

function printTable(title, rows, extraCol) {
  console.log(`\n${title}`);
  const header = extraCol
    ? `  ${'Bucket'.padEnd(28)}${'N'.padStart(6)}${'Actual hit%'.padStart(14)}${'Avg predicted%'.padStart(17)}`
    : `  ${'Bucket'.padEnd(28)}${'N'.padStart(6)}${'Actual hit%'.padStart(14)}`;
  console.log(header);
  for (const r of rows) {
    const line = extraCol
      ? `  ${String(r.bucket).padEnd(28)}${String(r.n).padStart(6)}${pct(r.hitRate).padStart(14)}${pct(r.avgPredicted).padStart(17)}`
      : `  ${String(r.bucket).padEnd(28)}${String(r.n).padStart(6)}${pct(r.hitRate).padStart(14)}`;
    console.log(line);
  }
}

// Two-proportion z-test — used to flag whether a split is likely real signal
// or just noise from a modest sample, rather than eyeballing raw percentages.
function twoPropZ(w1, n1, w2, n2) {
  if (n1 === 0 || n2 === 0) return null;
  const p1 = w1 / n1, p2 = w2 / n2;
  const pPool = (w1 + w2) / (n1 + n2);
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / n1 + 1 / n2));
  if (se === 0) return null;
  return (p1 - p2) / se;
}

async function main() {
  const raw = await readFile(TRACKER_PATH, 'utf8');
  const tracker = JSON.parse(raw);
  const all = tracker?.market?.hrThreat || [];
  const graded = all.filter(r => r.result === 'win' || r.result === 'loss');

  console.log('═'.repeat(70));
  console.log('HR THREATS CALIBRATION REPORT');
  console.log('═'.repeat(70));
  console.log(`Total captured: ${all.length}  |  Graded (win/loss): ${graded.length}  |  Pending: ${all.length - graded.length}`);
  if (!graded.length) { console.log('\nNo graded picks yet — nothing to analyze.'); return; }

  const overallWins = graded.filter(r => r.result === 'win').length;
  console.log(`Overall actual hit rate: ${overallWins}/${graded.length} = ${pct(overallWins / graded.length)}`);

  // ── Score calibration: does a higher predicted score actually mean a higher
  // real hit rate? A well-calibrated model's buckets should read left-to-right
  // ascending; a model with a compounding-overconfidence problem in its
  // multiplier stack will often show the opposite. ──
  const scoreBucketOrder = ['18%', '19%', '20-21%', '22-24%', '25-29%', '30%+'];
  const scoreBucket = r => {
    const s = r.score;
    if (s == null) return null;
    if (s < 19) return '18%';
    if (s < 20) return '19%';
    if (s < 22) return '20-21%';
    if (s < 25) return '22-24%';
    if (s < 30) return '25-29%';
    return '30%+';
  };
  printTable('Score calibration (predicted HR% bucket vs actual hit rate):', bucketStats(graded, scoreBucket, scoreBucketOrder), true);

  const low = graded.filter(r => r.score < 22);
  const high = graded.filter(r => r.score >= 22);
  if (low.length && high.length) {
    const lw = low.filter(r => r.result === 'win').length;
    const hw = high.filter(r => r.result === 'win').length;
    const z = twoPropZ(lw, low.length, hw, high.length);
    console.log(`\n  Score < 22%: ${pct(lw / low.length)} actual (n=${low.length})  vs  Score >= 22%: ${pct(hw / high.length)} actual (n=${high.length})`);
    if (z != null) console.log(`  z = ${z.toFixed(2)} ${Math.abs(z) > 1.96 ? '(statistically significant difference, p<0.05)' : '(not conventionally significant at this sample size)'}`);
  }

  // ── Live client score calibration — score above is this file's OWN scoring
  // (scoreForMarket('hr'), used to actually pick/grade), which is NOT what a site
  // visitor sees. liveScore is a snapshot of the separate, simpler formula the live
  // HR Threats board actually runs (see update-tracker.mjs's computeLiveHRScore, a
  // line-for-line port of app.js's loadHRPotential formula) -- captured starting
  // when this field shipped, so it'll be empty/thin until enough picks accumulate
  // under it. This is the calibration check that actually answers "does the number
  // users see rank players correctly," separate from this file's own scoring. ──
  const withLiveScore = graded.filter(r => Number.isFinite(r.liveScore));
  console.log(`\nPicks with live client score snapshot: ${withLiveScore.length}/${graded.length}`);
  if (withLiveScore.length >= 20) {
    const liveScoreBucket = r => {
      const s = r.liveScore;
      if (s < 19) return '18%';
      if (s < 20) return '19%';
      if (s < 22) return '20-21%';
      if (s < 25) return '22-24%';
      if (s < 30) return '25-29%';
      return '30%+';
    };
    printTable('Live client score calibration (what users actually see):', bucketStats(withLiveScore, liveScoreBucket, scoreBucketOrder, 'liveScore'), true);
    const liveLow = withLiveScore.filter(r => r.liveScore < 22);
    const liveHigh = withLiveScore.filter(r => r.liveScore >= 22);
    if (liveLow.length && liveHigh.length) {
      const lw = liveLow.filter(r => r.result === 'win').length;
      const hw = liveHigh.filter(r => r.result === 'win').length;
      const z = twoPropZ(lw, liveLow.length, hw, liveHigh.length);
      console.log(`\n  Live score < 22%: ${pct(lw / liveLow.length)} actual (n=${liveLow.length})  vs  Live score >= 22%: ${pct(hw / liveHigh.length)} actual (n=${liveHigh.length})`);
      if (z != null) console.log(`  z = ${z.toFixed(2)} ${Math.abs(z) > 1.96 ? '(statistically significant difference, p<0.05)' : '(not conventionally significant at this sample size)'}`);
    }
  } else {
    console.log('  (need at least 20 graded picks with a live-score snapshot for a meaningful breakdown — check back after more picks are captured and graded under the new field)');
  }

  // ── Logistic vs legacy formula -- which one actually produced `score` for a given
  // pick (see update-tracker.mjs's simulateHRGameOdds/hrScoreSource). Only present on
  // picks captured after scripts/fit-hr-logistic-model.mjs's model was wired in, so
  // this stays empty until enough accumulate under it -- same "check back later"
  // convention as the live-score section above. ──
  const withSource = graded.filter(r => r.hrScoreSource === 'logistic' || r.hrScoreSource === 'legacy');
  if (withSource.length) {
    console.log(`\nScore source breakdown: ${withSource.length}/${graded.length} picks have hrScoreSource recorded`);
    for (const source of ['logistic', 'legacy']) {
      const rows = withSource.filter(r => r.hrScoreSource === source);
      if (!rows.length) continue;
      const wins = rows.filter(r => r.result === 'win').length;
      console.log(`  ${source.padEnd(10)} n=${String(rows.length).padStart(5)}   actual hit rate: ${pct(wins / rows.length)}`);
    }
  }

  // ── Signal-tag breakdowns (isOnFire/isFavorable/isDrought/isDue/hasNearHR) — same
  // methodology as the score-calibration z-test above, not just raw percentages:
  // only present on picks captured after those tags were added to the snapshot,
  // and a tag's TRUE/FALSE split is only worth reading once both sides clear a
  // real sample size — the whole reason the score check above and
  // tune-model-params.mjs both gate on sample size before treating a split as
  // signal instead of noise from a handful of picks. hasNearHR is the board's
  // "🚀 NEAR HR" chip (real warning-track power in the last 10 games) — previously
  // a display-only chip never checked against real graded outcomes. ──
  const TAG_MIN_SAMPLE_PER_SIDE = 20;
  for (const tag of ['isOnFire', 'isFavorable', 'isDrought', 'isDue', 'hasNearHR']) {
    const withTag = graded.filter(r => tag in r);
    if (!withTag.length) continue;
    const on = withTag.filter(r => r[tag]);
    const off = withTag.filter(r => !r[tag]);
    if (!on.length || !off.length) continue;
    const ow = on.filter(r => r.result === 'win').length;
    const fw = off.filter(r => r.result === 'win').length;
    const z = twoPropZ(ow, on.length, fw, off.length);
    let line = `\n${tag}: TRUE ${pct(ow / on.length)} (n=${on.length})  vs  FALSE ${pct(fw / off.length)} (n=${off.length})`;
    if (on.length < TAG_MIN_SAMPLE_PER_SIDE || off.length < TAG_MIN_SAMPLE_PER_SIDE) {
      line += `\n  (below the ${TAG_MIN_SAMPLE_PER_SIDE}-per-side sample floor — too thin to read as signal yet, treat as noise-risk)`;
    } else if (z != null) {
      line += `\n  z = ${z.toFixed(2)} ${Math.abs(z) > 1.96 ? '(statistically significant difference, p<0.05)' : '(not conventionally significant at this sample size)'}`;
    }
    console.log(line);
  }

  // ── Platoon-split breakdown (exploratory) — this batter's real AVG/OBP/SLG vs
  // today's specific opposing pitcher's throwing hand, not currently used by any live
  // scoring (client or server) for the HR market -- see update-tracker.mjs's
  // platoonAB/platoonOps/platoonFavorable comment. Recorded purely to check whether
  // it's worth building into the Compare tray's proposed platoon-corrected re-rank
  // before spending any UI/latency budget on it, same "measure before we build"
  // approach already taken for every other signal here. Only present on picks with
  // 15+ AB against this pitcher hand this season (battingSplitVsHand's own sample
  // floor), so this fills in slower than the other breakdowns. ──
  const withPlatoon = graded.filter(r => r.platoonFavorable != null);
  console.log(`\nPicks with platoon-split data: ${withPlatoon.length}/${graded.length}`);
  if (withPlatoon.length) {
    const on = withPlatoon.filter(r => r.platoonFavorable);
    const off = withPlatoon.filter(r => !r.platoonFavorable);
    if (on.length && off.length) {
      const ow = on.filter(r => r.result === 'win').length;
      const fw = off.filter(r => r.result === 'win').length;
      const z = twoPropZ(ow, on.length, fw, off.length);
      let line = `  platoonFavorable: TRUE ${pct(ow / on.length)} (n=${on.length})  vs  FALSE ${pct(fw / off.length)} (n=${off.length})`;
      if (on.length < TAG_MIN_SAMPLE_PER_SIDE || off.length < TAG_MIN_SAMPLE_PER_SIDE) {
        line += `\n  (below the ${TAG_MIN_SAMPLE_PER_SIDE}-per-side sample floor — too thin to read as signal yet, treat as noise-risk)`;
      } else if (z != null) {
        line += `\n  z = ${z.toFixed(2)} ${Math.abs(z) > 1.96 ? '(statistically significant difference, p<0.05)' : '(not conventionally significant at this sample size)'}`;
      }
      console.log(line);
    }
  } else {
    console.log('  (no graded picks with platoon-split data yet — check back after more picks are captured and graded under the new field)');
  }

  // ── Matchup Edge breakdown (exploratory) — the same 0-99 pitch-mix-vs-batter score
  // shown on the live HR Threats board and its sort control, and in the Pitcher Matchup
  // modal as "MATCHUP EDGE" (see update-tracker.mjs's computeMatchupEdgeScore comment).
  // Not used by any live scoring for the HR market -- recorded purely to check whether
  // it actually predicts real outcomes before it's ever wired into scoreForMarket,
  // same "measure before we build" approach as every other signal
  // here. Bucket thresholds mirror gradePitchAdvantage's own Weak/Neutral/Strong/
  // Excellent labels so a bucket here reads the same as the board's own chip color.
  // Null until both this pitcher's and this batter's Statcast pitch-mix sync have
  // landed, so this fills in slower than the box-score-only signals. ──
  const withMatchupEdge = graded.filter(r => Number.isFinite(r.matchupEdge));
  console.log(`\nPicks with Matchup Edge data: ${withMatchupEdge.length}/${graded.length}`);
  if (withMatchupEdge.length >= 20) {
    const matchupEdgeBucket = r => {
      const s = r.matchupEdge;
      if (s < 45) return 'Weak (<45)';
      if (s < 64) return 'Neutral (45-63)';
      if (s < 78) return 'Strong (64-77)';
      return 'Excellent (78+)';
    };
    printTable('Matchup Edge calibration (predicted grade vs actual hit rate):', bucketStats(withMatchupEdge, matchupEdgeBucket, ['Weak (<45)', 'Neutral (45-63)', 'Strong (64-77)', 'Excellent (78+)'], 'matchupEdge'), true);
    const edgeLow = withMatchupEdge.filter(r => r.matchupEdge < 64);
    const edgeHigh = withMatchupEdge.filter(r => r.matchupEdge >= 64);
    if (edgeLow.length && edgeHigh.length) {
      const lw = edgeLow.filter(r => r.result === 'win').length;
      const hw = edgeHigh.filter(r => r.result === 'win').length;
      const z = twoPropZ(lw, edgeLow.length, hw, edgeHigh.length);
      console.log(`\n  Matchup Edge < 64: ${pct(lw / edgeLow.length)} actual (n=${edgeLow.length})  vs  Matchup Edge >= 64: ${pct(hw / edgeHigh.length)} actual (n=${edgeHigh.length})`);
      if (z != null) console.log(`  z = ${z.toFixed(2)} ${Math.abs(z) > 1.96 ? '(statistically significant difference, p<0.05)' : '(not conventionally significant at this sample size)'}`);
    }
  } else {
    console.log('  (need at least 20 graded picks with Matchup Edge data for a meaningful breakdown — check back after more picks are captured and graded under the new field)');
  }

  // ── Pitcher-matchup breakdowns — only present on picks captured after the
  // pitcher-snapshot fields were added; will be thin/empty at first. ──
  const withPitcher = graded.filter(r => r.pitcherHr9 != null);
  console.log(`\nPicks with pitcher-matchup data: ${withPitcher.length}/${graded.length}`);
  if (withPitcher.length >= 20) {
    const hr9Bucket = r => r.pitcherHr9 < 0.9 ? '<0.9 HR/9' : r.pitcherHr9 < 1.2 ? '0.9-1.2 HR/9' : '1.2+ HR/9';
    printTable('By opposing pitcher HR/9 allowed:', bucketStats(withPitcher, hr9Bucket, ['<0.9 HR/9', '0.9-1.2 HR/9', '1.2+ HR/9']));

    const whipBucket = r => r.pitcherWhip == null ? null : r.pitcherWhip < 1.15 ? '<1.15 WHIP' : r.pitcherWhip < 1.35 ? '1.15-1.35 WHIP' : '1.35+ WHIP';
    printTable('By opposing pitcher WHIP:', bucketStats(withPitcher, whipBucket, ['<1.15 WHIP', '1.15-1.35 WHIP', '1.35+ WHIP']));

    // Coors Field (145) sits in a class of its own -- the next-highest park (CIN, 112)
    // isn't within 30 points of it. A flat "103+" bucket lumps Coors in with parks that
    // are only mildly hitter-friendly (MIL 104, NYY 105, BOS 106, PHI 107, TEX 108),
    // and those modest parks' small-sample noise was burying Coors' own real signal --
    // Coors alone showed the highest win rate of any park in the data (28.6%, n=14)
    // while the aggregate "103+" bucket read 14.8%. Splitting off a genuinely extreme
    // tier (120+, comfortably above every park except Coors) lets that signal show
    // through instead of averaging it away.
    const parkBucket = r => r.parkFactor == null ? null : r.parkFactor < 97 ? 'Pitcher park (<97)' : r.parkFactor <= 103 ? 'Neutral park (97-103)' : r.parkFactor < 120 ? 'Hitter park (104-119)' : 'Extreme hitter park (120+)';
    printTable('By park factor:', bucketStats(withPitcher, parkBucket, ['Pitcher park (<97)', 'Neutral park (97-103)', 'Hitter park (104-119)', 'Extreme hitter park (120+)']));
  } else {
    console.log('  (need at least 20 graded picks with pitcher data for a meaningful breakdown — check back after more picks are captured and graded)');
  }

  // ── Exploratory "2-strike contact suppression" ("Pitcher IQ") breakdown —
  // see scripts/sync-pitcher-2k-suppression.mjs for what this measures. Only
  // covers today's probable starters at capture time, so this fills in much
  // slower than the pitcherHr9/WHIP breakdowns above; a real read on whether
  // it's worth wiring into HR Probability needs this section past its sample
  // floor, not just the overall win rate. Not used by scoreForMarket yet.
  const withSuppression = graded.filter(r => r.pitcher2kSuppressionDelta != null);
  console.log(`\nPicks with 2-strike suppression data: ${withSuppression.length}/${graded.length}`);
  if (withSuppression.length >= 20) {
    const suppressionBucket = r => r.pitcher2kSuppressionDelta <= -5 ? 'Suppresses hard (<=-5pp)' : r.pitcher2kSuppressionDelta < 5 ? 'Neutral (-5 to +5pp)' : 'Gets hit harder (5pp+)';
    printTable('By opposing pitcher 2-strike hard-hit suppression:', bucketStats(withSuppression, suppressionBucket, ['Suppresses hard (<=-5pp)', 'Neutral (-5 to +5pp)', 'Gets hit harder (5pp+)']));
  } else {
    console.log('  (need at least 20 graded picks with 2-strike suppression data for a meaningful breakdown — check back after more picks are captured and graded)');
  }

  // ── Batter sample-size breakdown — checks whether real calibration holds up
  // for a part-time/platoon/bench batter the same way it does for an everyday
  // starter, not just whether the model's OWN shrinkage logic feels reasonable.
  // batterAtBats was only added to the capture in this same session, so this
  // will be empty/thin at first -- same "instrument now, judge once real picks
  // accumulate" pattern as startBFShare/matchupEdge above. Boundaries: POOL_MIN_AB
  // (40) already floors what gets captured at all, so buckets start above that --
  // <150 AB is roughly a part-timer/injury-limited/recent-call-up sample, 150-350
  // is a platoon or bench-regular season, 350+ is a genuine everyday starter.
  const withBatterAB = graded.filter(r => r.batterAtBats != null);
  console.log(`\nPicks with batter AB-total data: ${withBatterAB.length}/${graded.length}`);
  if (withBatterAB.length >= 20) {
    const abBucket = r => r.batterAtBats < 150 ? '<150 AB (part-time)' : r.batterAtBats < 350 ? '150-350 AB (platoon/bench)' : '350+ AB (everyday)';
    printTable('By batter season AB total:', bucketStats(withBatterAB, abBucket, ['<150 AB (part-time)', '150-350 AB (platoon/bench)', '350+ AB (everyday)']));
  } else {
    console.log('  (need at least 20 graded picks with batter AB-total data for a meaningful breakdown — check back after more picks are captured and graded under the new field)');
  }

  console.log('\n' + '═'.repeat(70));
}

main().catch(e => { console.error(e); process.exit(1); });
