#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Diamond Report Pick (game winner) calibration report — the market.drp[]
// counterpart to analyze-hr-matchups.mjs/analyze-k-matchups.mjs. Checks
// whether the pick's confidence (pickPct) actually tracks its real win rate,
// and whether specific matchup shapes (big ERA/WHIP/K9 gaps, day vs night,
// lopsided records) predict differently from the model's blended pick.
//
// Pure local analysis, no network calls -- safe to run any time. The
// eraDiff/whipDiff/k9Diff/record/isDayGame snapshot fields are only present
// on picks captured after that change shipped, so those breakdowns will be
// empty/thin until enough accumulate; the pickPct-calibration breakdown
// works on the full history immediately.
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
    if (!buckets.has(b)) buckets.set(b, { wins: 0, total: 0 });
    const e = buckets.get(b);
    e.total++;
    if (r.result === 'win') e.wins++;
  }
  const order = labelOrder || [...buckets.keys()];
  return order
    .filter(b => buckets.has(b))
    .map(b => {
      const e = buckets.get(b);
      return { bucket: b, n: e.total, hitRate: e.wins / e.total };
    });
}

function printTable(title, rows) {
  console.log(`\n${title}`);
  console.log(`  ${'Bucket'.padEnd(18)}${'N'.padStart(6)}${'Actual hit%'.padStart(14)}`);
  for (const r of rows) {
    console.log(`  ${String(r.bucket).padEnd(18)}${String(r.n).padStart(6)}${pct(r.hitRate).padStart(14)}`);
  }
}

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
  const all = tracker?.market?.drp || [];
  const graded = all.filter(r => r.result === 'win' || r.result === 'loss' || r.result === 'push');

  console.log('═'.repeat(70));
  console.log('DIAMOND REPORT PICK (GAME WINNER) CALIBRATION REPORT');
  console.log('═'.repeat(70));
  console.log(`Total captured: ${all.length}  |  Graded: ${graded.length}  |  Pending: ${all.length - graded.length}`);
  if (!graded.length) { console.log('\nNo graded picks yet — nothing to analyze.'); return; }

  const decided = graded.filter(r => r.result !== 'push');
  const wins = decided.filter(r => r.result === 'win').length;
  const pushes = graded.length - decided.length;
  console.log(`Overall pick hit rate: ${wins}/${decided.length} = ${pct(wins / decided.length)}  (${pushes} push${pushes === 1 ? '' : 'es'})`);

  // ── Confidence calibration: pickPct is a win-probability estimate (50-100%
  // scale, since it's always the favored side) -- a well-calibrated model's
  // buckets should read left-to-right ascending. ──
  const pctBucketOrder = ['50-54%', '55-59%', '60-64%', '65%+'];
  const pctBucket = r => {
    const p = r.pickPct;
    if (p == null) return null;
    if (p < 55) return '50-54%';
    if (p < 60) return '55-59%';
    if (p < 65) return '60-64%';
    return '65%+';
  };
  printTable('Confidence calibration (pickPct bucket vs actual hit rate):', bucketStats(decided, pctBucket, pctBucketOrder));

  const low = decided.filter(r => r.pickPct < 60);
  const high = decided.filter(r => r.pickPct >= 60);
  if (low.length && high.length) {
    const lw = low.filter(r => r.result === 'win').length;
    const hw = high.filter(r => r.result === 'win').length;
    const z = twoPropZ(lw, low.length, hw, high.length);
    console.log(`\n  pickPct < 60%: ${pct(lw / low.length)} actual (n=${low.length})  vs  pickPct >= 60%: ${pct(hw / high.length)} actual (n=${high.length})`);
    if (z != null) console.log(`  z = ${z.toFixed(2)} ${Math.abs(z) > 1.96 ? '(statistically significant difference, p<0.05)' : '(not conventionally significant at this sample size)'}`);
  }

  // ── Matchup-shape breakdowns — only present on picks captured after the
  // eraDiff/whipDiff/k9Diff/record/isDayGame snapshot fields were added. ──
  const withMatchup = decided.filter(r => r.eraDiff != null);
  console.log(`\nPicks with matchup snapshot data: ${withMatchup.length}/${decided.length}`);
  if (withMatchup.length >= 20) {
    const eraGapBucket = r => Math.abs(r.eraDiff) < 0.3 ? 'ERA gap <0.3' : Math.abs(r.eraDiff) < 1.0 ? 'ERA gap 0.3-1.0' : 'ERA gap 1.0+';
    printTable('By starting-pitcher ERA gap:', bucketStats(withMatchup, eraGapBucket, ['ERA gap <0.3', 'ERA gap 0.3-1.0', 'ERA gap 1.0+']));

    const recordGapBucket = r => {
      if (r.awayRecordPct == null || r.homeRecordPct == null) return null;
      const gap = Math.abs(r.awayRecordPct - r.homeRecordPct);
      return gap < 0.05 ? 'Record gap <5pt' : gap < 0.15 ? 'Record gap 5-15pt' : 'Record gap 15pt+';
    };
    printTable('By team record gap:', bucketStats(withMatchup, recordGapBucket, ['Record gap <5pt', 'Record gap 5-15pt', 'Record gap 15pt+']));

    const dayNight = bucketStats(withMatchup, r => r.isDayGame == null ? null : (r.isDayGame ? 'Day game' : 'Night game'), ['Day game', 'Night game']);
    if (dayNight.length > 1) printTable('By day/night:', dayNight);
  } else {
    console.log('  (need at least 20 graded picks with matchup data for a meaningful breakdown — check back after more picks are captured and graded)');
  }

  console.log('\n' + '═'.repeat(70));
}

main().catch(e => { console.error(e); process.exit(1); });
