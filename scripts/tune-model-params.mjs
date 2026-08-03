#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Bounded, logged auto-tune for data/model-params.json. Two tunable HR Threats
// constants live here, each earned by a real analysis:
//   - HR_MULT_SHRINKAGE (see update-tracker.mjs's shrinkMult) -- dampens each
//     individual, correlated input multiplier toward neutral.
//   - HR_SCORE_CALIBRATION_SLOPE/INTERCEPT (see update-tracker.mjs's
//     calibrateHRProb) -- a final linear recalibration of the combined
//     output, fit against real graded outcomes, correcting the compounding
//     overconfidence that shrinking each input individually doesn't fully
//     remove.
//
// This is deliberately conservative, on purpose: it's adjusting a real,
// live, real-money-adjacent scoring input, unattended, on a schedule. Every
// safeguard below exists because of a specific failure mode a naive
// "auto-tune from data" script would otherwise have:
//   - Minimum sample size gate (both the low-score and high-score bucket
//     need enough graded picks) -- an earlier calibration pass on the SB
//     market found a striking-looking split on just 26 graded picks (3 total
//     stolen bases); tuning a live parameter off a sample that thin would
//     be reacting to noise, not signal.
//   - Statistical significance bar stricter than the report's own (z > 2.0
//     here vs. the report's 1.96) -- this script changes something, the
//     report only describes something; the bar to act should be higher
//     than the bar to notice.
//   - Small, fixed step size and a clamped range -- no single run can move
//     the parameter far, so a bad read self-limits instead of compounding.
//   - Every run appends to data/model-tuning-log.json, adjusted or not --
//     "checked, no change" is as important a record as "changed X to Y",
//     so nobody has to guess whether this ran and silently decided nothing
//     was wrong vs. never ran at all.
//   - Writes only to data/model-params.json, a plain JSON data file --
//     never to this repo's source (.mjs/.js) files. An auto-tune is always
//     just a JSON diff, reviewable and revertable exactly like any other
//     bot-updated data file in this repo (tracker.json, park-factors.json,
//     etc.), never a silent code change nobody asked this script to make.
// ─────────────────────────────────────────────────────────────────────────

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRACKER_PATH = path.join(__dirname, '..', 'data', 'tracker.json');
const PARAMS_PATH = path.join(__dirname, '..', 'data', 'model-params.json');
const LOG_PATH = path.join(__dirname, '..', 'data', 'model-tuning-log.json');

const DEFAULT_PARAMS = { HR_MULT_SHRINKAGE: 0.6, HR_SCORE_CALIBRATION_SLOPE: 1, HR_SCORE_CALIBRATION_INTERCEPT: 0 };

// Safety rails -- see file header for why each of these exists.
const MIN_SAMPLE_PER_SIDE = 60;
const SIGNIFICANCE_Z = 2.0;
const STEP_TIGHTEN = 0.05;  // shrink harder when the high-score bucket is still underperforming
const STEP_LOOSEN = 0.03;   // ease off more cautiously if the low bucket now underperforms (asymmetric on purpose)
const MIN_SHRINKAGE = 0.3;
const MAX_SHRINKAGE = 1.0;

// HR_SCORE_CALIBRATION_* safety rails -- same philosophy as the shrinkage rails above,
// sized for a regression instead of a two-bucket split. A regression needs more points
// than a bucket comparison to pin down a slope reliably, hence the higher sample floor.
const MIN_SAMPLE_CALIBRATION = 150;
const MAX_STEP_SLOPE = 0.05;
const MAX_STEP_INTERCEPT = 3;
const MIN_CALIBRATION_SLOPE = 0.5;
const MAX_CALIBRATION_SLOPE = 1.0;   // never amplify past the raw model's own confidence, only compress toward it
const MIN_CALIBRATION_INTERCEPT = -5;
const MAX_CALIBRATION_INTERCEPT = 20;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Simple OLS of a 0/1 outcome on a 1-99 predicted score -- a linear probability model.
// Returns the fitted line plus the slope's standard error, so the caller can test the
// fitted slope against the null hypothesis slope=1 (i.e. "the model is already calibrated")
// rather than just eyeballing whether the fit looks off.
function olsRegression(points) {
  const n = points.length;
  if (n < 3) return null;
  const meanX = points.reduce((s, p) => s + p.x, 0) / n;
  const meanY = points.reduce((s, p) => s + p.y, 0) / n;
  let sxx = 0, sxy = 0;
  for (const p of points) { const dx = p.x - meanX; sxx += dx * dx; sxy += dx * (p.y - meanY); }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  let sse = 0;
  for (const p of points) { const resid = p.y - (intercept + slope * p.x); sse += resid * resid; }
  const df = n - 2;
  if (df <= 0) return null;
  const seSlope = Math.sqrt((sse / df) / sxx);
  if (!(seSlope > 0)) return null;
  return { n, slope, intercept, seSlope };
}

function cdtDateString(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

function twoPropZ(w1, n1, w2, n2) {
  if (n1 === 0 || n2 === 0) return null;
  const p1 = w1 / n1, p2 = w2 / n2;
  const pPool = (w1 + w2) / (n1 + n2);
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / n1 + 1 / n2));
  if (se === 0) return null;
  return (p1 - p2) / se;
}

async function loadJSON(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

async function loadParams() {
  const parsed = await loadJSON(PARAMS_PATH, null);
  return {
    generatedAt: parsed?.generatedAt ?? null,
    params: { ...DEFAULT_PARAMS, ...(parsed?.params || {}) },
    effectiveSince: { ...(parsed?.effectiveSince || {}) },
  };
}

async function saveParams(store) {
  store.generatedAt = new Date().toISOString();
  await mkdir(path.dirname(PARAMS_PATH), { recursive: true });
  await writeFile(PARAMS_PATH, JSON.stringify(store, null, 2) + '\n');
}

async function appendLog(entry) {
  const log = await loadJSON(LOG_PATH, { version: 1, entries: [] });
  log.entries ||= [];
  log.entries.push({ at: new Date().toISOString(), ...entry });
  await mkdir(path.dirname(LOG_PATH), { recursive: true });
  await writeFile(LOG_PATH, JSON.stringify(log, null, 2) + '\n');
}

// Mirrors analyze-hr-matchups.mjs's low/high score-bucket check exactly (score < 22%
// vs >= 22%) -- the same split that originally justified adding shrinkage at all, so
// re-checking it here (rather than inventing a different split) is checking the same
// thing the manual fix was checking, just automated and re-run over fresh data.
//
// Critical: only counts picks captured ON OR AFTER effectiveSince (when the CURRENT
// HR_MULT_SHRINKAGE value took effect). Without this filter, every run would keep
// re-diagnosing the same pre-fix historical picks forever -- they never leave
// tracker.json -- and would ratchet shrinkage tighter and tighter based on data that
// predates whatever value is currently live, long after that value was already fixed.
// This only ever judges the value actually in effect against picks made under it.
function checkHRShrinkage(tracker, effectiveSince) {
  const all = (tracker?.market?.hrThreat || []).filter(r => r.result === 'win' || r.result === 'loss');
  const graded = effectiveSince ? all.filter(r => r.date >= effectiveSince) : all;
  const low = graded.filter(r => r.score < 22);
  const high = graded.filter(r => r.score >= 22);
  const lw = low.filter(r => r.result === 'win').length;
  const hw = high.filter(r => r.result === 'win').length;
  const z = twoPropZ(lw, low.length, hw, high.length);
  return {
    param: 'HR_MULT_SHRINKAGE',
    effectiveSince: effectiveSince || null,
    excludedPreEffective: all.length - graded.length,
    nLow: low.length, nHigh: high.length,
    lowHitRate: low.length ? lw / low.length : null,
    highHitRate: high.length ? hw / high.length : null,
    z,
  };
}

// Fits actual outcome vs. the score already displayed (score already reflects whatever
// calibration is currently live, since calibrateHRProb runs before the score is stored --
// see update-tracker.mjs). A slope significantly below 1 is the compounding-overconfidence
// signature the calibration report flagged: the score rises faster than the real hit rate
// does. Same effectiveSince re-baselining as checkHRShrinkage, and for the same reason --
// only ever judge the calibration actually in effect against picks made under it.
//
// The outcome is coded 0/100, not 0/1, to match score's 0-100 scale -- a perfectly
// calibrated score of 25 should hit 25% of the time, so the calibrated relationship is
// slope=1/intercept=0 (y == x), not slope=0.01. Coding the outcome as 0/1 would test
// the fitted line against the wrong null and flag every model as wildly miscalibrated.
function checkHRCalibration(tracker, effectiveSince) {
  const all = (tracker?.market?.hrThreat || []).filter(r => r.result === 'win' || r.result === 'loss');
  const graded = effectiveSince ? all.filter(r => r.date >= effectiveSince) : all;
  const points = graded
    .filter(r => Number.isFinite(r.score))
    .map(r => ({ x: r.score, y: r.result === 'win' ? 100 : 0 }));
  const fit = olsRegression(points);
  const tSlope = fit ? (fit.slope - 1) / fit.seSlope : null;
  return {
    param: 'HR_SCORE_CALIBRATION',
    effectiveSince: effectiveSince || null,
    excludedPreEffective: all.length - graded.length,
    n: points.length,
    fittedSlope: fit?.slope ?? null,
    fittedIntercept: fit?.intercept ?? null,
    seSlope: fit?.seSlope ?? null,
    tSlope,
  };
}

async function tuneHRShrinkage(tracker, paramsStore) {
  const current = paramsStore.params.HR_MULT_SHRINKAGE;
  const effectiveSince = paramsStore.effectiveSince.HR_MULT_SHRINKAGE || null;
  const check = checkHRShrinkage(tracker, effectiveSince);

  console.log(`HR_MULT_SHRINKAGE check: n_low=${check.nLow}, n_high=${check.nHigh}, ` +
    `lowHitRate=${check.lowHitRate != null ? (check.lowHitRate * 100).toFixed(1) + '%' : 'n/a'}, ` +
    `highHitRate=${check.highHitRate != null ? (check.highHitRate * 100).toFixed(1) + '%' : 'n/a'}, ` +
    `z=${check.z != null ? check.z.toFixed(2) : 'n/a'}, current=${current}`);

  const gateMet = check.nLow >= MIN_SAMPLE_PER_SIDE && check.nHigh >= MIN_SAMPLE_PER_SIDE && check.z != null;
  if (!gateMet) {
    console.log(`Sample size gate not met (need >= ${MIN_SAMPLE_PER_SIDE} per side) — no change.`);
    await appendLog({ ...check, decision: 'skip', reason: 'sample size gate not met', current });
    return;
  }

  if (Math.abs(check.z) < SIGNIFICANCE_Z) {
    console.log(`Not statistically significant enough to act (|z| < ${SIGNIFICANCE_Z}) — no change.`);
    await appendLog({ ...check, decision: 'skip', reason: 'not statistically significant', current });
    return;
  }

  let next = current;
  let reason;
  if (check.z > 0) {
    // Low bucket still hitting meaningfully more than high bucket -- the original
    // inversion is still present (or not yet fully corrected); shrink harder.
    next = Math.max(MIN_SHRINKAGE, +(current - STEP_TIGHTEN).toFixed(3));
    reason = 'high-score bucket still underperforming low-score bucket — tightening shrinkage';
  } else {
    // Overshot -- low bucket now underperforms high bucket by a significant margin;
    // ease off, more cautiously (smaller step) than the tightening direction.
    next = Math.min(MAX_SHRINKAGE, +(current + STEP_LOOSEN).toFixed(3));
    reason = 'low-score bucket now underperforming high-score bucket — easing shrinkage';
  }

  if (next === current) {
    console.log(`Already at the ${next === MIN_SHRINKAGE ? 'floor' : 'ceiling'} (${current}) — no change.`);
    await appendLog({ ...check, decision: 'skip', reason: `at bound (${current}), cannot move further in indicated direction`, current });
    return;
  }

  paramsStore.params.HR_MULT_SHRINKAGE = next;
  // Re-baseline: the next check must only judge picks captured under this NEW value,
  // not re-count today's (now-superseded) evidence again next time this runs.
  paramsStore.effectiveSince.HR_MULT_SHRINKAGE = cdtDateString(new Date());
  await saveParams(paramsStore);
  console.log(`HR_MULT_SHRINKAGE: ${current} -> ${next} (${reason})`);
  await appendLog({ ...check, decision: 'adjust', reason, previous: current, next });
}

async function tuneHRCalibration(tracker, paramsStore) {
  const currentSlope = paramsStore.params.HR_SCORE_CALIBRATION_SLOPE;
  const currentIntercept = paramsStore.params.HR_SCORE_CALIBRATION_INTERCEPT;
  const effectiveSince = paramsStore.effectiveSince.HR_SCORE_CALIBRATION || null;
  const check = checkHRCalibration(tracker, effectiveSince);

  console.log(`HR_SCORE_CALIBRATION check: n=${check.n}, ` +
    `fittedSlope=${check.fittedSlope != null ? check.fittedSlope.toFixed(3) : 'n/a'}, ` +
    `fittedIntercept=${check.fittedIntercept != null ? check.fittedIntercept.toFixed(2) : 'n/a'}, ` +
    `t(slope=1)=${check.tSlope != null ? check.tSlope.toFixed(2) : 'n/a'}, ` +
    `current=slope ${currentSlope}, intercept ${currentIntercept}`);

  const gateMet = check.n >= MIN_SAMPLE_CALIBRATION && check.tSlope != null;
  if (!gateMet) {
    console.log(`Sample size gate not met (need >= ${MIN_SAMPLE_CALIBRATION}) — no change.`);
    await appendLog({ ...check, decision: 'skip', reason: 'sample size gate not met', current: { slope: currentSlope, intercept: currentIntercept } });
    return;
  }

  if (Math.abs(check.tSlope) < SIGNIFICANCE_Z) {
    console.log(`Not statistically significant enough to act (|t| < ${SIGNIFICANCE_Z}) — no change.`);
    await appendLog({ ...check, decision: 'skip', reason: 'not statistically significant', current: { slope: currentSlope, intercept: currentIntercept } });
    return;
  }

  // Step toward the fitted line, not onto it -- a single run's regression is one noisy
  // read, not ground truth, so it nudges the live params rather than replacing them.
  const nextSlope = clamp(currentSlope + clamp(check.fittedSlope - currentSlope, -MAX_STEP_SLOPE, MAX_STEP_SLOPE), MIN_CALIBRATION_SLOPE, MAX_CALIBRATION_SLOPE);
  const nextIntercept = clamp(currentIntercept + clamp(check.fittedIntercept - currentIntercept, -MAX_STEP_INTERCEPT, MAX_STEP_INTERCEPT), MIN_CALIBRATION_INTERCEPT, MAX_CALIBRATION_INTERCEPT);
  const roundedSlope = +nextSlope.toFixed(3);
  const roundedIntercept = +nextIntercept.toFixed(2);

  if (roundedSlope === currentSlope && roundedIntercept === currentIntercept) {
    console.log(`Already at bound or converged (slope ${currentSlope}, intercept ${currentIntercept}) — no change.`);
    await appendLog({ ...check, decision: 'skip', reason: 'at bound or converged on fitted line', current: { slope: currentSlope, intercept: currentIntercept } });
    return;
  }

  paramsStore.params.HR_SCORE_CALIBRATION_SLOPE = roundedSlope;
  paramsStore.params.HR_SCORE_CALIBRATION_INTERCEPT = roundedIntercept;
  // Re-baseline for the same reason as HR_MULT_SHRINKAGE above.
  paramsStore.effectiveSince.HR_SCORE_CALIBRATION = cdtDateString(new Date());
  await saveParams(paramsStore);
  console.log(`HR_SCORE_CALIBRATION: slope ${currentSlope} -> ${roundedSlope}, intercept ${currentIntercept} -> ${roundedIntercept} (stepping toward fitted calibration line)`);
  await appendLog({ ...check, decision: 'adjust', reason: 'stepping toward fitted calibration line', previous: { slope: currentSlope, intercept: currentIntercept }, next: { slope: roundedSlope, intercept: roundedIntercept } });
}

async function main() {
  const tracker = await loadJSON(TRACKER_PATH, null);
  if (!tracker) {
    console.log('No tracker.json found — nothing to tune against.');
    await appendLog({ param: 'HR_MULT_SHRINKAGE', decision: 'skip', reason: 'tracker.json missing/unreadable' });
    await appendLog({ param: 'HR_SCORE_CALIBRATION', decision: 'skip', reason: 'tracker.json missing/unreadable' });
    return;
  }

  const paramsStore = await loadParams();
  paramsStore.effectiveSince ||= {};

  await tuneHRShrinkage(tracker, paramsStore);
  await tuneHRCalibration(tracker, paramsStore);
}

main().catch(e => { console.error(e); process.exit(1); });
