#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Syncs real season-level Statcast batted-ball data (Barrel%, Hard-Hit%, Sweet-Spot%,
// xwOBA) from Baseball Savant's public leaderboards into data/statcast-hot-hitters.json
// — the exact file app.js's loadStatcastHotHitters()/getStatcastHotHitterProfile()
// already look for (see app.js, "HOT HITTER HR POTENTIAL ENGINE"). That file has never
// existed in this repo before, so every batter has always fallen back to the page-only
// proxy profile (buildFallbackHotHitterProfile) — Barrel% in particular has never had
// anywhere to come from, which is why it's never shown in the Pitcher Matchup modal's
// Hot Streak Signals panel.
//
// Also computes real "trend" fields (xwobaTrend/hardHitTrend/sweetSpotTrend/barrelTrend)
// — the recent-14-day value minus the season value — by pulling the same two
// leaderboards a second time scoped to a startDate/endDate range instead of the full
// season. app.js's getStatcastHotHitterProfile() has always read these trend fields and
// scored hot/cold streaks from them; until now nothing ever populated them, so every
// trend arrow silently rendered as "–" (defaults to 0 — reads as "no signal" rather than
// visibly broken, which is exactly why this went unnoticed).
//
// Four single, whole-league CSV pulls total (season batted-ball + season expected-stats
// + recent-window batted-ball + recent-window expected-stats), not one request per
// player, matching sync-pitcher-statcast.mjs's low-request-count approach. The
// recent-window pulls use min=1 instead of min=q ("qualified") — a 14-day window is too
// short for most non-everyday players to clear a qualified-PA bar, and a noisier partial
// signal for a part-time player is more useful here than dropping them entirely. Bat
// speed / blast rate (the newer, separate "Bat Tracking" leaderboard) are still left out
// of scope for this pass — app.js already treats them as optional and defaults to 0 when
// absent, so this stays a safe partial fill rather than a broken one.
//
// Known limitation, same as sync-pitcher-statcast.mjs: this environment cannot reach
// baseballsavant.mlb.com to verify these leaderboard URLs/columns/date-range params
// live. Column and param names below are the well-documented public schema from years
// of community sabermetric tooling, not something confirmed against a live response —
// the schema check fails loudly rather than silently writing wrong data if Savant's
// columns don't match, and the recent-window pulls are wrapped so a failure there
// doesn't take down the season-level data.
// ─────────────────────────────────────────────────────────────────────────

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseCSV } from './sync-pitcher-statcast.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const SEASON = new Date().getFullYear();
const RECENT_DAYS = 14;
const BASE = 'https://baseballsavant.mlb.com/leaderboard';

function isoDate(d) { return d.toISOString().slice(0, 10); }
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d; }

function battedBallUrl(params) {
  return `${BASE}/statcast?type=batter&position=&team=&csv=true&${params}`;
}
function expectedStatsUrl(params) {
  return `${BASE}/expected_statistics?type=batter&position=&team=&csv=true&${params}`;
}

const SEASON_BATTED_BALL_URL = battedBallUrl(`year=${SEASON}&min=q`);
const SEASON_EXPECTED_STATS_URL = expectedStatsUrl(`year=${SEASON}&min=q`);
const RECENT_START = isoDate(daysAgo(RECENT_DAYS));
const RECENT_END = isoDate(new Date());
const RECENT_BATTED_BALL_URL = battedBallUrl(`startDate=${RECENT_START}&endDate=${RECENT_END}&min=1`);
const RECENT_EXPECTED_STATS_URL = expectedStatsUrl(`startDate=${RECENT_START}&endDate=${RECENT_END}&min=1`);

async function fetchCSV(url, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DiamondReportBot/1.0; +https://diamondreport.app)' } });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw lastErr;
}

function pick(obj, keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return null;
}
function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : null; }

function assertSchema(rows, label, requiredAnyOf) {
  if (!rows.length) throw new Error(`${label}: CSV had no data rows`);
  const sample = rows[0];
  const hasId = pick(sample, ['player_id', 'batter_id', 'mlbam_id']) !== null;
  const hasAny = requiredAnyOf.some(k => sample[k] !== undefined);
  if (!hasId || !hasAny) {
    throw new Error(`${label}: unexpected CSV columns — got [${Object.keys(sample).join(', ')}]. Baseball Savant may have changed its schema.`);
  }
}

async function buildBattedBall(url, label) {
  const csv = await fetchCSV(url);
  const rows = parseCSV(csv);
  assertSchema(rows, label, ['brl_percent', 'brl_pa_percent', 'ev95percent']);
  const out = {};
  for (const r of rows) {
    const id = pick(r, ['player_id', 'batter_id', 'mlbam_id']);
    if (!id) continue;
    out[id] = {
      name: pick(r, ['player_name', 'last_name, first_name']),
      barrelPct: num(pick(r, ['brl_percent'])),
      hardHitPct: num(pick(r, ['ev95percent', 'hard_hit_percent'])),
      sweetSpotPct: num(pick(r, ['anglesweetspotpercent', 'sweet_spot_percent'])),
    };
  }
  return out;
}

async function buildExpectedStats(url, label) {
  const csv = await fetchCSV(url);
  const rows = parseCSV(csv);
  assertSchema(rows, label, ['est_woba', 'woba']);
  const out = {};
  for (const r of rows) {
    const id = pick(r, ['player_id', 'batter_id', 'mlbam_id']);
    if (!id) continue;
    out[id] = { xwoba: num(pick(r, ['est_woba', 'xwoba'])) };
  }
  return out;
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  let battedBall = {}, expected = {};
  let err = null;
  try {
    [battedBall, expected] = await Promise.all([
      buildBattedBall(SEASON_BATTED_BALL_URL, 'Statcast season batted-ball leaderboard'),
      buildExpectedStats(SEASON_EXPECTED_STATS_URL, 'Statcast season expected-stats leaderboard'),
    ]);
  } catch (e) {
    err = e.message;
    console.error('Statcast hot-hitters sync failed:', e.message);
  }

  if (err) { process.exitCode = 1; return; }

  // Trend data is a genuine bonus, not a requirement — if Savant's date-range params
  // don't behave the way this script assumes, every player just keeps trend fields
  // absent (reads as "no signal", same graceful default as before this existed) rather
  // than failing the whole sync.
  let recentBattedBall = {}, recentExpected = {};
  try {
    [recentBattedBall, recentExpected] = await Promise.all([
      buildBattedBall(RECENT_BATTED_BALL_URL, `Statcast ${RECENT_DAYS}-day batted-ball leaderboard`),
      buildExpectedStats(RECENT_EXPECTED_STATS_URL, `Statcast ${RECENT_DAYS}-day expected-stats leaderboard`),
    ]);
  } catch (e) {
    console.warn(`Trend data sync failed (non-fatal, season data still written):`, e.message);
  }

  const ids = new Set([...Object.keys(battedBall), ...Object.keys(expected)]);
  const players = [...ids].map(id => {
    const bb = battedBall[id] || {};
    const ex = expected[id] || {};
    const rbb = recentBattedBall[id] || {};
    const rex = recentExpected[id] || {};
    const trend = (recentVal, seasonVal) => (recentVal != null && seasonVal != null) ? +(recentVal - seasonVal).toFixed(3) : undefined;
    return {
      playerId: id,
      name: bb.name || null,
      barrelPct: bb.barrelPct,
      hardHitPct: bb.hardHitPct,
      sweetSpotPct: bb.sweetSpotPct,
      xwoba: ex.xwoba,
      barrelTrend: trend(rbb.barrelPct, bb.barrelPct),
      hardHitTrend: trend(rbb.hardHitPct, bb.hardHitPct),
      sweetSpotTrend: trend(rbb.sweetSpotPct, bb.sweetSpotPct),
      xwobaTrend: trend(rex.xwoba, ex.xwoba),
    };
  }).filter(p => p.barrelPct != null || p.hardHitPct != null || p.xwoba != null);

  const trendCount = players.filter(p => p.xwobaTrend !== undefined).length;
  const out = { generatedAt: new Date().toISOString(), season: SEASON, recentWindowDays: RECENT_DAYS, players };
  await writeFile(path.join(DATA_DIR, 'statcast-hot-hitters.json'), JSON.stringify(out, null, 2) + '\n');
  console.log(`Synced Statcast batted-ball/expected-stats profile for ${players.length} batters for ${SEASON} (${trendCount} with ${RECENT_DAYS}-day trend data).`);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch(e => { console.error(e); process.exit(1); });
}

export { buildBattedBall, buildExpectedStats, main };
