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
// IMPORTANT: app.js/update-tracker.mjs's predictHRLogistic ALREADY reads
// data/hr-logistic-model.json live (this stopped being report-only once that
// wiring shipped) -- running this script with --write and committing the
// result changes production scoring immediately, the same "measure, then a
// deliberate commit ships it" discipline as tune-model-params.mjs. Review the
// cross-validated numbers below against the CURRENTLY LIVE model's own
// comparisonToCurrentFormula block before deciding to replace it.
//
// Feature selection: restricted to real fields with strong coverage across
// the graded population. batterISO/pitcherHr9/pitcherWhip/park/wind/temperature
// factors/isOnFire co-occur on ~758/1213 graded rows; matchupEdge (added here)
// separately co-occurs with all of those on 590/1213 -- verified via
// scripts/analyze-hr-matchups.mjs's day-by-day capture coverage before adding
// it: matchupEdge has run at 92-100% real coverage on every day since it was
// added (2026-07-27), so its historical thinness is purely "field didn't
// exist yet before then," not an ongoing gap. zoneFitScore is still left out
// -- despite similarly good day-by-day coverage since 2026-08-01, intersected
// with every OTHER feature here it only reaches 193 graded rows (27 wins),
// too thin to add a 9th predictor reliably; revisit once that catches up.
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

const FEATURES = ['batterISO', 'pitcherHr9', 'pitcherWhip', 'parkFactor', 'windFactor', 'temperatureFactor', 'isOnFire', 'matchupEdge'];
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

// features param lets this build a reduced row for the ablation study below --
// defaults to the full FEATURES list so every existing call site (main model fit)
// is unaffected.
function buildFeatureRow(r, features = FEATURES) {
  return [1, ...features.map(f => (f === 'isOnFire' ? (r.isOnFire ? 1 : 0) : r[f]))];
}

function crossValidate(rows, lambda, features = FEATURES) {
  const withFold = assignFolds(rows, N_FOLDS);
  const outOfFoldP = new Array(rows.length);
  const yAll = rows.map(r => (r.result === 'win' ? 1 : 0));
  for (let fold = 0; fold < N_FOLDS; fold++) {
    const trainIdx = [], testIdx = [];
    withFold.forEach((wf, i) => (wf.fold === fold ? testIdx : trainIdx).push(i));
    const Xtrain = trainIdx.map(i => buildFeatureRow(withFold[i].row, features));
    const ytrain = trainIdx.map(i => (withFold[i].row.result === 'win' ? 1 : 0));
    const { means, stds } = fitStandardizer(Xtrain);
    const XtrainStd = standardize(Xtrain, means, stds);
    const beta = fitLogistic(XtrainStd, ytrain, lambda);
    const Xtest = testIdx.map(i => buildFeatureRow(withFold[i].row, features));
    const XtestStd = standardize(Xtest, means, stds);
    const p = predict(XtestStd, beta);
    testIdx.forEach((idx, k) => { outOfFoldP[idx] = p[k]; });
  }
  return { p: outOfFoldP, y: yAll, rows: withFold.map(wf => wf.row) };
}

// Picks lambda by the same CV-log-loss grid search main() uses for the full model,
// just reusable for an arbitrary feature subset -- the ablation study below needs
// this per reduced feature set since a smaller model may legitimately want a
// different regularization strength, not just the full model's own lambda reused.
function selectLambda(rows, features) {
  let best = null;
  for (const lambda of LAMBDA_GRID) {
    const cv = crossValidate(rows, lambda, features);
    const ll = logLoss(cv.y, cv.p);
    if (!best || ll < best.ll) best = { lambda, ll, cv };
  }
  return best;
}

// ── Leave-one-out feature ablation ──────────────────────────────────────────
// Same idea as the "accuracy of model trained without feature" table in
// https://lucaspauker.com/articles/home-run-modeling/ -- a fitted coefficient's
// sign/magnitude alone doesn't say whether a feature is pulling real weight or
// just correlating with something else already in the model; refitting WITHOUT
// it and checking whether cross-validated performance actually drops is the
// direct test. For each feature, drops it, re-selects lambda for that reduced
// set (see selectLambda's own comment), and reports the CV metric deltas versus
// the full model -- a feature whose removal barely moves AUC/log-loss is a
// candidate to drop entirely next time FEATURES is revisited, the same
// "measure before deciding" discipline this script already applies to
// lambda/lineup-vs-legacy-formula comparisons above.
function runFeatureAblation(trainable, fullAuc, fullBrier, fullLogLoss) {
  return FEATURES.map(dropped => {
    const reduced = FEATURES.filter(f => f !== dropped);
    const { lambda, cv } = selectLambda(trainable, reduced);
    const withoutAuc = auc(cv.y, cv.p);
    const withoutBrier = brierScore(cv.y, cv.p);
    const withoutLogLoss = logLoss(cv.y, cv.p);
    return {
      feature: dropped,
      lambda,
      aucWithout: withoutAuc,
      // Positive deltaAuc = removing this feature HURT the model (feature is real
      // signal); negative or ~0 = the model did fine without it.
      deltaAuc: (fullAuc == null || withoutAuc == null) ? null : fullAuc - withoutAuc,
      brierWithout: withoutBrier,
      deltaBrier: withoutBrier - fullBrier, // positive = worse (Brier is lower-is-better)
      logLossWithout: withoutLogLoss,
      deltaLogLoss: withoutLogLoss - fullLogLoss, // positive = worse
    };
  }).sort((a, b) => (b.deltaAuc ?? -Infinity) - (a.deltaAuc ?? -Infinity));
}

function printAblationTable(rows) {
  console.log('\nFeature ablation (leave-one-out, cross-validated -- see this file\'s header comment):');
  console.log('Positive ΔAUC/ΔLog-loss = removing that feature made the model WORSE (real signal). Near-zero or negative = the model did fine without it.');
  console.log(`  ${'Feature'.padEnd(20)}${'AUC w/o'.padStart(10)}${'ΔAUC'.padStart(9)}${'ΔLog-loss'.padStart(12)}${'ΔBrier'.padStart(10)}`);
  for (const r of rows) {
    const aucStr = r.aucWithout == null ? 'n/a' : r.aucWithout.toFixed(3);
    const dAucStr = r.deltaAuc == null ? 'n/a' : (r.deltaAuc >= 0 ? '+' : '') + r.deltaAuc.toFixed(3);
    const dLlStr = (r.deltaLogLoss >= 0 ? '+' : '') + r.deltaLogLoss.toFixed(4);
    const dBrStr = (r.deltaBrier >= 0 ? '+' : '') + r.deltaBrier.toFixed(4);
    console.log(`  ${r.feature.padEnd(20)}${aucStr.padStart(10)}${dAucStr.padStart(9)}${dLlStr.padStart(12)}${dBrStr.padStart(10)}`);
  }
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

  // ── Same metrics for the CURRENT model's own score, on the identical rows --
  // apples-to-apples, not a different-sized population. Excludes any row whose
  // score ALREADY came from a live logistic model (hrScoreSource === 'logistic'
  // -- see update-tracker.mjs), so a refit never ends up comparing a new model
  // against a baseline partly produced by an earlier version of itself. A
  // no-op today (no captured row has hrScoreSource yet), but real protection
  // once picks start accumulating under the now-live wiring. ──
  const legacyOnly = trainable.filter(r => r.hrScoreSource !== 'logistic');
  const currentP = legacyOnly.map(r => r.score / 100);
  const currentY = legacyOnly.map(r => (r.result === 'win' ? 1 : 0));
  const currentAuc = auc(currentY, currentP);
  const currentBrier = brierScore(currentY, currentP);
  const currentLogLoss = logLoss(currentY, currentP);

  console.log(`\nHeld-out (cross-validated) performance -- new model (n=${trainable.length}) vs. current formula (n=${legacyOnly.length}${legacyOnly.length !== trainable.length ? ', excludes rows already scored by a live logistic model' : ''}):`);
  console.log(`  ${'Metric'.padEnd(22)}${'New (logistic)'.padStart(18)}${'Current formula'.padStart(18)}`);
  console.log(`  ${'AUC (higher better)'.padEnd(22)}${(cvAuc == null ? 'n/a' : cvAuc.toFixed(3)).padStart(18)}${(currentAuc == null ? 'n/a' : currentAuc.toFixed(3)).padStart(18)}`);
  console.log(`  ${'Brier (lower better)'.padEnd(22)}${cvBrier.toFixed(4).padStart(18)}${currentBrier.toFixed(4).padStart(18)}`);
  console.log(`  ${'Log-loss (lower better)'.padEnd(22)}${cvLogLoss.toFixed(4).padStart(18)}${currentLogLoss.toFixed(4).padStart(18)}`);

  printBucketTable('New model (cross-validated, out-of-fold predictions):', bucketTable(cv.rows, cv.p, cv.y));
  printBucketTable('Current formula (its own live "score" field):', bucketTable(legacyOnly, currentP, currentY));

  const ablation = runFeatureAblation(trainable, cvAuc, cvBrier, cvLogLoss);
  printAblationTable(ablation);

  // ── Full-data fit (for persisting/reviewing coefficients -- NOT used for the
  // cross-validated numbers above, which only ever score a fold on a model
  // that never saw it). ──
  const Xfull = trainable.map(r => buildFeatureRow(r));
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
    comparisonToCurrentFormula: { auc: currentAuc, brier: currentBrier, logLoss: currentLogLoss, n: legacyOnly.length },
    // Leave-one-out feature ablation (see runFeatureAblation's header comment) --
    // persisted alongside the fit itself, not just printed, so the next person
    // revisiting FEATURES can check which predictors are actually earning their
    // place without re-running this script. deltaAuc close to 0 or negative for a
    // feature means the model performed just as well (or better) without it.
    featureAblation: ablation,
    note: 'app.js/update-tracker.mjs read this file live for HR probability scoring -- see predictHRLogistic in both. Not a report-only artifact.',
  };

  // --write is required to actually overwrite the LIVE model file (see this
  // script's IMPORTANT header comment) -- default is report-only, printing
  // what a refit would look like without touching production scoring. Same
  // "measure first, a deliberate step ships it" gate as tune-model-params.mjs,
  // just manual here rather than significance-tested, since a refit changing
  // which predictors exist isn't the kind of thing that should auto-apply.
  if (!process.argv.includes('--write')) {
    console.log('\n(dry run -- pass --write to overwrite data/hr-logistic-model.json with this fit)');
    return;
  }
  await writeFile(MODEL_PATH, JSON.stringify(model, null, 2) + '\n');
  console.log(`\nWrote fitted model to ${path.relative(path.join(__dirname, '..'), MODEL_PATH)} -- this is now what live HR scoring uses.`);
}

main().catch(e => { console.error(e); process.exit(1); });
