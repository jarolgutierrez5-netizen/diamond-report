#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// "How does this pitcher perform on the 1st pitch of an at-bat vs the 2nd vs the
// 3rd-or-later" — a signal nothing else in this app answers. sync-pitcher-statcast.mjs
// (pre-aggregated pitch-arsenal leaderboard) and sync-pitcher-zone-hr.mjs/
// sync-pitcher-rolling.mjs (per-pitch Statcast Search CSV) all bucket by PITCH TYPE or
// by RECENCY — none bucket by where a pitch falls in the count. A pitcher who grooves
// well-located first pitches for called strikes but gets hit hard once he falls behind
// looks identical to one who's tough all the way through in every existing data file.
//
// Same bounded ~15-30/day scope, same Statcast Search CSV (one row per PITCH, with a
// real pitch_number column — the pitch's sequence within that plate appearance), same
// reuse of todaysProbablePitcherIds/pitcherSearchURL as sync-pitcher-rolling.mjs.
//
// wOBA-against is computed the exact same way as sync-pitcher-zone-hr.mjs's byZone
// (sum(woba_value)/sum(woba_denom), both columns Statcast itself only populates on the
// PA-ending pitch) rather than hand-rolling AVG/SLG from `events` — one real, already-
// used-elsewhere metric beats two more that would need their own AB-counting logic.
// Whiff% is computed the same way sync-pitcher-rolling.mjs computes it (swings vs
// swinging-strike descriptions), just bucketed by pitch_number instead of by start.
//
// Same live-verification caveat as the other Statcast Search-based scripts in this
// repo: this sandbox cannot reach baseballsavant.mlb.com to confirm the CSV's exact
// column names (pitch_number, woba_value, woba_denom, description, events) against a
// live response — they're the well-documented public schema, not something this
// script has verified itself. Loud schema check + per-pitcher try/catch, same
// defensive pattern as the other scripts, so one bad response can't take down the
// whole run. Treat the first scheduled run as unverified until its own log output
// (and the resulting data/pitcher-count-performance.json) is manually checked.
// ─────────────────────────────────────────────────────────────────────────

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseCSV } from './sync-pitcher-statcast.mjs';
import { todaysProbablePitcherIds, pitcherSearchURL } from './sync-pitcher-zone-hr.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const OUT_PATH = path.join(DATA_DIR, 'pitcher-count-performance.json');

// A bucket with fewer than this many pitches is too thin a sample to report a
// whiff%/wOBA for — dropped from the output for that bucket rather than shown as a
// misleadingly precise-looking number off a handful of pitches.
const MIN_BUCKET_PITCHES = 15;

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

const WHIFF_DESCRIPTIONS = new Set(['swinging_strike', 'swinging_strike_blocked']);
const SWING_DESCRIPTIONS = new Set(['swinging_strike', 'swinging_strike_blocked', 'foul', 'foul_tip', 'foul_bunt', 'hit_into_play', 'missed_bunt']);

// pitch_number -> bucket label. 1st and 2nd pitch of the at-bat get their own bucket;
// everything from the 3rd pitch on (a batter who's worked the count deep) is one
// combined bucket, same "real sample size over false precision" reasoning
// sync-pitcher-rolling.mjs's MIN_ROLLING_PITCHES comment uses.
function bucketFor(pitchNumber) {
  if (pitchNumber === 1) return '1st';
  if (pitchNumber === 2) return '2nd';
  if (pitchNumber >= 3) return '3rd+';
  return null;
}
const BUCKET_ORDER = ['1st', '2nd', '3rd+'];

function buildPitcherCountPerformance(csv, name) {
  const rows = parseCSV(csv);
  if (!rows.length) return null;
  const sample = rows[0];
  if (!('pitch_number' in sample) || !('description' in sample) || !('woba_value' in sample) || !('woba_denom' in sample) || !('events' in sample)) {
    throw new Error(`unexpected CSV columns for ${name} — got [${Object.keys(sample).join(', ')}]`);
  }

  // bucket -> { pitches, swings, whiffs, wobaSum, denomSum, homeRuns }
  const agg = {};
  for (const b of BUCKET_ORDER) agg[b] = { pitches: 0, swings: 0, whiffs: 0, wobaSum: 0, denomSum: 0, homeRuns: 0 };

  for (const r of rows) {
    const pitchNumber = Number(r.pitch_number);
    const bucket = bucketFor(pitchNumber);
    if (!bucket) continue;
    const a = agg[bucket];
    a.pitches++;
    const desc = r.description || '';
    if (SWING_DESCRIPTIONS.has(desc)) a.swings++;
    if (WHIFF_DESCRIPTIONS.has(desc)) a.whiffs++;
    const wobaValue = r.woba_value === '' || r.woba_value == null ? null : Number(r.woba_value);
    const wobaDenom = r.woba_denom === '' || r.woba_denom == null ? null : Number(r.woba_denom);
    if (Number.isFinite(wobaValue) && Number.isFinite(wobaDenom)) {
      a.wobaSum += wobaValue;
      a.denomSum += wobaDenom;
    }
    if (r.events === 'home_run') a.homeRuns++;
  }

  const byCount = [];
  for (const bucket of BUCKET_ORDER) {
    const a = agg[bucket];
    if (a.pitches < MIN_BUCKET_PITCHES) continue;
    byCount.push({
      bucket,
      pitches: a.pitches,
      woba: a.denomSum > 0 ? +(a.wobaSum / a.denomSum).toFixed(3) : null,
      whiffPct: a.swings > 0 ? +((a.whiffs / a.swings) * 100).toFixed(1) : null,
      homeRuns: a.homeRuns,
    });
  }
  if (!byCount.length) return null;
  return { byCount };
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  const ids = await todaysProbablePitcherIds();
  console.log(`Found ${ids.size} probable starter(s) for today.`);

  const out = { generatedAt: new Date().toISOString(), pitchers: {} };
  let updated = 0, failed = 0;
  for (const [id, name] of ids) {
    try {
      const csv = await fetchText(pitcherSearchURL(id));
      const result = buildPitcherCountPerformance(csv, name);
      if (!result) { console.warn(`No usable count-performance data for ${name} (${id}) — skipping.`); continue; }
      out.pitchers[id] = result;
      updated++;
    } catch (e) {
      failed++;
      console.error(`Pitch-count performance sync failed for ${name} (${id}):`, e.message);
    }
    // Same polite bounded-scope delay as sync-pitcher-rolling.mjs/sync-pitcher-zone-hr.mjs.
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`Updated ${updated} pitcher(s), ${failed} failed, out of ${ids.size} probable starters.`);
  if (updated > 0) {
    await writeFile(OUT_PATH, JSON.stringify(out, null, 2) + '\n');
  }
  if (failed > 0 && updated === 0) process.exitCode = 1;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch(e => { console.error(e); process.exit(1); });
}

export { buildPitcherCountPerformance, bucketFor, main };
