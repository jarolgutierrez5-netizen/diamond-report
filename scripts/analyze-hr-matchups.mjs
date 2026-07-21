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
// history immediately.
// ─────────────────────────────────────────────────────────────────────────

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRACKER_PATH = path.join(__dirname, '..', 'data', 'tracker.json');

function pct(n) { return (n * 100).toFixed(1) + '%'; }

function bucketStats(rows, bucketFn, labelOrder) {
  const buckets = new Map();
  for (const r of rows) {
    const b = bucketFn(r);
    if (b == null) continue;
    if (!buckets.has(b)) buckets.set(b, { wins: 0, total: 0, scoreSum: 0 });
    const e = buckets.get(b);
    e.total++;
    if (r.result === 'win') e.wins++;
    if (Number.isFinite(r.score)) e.scoreSum += r.score;
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
    ? `  ${'Bucket'.padEnd(16)}${'N'.padStart(6)}${'Actual hit%'.padStart(14)}${'Avg predicted%'.padStart(17)}`
    : `  ${'Bucket'.padEnd(16)}${'N'.padStart(6)}${'Actual hit%'.padStart(14)}`;
  console.log(header);
  for (const r of rows) {
    const line = extraCol
      ? `  ${String(r.bucket).padEnd(16)}${String(r.n).padStart(6)}${pct(r.hitRate).padStart(14)}${pct(r.avgPredicted).padStart(17)}`
      : `  ${String(r.bucket).padEnd(16)}${String(r.n).padStart(6)}${pct(r.hitRate).padStart(14)}`;
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

  // ── Signal-tag breakdowns (isOnFire/isFavorable/isDrought/isDue) — same
  // methodology as the score-calibration z-test above, not just raw percentages:
  // only present on picks captured after those tags were added to the snapshot,
  // and a tag's TRUE/FALSE split is only worth reading once both sides clear a
  // real sample size — the whole reason the score check above and
  // tune-model-params.mjs both gate on sample size before treating a split as
  // signal instead of noise from a handful of picks. ──
  const TAG_MIN_SAMPLE_PER_SIDE = 20;
  for (const tag of ['isOnFire', 'isFavorable', 'isDrought', 'isDue']) {
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

  // ── Pitcher-matchup breakdowns — only present on picks captured after the
  // pitcher-snapshot fields were added; will be thin/empty at first. ──
  const withPitcher = graded.filter(r => r.pitcherHr9 != null);
  console.log(`\nPicks with pitcher-matchup data: ${withPitcher.length}/${graded.length}`);
  if (withPitcher.length >= 20) {
    const hr9Bucket = r => r.pitcherHr9 < 0.9 ? '<0.9 HR/9' : r.pitcherHr9 < 1.2 ? '0.9-1.2 HR/9' : '1.2+ HR/9';
    printTable('By opposing pitcher HR/9 allowed:', bucketStats(withPitcher, hr9Bucket, ['<0.9 HR/9', '0.9-1.2 HR/9', '1.2+ HR/9']));

    const whipBucket = r => r.pitcherWhip == null ? null : r.pitcherWhip < 1.15 ? '<1.15 WHIP' : r.pitcherWhip < 1.35 ? '1.15-1.35 WHIP' : '1.35+ WHIP';
    printTable('By opposing pitcher WHIP:', bucketStats(withPitcher, whipBucket, ['<1.15 WHIP', '1.15-1.35 WHIP', '1.35+ WHIP']));

    const parkBucket = r => r.parkFactor == null ? null : r.parkFactor < 97 ? 'Pitcher park (<97)' : r.parkFactor <= 103 ? 'Neutral park' : 'Hitter park (103+)';
    printTable('By park factor:', bucketStats(withPitcher, parkBucket, ['Pitcher park (<97)', 'Neutral park', 'Hitter park (103+)']));
  } else {
    console.log('  (need at least 20 graded picks with pitcher data for a meaningful breakdown — check back after more picks are captured and graded)');
  }

  console.log('\n' + '═'.repeat(70));
}

main().catch(e => { console.error(e); process.exit(1); });
