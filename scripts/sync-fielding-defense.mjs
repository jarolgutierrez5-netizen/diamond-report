#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Merges real defensive metrics — Outs Above Average (OAA) and Arm Strength — from
// Baseball Savant's public leaderboards into the existing per-player records in
// data/statcast-hot-hitters.json (same file sync-statcast-hot-hitters.mjs writes,
// same id-keyed shape app.js's getStatcastHotHitterProfile() already reads from).
// Kept as its own script rather than folded into sync-statcast-hot-hitters.mjs —
// same reasoning as sync-pitcher-zone-hr.mjs merging into pitcher-statcast.json: a
// distinct data source and concern (fielding, not hitting), so a distinct script
// that reads-then-merges rather than owns the whole file.
//
// Two whole-league CSV pulls, not one request per player, matching every other
// sync script in this repo. Only merges onto players who already have a hitting
// record in the file — a pure-defense player with zero offensive signal has no UI
// surface to display this on anyway (see app.js "Hot Streak Signals" panel).
//
// Known limitation, same as every other Savant-based script here: this environment
// cannot reach baseballsavant.mlb.com to verify these leaderboard URLs/columns live.
// Column names are the well-documented public schema from years of community
// sabermetric tooling, not confirmed against a live response — schema mismatches are
// logged loudly (real header + per-field populated counts) rather than silently
// writing wrong data, so the first live run should be checked manually.
// ─────────────────────────────────────────────────────────────────────────

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseCSV } from './sync-pitcher-statcast.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const HOT_HITTERS_PATH = path.join(DATA_DIR, 'statcast-hot-hitters.json');
const SEASON = new Date().getFullYear();
const BASE = 'https://baseballsavant.mlb.com/leaderboard';

const OAA_URL = `${BASE}/outs_above_average?type=Fielder&startYear=${SEASON}&endYear=${SEASON}&split=no&team=&range=year&min=1&pos=&roles=&viz=hide&csv=true`;
const ARM_STRENGTH_URL_CANDIDATES = [
  `${BASE}/arm-strength?type=Fielder&year=${SEASON}&team=&pos=&min=1&csv=true`,
  `${BASE}/custom?year=${SEASON}&type=fielder&filter=&min=1&selections=arm_strength,avg_arm_strength,arm_strength_max&chart=false&x=arm_strength&y=arm_strength&r=no&chartType=beeswarm&sort=arm_strength&sortDir=desc&csv=true`,
];

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

async function buildOAA() {
  const csv = await fetchCSV(OAA_URL);
  const rows = parseCSV(csv);
  if (!rows.length) throw new Error('Outs Above Average leaderboard: CSV had no data rows');
  const sample = rows[0];
  const hasId = pick(sample, ['player_id', 'entity_id', 'mlbam_id']) !== null;
  const hasAny = ['outs_above_average', 'oaa', 'runs_prevented'].some(k => sample[k] !== undefined);
  if (!hasId || !hasAny) {
    throw new Error(`Outs Above Average leaderboard: unexpected CSV columns — got [${Object.keys(sample).join(', ')}]. Baseball Savant may have changed its schema.`);
  }
  const out = {};
  for (const r of rows) {
    const id = pick(r, ['player_id', 'entity_id', 'mlbam_id']);
    if (!id) continue;
    out[id] = { oaa: num(pick(r, ['outs_above_average', 'oaa'])) };
  }
  const vals = Object.values(out);
  console.log(`OAA leaderboard matched schema — columns: ${Object.keys(sample).join(', ')}; ${vals.length} players, ${vals.filter(v => v.oaa != null).length} with oaa.`);
  return out;
}

async function buildArmStrength() {
  let lastErr;
  for (const url of ARM_STRENGTH_URL_CANDIDATES) {
    let csv;
    try {
      csv = await fetchCSV(url);
    } catch (e) {
      console.warn(`Arm-strength candidate ${url} failed to fetch: ${e.message}`);
      lastErr = e;
      continue;
    }
    const rows = parseCSV(csv);
    if (!rows.length) { lastErr = new Error('no data rows'); continue; }
    const sample = rows[0];
    const hasId = pick(sample, ['player_id', 'entity_id', 'mlbam_id']) !== null;
    // arm_overall (season-average arm strength across all throw types) and
    // max_arm_strength (hardest single competitive throw) confirmed live as the real
    // column names on the direct leaderboard — arm_strength/avg_arm_strength never
    // actually exist there, only on the custom-leaderboard fallback (which in turn
    // blanks those exact codes on every row, same issue seen with plate discipline).
    const hasAny = ['arm_overall', 'max_arm_strength', 'arm_strength', 'avg_arm_strength'].some(k => sample[k] !== undefined);
    if (!hasId || !hasAny) {
      console.warn(`Arm-strength candidate ${url} returned data but not the expected columns: ${Object.keys(sample).join(', ')}`);
      lastErr = new Error('unexpected columns');
      continue;
    }
    const out = {};
    for (const r of rows) {
      const id = pick(r, ['player_id', 'entity_id', 'mlbam_id']);
      if (!id) continue;
      out[id] = { armStrength: num(pick(r, ['arm_overall', 'max_arm_strength', 'arm_strength', 'avg_arm_strength'])) };
    }
    const vals = Object.values(out);
    console.log(`Arm-strength candidate ${url} matched schema — columns: ${Object.keys(sample).join(', ')}; ${vals.length} players, ${vals.filter(v => v.armStrength != null).length} with armStrength.`);
    return out;
  }
  throw lastErr;
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  let hotHitters;
  try {
    hotHitters = JSON.parse(await readFile(HOT_HITTERS_PATH, 'utf8'));
  } catch (e) {
    console.error('statcast-hot-hitters.json not found or unreadable — run sync-statcast-hot-hitters.mjs first. ' + e.message);
    process.exitCode = 1;
    return;
  }
  if (!Array.isArray(hotHitters.players)) {
    console.error('statcast-hot-hitters.json has no players array — nothing to merge onto.');
    process.exitCode = 1;
    return;
  }

  let oaa = {}, armStrength = {};
  try {
    oaa = await buildOAA();
  } catch (e) {
    console.warn('OAA sync failed (non-fatal):', e.message);
  }
  try {
    armStrength = await buildArmStrength();
  } catch (e) {
    console.warn('Arm-strength sync failed (non-fatal):', e.message);
  }

  let merged = 0;
  for (const p of hotHitters.players) {
    const o = oaa[p.playerId];
    const a = armStrength[p.playerId];
    if (o?.oaa != null) { p.oaa = o.oaa; merged++; }
    if (a?.armStrength != null) p.armStrength = a.armStrength;
  }

  hotHitters.generatedAt = new Date().toISOString();
  await writeFile(HOT_HITTERS_PATH, JSON.stringify(hotHitters, null, 2) + '\n');
  console.log(`Merged defensive metrics onto ${merged} of ${hotHitters.players.length} existing batter records.`);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch(e => { console.error(e); process.exit(1); });
}

export { buildOAA, buildArmStrength, main };
