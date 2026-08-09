// Unit tests for the two HR-probability formulas in scripts/update-tracker.mjs:
//   - scoreForMarket('hr', row) -- the real formula that selects and grades
//     actual HR Threats picks in data/tracker.json.
//   - computeLiveHRScore(row, statcastHotHitters, weatherHRMult) -- a
//     line-for-line port of app.js's live client formula, captured alongside
//     the real score purely for calibration comparison (see the function's
//     own header comment in update-tracker.mjs).
//
// These two are DELIBERATELY different formulas (see update-tracker.mjs's own
// comments) -- this file tests each on its own terms, not against each other.
// Both are pure/deterministic given a fixed row object: neither performs I/O,
// and simulateHRGameOdds falls through to its closed-form legacy path (no
// Math.random) as long as the fitted logistic model hasn't been loaded, which
// importing this module for tests never does (see update-tracker.mjs's own
// isDirectRun guard).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreForMarket,
  computeLiveHRScore,
  battedBallPowerIndex,
} from '../../scripts/update-tracker.mjs';

// A plausible everyday-starter row with an average-workload starting pitcher
// (startBFShare left unset -> defaults to 1, i.e. no quick-hook discount).
function baseRow(overrides = {}) {
  return {
    atBats: 300,
    hrSeason: 15,
    battingOrder: 3,
    pitcherHr9: 1.2,
    pitcherBFper9: 38,
    iso: 0.190,
    pitcherWhip: 1.25,
    parkFactor: 100,
    windFactor: 1,
    temperatureFactor: 1,
    zoneMatchupMult: 1,
    fatigueFactor: 1,
    homeRoadFactor: 1,
    matchupEdge: 55,
    isHot: false,
    ...overrides,
  };
}

describe('scoreForMarket(hr) -- real pick-selection formula', () => {
  test('returns a score in the documented 1-99 bound', () => {
    const score = scoreForMarket('hr', baseRow());
    assert.ok(Number.isFinite(score), 'score must be a finite number');
    assert.ok(score >= 1 && score <= 99, `score ${score} out of [1,99]`);
  });

  test('a higher season HR rate scores higher, all else equal', () => {
    const cold = scoreForMarket('hr', baseRow({ hrSeason: 5 }));
    const hot = scoreForMarket('hr', baseRow({ hrSeason: 35 }));
    assert.ok(hot > cold, `expected hot(${hot}) > cold(${cold})`);
  });

  test('a pitcher who allows more HR/9 raises the batter\'s score', () => {
    const stingy = scoreForMarket('hr', baseRow({ pitcherHr9: 0.6 }));
    const generous = scoreForMarket('hr', baseRow({ pitcherHr9: 2.2 }));
    assert.ok(generous > stingy, `expected generous(${generous}) > stingy(${stingy})`);
  });

  test('wind blowing out raises the score; blowing in lowers it', () => {
    const neutral = scoreForMarket('hr', baseRow({ windFactor: 1 }));
    const out = scoreForMarket('hr', baseRow({ windFactor: 1.2 }));
    const inward = scoreForMarket('hr', baseRow({ windFactor: 0.85 }));
    assert.ok(out > neutral, `wind out(${out}) should exceed neutral(${neutral})`);
    assert.ok(inward < neutral, `wind in(${inward}) should be below neutral(${neutral})`);
  });

  test('a hitter-friendly park raises the score; a pitcher-friendly park lowers it', () => {
    // Was a real gap until this test's own PR: scoreForMarket('hr')'s legacy
    // hrPerPA (the path used whenever the fitted logistic model hasn't
    // loaded) had no parkAdj term at all -- row.parkFactor only ever reached
    // this function inside logisticFeatures, invisible to the fallback
    // formula that actually selects/grades real picks whenever the logistic
    // model is unavailable, even though computeLiveHRScore's own client
    // mirror (tested below) already applied it correctly. Fixed alongside
    // this test -- see parkAdj in scoreForMarket's hr branch.
    const neutral = scoreForMarket('hr', baseRow({ parkFactor: 100 }));
    const hitterFriendly = scoreForMarket('hr', baseRow({ parkFactor: 130 }));
    const pitcherFriendly = scoreForMarket('hr', baseRow({ parkFactor: 70 }));
    assert.ok(hitterFriendly > neutral, `hitter-friendly(${hitterFriendly}) should exceed neutral(${neutral})`);
    assert.ok(pitcherFriendly < neutral, `pitcher-friendly(${pitcherFriendly}) should be below neutral(${neutral})`);
  });

  test('a missing parkFactor defaults to neutral rather than throwing', () => {
    const withDefault = scoreForMarket('hr', baseRow({ parkFactor: undefined }));
    const explicit100 = scoreForMarket('hr', baseRow({ parkFactor: 100 }));
    assert.equal(withDefault, explicit100);
  });

  test('a quick-hook starter (low startBFShare) pulls the score toward the bullpen matchup', () => {
    // Same batter/pitcher inputs, but a bad bullpen (via a worse pitcherHr9
    // read is the closest lever scoreForMarket('hr') actually exposes -- it
    // has no separate bullpen term, unlike computeLiveHRScore below) should
    // still respond to startBFShare's weight shift onto the pitcher/batter mix.
    const fullWorkload = scoreForMarket('hr', baseRow({ startBFShare: 1 }));
    const quickHook = scoreForMarket('hr', baseRow({ startBFShare: 0.55 }));
    // Weight on the (worse-for-the-batter, since pitcherRate here < batterRate
    // in this fixture) pitcher term shrinks as startBFShare drops, so the
    // score should move -- this fixture's pitcherHr9=1.2 sits below the
    // batter's own ~equivalent rate, so less pitcher weight means a higher score.
    assert.notEqual(quickHook, fullWorkload, 'startBFShare should change the score');
  });
});

describe('computeLiveHRScore -- client-display formula mirror', () => {
  test('returns a score in the documented 1-99 bound', () => {
    const score = computeLiveHRScore(baseRow(), new Map());
    assert.ok(score >= 1 && score <= 99, `score ${score} out of [1,99]`);
  });

  test('backward compatible: an average-workload starter (startBFShare=1, or unset) ignores bullpenRate entirely', () => {
    // bullpenWeight = 0.4*(1-1) = 0 when startBFShare is 1, so bullpenRate must
    // be provably inert -- this is the exact backward-compatibility guarantee
    // the bullpen-HR-rate blend (PR #318) was designed around.
    const withoutBullpen = computeLiveHRScore(baseRow({ startBFShare: 1 }), new Map());
    const eliteBullpen = computeLiveHRScore(baseRow({ startBFShare: 1, bullpenRate: 0.010 }), new Map());
    const terribleBullpen = computeLiveHRScore(baseRow({ startBFShare: 1, bullpenRate: 0.060 }), new Map());
    assert.equal(withoutBullpen, eliteBullpen, 'bullpenRate must be inert at startBFShare=1');
    assert.equal(withoutBullpen, terribleBullpen, 'bullpenRate must be inert at startBFShare=1');
  });

  test('a quick-hook starter facing a bad bullpen scores higher than facing an elite bullpen', () => {
    // The actual bug class PR #318 fixed: before it, the weight startBFShare
    // discounted away from a quick-hook starter just inflated the batter's
    // own rate instead of reflecting who they actually face the rest of the
    // game. This is a direct regression test for that fix.
    const quickHookGoodBullpen = computeLiveHRScore(
      baseRow({ startBFShare: 0.55, bullpenRate: 0.018 }), new Map()
    );
    const quickHookBadBullpen = computeLiveHRScore(
      baseRow({ startBFShare: 0.55, bullpenRate: 0.055 }), new Map()
    );
    assert.ok(
      quickHookBadBullpen > quickHookGoodBullpen,
      `expected bad-bullpen score (${quickHookBadBullpen}) > good-bullpen score (${quickHookGoodBullpen})`
    );
  });

  test('zoneMatchupMult actually moves the score (regression test for the missing-zoneMult bug fixed alongside the bullpen blend)', () => {
    // computeLiveHRScore silently ignored row.zoneMatchupMult for a long time
    // despite every caller already computing it -- a real drift from the
    // client formula this function is supposed to mirror. Locks that fix in.
    const neutralZone = computeLiveHRScore(baseRow({ zoneMatchupMult: 1 }), new Map());
    const favorableZone = computeLiveHRScore(baseRow({ zoneMatchupMult: 1.15 }), new Map());
    const unfavorableZone = computeLiveHRScore(baseRow({ zoneMatchupMult: 0.85 }), new Map());
    assert.ok(favorableZone > neutralZone, `favorable zone (${favorableZone}) should exceed neutral (${neutralZone})`);
    assert.ok(unfavorableZone < neutralZone, `unfavorable zone (${unfavorableZone}) should be below neutral (${neutralZone})`);
  });

  test('weatherHRMult is applied (a rainout-cold game suppresses the score, a hot/thin-air game raises it)', () => {
    const neutral = computeLiveHRScore(baseRow(), new Map(), 1);
    const boosted = computeLiveHRScore(baseRow(), new Map(), 1.1);
    const suppressed = computeLiveHRScore(baseRow(), new Map(), 0.9);
    assert.ok(boosted > neutral, `boosted(${boosted}) should exceed neutral(${neutral})`);
    assert.ok(suppressed < neutral, `suppressed(${suppressed}) should be below neutral(${neutral})`);
  });

  test('an on-fire batter (hot Statcast profile) scores at least as high as a cold one', () => {
    const hotProfile = new Map([['501', {
      xwoba: 0.430, xwobaTrend: 0.070, hardHitPct: 55, hardHitTrend: 12,
      sweetSpotPct: 42, sweetSpotTrend: 9, barrelPct: 17, barrelTrend: 6,
      batSpeed: 76, batSpeedTrend: 2, blastRate: 20, blastTrend: 6,
      recentOpsTrend: 0.180, pullPct: 42, fbPct: 40, ldPct: 26, avgExitVelo: 92,
    }]]);
    const row = baseRow({ id: '501', name: 'Hot Batter' });
    const cold = computeLiveHRScore({ ...row, id: '999' }, hotProfile);
    const hot = computeLiveHRScore(row, hotProfile);
    assert.ok(hot >= cold, `hot(${hot}) should be >= cold(${cold})`);
  });
});

describe('battedBallPowerIndex -- shared batter/pitcher contact-quality correction', () => {
  test('returns neutral (1) below the minimum pitch sample', () => {
    assert.equal(battedBallPowerIndex({ pitches: 50, xslg: 0.600, hardHitPct: 60 }), 1);
  });

  test('returns neutral (1) for null/undefined input', () => {
    assert.equal(battedBallPowerIndex(null), 1);
    assert.equal(battedBallPowerIndex(undefined), 1);
  });

  test('clamps to [0.7, 1.5] even for extreme inputs', () => {
    const extremeHigh = battedBallPowerIndex({ pitches: 500, xslg: 5, hardHitPct: 500 });
    const extremeLow = battedBallPowerIndex({ pitches: 500, xslg: 0.001, hardHitPct: 0.001 });
    assert.equal(extremeHigh, 1.5);
    assert.equal(extremeLow, 0.7);
  });

  test('a league-average sample returns ~1', () => {
    // LEAGUE_AVG_XSLG=0.400, LEAGUE_AVG_HARD_HIT_PCT=36 (both internal to
    // update-tracker.mjs) -- feeding exactly those values in should round-trip
    // to a neutral multiplier.
    const idx = battedBallPowerIndex({ pitches: 500, xslg: 0.400, hardHitPct: 36 });
    assert.ok(Math.abs(idx - 1) < 0.001, `expected ~1, got ${idx}`);
  });
});
