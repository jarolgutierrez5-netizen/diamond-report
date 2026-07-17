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
// Plate discipline (chase-rate, zone-contact%) and Sprint Speed are separate
// leaderboards from the batted-ball one above, each a single whole-league pull.
// Savant has no dedicated "/leaderboard/plate-discipline" page (confirmed 404 live) —
// these metrics live in the "Custom Leaderboards" builder instead, so try that as a
// fallback. Kept as a list rather than a single guessed URL since the exact `selections`
// column codes for that endpoint aren't verifiable from this sandbox either.
const PLATE_DISCIPLINE_URL_CANDIDATES = [
  `${BASE}/plate-discipline?type=batter&year=${SEASON}&position=&team=&min=q&csv=true`,
  `${BASE}/custom?year=${SEASON}&type=batter&filter=&min=q&selections=o_swing_percent,z_swing_percent,swing_percent,z_contact_percent,contact_percent,whiff_percent&chart=false&x=o_swing_percent&y=z_contact_percent&r=no&chartType=beeswarm&sort=xwoba&sortDir=desc&csv=true`,
];
const SPRINT_SPEED_URL = `${BASE}/sprint_speed?year=${SEASON}&position=&team=&min=10&csv=true`;

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

async function buildPlateDiscipline() {
  let lastErr;
  for (const url of PLATE_DISCIPLINE_URL_CANDIDATES) {
    let csv;
    try {
      csv = await fetchCSV(url);
    } catch (e) {
      console.warn(`Plate-discipline candidate ${url} failed to fetch: ${e.message}`);
      lastErr = e;
      continue;
    }
    const rows = parseCSV(csv);
    try {
      assertSchema(rows, 'Statcast plate-discipline leaderboard', ['o_swing_percent', 'z_contact_percent', 'swing_percent']);
    } catch (e) {
      console.warn(`Plate-discipline candidate ${url} returned data but not the expected columns: ${rows[0] ? Object.keys(rows[0]).join(', ') : '(no rows)'}`);
      lastErr = e;
      continue;
    }
    const out = {};
    for (const r of rows) {
      const id = pick(r, ['player_id', 'batter_id', 'mlbam_id']);
      if (!id) continue;
      out[id] = {
        chasePct: num(pick(r, ['o_swing_percent', 'chase_percent'])),
        zoneContactPct: num(pick(r, ['z_contact_percent'])),
        swingStrikePct: num(pick(r, ['swstr_percent', 'whiff_percent'])),
      };
    }
    const vals = Object.values(out);
    console.log(`Plate-discipline candidate ${url} matched schema — columns: ${rows[0] ? Object.keys(rows[0]).join(', ') : '(no rows)'}; ${vals.length} players, ${vals.filter(v => v.chasePct != null).length} with chasePct, ${vals.filter(v => v.zoneContactPct != null).length} with zoneContactPct, ${vals.filter(v => v.swingStrikePct != null).length} with swingStrikePct.`);
    return out;
  }
  throw lastErr;
}

async function buildSprintSpeed() {
  const csv = await fetchCSV(SPRINT_SPEED_URL);
  const rows = parseCSV(csv);
  assertSchema(rows, 'Statcast Sprint Speed leaderboard', ['sprint_speed']);
  const out = {};
  for (const r of rows) {
    const id = pick(r, ['player_id', 'batter_id', 'mlbam_id']);
    if (!id) continue;
    out[id] = { sprintSpeed: num(pick(r, ['sprint_speed'])) };
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

  // Plate discipline and Sprint Speed are independent, non-fatal add-ons — same
  // reasoning as the recent-window trend pull above.
  let plateDiscipline = {}, sprintSpeed = {};
  try {
    plateDiscipline = await buildPlateDiscipline();
  } catch (e) {
    console.warn('Plate-discipline sync failed (non-fatal):', e.message);
  }
  try {
    sprintSpeed = await buildSprintSpeed();
  } catch (e) {
    console.warn('Sprint Speed sync failed (non-fatal):', e.message);
  }

  const ids = new Set([...Object.keys(battedBall), ...Object.keys(expected)]);
  let rawPlayers = [...ids].map(id => {
    const bb = battedBall[id] || {};
    const ex = expected[id] || {};
    const rbb = recentBattedBall[id] || {};
    const rex = recentExpected[id] || {};
    const pd = plateDiscipline[id] || {};
    const ss = sprintSpeed[id] || {};
    const trend = (recentVal, seasonVal) => (recentVal != null && seasonVal != null) ? +(recentVal - seasonVal).toFixed(3) : undefined;
    return {
      playerId: id,
      name: bb.name || null,
      barrelPct: bb.barrelPct,
      hardHitPct: bb.hardHitPct,
      sweetSpotPct: bb.sweetSpotPct,
      xwoba: ex.xwoba,
      chasePct: pd.chasePct,
      zoneContactPct: pd.zoneContactPct,
      swingStrikePct: pd.swingStrikePct,
      sprintSpeed: ss.sprintSpeed,
      barrelTrend: trend(rbb.barrelPct, bb.barrelPct),
      hardHitTrend: trend(rbb.hardHitPct, bb.hardHitPct),
      sweetSpotTrend: trend(rbb.sweetSpotPct, bb.sweetSpotPct),
      xwobaTrend: trend(rex.xwoba, ex.xwoba),
    };
  }).filter(p => p.barrelPct != null || p.hardHitPct != null || p.xwoba != null);

  // Sanity check: if the "recent window" pull is byte-identical to the season pull for
  // every single player, the startDate/endDate params almost certainly aren't actually
  // scoping anything on Savant's side (these two leaderboards may only support `year`,
  // not arbitrary date ranges — unverified from this environment, see file header).
  // Writing out a field called "Trend" that's silently just season data again would be
  // worse than the absent-field default this replaced — drop it rather than ship it.
  const withTrend = rawPlayers.filter(p => p.xwobaTrend !== undefined);
  const nonZeroTrend = withTrend.filter(p => p.xwobaTrend !== 0 || p.barrelTrend !== 0 || p.hardHitTrend !== 0 || p.sweetSpotTrend !== 0);
  if (withTrend.length > 20 && nonZeroTrend.length === 0) {
    console.warn(`All ${withTrend.length} players had exactly zero trend across every metric — the recent-window pull almost certainly returned season data again rather than a real ${RECENT_DAYS}-day window. Dropping trend fields rather than writing fake zeros.`);
    rawPlayers = rawPlayers.map(p => {
      const { barrelTrend, hardHitTrend, sweetSpotTrend, xwobaTrend, ...rest } = p;
      return rest;
    });
  }
  const players = rawPlayers;

  const trendCount = players.filter(p => p.xwobaTrend !== undefined).length;
  const out = { generatedAt: new Date().toISOString(), season: SEASON, recentWindowDays: RECENT_DAYS, players };
  await writeFile(path.join(DATA_DIR, 'statcast-hot-hitters.json'), JSON.stringify(out, null, 2) + '\n');
  console.log(`Synced Statcast profile for ${players.length} batters for ${SEASON} (${trendCount} with ${RECENT_DAYS}-day trend data, ${players.filter(p=>p.chasePct!=null).length} with plate discipline, ${players.filter(p=>p.sprintSpeed!=null).length} with sprint speed).`);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch(e => { console.error(e); process.exit(1); });
}

export { buildBattedBall, buildExpectedStats, main };
