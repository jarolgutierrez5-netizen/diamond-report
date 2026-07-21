#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// "Near HR" tracker — deep fly-ball outs (warning-track power) a batter has
// hit in his last 10 games. The matchup modal's existing HR/xHR signals only
// ever look at contact quality in aggregate (Barrel%, Hard-Hit%, xwOBA); none
// of them show "this specific ball almost left the yard but didn't," which is
// what this fills in.
//
// Reuses the same Statcast Search CSV endpoint and URL-building approach
// sync-pitcher-zone-hr.mjs and sync-batter-pitch-mix-trend.mjs already have
// working for real batter-scoped pulls, scoped to the same batter pool
// data/statcast-hot-hitters.json already tracks (the app's established
// "batters we have real Statcast data for" universe) rather than the whole
// league.
//
// "Near HR" means a fly ball that stayed in the park: events is a batted-ball
// out, bb_type is fly_ball, and hit_distance_sc is at or beyond
// NEAR_HR_MIN_DISTANCE_FT — genuine warning-track/wall territory, not just
// "hit hard." A double or triple off the wall is a HIT, not counted here —
// this is specifically about would-be homers that got caught.
//
// Same live-verification caveat as the other Statcast Search-based scripts in
// this repo: this sandbox cannot reach baseballsavant.mlb.com to confirm the
// CSV's exact column names (events, bb_type, hit_distance_sc, launch_speed,
// launch_angle, game_date, play_id) against a live response — they're the
// well-documented public schema, not something this script has verified
// itself. Loud schema check + per-batter try/catch, same defensive pattern as
// the other two scripts, so one bad response can't take down the whole run.
// Treat the first scheduled run as unverified until its own log output (and
// the resulting data/near-hrs.json) is manually checked.
// ─────────────────────────────────────────────────────────────────────────

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseCSV } from './sync-pitcher-statcast.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const HOT_HITTERS_PATH = path.join(DATA_DIR, 'statcast-hot-hitters.json');
const NEAR_HR_PATH = path.join(DATA_DIR, 'near-hrs.json');
const SEASON = new Date().getFullYear();
const SEARCH_BASE = 'https://baseballsavant.mlb.com/statcast_search/csv';

// A batter plays roughly 10 games in ~14-16 calendar days once off days are
// counted; 24 gives real margin (call-ups, short IL stints, a stretch with
// extra off days) while still being a bounded, real "recent" window rather
// than the whole season. The actual "last 10 games" cut happens afterward,
// from the real game_date values that come back — this is just the outer
// fetch window.
const LOOKBACK_DAYS = 24;
const GAMES_TO_KEEP = 10;
const NEAR_HR_MIN_DISTANCE_FT = 375;

function isoDate(d) { return d.toISOString().slice(0, 10); }
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d; }
const WINDOW_START = isoDate(daysAgo(LOOKBACK_DAYS));
const WINDOW_END = isoDate(new Date());

// Same fetch-with-timeout-and-retry guard as sync-pitcher-zone-hr.mjs /
// sync-batter-pitch-mix-trend.mjs — a slow/hanging response otherwise stalls
// this whole per-batter loop.
const FETCH_TIMEOUT_MS = 15000;
async function fetchText(url, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DiamondReportBot/1.0; +https://diamondreport.app)' }, signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (e) {
      lastErr = e.name === 'AbortError' ? new Error(`Timed out after ${FETCH_TIMEOUT_MS}ms for ${url}`) : e;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 1500 * (i + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

function batterSearchURL(batterId) {
  const params = new URLSearchParams({
    all: 'true',
    hfGT: 'R|PO|S|',
    hfSea: `${SEASON}|`,
    game_date_gt: WINDOW_START,
    game_date_lt: WINDOW_END,
    player_type: 'batter',
    group_by: 'name',
    sort_col: 'pitches',
    player_event_sort: 'api_p_release_speed',
    sort_order: 'desc',
    min_pitches: '0',
    min_results: '0',
    type: 'details',
  });
  params.append('batters_lookup[]', String(batterId));
  return `${SEARCH_BASE}?${params.toString()}`;
}

// Video link for a specific Statcast play — the same play_id -> sporty-videos
// URL scheme Baseball Savant's own site uses to embed a single play's clip.
// Unverified live in this sandbox like everything else above; a row without
// a play_id just gets no link rather than a broken one.
function savantVideoURL(playId) {
  return playId ? `https://baseballsavant.mlb.com/sporty-videos?playId=${playId}` : null;
}

async function loadTrackedBatters() {
  const raw = await readFile(HOT_HITTERS_PATH, 'utf8');
  const data = JSON.parse(raw);
  return (data.players || []).filter(p => p.playerId).map(p => ({ id: p.playerId, name: p.name }));
}

// Returns an array of near-HR events for this batter's real last 10 games
// (by distinct game_date, not a fixed calendar window), sorted longest first.
function buildNearHRs(csv, batterName) {
  const rows = parseCSV(csv);
  if (!rows.length) return [];
  const sample = rows[0];
  if (!('events' in sample) || !('bb_type' in sample) || !('hit_distance_sc' in sample) || !('game_date' in sample)) {
    throw new Error(`unexpected CSV columns for ${batterName} — got [${Object.keys(sample).join(', ')}]`);
  }

  // Statcast Search returns one row per PITCH; only the pitch that ended the
  // plate appearance in a ball in play carries a non-empty events value.
  const battedBalls = rows.filter(r => r.events && r.events !== '');
  const dates = [...new Set(battedBalls.map(r => r.game_date).filter(Boolean))].sort().reverse();
  const last10 = new Set(dates.slice(0, GAMES_TO_KEEP));

  return battedBalls
    .filter(r => last10.has(r.game_date))
    .filter(r => r.bb_type === 'fly_ball' && r.events !== 'home_run')
    .map(r => ({
      date: r.game_date,
      distance: Number(r.hit_distance_sc),
      exitVelo: Number.isFinite(Number(r.launch_speed)) ? Number(r.launch_speed) : null,
      launchAngle: Number.isFinite(Number(r.launch_angle)) ? Number(r.launch_angle) : null,
      event: r.events,
      description: r.des || null,
      matchup: [r.away_team, r.home_team].filter(Boolean).join(' @ ') || null,
      videoUrl: savantVideoURL(r.play_id),
    }))
    .filter(r => Number.isFinite(r.distance) && r.distance >= NEAR_HR_MIN_DISTANCE_FT)
    .sort((a, b) => b.distance - a.distance);
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  let batters;
  try {
    batters = await loadTrackedBatters();
  } catch (e) {
    console.error('statcast-hot-hitters.json not found/unreadable — run sync-statcast-hot-hitters.mjs first:', e.message);
    process.exitCode = 1;
    return;
  }
  console.log(`Checking ${batters.length} tracked batter(s) for near-HRs in their last ${GAMES_TO_KEEP} games.`);

  const out = {
    generatedAt: new Date().toISOString(),
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    minDistanceFt: NEAR_HR_MIN_DISTANCE_FT,
    players: {},
  };
  let updated = 0, failed = 0, withNearHRs = 0;
  for (const { id, name } of batters) {
    try {
      const csv = await fetchText(batterSearchURL(id));
      out.players[id] = buildNearHRs(csv, name);
      updated++;
      if (out.players[id].length) withNearHRs++;
    } catch (e) {
      failed++;
      console.error(`Near-HR sync failed for ${name} (${id}):`, e.message);
    }
    // Polite bounded-scope delay, same spirit as the other Statcast Search
    // scripts — a public, unauthenticated endpoint with no documented rate
    // limit, and this runs against the whole ~250-player tracked pool rather
    // than a short per-day list, so this errs a little longer than theirs.
    await new Promise(r => setTimeout(r, 600));
  }

  console.log(`Checked ${updated}/${batters.length} batters (${failed} failed), ${withNearHRs} with at least one near-HR in their last ${GAMES_TO_KEEP} games.`);
  if (updated > 0) {
    await writeFile(NEAR_HR_PATH, JSON.stringify(out, null, 2) + '\n');
  }
  if (failed > 0 && updated === 0) process.exitCode = 1;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch(e => { console.error(e); process.exit(1); });
}

export { batterSearchURL, buildNearHRs, savantVideoURL, main };
