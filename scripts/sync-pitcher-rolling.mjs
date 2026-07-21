#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Rolling pitch metrics — "is this pitcher's stuff trending up or down right
// now," which nothing else in this app answers. sync-pitcher-statcast.mjs and
// sync-pitcher-zone-hr.mjs both only ever produce SEASON aggregates; a pitcher
// who's lost velocity or leaned harder on a different pitch the last few
// outings looks identical to his full-season self in every existing data file.
//
// For each of today's probable starters (same bounded ~15-30/day scope as
// sync-pitcher-zone-hr.mjs), pulls the same Statcast Search CSV (one row per
// PITCH, real game_date on every row), groups rows by game_date to reconstruct
// individual starts, and compares the last ROLLING_STARTS outings against the
// full-season baseline for the three signals that most directly answer "how
// will today's at-bats go": velocity, usage mix, and whiff rate, per pitch type.
//
// Same live-verification caveat as the other Statcast Search-based scripts in
// this repo: this sandbox cannot reach baseballsavant.mlb.com to confirm the
// CSV's exact column names (release_speed, release_spin_rate, description,
// pitch_type, game_date) against a live response — they're the well-documented
// public schema, not something this script has verified itself. Loud schema
// check + per-pitcher try/catch, same defensive pattern as the other two
// scripts, so one bad response can't take down the whole run. Treat the first
// scheduled run as unverified until its own log output (and the resulting
// data/pitcher-rolling.json) is manually checked.
// ─────────────────────────────────────────────────────────────────────────

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseCSV, PITCH_NAME_MAP } from './sync-pitcher-statcast.mjs';
import { todaysProbablePitcherIds, pitcherSearchURL } from './sync-pitcher-zone-hr.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const ROLLING_PATH = path.join(DATA_DIR, 'pitcher-rolling.json');

// Last N starts compared against the season baseline — 3 is enough to catch a
// real recent shift (a velocity dip, a new go-to pitch) while still being a
// real sample, not one shaky outing.
const ROLLING_STARTS = 3;
// A pitch type with fewer than this many pitches across the rolling window is
// too thin a sample for a rolling average to mean anything — dropped from the
// rolling comparison for that pitch (still counted in the season baseline).
const MIN_ROLLING_PITCHES = 8;

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

const SWING_DESCRIPTIONS = new Set(['swinging_strike', 'swinging_strike_blocked', 'foul', 'foul_tip', 'foul_bunt', 'hit_into_play', 'missed_bunt']);
const WHIFF_DESCRIPTIONS = new Set(['swinging_strike', 'swinging_strike_blocked']);

function buildPitcherRolling(csv, name) {
  const rows = parseCSV(csv);
  if (!rows.length) return null;
  const sample = rows[0];
  if (!('pitch_type' in sample) || !('game_date' in sample) || !('release_speed' in sample) || !('description' in sample)) {
    throw new Error(`unexpected CSV columns for ${name} — got [${Object.keys(sample).join(', ')}]`);
  }

  const dates = [...new Set(rows.map(r => r.game_date).filter(Boolean))].sort().reverse();
  const rollingDates = new Set(dates.slice(0, ROLLING_STARTS));
  if (!rollingDates.size) return null;

  // pitchName -> { seasonCount, seasonVeloSum, seasonSpinSum, seasonSpinCount,
  //                seasonSwings, seasonWhiffs, rollingCount, rollingVeloSum,
  //                rollingSpinSum, rollingSpinCount, rollingSwings, rollingWhiffs }
  const agg = {};
  let seasonTotal = 0, rollingTotal = 0;

  for (const r of rows) {
    const pitchType = r.pitch_type;
    if (!pitchType) continue;
    const pitchName = r.pitch_name || PITCH_NAME_MAP[pitchType] || pitchType;
    if (!agg[pitchName]) agg[pitchName] = {
      seasonCount: 0, seasonVeloSum: 0, seasonSpinSum: 0, seasonSpinCount: 0, seasonSwings: 0, seasonWhiffs: 0,
      rollingCount: 0, rollingVeloSum: 0, rollingSpinSum: 0, rollingSpinCount: 0, rollingSwings: 0, rollingWhiffs: 0,
    };
    const a = agg[pitchName];
    const velo = Number(r.release_speed);
    const spin = Number(r.release_spin_rate);
    const desc = r.description || '';
    const isSwing = SWING_DESCRIPTIONS.has(desc);
    const isWhiff = WHIFF_DESCRIPTIONS.has(desc);
    const inRolling = rollingDates.has(r.game_date);

    a.seasonCount++;
    seasonTotal++;
    if (Number.isFinite(velo)) a.seasonVeloSum += velo;
    if (Number.isFinite(spin)) { a.seasonSpinSum += spin; a.seasonSpinCount++; }
    if (isSwing) a.seasonSwings++;
    if (isWhiff) a.seasonWhiffs++;

    if (inRolling) {
      a.rollingCount++;
      rollingTotal++;
      if (Number.isFinite(velo)) a.rollingVeloSum += velo;
      if (Number.isFinite(spin)) { a.rollingSpinSum += spin; a.rollingSpinCount++; }
      if (isSwing) a.rollingSwings++;
      if (isWhiff) a.rollingWhiffs++;
    }
  }

  const byPitch = [];
  for (const [pitchName, a] of Object.entries(agg)) {
    if (a.rollingCount < MIN_ROLLING_PITCHES) continue;
    const seasonVelo = a.seasonCount > 0 ? a.seasonVeloSum / a.seasonCount : null;
    const rollingVelo = a.rollingCount > 0 ? a.rollingVeloSum / a.rollingCount : null;
    const seasonUsagePct = seasonTotal > 0 ? (a.seasonCount / seasonTotal) * 100 : null;
    const rollingUsagePct = rollingTotal > 0 ? (a.rollingCount / rollingTotal) * 100 : null;
    const seasonWhiffPct = a.seasonSwings > 0 ? (a.seasonWhiffs / a.seasonSwings) * 100 : null;
    const rollingWhiffPct = a.rollingSwings > 0 ? (a.rollingWhiffs / a.rollingSwings) * 100 : null;
    byPitch.push({
      name: pitchName,
      seasonVelo: seasonVelo != null ? +seasonVelo.toFixed(1) : null,
      rollingVelo: rollingVelo != null ? +rollingVelo.toFixed(1) : null,
      veloDelta: (seasonVelo != null && rollingVelo != null) ? +(rollingVelo - seasonVelo).toFixed(1) : null,
      seasonUsagePct: seasonUsagePct != null ? +seasonUsagePct.toFixed(1) : null,
      rollingUsagePct: rollingUsagePct != null ? +rollingUsagePct.toFixed(1) : null,
      usageDelta: (seasonUsagePct != null && rollingUsagePct != null) ? +(rollingUsagePct - seasonUsagePct).toFixed(1) : null,
      seasonWhiffPct: seasonWhiffPct != null ? +seasonWhiffPct.toFixed(1) : null,
      rollingWhiffPct: rollingWhiffPct != null ? +rollingWhiffPct.toFixed(1) : null,
      whiffDelta: (seasonWhiffPct != null && rollingWhiffPct != null) ? +(rollingWhiffPct - seasonWhiffPct).toFixed(1) : null,
    });
  }
  if (!byPitch.length) return null;
  byPitch.sort((a, b) => (b.rollingUsagePct || 0) - (a.rollingUsagePct || 0));

  return { lastStartDates: [...rollingDates].sort().reverse(), byPitch };
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  const ids = await todaysProbablePitcherIds();
  console.log(`Found ${ids.size} probable starter(s) for today.`);

  const out = { generatedAt: new Date().toISOString(), rollingStarts: ROLLING_STARTS, pitchers: {} };
  let updated = 0, failed = 0;
  for (const [id, name] of ids) {
    try {
      const csv = await fetchText(pitcherSearchURL(id));
      const result = buildPitcherRolling(csv, name);
      if (!result) { console.warn(`No usable rolling data for ${name} (${id}) — skipping.`); continue; }
      out.pitchers[id] = result;
      updated++;
    } catch (e) {
      failed++;
      console.error(`Rolling pitch metrics sync failed for ${name} (${id}):`, e.message);
    }
    // Same polite bounded-scope delay as sync-pitcher-zone-hr.mjs.
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`Updated ${updated} pitcher(s), ${failed} failed, out of ${ids.size} probable starters.`);
  if (updated > 0) {
    await writeFile(ROLLING_PATH, JSON.stringify(out, null, 2) + '\n');
  }
  if (failed > 0 && updated === 0) process.exitCode = 1;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch(e => { console.error(e); process.exit(1); });
}

export { buildPitcherRolling, main };
