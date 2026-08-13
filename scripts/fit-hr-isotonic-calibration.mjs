#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Weekly, unattended, safety-railed fit of an isotonic (monotonic
// step-function) calibration curve for HR Threats, against the graded picks
// already sitting in data/tracker.json's market.hrThreat[].
//
// Why this exists, on top of tune-model-params.mjs's existing
// HR_SCORE_CALIBRATION_SLOPE/INTERCEPT: that's a straight-line correction --
// it can rescale the whole score-vs-outcome curve, but it structurally
// cannot fix a NON-MONOTONIC miscalibration (a middle score bucket hitting
// at a lower real rate than a bucket below it), because a linear transform
// preserves rank order by construction. data/calibration-report.md has shown
// exactly that shape (a 22-24% bucket underperforming an 18% bucket).
// Isotonic regression fits a monotonic (non-decreasing) step function
// instead -- the standard statistical tool for this exact failure mode.
//
// This is layered ON TOP of, not a replacement for, the existing
// shrinkMult/calibrateHRProb correction: it's fit directly against
// data/tracker.json's r.score field, which for legacy-path rows already
// reflects whatever HR_MULT_SHRINKAGE/HR_SCORE_CALIBRATION_SLOPE/INTERCEPT
// was live at capture time -- so it's a genuine residual correction on
// "whatever score is actually shown today," applied uniformly regardless of
// whether that score came from the fitted logistic model (predictHRLogistic,
// which currently receives NO further correction at all) or the legacy
// simulation+linear-calibration path. See simulateHRGameOdds in
// update-tracker.mjs/app.js for exactly where this plugs in.
//
// Auto-schedule posture (unlike fit-hr-logistic-model.mjs's manual --write
// review step): this runs weekly via .github/workflows/calibration-report.yml
// and always writes its decision, gated by objective criteria rather than a
// human eyeballing a diff -- same "measure, then a deliberate, logged action"
// discipline as tune-model-params.mjs, just applied to a curve fit instead of
// two scalar nudges. Safety rails, all logged to data/model-tuning-log.json
// on every run (activated, refreshed, or skipped):
//   - Minimum sample size before ANY fit is attempted (MIN_SAMPLE_ISOTONIC).
//   - Quantile bucketing (not one breakpoint per raw score) so each fitted
//     point rests on a real sample, not a single pick's outcome.
//   - K-fold cross-validation: the curve only activates/stays active if it
//     beats the current no-further-correction baseline (score/100 taken
//     directly as the probability estimate) on held-out Brier score by a
//     real margin, AND wins on a majority of folds (not just on average --
//     guards against one lucky fold masking a curve that's actually a wash).
//   - effectiveSince re-baselining (same convention as tune-model-params.mjs's
//     checkHRShrinkage/checkHRCalibration): once active, later refits only
//     use picks captured on/after activation, so a refit never keeps
//     "re-correcting" the same pre-activation history forever.
//   - Ships INACTIVE (active:false, identity behavior) until data clears the
//     bar -- same "behavior-neutral until earned" default as every other
//     tunable in this repo.
// ─────────────────────────────────────────────────────────────────────────

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRACKER_PATH = path.join(__dirname, '..', 'data', 'tracker.json');
const CALIBRATION_PATH = path.join(__dirname, '..', 'data', 'hr-isotonic-calibration.json');
const LOG_PATH = path.join(__dirname, '..', 'data', 'model-tuning-log.json');

// Below this, quantile buckets would rest on too few picks each to trust --
// no fit is even attempted (matches tune-model-params.mjs's own
// MIN_SAMPLE_CALIBRATION=150 floor for a 2-parameter linear fit; this fits
// more parameters, so it earns a higher floor).
const MIN_SAMPLE_ISOTONIC = 400;
const CV_FOLDS = 5;
// Absolute Brier-score improvement the isotonic curve must beat the
// no-further-correction baseline by, on held-out folds, before it's trusted
// live -- comparable in scale to the real Brier gap fit-hr-logistic-model.mjs
// found between its fitted model and the legacy formula (0.117 vs 0.125).
const MIN_BRIER_IMPROVEMENT = 0.003;
// Isotonic must win on at least this fraction of folds, not just on
// average -- a curve that wins big on one fold and loses on the rest is
// noise dressed up as a win.
const MIN_FOLD_WIN_FRACTION = 0.8;

function clampBuckets(n) {
  // ~150+ picks per bucket at the floor above, capped so a very large future
  // sample doesn't produce a needlessly jagged step function.
  return Math.max(4, Math.min(8, Math.floor(n / 150)));
}

async function loadJSON(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

async function appendLog(entry) {
  const log = await loadJSON(LOG_PATH, { version: 1, entries: [] });
  log.entries ||= [];
  log.entries.push({ at: new Date().toISOString(), ...entry });
  await mkdir(path.dirname(LOG_PATH), { recursive: true });
  await writeFile(LOG_PATH, JSON.stringify(log, null, 2) + '\n');
}

// Quantile-bucket a score-sorted point list into `nBuckets` roughly-equal-size
// groups (by count, not by score range -- HR Threats scores cluster in a
// fairly narrow real band, so equal-width bins would leave some nearly
// empty), returning each bucket's mean score (x), mean outcome (y, 0-1), and
// sample count (w).
function quantileBuckets(points, nBuckets) {
  const sorted = [...points].sort((a, b) => a.x - b.x);
  const n = sorted.length;
  const buckets = [];
  for (let i = 0; i < nBuckets; i++) {
    const lo = Math.floor((i * n) / nBuckets);
    const hi = Math.floor(((i + 1) * n) / nBuckets);
    const slice = sorted.slice(lo, hi);
    if (!slice.length) continue;
    const xSum = slice.reduce((s, p) => s + p.x, 0);
    const ySum = slice.reduce((s, p) => s + p.y, 0);
    buckets.push({ x: xSum / slice.length, y: ySum / slice.length, w: slice.length });
  }
  return buckets;
}

// Pool-adjacent-violators algorithm: merges adjacent buckets (already sorted
// by x) whenever a later bucket's mean is lower than an earlier one's,
// weighted-averaging the merged group, until the sequence of means is
// non-decreasing. Standard, exact isotonic regression fit under squared-error
// loss for a small number of weighted points.
function poolAdjacentViolators(buckets) {
  const stack = [];
  for (const b of buckets) {
    let block = { ySum: b.y * b.w, w: b.w, xMin: b.x, xMax: b.x, xSum: b.x * b.w };
    stack.push(block);
    while (stack.length > 1 && (stack[stack.length - 2].ySum / stack[stack.length - 2].w) > (stack[stack.length - 1].ySum / stack[stack.length - 1].w)) {
      const b2 = stack.pop();
      const b1 = stack.pop();
      stack.push({ ySum: b1.ySum + b2.ySum, w: b1.w + b2.w, xMin: b1.xMin, xMax: b2.xMax, xSum: b1.xSum + b2.xSum });
    }
  }
  return stack.map(b => ({ x: b.xSum / b.w, y: b.ySum / b.w, n: b.w }));
}

// Piecewise-linear interpolation between fitted breakpoints; clamps to the
// first/last breakpoint's y outside the fitted range rather than
// extrapolating a step function past data it was never fit on.
function interpolate(breakpoints, x) {
  if (!breakpoints.length) return x / 100;
  if (x <= breakpoints[0].x) return breakpoints[0].y;
  if (x >= breakpoints[breakpoints.length - 1].x) return breakpoints[breakpoints.length - 1].y;
  for (let i = 0; i < breakpoints.length - 1; i++) {
    const a = breakpoints[i], b = breakpoints[i + 1];
    if (x >= a.x && x <= b.x) {
      const t = (b.x === a.x) ? 0 : (x - a.x) / (b.x - a.x);
      return a.y + t * (b.y - a.y);
    }
  }
  return breakpoints[breakpoints.length - 1].y;
}

function brier(preds) {
  return preds.reduce((s, p) => s + (p.pred - p.outcome) ** 2, 0) / preds.length;
}

function shuffle(arr, seed) {
  // Small deterministic LCG so a re-run of this exact script against the
  // exact same tracker.json snapshot reproduces the exact same fold split --
  // real randomness isn't needed here, reproducibility for debugging is more
  // valuable.
  let s = seed;
  const rand = () => { s = (s * 1103515245 + 12345) % 2 ** 31; return s / 2 ** 31; };
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Cross-validated comparison: isotonic-corrected score vs. the
// no-further-correction baseline (score/100 taken directly as the
// probability estimate -- exactly what a user sees today). Refits the curve
// fresh on each fold's training split so the held-out fold never leaks into
// its own evaluation.
function crossValidate(points) {
  const shuffled = shuffle(points, 20260812);
  const foldSize = Math.ceil(shuffled.length / CV_FOLDS);
  let isoWins = 0;
  const isoBriers = [], baseBriers = [];
  for (let f = 0; f < CV_FOLDS; f++) {
    const testStart = f * foldSize, testEnd = Math.min(shuffled.length, testStart + foldSize);
    const test = shuffled.slice(testStart, testEnd);
    const train = [...shuffled.slice(0, testStart), ...shuffled.slice(testEnd)];
    if (!test.length || train.length < MIN_SAMPLE_ISOTONIC / 2) continue;
    const buckets = quantileBuckets(train, clampBuckets(train.length));
    const fitted = poolAdjacentViolators(buckets);
    const isoPreds = test.map(p => ({ pred: interpolate(fitted, p.x), outcome: p.y }));
    const basePreds = test.map(p => ({ pred: p.x / 100, outcome: p.y }));
    const isoBrier = brier(isoPreds), baseBrier = brier(basePreds);
    isoBriers.push(isoBrier); baseBriers.push(baseBrier);
    if (isoBrier < baseBrier) isoWins++;
  }
  const foldsRun = isoBriers.length;
  const meanIso = isoBriers.reduce((a, b) => a + b, 0) / foldsRun;
  const meanBase = baseBriers.reduce((a, b) => a + b, 0) / foldsRun;
  return { foldsRun, meanIsoBrier: meanIso, meanBaseBrier: meanBase, improvement: meanBase - meanIso, foldWinFraction: isoWins / foldsRun };
}

async function main() {
  const tracker = await loadJSON(TRACKER_PATH, null);
  const existing = await loadJSON(CALIBRATION_PATH, null);
  const effectiveSince = existing?.active ? (existing.effectiveSince || null) : null;

  const all = (tracker?.market?.hrThreat || []).filter(r => r.result === 'win' || r.result === 'loss');
  // Same re-baselining discipline as tune-model-params.mjs: once this curve
  // is live, only judge/refit it against picks captured under it, so a
  // weekly refit never keeps "correcting" pre-activation history forever.
  const graded = effectiveSince ? all.filter(r => r.date >= effectiveSince) : all;
  const points = graded
    .filter(r => Number.isFinite(r.score))
    .map(r => ({ x: r.score, y: r.result === 'win' ? 1 : 0 }));

  console.log(`HR isotonic calibration: n=${points.length} graded picks` + (effectiveSince ? ` (since ${effectiveSince})` : ' (all history -- not yet active)') + '.');

  if (points.length < MIN_SAMPLE_ISOTONIC) {
    console.log(`Sample size gate not met (need >= ${MIN_SAMPLE_ISOTONIC}) -- leaving inactive.`);
    await appendLog({ param: 'HR_ISOTONIC_CALIBRATION', n: points.length, decision: 'skip', reason: 'sample size gate not met', active: existing?.active ?? false });
    if (!existing) {
      await writeFile(CALIBRATION_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), active: false, n: points.length, effectiveSince: null, breakpoints: [] }, null, 2) + '\n');
    }
    return;
  }

  const cv = crossValidate(points);
  console.log(`CV (${cv.foldsRun} folds): isotonic Brier=${cv.meanIsoBrier.toFixed(4)}, baseline Brier=${cv.meanBaseBrier.toFixed(4)}, ` +
    `improvement=${cv.improvement.toFixed(4)}, foldWinFraction=${cv.foldWinFraction.toFixed(2)}.`);

  const clears = cv.improvement >= MIN_BRIER_IMPROVEMENT && cv.foldWinFraction >= MIN_FOLD_WIN_FRACTION;
  if (!clears) {
    console.log('Does not clear the activation bar -- leaving inactive/unchanged.');
    await appendLog({
      param: 'HR_ISOTONIC_CALIBRATION', n: points.length, foldsRun: cv.foldsRun,
      meanIsoBrier: cv.meanIsoBrier, meanBaseBrier: cv.meanBaseBrier, improvement: cv.improvement, foldWinFraction: cv.foldWinFraction,
      decision: 'skip', reason: 'CV improvement did not clear the bar', active: existing?.active ?? false,
    });
    if (!existing) {
      await writeFile(CALIBRATION_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), active: false, n: points.length, effectiveSince: null, breakpoints: [], cv }, null, 2) + '\n');
    }
    return;
  }

  // Clears the bar -- fit the final curve on ALL eligible points (not just
  // one fold's training split) and activate/refresh.
  const finalBuckets = quantileBuckets(points, clampBuckets(points.length));
  const breakpoints = poolAdjacentViolators(finalBuckets).map(b => ({ x: +b.x.toFixed(2), y: +b.y.toFixed(4), n: b.n }));
  const wasActive = existing?.active === true;
  const newEffectiveSince = wasActive ? effectiveSince : new Date().toISOString().slice(0, 10);

  const out = { generatedAt: new Date().toISOString(), active: true, n: points.length, effectiveSince: newEffectiveSince, breakpoints, cv };
  await writeFile(CALIBRATION_PATH, JSON.stringify(out, null, 2) + '\n');
  console.log(`${wasActive ? 'Refreshed' : 'Activated'} isotonic calibration: ${breakpoints.length} breakpoints, effectiveSince=${newEffectiveSince}.`);
  await appendLog({
    param: 'HR_ISOTONIC_CALIBRATION', n: points.length, foldsRun: cv.foldsRun,
    meanIsoBrier: cv.meanIsoBrier, meanBaseBrier: cv.meanBaseBrier, improvement: cv.improvement, foldWinFraction: cv.foldWinFraction,
    decision: wasActive ? 'refresh' : 'activate', breakpoints: breakpoints.length, effectiveSince: newEffectiveSince, active: true,
  });
}

main().catch(e => { console.error(e); process.exit(1); });
