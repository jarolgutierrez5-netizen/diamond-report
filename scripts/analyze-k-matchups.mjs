#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// K Props calibration report — the strikeouts-market counterpart to
// analyze-hr-matchups.mjs. Reads the graded picks already sitting in
// data/tracker.json's market.kprop[] (see update-tracker.mjs's
// computeKProp/gradePending) and checks whether bigger model edge over the
// line actually translates into a higher real hit rate, and whether the
// model performs differently across pitcher/opponent-lineup profiles.
//
// Every K Props pick is an OVER on the model's own line (line = real
// sportsbook line when available, else floor(projK) - 0.5) -- there's no
// natural "50% baseline" the way a coin-flip market has, so this checks
// relative calibration (edge bucket vs hit rate) rather than an absolute
// score-vs-outcome check like the HR report.
//
// Pure local analysis, no network calls -- safe to run any time. The
// k9/projIP/oppKpct fields are only present on picks captured after that
// change shipped, so the pitcher/opponent breakdowns below will be
// empty/thin until enough of those accumulate; the edge-calibration and
// lineSource breakdowns work on the full history immediately.
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
  console.log(`  ${'Bucket'.padEnd(18)}${'N'.padStart(6)}${'OVER hit%'.padStart(13)}`);
  for (const r of rows) {
    console.log(`  ${String(r.bucket).padEnd(18)}${String(r.n).padStart(6)}${pct(r.hitRate).padStart(13)}`);
  }
}

// Two-proportion z-test -- same use as in analyze-hr-matchups.mjs, flags
// whether a split is likely real signal vs. noise from a modest sample.
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
  const all = tracker?.market?.kprop || [];
  const graded = all.filter(r => r.result === 'win' || r.result === 'loss' || r.result === 'push');

  console.log('═'.repeat(70));
  console.log('K PROPS CALIBRATION REPORT');
  console.log('═'.repeat(70));
  console.log(`Total captured: ${all.length}  |  Graded: ${graded.length}  |  Pending: ${all.length - graded.length}`);
  if (!graded.length) { console.log('\nNo graded picks yet — nothing to analyze.'); return; }

  const decided = graded.filter(r => r.result !== 'push');
  const wins = decided.filter(r => r.result === 'win').length;
  const pushes = graded.length - decided.length;
  console.log(`Overall OVER hit rate: ${wins}/${decided.length} = ${pct(wins / decided.length)}  (${pushes} push${pushes === 1 ? '' : 'es'})`);

  // ── Edge calibration: line = floor(projK)-0.5 (model line) or the real book
  // line -- either way, a bigger gap between the model's own projK and the
  // line it bet OVER on should mean a more confident, more-often-correct
  // pick. Non-monotonic buckets here would be the K Props equivalent of the
  // HR score-inversion finding. ──
  const edgeBucketOrder = ['<0.5', '0.5-1.0', '1.0-1.5', '1.5-2.0', '2.0+'];
  const edgeBucket = r => {
    const e = r.projK - r.line;
    if (!Number.isFinite(e)) return null;
    if (e < 0.5) return '<0.5';
    if (e < 1.0) return '0.5-1.0';
    if (e < 1.5) return '1.0-1.5';
    if (e < 2.0) return '1.5-2.0';
    return '2.0+';
  };
  printTable('Edge calibration (projK - line bucket vs actual OVER hit rate):', bucketStats(decided, edgeBucket, edgeBucketOrder));

  const lowEdge = decided.filter(r => (r.projK - r.line) < 1.0);
  const highEdge = decided.filter(r => (r.projK - r.line) >= 1.0);
  if (lowEdge.length && highEdge.length) {
    const lw = lowEdge.filter(r => r.result === 'win').length;
    const hw = highEdge.filter(r => r.result === 'win').length;
    const z = twoPropZ(lw, lowEdge.length, hw, highEdge.length);
    console.log(`\n  Edge < 1.0: ${pct(lw / lowEdge.length)} actual (n=${lowEdge.length})  vs  Edge >= 1.0: ${pct(hw / highEdge.length)} actual (n=${highEdge.length})`);
    if (z != null) console.log(`  z = ${z.toFixed(2)} ${Math.abs(z) > 1.96 ? '(statistically significant difference, p<0.05)' : '(not conventionally significant at this sample size)'}`);
  }

  // ── Real sportsbook line vs model-derived fallback line — only meaningful
  // once ODDS_API_KEY is set and real book lines start flowing; currently
  // 100% model-line in this tracker's history. ──
  const bySource = bucketStats(decided, r => r.lineSource || 'model', ['model', 'sportsbook']);
  if (bySource.length > 1) printTable('By line source:', bySource);

  // ── "What went wrong" on losses: tells apart a short outing (pulled early,
  // never got the innings/batters faced to reach the projected K count
  // regardless of how well they were pitching) from a full outing that just
  // didn't produce enough strikeouts (the model's read on this pitcher's
  // stuff/matchup was the actual miss). Only present on picks graded after
  // finalIP/finalBF were added to the K prop grading step. ──
  const losses = decided.filter(r => r.result === 'loss');
  const lossesWithPerf = losses.filter(r => r.finalIP != null || r.finalBF != null);
  if (lossesWithPerf.length) {
    let shortOuting = 0, fullOuting = 0;
    for (const r of lossesWithPerf) {
      const pulledEarly = (r.finalIP != null && r.projIP != null && r.finalIP < r.projIP - 1)
        || (r.finalBF != null && r.finalBF < 20);
      if (pulledEarly) shortOuting++; else fullOuting++;
    }
    console.log(`\nMiss diagnosis (${lossesWithPerf.length}/${losses.length} losses with performance data):`);
    console.log(`  Short outing (pulled early, never got the look): ${shortOuting} (${pct(shortOuting / lossesWithPerf.length)})`);
    console.log(`  Full outing, just didn't miss enough bats: ${fullOuting} (${pct(fullOuting / lossesWithPerf.length)})`);
  }

  // ── Pitcher K/9 and opponent-lineup K-rate breakdowns — only present on
  // picks captured after the k9/projIP/oppKpct snapshot fields were added;
  // will be thin/empty at first. ──
  const withMatchup = decided.filter(r => r.k9 != null);
  console.log(`\nPicks with matchup snapshot data: ${withMatchup.length}/${decided.length}`);
  if (withMatchup.length >= 20) {
    const k9Bucket = r => r.k9 < 7 ? '<7 K/9' : r.k9 < 9 ? '7-9 K/9' : '9+ K/9';
    printTable('By pitcher K/9:', bucketStats(withMatchup, k9Bucket, ['<7 K/9', '7-9 K/9', '9+ K/9']));

    const oppBucket = r => r.oppKpct == null ? null : r.oppKpct < 0.20 ? 'Low-K lineup (<20%)' : r.oppKpct < 0.25 ? 'Avg lineup (20-25%)' : 'High-K lineup (25%+)';
    printTable('By opponent lineup K-rate:', bucketStats(withMatchup, oppBucket, ['Low-K lineup (<20%)', 'Avg lineup (20-25%)', 'High-K lineup (25%+)']));

    // Real lineups (not just their averaged K%) let this check whether one
    // specific batting-order spot's season K-rate predicts the pitcher's
    // real strikeout total better than the lineup-wide average does -- e.g.
    // if the bottom-of-the-order K% ends up mattering more than 1-2 hitters.
    const withLineup = withMatchup.filter(r => Array.isArray(r.lineup) && r.lineup.length === 9);
    if (withLineup.length >= 20) {
      const spotAvgKpct = spot => {
        const vals = withLineup.map(r => r.lineup.find(b => b.battingOrder === spot)?.kPct).filter(v => v != null);
        return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
      };
      console.log(`\nAvg season K% by batting-order spot (n=${withLineup.length} lineups):`);
      for (let spot = 1; spot <= 9; spot++) {
        const avg = spotAvgKpct(spot);
        if (avg != null) console.log(`  Spot ${spot}: ${pct(avg)}`);
      }
    }
  } else {
    console.log('  (need at least 20 graded picks with matchup data for a meaningful breakdown — check back after more picks are captured and graded)');
  }

  console.log('\n' + '═'.repeat(70));
}

main().catch(e => { console.error(e); process.exit(1); });
