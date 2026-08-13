// Unit tests for the Monte Carlo-based markets (Hits/TB/RBI/HR+RBI via
// simulatePropOdds, stolen base via simulateSBOdds). Unlike hr-formula.test.mjs's
// closed-form HR path, these genuinely call Math.random() (MC_TRIALS=3000
// trials per call), so exact-value assertions would be flaky by construction.
// Every assertion here instead checks bounds and DIRECTION (a clearly-better
// hitter scores clearly higher), using tolerance wide enough that normal
// Monte Carlo noise can never flip the result -- at MC_TRIALS=3000 the
// standard error of a proportion is under ~1 percentage point, far smaller
// than the deliberately large gaps these fixtures create.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { simulatePropOdds, simulateSBOdds, scoreForMarket } from '../../scripts/update-tracker.mjs';

function baseRow(overrides = {}) {
  return {
    avg: 0.270, obp: 0.335, slg: 0.440,
    atBats: 300, hrSeason: 15, battingOrder: 3,
    pitcherAvgAllowed: 0.250, pitcherSlgAllowed: 0.410,
    parkFactor: 100,
    ...overrides,
  };
}

describe('simulatePropOdds', () => {
  for (const market of ['hits', 'tb', 'hr', 'rbis', 'hrrbi']) {
    test(`${market}: returns a score in the documented 1-99 bound`, () => {
      const score = simulatePropOdds(market, baseRow());
      assert.ok(Number.isInteger(score), `expected an integer score, got ${score}`);
      assert.ok(score >= 1 && score <= 99, `${market} score ${score} out of [1,99]`);
    });

    test(`${market}: a clearly elite hitter scores well above a clearly weak one`, () => {
      const weak = baseRow({ avg: 0.190, obp: 0.230, slg: 0.280, hrSeason: 2 });
      const elite = baseRow({ avg: 0.330, obp: 0.410, slg: 0.620, hrSeason: 40 });
      const weakScore = simulatePropOdds(market, weak);
      const eliteScore = simulatePropOdds(market, elite);
      assert.ok(
        eliteScore > weakScore + 10,
        `${market}: expected elite(${eliteScore}) to clearly exceed weak(${weakScore})`
      );
    });
  }

  test('hits: a leadoff hitter (more PA) scores at least as well as a 9-hole hitter, all else equal', () => {
    const leadoff = simulatePropOdds('hits', baseRow({ battingOrder: 1 }));
    const ninth = simulatePropOdds('hits', baseRow({ battingOrder: 9 }));
    assert.ok(leadoff >= ninth - 10, `leadoff(${leadoff}) should not trail ninth(${ninth}) by more than noise`);
  });
});

describe('simulateSBOdds', () => {
  test('returns a score in the documented 1-99 bound', () => {
    const score = simulateSBOdds({ stolenBases: 20, caughtStealing: 5, atBats: 400 });
    assert.ok(score >= 1 && score <= 99, `score ${score} out of [1,99]`);
  });

  test('a real base-stealing threat scores well above a station-to-station hitter', () => {
    const burner = simulateSBOdds({ stolenBases: 45, caughtStealing: 6, atBats: 500 });
    const stationary = simulateSBOdds({ stolenBases: 0, caughtStealing: 0, atBats: 500 });
    assert.ok(
      burner > stationary + 10,
      `expected burner(${burner}) to clearly exceed stationary(${stationary})`
    );
  });

  // batterySuppression's formula in update-tracker.mjs/app.js is
  // `1 + (pitcherSbAllowed/pAtt - 0.72) * 0.6` -- this test previously
  // documented that formula as `1 - (...)`, an inverted sign under which a
  // battery good at throwing runners out (a LOW success-rate-allowed) would
  // have boosted predicted attempts instead of suppressing them, backwards
  // from real base-stealing strategy. That's since been fixed to the `1 +`
  // form on the live formula; this test now verifies the CORRECT direction
  // holds (a strong battery suppresses predicted attempts, a leaky one
  // encourages them) instead of pinning the old inverted behavior.
  test('batterySuppression: a battery good at throwing runners out scores lower than a leaky one', () => {
    const goodDefense = simulateSBOdds({
      stolenBases: 15, caughtStealing: 3, atBats: 400,
      pitcherSbAllowed: 2, pitcherCsAllowed: 10, // ~17% success rate allowed -- a strong battery
    });
    const leakyDefense = simulateSBOdds({
      stolenBases: 15, caughtStealing: 3, atBats: 400,
      pitcherSbAllowed: 20, pitcherCsAllowed: 2, // ~91% success rate allowed -- a weak battery
    });
    assert.ok(
      goodDefense < leakyDefense,
      `expected a strong battery(${goodDefense}) to suppress predicted attempts below a leaky one(${leakyDefense})`
    );
  });

  test('zero season attempts is a low but non-zero score, never a throw', () => {
    const score = simulateSBOdds({ stolenBases: 0, caughtStealing: 0, atBats: 0 });
    assert.ok(score >= 1 && score <= 99);
  });
});

describe('scoreForMarket dispatch', () => {
  test('routes "sb" to simulateSBOdds and any other key to simulatePropOdds, both in bounds', () => {
    const row = { ...baseRow(), stolenBases: 10, caughtStealing: 3 };
    for (const market of ['sb', 'hits', 'tb', 'rbis', 'hrrbi']) {
      const score = scoreForMarket(market, row);
      assert.ok(score >= 1 && score <= 99, `${market} via scoreForMarket: ${score} out of [1,99]`);
    }
  });
});
