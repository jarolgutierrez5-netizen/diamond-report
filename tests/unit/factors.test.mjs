// Unit tests for the small, independent adjustment factors scripts/update-tracker.mjs
// exports -- each is a pure function of its inputs (no I/O), applied via
// shrinkMult() as a multiplier onto one of the market formulas in
// hr-formula.test.mjs. Tested in isolation here since a bug in any one of
// these (e.g. a wind-direction regex not matching a real MLB API string) would
// otherwise only surface as an unexplained score drift, not a clear failure.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  windPowerFactor,
  temperaturePowerFactor,
  isDayGameCT,
  doubleheaderFatigueFactor,
  zoneMatchupMultiplier,
  homeRoadPowerFactor,
  log5,
  shrinkMult,
  calibrateHRProb,
  computeIsHot,
} from '../../scripts/update-tracker.mjs';

describe('windPowerFactor', () => {
  test('no wind data -> neutral', () => {
    assert.equal(windPowerFactor(undefined), 1);
    assert.equal(windPowerFactor({}), 1);
    assert.equal(windPowerFactor({ wind: '' }), 1);
  });
  test('"Calm"/"Varies" (no mph, or no direction) -> neutral', () => {
    assert.equal(windPowerFactor({ wind: 'Calm' }), 1);
    assert.equal(windPowerFactor({ wind: 'Varies' }), 1);
  });
  test('blowing out boosts above 1, scaling with speed', () => {
    const light = windPowerFactor({ wind: '5 mph, Out To CF' });
    const strong = windPowerFactor({ wind: '18 mph, Out To LF' });
    assert.ok(light > 1, `light out-wind (${light}) should boost`);
    assert.ok(strong > light, `stronger wind (${strong}) should boost more than light (${light})`);
    assert.ok(strong <= 1.25, `must respect the documented +25% ceiling, got ${strong}`);
  });
  test('blowing in suppresses below 1, scaling with speed, floored at -20%', () => {
    const light = windPowerFactor({ wind: '5 mph, In From RF' });
    const strong = windPowerFactor({ wind: '25 mph, In From CF' });
    assert.ok(light < 1, `light in-wind (${light}) should suppress`);
    assert.ok(strong < light, `stronger in-wind (${strong}) should suppress more than light (${light})`);
    assert.ok(strong >= 0.80, `must respect the documented -20% floor, got ${strong}`);
  });
  test('a crosswind (no clear in/out) is neutral', () => {
    assert.equal(windPowerFactor({ wind: '10 mph, L To R' }), 1);
  });
});

describe('temperaturePowerFactor', () => {
  test('missing temp -> neutral', () => {
    assert.equal(temperaturePowerFactor(undefined), 1);
    assert.equal(temperaturePowerFactor({}), 1);
    assert.equal(temperaturePowerFactor({ temp: '' }), 1);
  });
  test('non-numeric ("roof closed"/dome) -> neutral', () => {
    assert.equal(temperaturePowerFactor({ temp: 'roof closed' }), 1);
  });
  test('reference temp (70F) -> neutral', () => {
    assert.equal(temperaturePowerFactor({ temp: 70 }), 1);
    assert.equal(temperaturePowerFactor({ temp: '70' }), 1);
  });
  test('hotter than reference boosts, colder suppresses, symmetric around 70F', () => {
    const hot = temperaturePowerFactor({ temp: 90 });
    const cold = temperaturePowerFactor({ temp: 50 });
    assert.ok(hot > 1, `90F (${hot}) should boost`);
    assert.ok(cold < 1, `50F (${cold}) should suppress`);
    assert.ok(Math.abs((hot - 1) - (1 - cold)) < 1e-9, 'should be symmetric around the 70F reference');
  });
  test('extreme readings are clamped to the documented +/-30F delta', () => {
    const extremeHot = temperaturePowerFactor({ temp: 140 });
    const cappedHot = temperaturePowerFactor({ temp: 100 });
    assert.equal(extremeHot, cappedHot, 'anything past 100F should clamp the same as exactly 100F');
  });
});

describe('isDayGameCT', () => {
  test('a 1pm CT start is a day game', () => {
    assert.equal(isDayGameCT('2026-07-15T18:00:00Z'), true); // 18:00 UTC = 13:00 CDT
  });
  test('a 7pm CT start is not a day game', () => {
    assert.equal(isDayGameCT('2026-07-15T00:00:00Z'), false); // 00:00 UTC = 19:00 CDT prior day
  });
});

describe('doubleheaderFatigueFactor', () => {
  test('game 2 of a real doubleheader applies the documented -6% penalty', () => {
    assert.equal(doubleheaderFatigueFactor({ doubleHeader: 'Y', gameNumber: 2 }), 0.94);
  });
  test('game 1 of a doubleheader is neutral', () => {
    assert.equal(doubleheaderFatigueFactor({ doubleHeader: 'Y', gameNumber: 1 }), 1);
  });
  test('a normal single game (doubleHeader: "N") is neutral', () => {
    assert.equal(doubleheaderFatigueFactor({ doubleHeader: 'N', gameNumber: 1 }), 1);
  });
  test('missing/undefined game data is neutral, not a throw', () => {
    assert.equal(doubleheaderFatigueFactor(undefined), 1);
    assert.equal(doubleheaderFatigueFactor({}), 1);
  });
});

describe('zoneMatchupMultiplier', () => {
  test('missing either zone map -> neutral', () => {
    assert.equal(zoneMatchupMultiplier(null, { 1: {} }), 1);
    assert.equal(zoneMatchupMultiplier({ 1: {} }, null), 1);
  });
  test('below the minimum shared-zone overlap -> neutral', () => {
    // Only 2 zones overlap, below MIN_ZONE_OVERLAP (4).
    const b = { 1: { woba: 0.400 }, 2: { woba: 0.400 } };
    const p = { 1: { woba: 0.400 }, 2: { woba: 0.400 } };
    assert.equal(zoneMatchupMultiplier(b, p), 1);
  });
  test('enough overlap with above-average wOBA both sides boosts above 1, clamped to 1.15', () => {
    const hotZone = { woba: 0.500 };
    const b = { 1: hotZone, 2: hotZone, 3: hotZone, 4: hotZone, 5: hotZone };
    const p = { 1: hotZone, 2: hotZone, 3: hotZone, 4: hotZone, 5: hotZone };
    const result = zoneMatchupMultiplier(b, p);
    assert.ok(result > 1, `expected a boost, got ${result}`);
    assert.ok(result <= 1.15, `must respect the documented 1.15 ceiling, got ${result}`);
  });
});

describe('homeRoadPowerFactor', () => {
  test('missing split data -> neutral', () => {
    assert.equal(homeRoadPowerFactor(null, 0.450), 1);
    assert.equal(homeRoadPowerFactor({ slg: null }, 0.450), 1);
    assert.equal(homeRoadPowerFactor({ slg: 0.450 }, 0), 1);
  });
  test('a split SLG above the season baseline boosts, clamped to 1.20', () => {
    const result = homeRoadPowerFactor({ slg: 0.900 }, 0.450);
    assert.equal(result, 1.20);
  });
  test('a split SLG below the season baseline suppresses, clamped to 0.85', () => {
    const result = homeRoadPowerFactor({ slg: 0.100 }, 0.450);
    assert.equal(result, 0.85);
  });
  test('an exactly-baseline split is neutral', () => {
    assert.equal(homeRoadPowerFactor({ slg: 0.450 }, 0.450), 1);
  });
});

describe('log5', () => {
  test('degenerate league rate (0 or 1) falls back to the batter\'s own rate', () => {
    assert.equal(log5(0.300, 0.250, 0), 0.300);
    assert.equal(log5(0.300, 0.250, 1), 0.300);
  });
  test('batter and pitcher both exactly at league average returns league average', () => {
    const result = log5(0.320, 0.320, 0.320);
    assert.ok(Math.abs(result - 0.320) < 0.001, `expected ~0.320, got ${result}`);
  });
  test('a batter better than average facing a pitcher worse than average exceeds league average', () => {
    const result = log5(0.380, 0.360, 0.320);
    assert.ok(result > 0.320, `expected result (${result}) above league avg (0.320)`);
  });
});

describe('shrinkMult / calibrateHRProb', () => {
  test('shrinkMult(1) is always 1 (a neutral multiplier is never shrunk away from neutral)', () => {
    assert.equal(shrinkMult(1), 1);
  });
  test('shrinkMult pulls a multiplier partway toward 1, per HR_MULT_SHRINKAGE', () => {
    // DEFAULT_MODEL_PARAMS.HR_MULT_SHRINKAGE = 0.6 -- shrinkMult(1.5) = 1 + (1.5-1)*0.6 = 1.3
    const result = shrinkMult(1.5);
    assert.ok(Math.abs(result - 1.3) < 1e-9, `expected 1.3, got ${result}`);
  });
  test('calibrateHRProb is the identity transform under the shipped default params', () => {
    // DEFAULT_MODEL_PARAMS: slope=1, intercept=0 -- see calibrateHRProb's own
    // header comment for why this is deliberately a no-op until the auto-tuner
    // has real evidence to move it.
    assert.equal(calibrateHRProb(42), 42);
    assert.equal(calibrateHRProb(7.5), 7.5);
  });
});

describe('computeIsHot', () => {
  test('too small a recent sample (< 15 AB) is never hot', () => {
    assert.equal(computeIsHot({ ab: 10, avg: 0.500, hr: 3 }, 0.250), false);
  });
  test('a real AVG surge (>= .050 over season baseline) is hot', () => {
    assert.equal(computeIsHot({ ab: 20, avg: 0.350, hr: 0 }, 0.280), true);
  });
  test('a real power surge (>= 2 HR in the recent window) is hot regardless of AVG', () => {
    assert.equal(computeIsHot({ ab: 20, avg: 0.230, hr: 2 }, 0.280), true);
  });
  test('a merely-decent recent stretch (neither bar cleared) is not hot', () => {
    assert.equal(computeIsHot({ ab: 20, avg: 0.300, hr: 1 }, 0.280), false);
  });
});
