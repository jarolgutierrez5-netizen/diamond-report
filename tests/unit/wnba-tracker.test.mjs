// Unit tests for the pure/deterministic functions scripts/update-wnba-
// tracker.mjs exports -- no I/O, no Math.random. Network-dependent capture()/
// grade() paths are exercised separately (see the script's own header
// comment) against real cached ESPN data, not repeated here.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractGameRow,
  actualForBoard,
  wnbaConsistency,
  wnbaDefenseAdjustment,
  computeCalibration,
  pruneOld,
  BOARDS,
} from '../../scripts/update-wnba-tracker.mjs';

describe('extractGameRow', () => {
  const rawGamelog = {
    labels: ['MIN', 'PTS', 'REB', 'AST', 'STL', 'BLK', 'TO', 'FG', 'FG%', '3PT', '3P%', 'FT', 'FT%', 'PF'],
    seasonTypes: [
      {
        displayName: 'Regular Season',
        categories: [
          { name: 'august', events: [
            { eventId: '111', stats: ['30', '16', '7', '2', '1', '0', '3', '6-12', '50.0', '2-4', '50.0', '2-2', '100.0', '1'] },
            { eventId: '222', stats: ['28', '9', '3', '5', '0', '1', '2', '3-10', '30.0', '1-3', '33.3', '2-2', '100.0', '2'] },
          ] },
        ],
      },
    ],
  };

  test('finds the real per-game row matching a specific eventId', () => {
    const row = extractGameRow(rawGamelog, '222');
    assert.deepEqual(row, { pts: 9, reb: 3, ast: 5, threes: 1 });
  });

  test('returns null for an eventId with no matching real game', () => {
    assert.equal(extractGameRow(rawGamelog, '999'), null);
  });

  test('returns null when the response has no usable labels', () => {
    assert.equal(extractGameRow({}, '111'), null);
  });
});

describe('actualForBoard', () => {
  const row = { pts: 16, reb: 7, ast: 2, threes: 2 };
  test('points/rebounds/assists/threes read the matching field', () => {
    assert.equal(actualForBoard('points', row), 16);
    assert.equal(actualForBoard('rebounds', row), 7);
    assert.equal(actualForBoard('assists', row), 2);
    assert.equal(actualForBoard('threes', row), 2);
  });
  test('pra sums real pts+reb+ast', () => {
    assert.equal(actualForBoard('pra', row), 25);
  });
  test('pra is NaN (not a fabricated 0) when a component is missing', () => {
    assert.ok(Number.isNaN(actualForBoard('pra', { pts: 16, reb: NaN, ast: 2 })));
  });
});

describe('wnbaConsistency', () => {
  const cfg = BOARDS.find(b => b.key === 'points');
  test('low coefficient of variation grades Steady', () => {
    assert.equal(wnbaConsistency(cfg, { ptsPerGame: 20, ptsStdDev: 3 }), 'Steady');
  });
  test('mid coefficient of variation grades Moderate', () => {
    assert.equal(wnbaConsistency(cfg, { ptsPerGame: 10, ptsStdDev: 4.5 }), 'Moderate');
  });
  test('high coefficient of variation grades Volatile', () => {
    assert.equal(wnbaConsistency(cfg, { ptsPerGame: 8, ptsStdDev: 6 }), 'Volatile');
  });
  test('null (not a fabricated label) when average is zero/missing', () => {
    assert.equal(wnbaConsistency(cfg, { ptsPerGame: 0, ptsStdDev: 2 }), null);
    assert.equal(wnbaConsistency(cfg, { ptsStdDev: 2 }), null);
  });
});

describe('wnbaDefenseAdjustment', () => {
  const pointsCfg = BOARDS.find(b => b.key === 'points');
  const reboundsCfg = BOARDS.find(b => b.key === 'rebounds');
  const teamDefense = { leagueAvgPointsAgainst: 80, teams: { LV: { avgPointsAgainst: 100 } } };

  test('returns the real ratio for a board with a real defenseStatKey and data', () => {
    assert.equal(wnbaDefenseAdjustment(pointsCfg, 'LV', teamDefense), 1.25);
  });
  test('null (not a fabricated neutral ratio) for a board with no defenseStatKey', () => {
    assert.equal(wnbaDefenseAdjustment(reboundsCfg, 'LV', teamDefense), null);
  });
  test('null when the specific opponent has no real data', () => {
    assert.equal(wnbaDefenseAdjustment(pointsCfg, 'NY', teamDefense), null);
  });
  test('null when no team-defense data exists at all', () => {
    assert.equal(wnbaDefenseAdjustment(pointsCfg, 'LV', null), null);
  });
});

describe('computeCalibration', () => {
  test('summarizes real MAE/bias overall, by board, and by consistency; ignores pending entries', () => {
    const entries = [
      { board: 'points', status: 'graded', absError: 2, error: 1, consistency: 'Steady', cushion: 1.1, rawError: 0.5 },
      { board: 'points', status: 'graded', absError: 4, error: -3, consistency: 'Volatile', cushion: null, rawError: -3 },
      { board: 'rebounds', status: 'graded', absError: 1, error: 1, consistency: 'Steady', cushion: null, rawError: 1 },
      { board: 'assists', status: 'pending' },
    ];
    const calibration = computeCalibration(entries);
    assert.equal(calibration.overall.n, 3);
    assert.equal(calibration.byBoard.points.n, 2);
    assert.equal(calibration.byBoard.points.mae, 3);
    assert.equal(calibration.byBoard.assists.n, 0);
    assert.equal(calibration.byConsistency.Steady.n, 2);
    assert.equal(calibration.byConsistency.Volatile.n, 1);
    // Only the one graded, cushion-bearing Points entry feeds this check.
    assert.equal(calibration.defenseAdjustmentCheck.n, 1);
    assert.equal(calibration.defenseAdjustmentCheck.maeAdjusted, 2);
    assert.equal(calibration.defenseAdjustmentCheck.maeUnadjusted, 0.5);
  });

  test('defenseAdjustmentCheck is null (not a fabricated empty summary) when no board has real adjustment data yet', () => {
    const entries = [{ board: 'rebounds', status: 'graded', absError: 1, error: 1, consistency: 'Steady', cushion: null, rawError: 1 }];
    assert.equal(computeCalibration(entries).defenseAdjustmentCheck, null);
  });
});

describe('pruneOld', () => {
  test('drops entries older than the retention window, keeps the rest', () => {
    const old = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
    const recent = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
    const entries = [{ date: old, id: 'stale' }, { date: recent, id: 'fresh' }];
    const result = pruneOld(entries);
    assert.deepEqual(result.map(e => e.id), ['fresh']);
  });
});
