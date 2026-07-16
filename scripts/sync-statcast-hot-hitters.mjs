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
// Deliberately scoped to two single, whole-league CSV pulls (batted-ball leaderboard +
// expected-stats leaderboard) rather than one request per player, matching the existing
// sync-pitcher-statcast.mjs's low-request-count approach. Bat speed / blast rate (a
// newer, separate "Bat Tracking" leaderboard) are left out of scope for this pass —
// app.js already treats them as optional and defaults to 0 when absent, so this is a
// safe partial fill rather than a broken one. "Trend" fields (day-over-day change) are
// also left out on purpose: computing a real trend needs a second, recent-window pull,
// which is a meaningfully bigger and riskier addition than this pass covers; every
// trend field already defaults to 0 in app.js when missing, which just reads as
// "no hot/cold signal" rather than wrong data.
//
// Known limitation, same as sync-pitcher-statcast.mjs: this environment cannot reach
// baseballsavant.mlb.com to verify these leaderboard URLs/columns live. Column names
// below are the well-documented public schema from years of community sabermetric
// tooling, not something confirmed against a live response — the schema check fails
// loudly rather than silently writing wrong data if Savant's columns don't match.
// ─────────────────────────────────────────────────────────────────────────

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseCSV } from './sync-pitcher-statcast.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const SEASON = new Date().getFullYear();
const BATTED_BALL_URL = `https://baseballsavant.mlb.com/leaderboard/statcast?type=batter&year=${SEASON}&position=&team=&min=q&csv=true`;
const EXPECTED_STATS_URL = `https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=batter&year=${SEASON}&position=&team=&min=q&csv=true`;

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

async function buildBattedBall() {
  const csv = await fetchCSV(BATTED_BALL_URL);
  const rows = parseCSV(csv);
  assertSchema(rows, 'Statcast batted-ball leaderboard', ['brl_percent', 'brl_pa_percent', 'ev95percent']);
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

async function buildExpectedStats() {
  const csv = await fetchCSV(EXPECTED_STATS_URL);
  const rows = parseCSV(csv);
  assertSchema(rows, 'Statcast expected-stats leaderboard', ['est_woba', 'woba']);
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
    [battedBall, expected] = await Promise.all([buildBattedBall(), buildExpectedStats()]);
  } catch (e) {
    err = e.message;
    console.error('Statcast hot-hitters sync failed:', e.message);
  }

  if (err) { process.exitCode = 1; return; }

  const ids = new Set([...Object.keys(battedBall), ...Object.keys(expected)]);
  const players = [...ids].map(id => {
    const bb = battedBall[id] || {};
    const ex = expected[id] || {};
    return {
      playerId: id,
      name: bb.name || null,
      barrelPct: bb.barrelPct,
      hardHitPct: bb.hardHitPct,
      sweetSpotPct: bb.sweetSpotPct,
      xwoba: ex.xwoba,
      // Trend fields intentionally omitted — see file header. app.js defaults each of
      // these to 0 (via `Number(fromRepo.xTrend || 0)`) when absent.
    };
  }).filter(p => p.barrelPct != null || p.hardHitPct != null || p.xwoba != null);

  const out = { generatedAt: new Date().toISOString(), season: SEASON, players };
  await writeFile(path.join(DATA_DIR, 'statcast-hot-hitters.json'), JSON.stringify(out, null, 2) + '\n');
  console.log(`Synced Statcast batted-ball/expected-stats profile for ${players.length} batters for ${SEASON}.`);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch(e => { console.error(e); process.exit(1); });
}

export { buildBattedBall, buildExpectedStats, main };
