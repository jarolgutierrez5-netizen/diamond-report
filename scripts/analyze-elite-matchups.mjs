#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Elite Picks calibration report — the market.premium[] counterpart to
// analyze-hr-matchups.mjs/analyze-k-matchups.mjs. Elite Picks shares the
// exact same scoreForMarket()/buildEliteBatterPool() pipeline as the HR
// Threats board (captureEliteToday just takes buildEliteFills' top N per
// market instead of every qualifying row), so a fix made there (e.g. the HR
// multiplier shrinkage) already applies here too -- this checks whether
// each of the six markets (hr/hits/rbis/tb/sb/hrrbi) is independently
// well-calibrated, not just the shared HR formula.
//
// Pure local analysis, no network calls -- safe to run any time. The
// matchup-snapshot fields (batterOPS, pitcherHr9, parkFactor, etc.) are only
// present on picks captured after that change shipped, so those breakdowns
// will be empty/thin until enough accumulate; the score-calibration and tag
// breakdowns work on the full history immediately.
// ─────────────────────────────────────────────────────────────────────────

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRACKER_PATH = path.join(__dirname, '..', 'data', 'tracker.json');
const MARKETS = ['hr', 'hits', 'rbis', 'tb', 'sb', 'hrrbi'];

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

function twoPropZ(w1, n1, w2, n2) {
  if (n1 === 0 || n2 === 0) return null;
  const p1 = w1 / n1, p2 = w2 / n2;
  const pPool = (w1 + w2) / (n1 + n2);
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / n1 + 1 / n2));
  if (se === 0) return null;
  return (p1 - p2) / se;
}

const scoreBucketOrder = ['<20%', '20-29%', '30-39%', '40-49%', '50%+'];
function scoreBucket(r) {
  const s = r.score;
  if (s == null) return null;
  if (s < 20) return '<20%';
  if (s < 30) return '20-29%';
  if (s < 40) return '30-39%';
  if (s < 50) return '40-49%';
  return '50%+';
}

async function main() {
  const raw = await readFile(TRACKER_PATH, 'utf8');
  const tracker = JSON.parse(raw);
  const all = tracker?.market?.premium || [];

  console.log('═'.repeat(70));
  console.log('ELITE PICKS CALIBRATION REPORT');
  console.log('═'.repeat(70));
  console.log(`Total captured (all markets): ${all.length}`);

  for (const market of MARKETS) {
    const marketAll = all.filter(r => r.market === market);
    const graded = marketAll.filter(r => r.result === 'win' || r.result === 'loss');
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`Market: ${market.toUpperCase()}  (captured: ${marketAll.length}, graded: ${graded.length}, pending: ${marketAll.length - graded.length})`);
    if (!graded.length) { console.log('  No graded picks yet.'); continue; }

    const wins = graded.filter(r => r.result === 'win').length;
    console.log(`  Overall actual hit rate: ${wins}/${graded.length} = ${pct(wins / graded.length)}`);

    printTable('  Score calibration:', bucketStats(graded, scoreBucket, scoreBucketOrder), true);

    const mid = graded.reduce((a, r) => a + (r.score || 0), 0) / graded.length;
    const low = graded.filter(r => r.score < mid);
    const high = graded.filter(r => r.score >= mid);
    if (low.length >= 5 && high.length >= 5) {
      const lw = low.filter(r => r.result === 'win').length;
      const hw = high.filter(r => r.result === 'win').length;
      const z = twoPropZ(lw, low.length, hw, high.length);
      console.log(`  Below median score (<${mid.toFixed(1)}%): ${pct(lw / low.length)} actual (n=${low.length})  vs  At/above median: ${pct(hw / high.length)} actual (n=${high.length})`);
      if (z != null) console.log(`  z = ${z.toFixed(2)} ${Math.abs(z) > 1.96 ? '(statistically significant difference, p<0.05)' : '(not conventionally significant at this sample size)'}`);
    }

    // Same methodology as the median-split z-test just above, not just raw
    // percentages -- a tag's TRUE/FALSE split is only worth reading once both
    // sides clear a real sample size.
    const TAG_MIN_SAMPLE_PER_SIDE = 20;
    for (const tag of ['isFavorable', 'isHot', 'isDrought', 'isDue']) {
      const withTag = graded.filter(r => tag in r);
      if (!withTag.length) continue;
      const on = withTag.filter(r => r[tag]);
      const off = withTag.filter(r => !r[tag]);
      if (!on.length || !off.length) continue;
      const ow = on.filter(r => r.result === 'win').length;
      const fw = off.filter(r => r.result === 'win').length;
      const z = twoPropZ(ow, on.length, fw, off.length);
      let line = `  ${tag}: TRUE ${pct(ow / on.length)} (n=${on.length})  vs  FALSE ${pct(fw / off.length)} (n=${off.length})`;
      if (on.length < TAG_MIN_SAMPLE_PER_SIDE || off.length < TAG_MIN_SAMPLE_PER_SIDE) {
        line += `\n  (below the ${TAG_MIN_SAMPLE_PER_SIDE}-per-side sample floor — too thin to read as signal yet, treat as noise-risk)`;
      } else if (z != null) {
        line += `\n  z = ${z.toFixed(2)} ${Math.abs(z) > 1.96 ? '(statistically significant difference, p<0.05)' : '(not conventionally significant at this sample size)'}`;
      }
      console.log(line);
    }

    const withPitcher = graded.filter(r => r.pitcherHr9 != null);
    if (withPitcher.length >= 20) {
      const hr9Bucket = r => r.pitcherHr9 < 0.9 ? '<0.9 HR/9' : r.pitcherHr9 < 1.2 ? '0.9-1.2 HR/9' : '1.2+ HR/9';
      printTable('  By opposing pitcher HR/9 allowed:', bucketStats(withPitcher, hr9Bucket, ['<0.9 HR/9', '0.9-1.2 HR/9', '1.2+ HR/9']));
    } else {
      console.log(`  (${withPitcher.length}/${graded.length} graded picks have matchup-snapshot data — need 20+ for a pitcher-profile breakdown)`);
    }
  }

  console.log('\n' + '═'.repeat(70));
}

main().catch(e => { console.error(e); process.exit(1); });
