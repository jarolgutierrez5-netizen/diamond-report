#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Fits a real L2-regularized logistic regression for HR Threats probability
// against the graded picks already sitting in data/tracker.json, as an
// alternative to the hand-tuned multiplicative formula in update-tracker.mjs's
// scoreForMarket('hr') / app.js's loadHRPotential.
//
// Why this exists: analyze-hr-matchups.mjs's calibration report showed the
// current formula's predicted-score buckets don't discriminate real outcome
// rate well (a linear fit of actual-vs-predicted came back with slope ~ -0.11,
// essentially flat/inverted) even at n=1213 graded picks. The current formula
// combines its real inputs (batter power, pitcher HR-proneness, park, weather,
// hot-streak form) with hand-picked weights (60/40 batter/pitcher split, 0.5
// park shrinkage, etc.) that were never fit to data -- they're plausible
// priors, not fitted parameters. This script keeps the same real, already-
// captured inputs but lets a model learn their actual weights from what has
// really happened, so calibration falls out of the fit itself instead of
// needing a separate post-hoc linear correction bolted on afterward (see
// tune-model-params.mjs's HR_SCORE_CALIBRATION_SLOPE/INTERCEPT).
//
// Zero npm dependencies (built-in fetch/fs only, hand-rolled linear algebra
// for an 8x8 system) -- same "no package.json needed" convention as every
// other script in this directory.
//
// IMPORTANT: this script only FITS and REPORTS. It does not wire the fitted
// model into live scoring anywhere -- app.js/update-tracker.mjs are untouched.
// It writes its fitted coefficients to data/hr-logistic-model.json purely so
// the fit is reviewable/reproducible; actually replacing the live formula
// with this model is a separate, deliberate follow-up decision once the
// cross-validated numbers below have been reviewed against the current
// model's own real performance on the same picks.
//
// Feature selection: restricted to real fields with strong coverage across
// the graded population (batterOPS/ISO, pitcherHr9/Whip, park/wind/temperature
// factors, isOnFire all co-occur on the same ~758/1213 graded rows -- fields
// added later, like matchupEdge/zoneFitScore/platoon splits, have thinner
// coverage and are left out rather than shrinking the training set further).
// batterOPS and pitcherSlgAllowed were dropped for redundancy: OPS/ISO
// correlate at r=0.66 (ISO is the more HR-specific signal), and
// pitcherHr9/pitcherSlgAllowed correlate at r=0.83 (HR9 is the more direct
// one) -- keeping both of a highly correlated pair makes coefficients
// unstable without adding real information, especially at this sample size.
// isFavorable/isDrought/isDue were left out too: isFavorable in particular is
// itself just a threshold function of OPS/WHIP already in the feature set
// (see app.js's earlyFavorable), so including it would be re-feeding the old
// heuristic's own arbitrary cutoff back in as if it were independent signal.
// ─────────────────────────────────────────────────────────────────────────

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRACKER_PATH = path.join(__dirname, '..', 'data', 'tracker.json');
const MODEL_PATH = path.join(__dirname, '..', 'data', 'hr-logistic-model.json');

const FEATURES = ['batterISO', 'pitcherHr9', 'pitcherWhip', 'parkFactor', 'windFactor', 'temperatureFactor', 'isOnFire'];
const N_FOLDS = 5;
const LAMBDA_GRID = [0.5, 1, 2, 5, 10, 20, 40, 80]; // L2 penalty candidates on standardized features, chosen by CV log-loss

function pct(n) { return (n * 100).toFixed(1) + '%'; }
function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }

// ── Small hand-rolled linear algebra (matrices here never exceed 8x8) ──
function matMulVec(A, v) {
  return A.map(row => row.reduce((s, a, j) => s + a * v[j], 0));
}
function matMulMat(A, B) {
  const n = A.length, m = B[0].length, k = B.length;
  const out = Array.from({ length: n }, () => new Array(m).fill(0));
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) {
    let s = 0;
    for (let p = 0; p < k; p++) s += A[i][p] * B[p][j];
    out[i][j] = s;
  }
  return out;
}
function transpose(A) {
  return A[0].map((_, j) => A.map(row => row[j]));
}
// Gauss-Jordan inversion with partial pivoting.
function invert(A) {
  const n = A.length;
  const M = A.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    if (Math.abs(M[pivot][col]) < 1e-12) throw new Error('Singular matrix during logistic regression fit (feature collinearity too severe) -- reduce feature set.');
    [M[col], M[pivot]] = [M[pivot], M[col]];
    const pv = M[col][col];
    for (let j = 0; j < 2 * n; j++) M[col][j] /= pv;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[col][j];
    }
  }
  return M.map(row => row.slice(n));
}

// ── Standardization (z-score each feature; intercept column left untouched) ──
function standardize(X, means, stds) {
  return X.map(row => row.map((x, j) => (j === 0 ? 1 : (x - means[j]) / stds[j])));
}
function fitStandardizer(X) {
  const nFeat = X[0].length;
  const means = new Array(nFeat).fill(0), stds = new Array(nFeat).fill(1);
  for (let j = 1; j < nFeat; j++) {
    const col = X.map(row => row[j]);
    const mean = col.reduce((a, b) => a + b, 0) / col.length;
    const variance = col.reduce((a, b) => a + (b - mean) ** 2, 0) / col.length;
    means[j] = mean;
    stds[j] = Math.sqrt(variance) || 1;
  }
  return { means, stds };
}

// IRLS (Newton-Raphson) fit of L2-regularized logistic regression.
// X rows already include a leading 1 for the intercept; intercept isn't penalized.
function fitLogistic(X, y, lambda, maxIter = 50) {
  const n = X[0].length;
  let beta = new Array(n).fill(0);
  const penalty = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j && i !== 0 ? lambda : 0)));
  for (let iter = 0; iter < maxIter; iter++) {
    const p = X.map(row => sigmoid(row.reduce((s, x, j) => s + x * beta[j], 0)));
    const W = p.map(pi => Math.max(pi * (1 - pi), 1e-6));
    // Hessian = X^T W X + penalty ; gradient = X^T (y - p) - penalty*beta
    const XtWX = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i < X.length; i++) {
      for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
        XtWX[a][b] += X[i][a] * W[i] * X[i][b];
      }
    }
    const hessian = XtWX.map((row, a) => row.map((v, b) => v + penalty[a][b]));
    const grad = new Array(n).fill(0);
    for (let i = 0; i < X.length; i++) {
      for (let a = 0; a < n; a++) grad[a] += X[i][a] * (y[i] - p[i]);
    }
    for (let a = 0; a < n; a++) grad[a] -= penalty[a].reduce((s, v, b) => s + v * beta[b], 0);
    const step = matMulVec(invert(hessian), grad);
    let maxDelta = 0;
    for (let a = 0; a < n; a++) { beta[a] += step[a]; maxDelta = Math.max(maxDelta, Math.abs(step[a])); }
    if (maxDelta < 1e-8) break;
  }
  return beta;
}

function predict(X, beta) {
  return X.map(row => sigmoid(row.reduce((s, x, j) => s + x * beta[j], 0)));
}

// ── Honest performance metrics ──
function logLoss(y, p) {
  let s = 0;
  for (let i = 0; i < y.length; i++) {
    const pi = Math.min(Math.max(p[i], 1e-9), 1 - 1e-9);
    s += y[i] === 1 ? -Math.log(pi) : -Math.log(1 - pi);
  }
  return s / y.length;
}
function brierScore(y, p) {
  let s = 0;
  for (let i = 0; i < y.length; i++) s += (p[i] - y[i]) ** 2;
  return s / y.length;
}
// AUC via rank-sum (Mann-Whitney U) -- probability a random positive outranks a random negative.
function auc(y, p) {
  const paired = y.map((yi, i) => ({ y: yi, p: p[i] }));
  paired.sort((a, b) => a.p - b.p);
  let rankSum = 0, rank = 1;
  for (let i = 0; i < paired.length; i++) {
    // average ranks for ties
    let j = i;
    while (j + 1 < paired.length && paired[j + 1].p === paired[i].p) j++;
    const avgRank = (rank + rank + (j - i)) / 2;
    for (let k = i; k <= j; k++) paired[k].rank = avgRank;
    rank += (j - i + 1);
    i = j;
  }
  const nPos = y.filter(v => v === 1).length, nNeg = y.length - nPos;
  if (!nPos || !nNeg) return null;
  for (const row of paired) if (row.y === 1) rankSum += row.rank;
  return (rankSum - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

// Deterministic 5-fold assignment (round-robin over date-sorted rows -- fully
// reproducible across runs, no seeded-PRNG bookkeeping needed).
function assignFolds(rows, k) {
  const sorted = [...rows].sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.playerId || 0) - (b.playerId || 0));
  return sorted.map((r, i) => ({ row: r, fold: i % k }));
}

function buildFeatureRow(r) {
  return [1, r.batterISO, r.pitcherHr9, r.pitcherWhip, r.parkFactor, r.windFactor, r.temperatureFactor, r.isOnFire ? 1 : 0];
}

function crossValidate(rows, lambda) {
  const withFold = assignFolds(rows, N_FOLDS);
  const outOfFoldP = new Array(rows.length);
  const yAll = rows.map(r => (r.result === 'win' ? 1 : 0));
  for (let fold = 0; fold < N_FOLDS; fold++) {
    const trainIdx = [], testIdx = [];
    withFold.forEach((wf, i) => (wf.fold === fold ? testIdx : trainIdx).push(i));
    const Xtrain = trainIdx.map(i => buildFeatureRow(withFold[i].row));
    const ytrain = trainIdx.map(i => (withFold[i].row.result === 'win' ? 1 : 0));
    const { means, stds } = fitStandardizer(Xtrain);
    const XtrainStd = standardize(Xtrain, means, stds);
    const beta = fitLogistic(XtrainStd, ytrain, lambda);
    const Xtest = testIdx.map(i => buildFeatureRow(withFold[i].row));
    const XtestStd = standardize(Xtest, means, stds);
    const p = predict(XtestStd, beta);
    testIdx.forEach((idx, k) => { outOfFoldP[idx] = p[k]; });
  }
  return { p: outOfFoldP, y: yAll, rows: withFold.map(wf => wf.row) };
}

function bucketTable(rows, p, y) {
  const buckets = new Map();
  for (let i = 0; i < rows.length; i++) {
    const pct = Math.round(p[i] * 100);
    const label = pct < 8 ? '<8%' : pct < 12 ? '8-11%' : pct < 16 ? '12-15%' : pct < 20 ? '16-19%' : pct < 25 ? '20-24%' : '25%+';
    if (!buckets.has(label)) buckets.set(label, { n: 0, wins: 0, pSum: 0 });
    const b = buckets.get(label);
    b.n++; b.wins += y[i]; b.pSum += p[i];
  }
  const order = ['<8%', '8-11%', '12-15%', '16-19%', '20-24%', '25%+'];
  return order.filter(l => buckets.has(l)).map(l => {
    const b = buckets.get(l);
    return { bucket: l, n: b.n, hitRate: b.wins / b.n, avgPredicted: b.pSum / b.n };
  });
}

function printBucketTable(title, rows) {
  console.log(`\n${title}`);
  console.log(`  ${'Bucket'.padEnd(12)}${'N'.padStart(6)}${'Actual hit%'.padStart(14)}${'Avg predicted%'.padStart(17)}`);
  for (const r of rows) {
    console.log(`  ${r.bucket.padEnd(12)}${String(r.n).padStart(6)}${pct(r.hitRate).padStart(14)}${pct(r.avgPredicted).padStart(17)}`);
  }
}

async function main() {
  const raw = await readFile(TRACKER_PATH, 'utf8');
  const tracker = JSON.parse(raw);
  const all = tracker?.market?.hrThreat || [];
  const graded = all.filter(r => r.result === 'win' || r.result === 'loss');
  const trainable = graded.filter(r => FEATURES.every(f => f === 'isOnFire' ? typeof r[f] === 'boolean' : Number.isFinite(r[f])) && Number.isFinite(r.score));

  console.log('═'.repeat(70));
  console.log('HR PROBABILITY -- LOGISTIC REGRESSION FIT');
  console.log('═'.repeat(70));
  console.log(`Graded picks: ${graded.length}  |  Usable (full feature coverage): ${trainable.length}`);
  const wins = trainable.filter(r => r.result === 'win').length;
  console.log(`Actual hit rate in usable set: ${wins}/${trainable.length} = ${pct(wins / trainable.length)}`);
  if (trainable.length < 200) { console.log('\nToo few usable rows to fit reliably -- stopping.'); return; }

  // ── Pick lambda by cross-validated log-loss (data-driven, not guessed) ──
  console.log('\nSelecting L2 penalty (lambda) by 5-fold cross-validated log-loss:');
  let best = null;
  for (const lambda of LAMBDA_GRID) {
    const cv = crossValidate(trainable, lambda);
    const ll = logLoss(cv.y, cv.p);
    console.log(`  lambda=${lambda.toString().padStart(4)}   CV log-loss=${ll.toFixed(4)}`);
    if (!best || ll < best.ll) best = { lambda, ll, cv };
  }
  console.log(`Selected lambda=${best.lambda}`);

  const { cv } = best;
  const cvAuc = auc(cv.y, cv.p);
  const cvBrier = brierScore(cv.y, cv.p);
  const cvLogLoss = logLoss(cv.y, cv.p);

  // ── Same metrics for the CURRENT model's own score, on the identical rows,
  // so this is an apples-to-apples comparison, not against a different-sized
  // population. ──
  const currentP = trainable.map(r => r.score / 100);
  const currentY = trainable.map(r => (r.result === 'win' ? 1 : 0));
  const currentAuc = auc(currentY, currentP);
  const currentBrier = brierScore(currentY, currentP);
  const currentLogLoss = logLoss(currentY, currentP);

  console.log('\nHeld-out (cross-validated) performance, new model vs. current formula, same rows:');
  console.log(`  ${'Metric'.padEnd(22)}${'New (logistic)'.padStart(18)}${'Current formula'.padStart(18)}`);
  console.log(`  ${'AUC (higher better)'.padEnd(22)}${(cvAuc == null ? 'n/a' : cvAuc.toFixed(3)).padStart(18)}${(currentAuc == null ? 'n/a' : currentAuc.toFixed(3)).padStart(18)}`);
  console.log(`  ${'Brier (lower better)'.padEnd(22)}${cvBrier.toFixed(4).padStart(18)}${currentBrier.toFixed(4).padStart(18)}`);
  console.log(`  ${'Log-loss (lower better)'.padEnd(22)}${cvLogLoss.toFixed(4).padStart(18)}${currentLogLoss.toFixed(4).padStart(18)}`);

  printBucketTable('New model (cross-validated, out-of-fold predictions):', bucketTable(cv.rows, cv.p, cv.y));
  printBucketTable('Current formula (same rows, its own live "score" field):', bucketTable(trainable, currentP, currentY));

  // ── Full-data fit (for persisting/reviewing coefficients -- NOT used for the
  // cross-validated numbers above, which only ever score a fold on a model
  // that never saw it). ──
  const Xfull = trainable.map(buildFeatureRow);
  const yfull = trainable.map(r => (r.result === 'win' ? 1 : 0));
  const { means, stds } = fitStandardizer(Xfull);
  const XfullStd = standardize(Xfull, means, stds);
  const betaFull = fitLogistic(XfullStd, yfull, best.lambda);

  console.log('\nFull-data fitted coefficients (on standardized features; sign/magnitude show direction and relative importance, not raw units):');
  const featureNames = ['intercept', ...FEATURES];
  featureNames.forEach((name, i) => console.log(`  ${name.padEnd(20)}${betaFull[i].toFixed(4)}`));

  const model = {
    generatedAt: new Date().toISOString(),
    features: FEATURES,
    lambda: best.lambda,
    coefficients: Object.fromEntries(featureNames.map((name, i) => [name, betaFull[i]])),
    featureMeans: Object.fromEntries(FEATURES.map((f, i) => [f, means[i + 1]])),
    featureStds: Object.fromEntries(FEATURES.map((f, i) => [f, stds[i + 1]])),
    training: { n: trainable.length, wins, hitRate: wins / trainable.length },
    crossValidated: { nFolds: N_FOLDS, auc: cvAuc, brier: cvBrier, logLoss: cvLogLoss },
    comparisonToCurrentFormula: { auc: currentAuc, brier: currentBrier, logLoss: currentLogLoss },
    note: 'Fitted and reported only -- not wired into live scoring anywhere. See this script\'s file header.',
  };
  await writeFile(MODEL_PATH, JSON.stringify(model, null, 2) + '\n');
  console.log(`\nWrote fitted model to ${path.relative(path.join(__dirname, '..'), MODEL_PATH)} (report/reference only, not live).`);
}

main().catch(e => { console.error(e); process.exit(1); });
