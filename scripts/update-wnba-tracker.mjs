#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Internal calibration log for the WNBA prop board family (app.js:
// WNBA_PROP_BOARDS) -- not a public-facing feature (unlike scripts/update-
// tracker.mjs's MLB Track Record, which feeds track-record.html), just a
// real capture-then-grade record of how close each board's individual
// projection actually lands, so the model can be reviewed and re-tuned
// with real evidence instead of guessing.
//
// Same two-phase shape update-tracker.mjs already established for MLB:
//   1. CAPTURE -- for TODAY's real games, record every rostered player's
//      real projection (season average, defense-adjusted for Points when a
//      real opponent match exists) *before* the games are played. Has to
//      happen pre-game -- capturing after the fact would silently bake that
//      game's own result into the "projection", making accuracy look
//      artificially perfect (lookahead bias). Once captured, an entry is
//      never re-captured or altered.
//   2. GRADE -- for any earlier day's entries still "pending", re-fetches
//      that player's real ESPN gamelog and finds the specific real game
//      (matched by eventId) to resolve the real actual value.
//
// Deliberately mirrors app.js's own wnbaStatConsistency/wnbaDefenseAdjustment
// formulas server-side (kept in sync by hand, same tradeoff drKConfidenceScore's
// server-side reimplementation in update-tracker.mjs already accepts) rather
// than trying to share code between a browser script and a Node script.
//
// Zero npm dependencies (Node's built-in fetch), matching every other sync
// script in this repo.
// ─────────────────────────────────────────────────────────────────────────

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const TRACKER_PATH = path.join(DATA_DIR, 'wnba-tracker.json');
const SCHEDULE_PATH = path.join(DATA_DIR, 'wnba-schedule.json');
const PLAYER_STATS_PATH = path.join(DATA_DIR, 'wnba-player-stats.json');
const TEAM_DEFENSE_PATH = path.join(DATA_DIR, 'wnba-team-defense.json');

// Real per-board field mapping -- mirrors app.js's WNBA_PROP_BOARDS exactly
// (avgField/stdDevField names, and which board has a real defenseStatKey).
const BOARDS = [
  { key: 'points', avgField: 'ptsPerGame', stdDevField: 'ptsStdDev', rowKey: 'pts', defenseStatKey: 'avgPointsAgainst' },
  { key: 'rebounds', avgField: 'rebPerGame', stdDevField: 'rebStdDev', rowKey: 'reb' },
  { key: 'assists', avgField: 'astPerGame', stdDevField: 'astStdDev', rowKey: 'ast' },
  { key: 'threes', avgField: 'threesPerGame', stdDevField: 'threesStdDev', rowKey: 'threes' },
  { key: 'pra', avgField: 'praPerGame', stdDevField: 'praStdDev', rowKey: 'pra' },
];

const FETCH_TIMEOUT_MS = 15000;
const RETAIN_DAYS = 60; // keeps the log a real, reviewable recent window rather than growing unbounded all season.

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

async function fetchJSON(url, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' }, signal: controller.signal });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} for ${url}`);
        err.status = res.status;
        throw err;
      }
      return await res.json();
    } catch (e) {
      lastErr = e.name === 'AbortError' ? new Error(`Timed out after ${FETCH_TIMEOUT_MS}ms for ${url}`) : e;
      if (e.status === 404) break;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

async function loadJSON(p) {
  try {
    return JSON.parse(await readFile(p, 'utf8'));
  } catch (e) {
    return null;
  }
}

function gamelogURL(playerId) {
  return `https://site.web.api.espn.com/apis/common/v3/sports/basketball/wnba/athletes/${playerId}/gamelog`;
}

// Same made-attempted split parsing sync-wnba-player-stats.mjs uses for the
// 3PT column ("1-3" -> 1 real make).
function parseStatCell(v) {
  if (v == null) return NaN;
  const s = String(v);
  const made = s.includes('-') ? s.split('-')[0] : s;
  return Number(made);
}

// Mirrors app.js's wnbaStatConsistency exactly (real coefficient of
// variation, same Steady/Moderate/Volatile bands).
function wnbaConsistency(cfg, p) {
  const avg = Number(p[cfg.avgField]);
  const stdDev = Number(p[cfg.stdDevField]);
  if (!(avg > 0) || !Number.isFinite(stdDev)) return null;
  const cv = stdDev / avg;
  return cv < 0.35 ? 'Steady' : cv < 0.6 ? 'Moderate' : 'Volatile';
}

// Mirrors app.js's wnbaDefenseAdjustment exactly (real opponent points-
// allowed vs. real league average). Null -- not a fabricated neutral ratio
// -- when the board has no defenseStatKey or the real data isn't available.
function wnbaDefenseAdjustment(cfg, oppAbbr, teamDefense) {
  if (!cfg.defenseStatKey || !teamDefense) return null;
  const oppTeam = teamDefense.teams && teamDefense.teams[oppAbbr];
  const oppVal = oppTeam && oppTeam[cfg.defenseStatKey];
  const leagueAvg = teamDefense.leagueAvgPointsAgainst;
  if (oppVal == null || !(leagueAvg > 0)) return null;
  return oppVal / leagueAvg;
}

// Captures every rostered player with a real game today (across all 5
// boards) whose projection hasn't already been captured today -- an entry,
// once written, is never re-captured or altered, same "locked once
// captured" rule update-tracker.mjs's MLB capture uses.
async function capture(tracker) {
  const schedule = await loadJSON(SCHEDULE_PATH);
  const statsData = await loadJSON(PLAYER_STATS_PATH);
  const teamDefense = await loadJSON(TEAM_DEFENSE_PATH);
  if (!schedule || !statsData) {
    console.log('Missing wnba-schedule.json or wnba-player-stats.json -- skipping capture.');
    return;
  }

  const today = todayStr();
  const todaysGames = (schedule.events || []).filter(g => (g.date || '').slice(0, 10) === today && g.home && g.away && g.home.abbreviation && g.away.abbreviation);
  if (!todaysGames.length) {
    console.log('No real WNBA games today -- nothing to capture.');
    return;
  }

  const oppByTeam = {};
  const eventByTeam = {};
  todaysGames.forEach(g => {
    oppByTeam[g.home.abbreviation] = g.away.abbreviation;
    oppByTeam[g.away.abbreviation] = g.home.abbreviation;
    eventByTeam[g.home.abbreviation] = g.id;
    eventByTeam[g.away.abbreviation] = g.id;
  });

  const existingKeys = new Set(tracker.entries.map(e => `${e.date}|${e.playerId}|${e.board}`));
  const players = Object.entries(statsData.players || {});
  let captured = 0;
  for (const [id, p] of players) {
    const oppAbbr = oppByTeam[p.teamAbbr];
    if (!oppAbbr) continue;
    for (const cfg of BOARDS) {
      const seasonAvg = p[cfg.avgField];
      if (seasonAvg == null) continue;
      const key = `${today}|${id}|${cfg.key}`;
      if (existingKeys.has(key)) continue;
      const ratio = wnbaDefenseAdjustment(cfg, oppAbbr, teamDefense);
      const projAvg = ratio != null ? +(seasonAvg * ratio).toFixed(2) : seasonAvg;
      tracker.entries.push({
        date: today, eventId: eventByTeam[p.teamAbbr], playerId: id, name: p.name,
        board: cfg.key, teamAbbr: p.teamAbbr, oppAbbr,
        seasonAvg, projAvg,
        cushion: ratio != null ? +(projAvg - seasonAvg).toFixed(2) : null,
        consistency: wnbaConsistency(cfg, p),
        status: 'pending', actual: null, error: null, absError: null, rawError: null,
      });
      captured++;
    }
  }
  console.log(`Captured ${captured} new entr${captured === 1 ? 'y' : 'ies'} for ${today} (${todaysGames.length} real game(s)).`);
}

// Real per-game {pts,reb,ast,threes} for one specific real game (matched by
// eventId), from a player's real gamelog -- same label-index parsing
// sync-wnba-player-stats.mjs's extractSeasonRows uses, scoped to a single
// game instead of summed across the season.
function extractGameRow(raw, eventId) {
  const labels = raw?.labels;
  if (!Array.isArray(labels)) return null;
  const idx = { pts: labels.indexOf('PTS'), reb: labels.indexOf('REB'), ast: labels.indexOf('AST'), threes: labels.indexOf('3PT') };
  if (idx.pts === -1) return null;
  for (const st of raw?.seasonTypes || []) {
    for (const cat of st?.categories || []) {
      for (const ev of cat?.events || []) {
        if (String(ev?.eventId) !== String(eventId)) continue;
        const stats = ev?.stats;
        if (!Array.isArray(stats)) continue;
        return {
          pts: Number(stats[idx.pts]),
          reb: idx.reb !== -1 ? Number(stats[idx.reb]) : NaN,
          ast: idx.ast !== -1 ? Number(stats[idx.ast]) : NaN,
          threes: idx.threes !== -1 ? parseStatCell(stats[idx.threes]) : NaN,
        };
      }
    }
  }
  return null;
}

function actualForBoard(board, row) {
  if (board === 'points') return row.pts;
  if (board === 'rebounds') return row.reb;
  if (board === 'assists') return row.ast;
  if (board === 'threes') return row.threes;
  if (board === 'pra') return (Number.isFinite(row.pts) && Number.isFinite(row.reb) && Number.isFinite(row.ast)) ? row.pts + row.reb + row.ast : NaN;
  return NaN;
}

// Resolves every still-pending entry against each player's real gamelog --
// one real fetch per player (not per board), since a player usually has up
// to 5 pending entries (one per board) from the same real game.
async function grade(tracker) {
  const pending = tracker.entries.filter(e => e.status === 'pending');
  if (!pending.length) {
    console.log('No pending entries to grade.');
    return;
  }
  const byPlayer = {};
  pending.forEach(e => { (byPlayer[e.playerId] = byPlayer[e.playerId] || []).push(e); });

  let graded = 0, stillPending = 0, failed = 0;
  for (const [playerId, entries] of Object.entries(byPlayer)) {
    let raw;
    try {
      raw = await fetchJSON(gamelogURL(playerId));
    } catch (e) {
      failed++;
      console.error(`Gamelog fetch failed for player ${playerId}:`, e.message);
      await new Promise(r => setTimeout(r, 350));
      continue;
    }
    for (const entry of entries) {
      const row = extractGameRow(raw, entry.eventId);
      const actual = row ? actualForBoard(entry.board, row) : NaN;
      if (!Number.isFinite(actual)) {
        stillPending++;
        continue;
      }
      entry.actual = actual;
      entry.error = +(actual - entry.projAvg).toFixed(2);
      entry.absError = +Math.abs(entry.error).toFixed(2);
      entry.rawError = +(actual - entry.seasonAvg).toFixed(2);
      entry.status = 'graded';
      graded++;
    }
    // Same polite bounded-scope delay every other sync script in this repo
    // uses against a free, unauthenticated public endpoint.
    await new Promise(r => setTimeout(r, 350));
  }
  console.log(`Graded ${graded}, still pending ${stillPending}, gamelog fetch failures ${failed}.`);
}

function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}
function summarize(entries) {
  if (!entries.length) return { n: 0, mae: null, bias: null };
  return {
    n: entries.length,
    mae: +mean(entries.map(e => e.absError)).toFixed(2),
    bias: +mean(entries.map(e => e.error)).toFixed(2), // signed -- positive means the model runs low, negative means it runs high
  };
}

// Real diagnostics computed fresh from the graded entries every run --
// nothing here is itself synced or cached, it's derived purely from the
// real capture/grade records above.
function computeCalibration(entries) {
  const graded = entries.filter(e => e.status === 'graded');
  const byBoard = {};
  BOARDS.forEach(cfg => { byBoard[cfg.key] = summarize(graded.filter(e => e.board === cfg.key)); });
  const byConsistency = {};
  ['Steady', 'Moderate', 'Volatile'].forEach(label => { byConsistency[label] = summarize(graded.filter(e => e.consistency === label)); });
  // Points-only: does the real defense adjustment actually land closer to
  // the real actual than the unadjusted season average would have? Compares
  // each graded, defense-adjusted Points entry's real absError against what
  // its real error would have been using seasonAvg instead of projAvg.
  const adjustedEntries = graded.filter(e => e.board === 'points' && e.cushion != null);
  const defenseAdjustmentCheck = adjustedEntries.length ? {
    n: adjustedEntries.length,
    maeAdjusted: +mean(adjustedEntries.map(e => e.absError)).toFixed(2),
    maeUnadjusted: +mean(adjustedEntries.map(e => Math.abs(e.rawError))).toFixed(2),
  } : null;
  return { overall: summarize(graded), byBoard, byConsistency, defenseAdjustmentCheck };
}

function pruneOld(entries) {
  const cutoff = new Date(Date.now() - RETAIN_DAYS * 86400000).toISOString().slice(0, 10);
  return entries.filter(e => e.date >= cutoff);
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  let tracker = await loadJSON(TRACKER_PATH);
  if (!tracker || !Array.isArray(tracker.entries)) tracker = { entries: [] };

  await grade(tracker);
  await capture(tracker);

  tracker.entries = pruneOld(tracker.entries);
  tracker.updatedAt = new Date().toISOString();
  tracker.calibration = computeCalibration(tracker.entries);

  await writeFile(TRACKER_PATH, JSON.stringify(tracker, null, 2) + '\n');
  console.log(`Wrote ${tracker.entries.length} entr${tracker.entries.length === 1 ? 'y' : 'ies'} (retaining last ${RETAIN_DAYS} days).`);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch(e => { console.error(e); process.exit(1); });
}

export { capture, grade, extractGameRow, actualForBoard, wnbaConsistency, wnbaDefenseAdjustment, computeCalibration, pruneOld, gamelogURL, BOARDS, main };
