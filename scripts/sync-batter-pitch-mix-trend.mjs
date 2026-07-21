#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Compares the pitch mix a batter has actually SEEN in the last 14 days against his
// season-long mix (data/batter-pitch-type-season.json, already synced by
// sync-pitcher-statcast.mjs) -- "are pitchers attacking him differently right now" --
// the one signal getColdBatterDiagnosis (app.js) had a hook for
// (profile.pitchMixShift) but nothing populated yet.
//
// Bounded on purpose: only pulls this for batters ALREADY showing a real cold stretch
// (data/statcast-hot-hitters.json's recentOpsTrend <= -0.080, the same threshold
// getColdBatterDiagnosis itself gates on) -- there's no reason to spend a per-player
// request on a batter the diagnosis panel will never show anyway, and this keeps the
// request count in the same bounded-per-day range as sync-pitcher-zone-hr.mjs's
// per-probable-starter pulls rather than one request per every batter in the league.
//
// Data source: Baseball Savant's Statcast Search CSV export (statcast_search/csv),
// the same real, per-pitch (not pre-aggregated) endpoint sync-pitcher-zone-hr.mjs
// already uses successfully -- reusing its proven URL-building/CSV-parsing approach
// rather than the "/leaderboard/..." endpoints, which sync-statcast-hot-hitters.mjs
// confirmed live do NOT honor arbitrary startDate/endDate params. Statcast Search is a
// different, genuinely per-event tool (its whole purpose is filtering individual
// pitches, date range included), so game_date_gt/game_date_lt are far more likely to
// actually scope the results -- but this environment still cannot reach
// baseballsavant.mlb.com to confirm that live. Defended two ways: (1) the usual loud
// schema-mismatch check, and (2) checking that the CSV rows this returns actually carry
// game_date values inside the requested window -- if they don't (Savant silently
// ignoring the date params and returning the whole season instead), this drops the
// trend data for that batter rather than writing a comparison built on a lie. Treat the
// first scheduled run as unverified until its own log output is checked.
// ─────────────────────────────────────────────────────────────────────────

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseCSV, PITCH_NAME_MAP } from './sync-pitcher-statcast.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const HOT_HITTERS_PATH = path.join(DATA_DIR, 'statcast-hot-hitters.json');
const BATTER_PITCH_SEASON_PATH = path.join(DATA_DIR, 'batter-pitch-type-season.json');
const SEASON = new Date().getFullYear();
const SEARCH_BASE = 'https://baseballsavant.mlb.com/statcast_search/csv';
const RECENT_DAYS = 14;
// Below this many pitches seen in the recent window, a usage% comparison is too noisy
// to mean anything (a single at-bat can be 3-8 pitches) -- same spirit as
// sync-statcast-hot-hitters.mjs's STATCAST_MIN_PITCHES-style thin-sample guards
// elsewhere in this app.
const MIN_RECENT_PITCHES = 15;
// A shift smaller than this (percentage points of usage) isn't worth surfacing as "a
// different mix" -- normal week-to-week noise in a small sample easily produces a few
// points of movement with no real approach change behind it.
const MIN_SHIFT_PCT = 8;

function isoDate(d) { return d.toISOString().slice(0, 10); }
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d; }
const RECENT_START = isoDate(daysAgo(RECENT_DAYS));
const RECENT_END = isoDate(new Date());

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
    game_date_gt: RECENT_START,
    game_date_lt: RECENT_END,
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

async function loadCurrentlyColdBatters() {
  const raw = await readFile(HOT_HITTERS_PATH, 'utf8');
  const data = JSON.parse(raw);
  return (data.players || [])
    .filter(p => Number.isFinite(p.recentOpsTrend) && p.recentOpsTrend <= -0.080)
    .map(p => ({ id: p.playerId, name: p.name }));
}

async function loadSeasonPitchMix() {
  try {
    const raw = await readFile(BATTER_PITCH_SEASON_PATH, 'utf8');
    const data = JSON.parse(raw);
    return data.players || {};
  } catch (e) {
    console.warn('batter-pitch-type-season.json not found/unreadable — trend comparison will have nothing to compare against:', e.message);
    return {};
  }
}

// Returns { recentUsageByPitch: {name: pct}, recentPitchCount, datesInWindow, datesOutOfWindow }
// or null if the CSV didn't look like real Statcast Search output at all.
function buildRecentUsage(csv, batterName) {
  const rows = parseCSV(csv);
  if (!rows.length) return { recentUsageByPitch: {}, recentPitchCount: 0, datesInWindow: 0, datesOutOfWindow: 0 };
  const sample = rows[0];
  if (!('pitch_type' in sample) || !('game_date' in sample)) {
    throw new Error(`unexpected CSV columns for ${batterName} — got [${Object.keys(sample).join(', ')}]`);
  }
  let datesInWindow = 0, datesOutOfWindow = 0;
  const counts = {};
  let total = 0;
  for (const r of rows) {
    const date = r.game_date;
    if (date && date >= RECENT_START && date <= RECENT_END) datesInWindow++;
    else if (date) datesOutOfWindow++;
    const pitchType = r.pitch_type;
    if (!pitchType) continue;
    const name = r.pitch_name || PITCH_NAME_MAP[pitchType] || pitchType;
    counts[name] = (counts[name] || 0) + 1;
    total++;
  }
  const recentUsageByPitch = {};
  for (const [name, c] of Object.entries(counts)) recentUsageByPitch[name] = +((c / total) * 100).toFixed(1);
  return { recentUsageByPitch, recentPitchCount: total, datesInWindow, datesOutOfWindow };
}

function computeShift(recentUsageByPitch, seasonPitchTypeStats) {
  const seasonByName = {};
  for (const s of seasonPitchTypeStats || []) if (s.name) seasonByName[s.name] = s.usagePct;
  const names = new Set([...Object.keys(recentUsageByPitch), ...Object.keys(seasonByName)]);
  const shifts = [];
  for (const name of names) {
    const recentUsagePct = recentUsageByPitch[name] ?? 0;
    const seasonUsagePct = seasonByName[name] ?? 0;
    const delta = recentUsagePct - seasonUsagePct;
    if (Math.abs(delta) >= MIN_SHIFT_PCT) shifts.push({ pitchName: name, recentUsagePct, seasonUsagePct, delta: +delta.toFixed(1) });
  }
  shifts.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return shifts;
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  let coldBatters;
  try {
    coldBatters = await loadCurrentlyColdBatters();
  } catch (e) {
    console.error('statcast-hot-hitters.json not found/unreadable — run sync-statcast-hot-hitters.mjs first:', e.message);
    process.exitCode = 1;
    return;
  }
  console.log(`Found ${coldBatters.length} currently-cold batter(s) to check pitch-mix trend for.`);
  if (!coldBatters.length) return;

  const seasonByPlayer = await loadSeasonPitchMix();

  let hotHitters;
  try {
    hotHitters = JSON.parse(await readFile(HOT_HITTERS_PATH, 'utf8'));
  } catch (e) {
    console.error('Failed to re-read statcast-hot-hitters.json for merge:', e.message);
    process.exitCode = 1;
    return;
  }
  const byPlayerId = new Map((hotHitters.players || []).map(p => [String(p.playerId), p]));

  let checked = 0, withShift = 0, dateFilterSuspect = 0, failures = 0;
  for (const batter of coldBatters) {
    try {
      const csv = await fetchText(batterSearchURL(batter.id));
      const usage = buildRecentUsage(csv, batter.name);
      checked++;

      // Sanity check: if most returned rows carry a game_date OUTSIDE the requested
      // window, Savant almost certainly ignored game_date_gt/game_date_lt and returned
      // the whole season instead (same failure mode sync-statcast-hot-hitters.mjs
      // confirmed live on the leaderboard endpoints) -- skip this batter rather than
      // write a "trend" that's actually just season data compared to itself.
      const totalDated = usage.datesInWindow + usage.datesOutOfWindow;
      if (totalDated > 0 && usage.datesOutOfWindow / totalDated > 0.5) {
        dateFilterSuspect++;
        continue;
      }

      if (usage.recentPitchCount < MIN_RECENT_PITCHES) continue;

      const seasonStats = seasonByPlayer[batter.id]?.seasonPitchTypeStats;
      const shifts = computeShift(usage.recentUsageByPitch, seasonStats);
      const p = byPlayerId.get(String(batter.id));
      if (p) {
        if (shifts.length) { p.pitchMixShift = shifts; withShift++; }
        else delete p.pitchMixShift;
      }
    } catch (e) {
      failures++;
      console.warn(`Pitch-mix trend fetch failed for ${batter.name} (${batter.id}):`, e.message);
    }
    await new Promise(r => setTimeout(r, 400));
  }

  if (dateFilterSuspect > checked * 0.5 && checked >= 5) {
    console.warn(`${dateFilterSuspect}/${checked} batters returned mostly out-of-window dates — game_date_gt/game_date_lt likely aren't scoping this endpoint the way this script assumes. Pitch-mix trend data was skipped for those batters (not written as a false comparison); this needs live verification.`);
  }

  hotHitters.generatedAt = new Date().toISOString();
  await writeFile(HOT_HITTERS_PATH, JSON.stringify(hotHitters, null, 2) + '\n');
  console.log(`Checked ${checked}/${coldBatters.length} cold batters (${failures} failed), ${withShift} with a real pitch-mix shift >= ${MIN_SHIFT_PCT}pp, ${dateFilterSuspect} skipped as date-filter-suspect.`);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch(e => { console.error(e); process.exit(1); });
}

export { batterSearchURL, buildRecentUsage, computeShift, loadCurrentlyColdBatters, main };
