#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Syncs real per-pitch-type Statcast data from Baseball Savant's public pitch-arsenal
// leaderboard (no API key required) into data/pitcher-statcast.json and
// data/batter-pitch-type-season.json — the exact shapes app.js's client-side loaders
// (loadPitcherStatcast / loadBatterPitchTypeSeason) already expect.
//
// Why this exists: the Pitcher Matchup modal's per-pitch-type tables used to fall back
// to an algorithmically modeled estimate whenever these files were missing — which was
// *always*, since this sync never existed before. That fallback has been removed from
// app.js; this script is what actually populates real data so the tables show genuine
// numbers instead of "No real pitch-level data available."
//
// Zero npm dependencies (built-in fetch + a small hand-rolled CSV parser), matching
// scripts/update-tracker.mjs's approach so no package.json/npm install step is needed.
//
// Known limitation: Baseball Savant's pitch-arsenal leaderboard is a public endpoint,
// not a documented/versioned API, so its exact column names are inferred from public
// usage rather than verified live (this environment cannot reach baseballsavant.mlb.com
// to confirm). The schema sanity check below fails loudly if the expected columns are
// missing, rather than silently writing wrong data — treat the first scheduled run as
// unverified until its output is manually checked.
//
// Career pitcher stats (see buildPitcherCareerStatcast): this same leaderboard endpoint
// returns the WHOLE LEAGUE in one CSV per year requested — it's not a per-pitcher pull —
// so building a "career" view just means repeating this same cheap whole-league fetch
// once per season back to STATCAST_START_YEAR (Statcast's public pitch-tracking data
// starts in 2015) and blending the per-pitch-type rows across years, weighted by that
// year's real pitch count for that pitch type. Still bounded and cheap (~11 total
// requests/day as of 2026, not 11-per-pitcher), morning-run only like the season pull
// this shares its schema/parser with.
// ─────────────────────────────────────────────────────────────────────────

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const SEASON = new Date().getFullYear();
const BASE = 'https://baseballsavant.mlb.com/leaderboard/pitch-arsenal-stats';
// Statcast's public pitch-tracking data starts in the 2015 season — pulling "career"
// further back than this simply isn't possible from this endpoint (or any public
// Statcast source), so this is a real data-availability floor, not an arbitrary cutoff.
const STATCAST_START_YEAR = 2015;

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

// Minimal RFC4180-ish CSV parser — handles quoted fields with embedded commas/quotes
// (Savant exports player names as "Last, First").
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0].map(h => h.trim());
  return rows.slice(1).map(r => {
    const obj = {};
    header.forEach((h, i) => { obj[h] = r[i]; });
    return obj;
  });
}

function pick(obj, keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return null;
}
function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : null; }

const PITCH_NAME_MAP = {
  FF: '4-Seam Fastball', SI: 'Sinker / 2-Seam', FC: 'Cutter', SL: 'Slider',
  ST: 'Sweeper', SV: 'Slurve', CU: 'Curveball', KC: 'Curveball', CH: 'Changeup',
  FS: 'Splitter', FO: 'Splitter', SC: 'Screwball', EP: 'Eephus', KN: 'Knuckleball',
};

function rowToPitchStat(r) {
  const pitchType = pick(r, ['pitch_type']);
  const pitchNameRaw = pick(r, ['pitch_name']);
  const name = pitchNameRaw || PITCH_NAME_MAP[pitchType] || pitchType || 'Unknown';
  return {
    name,
    usagePct: num(pick(r, ['pitch_usage'])),
    pitches: num(pick(r, ['pitches'])),
    avg: num(pick(r, ['ba'])),
    slg: num(pick(r, ['slg'])),
    xslg: num(pick(r, ['est_slg', 'xslg'])),
    xba: num(pick(r, ['est_ba', 'xba'])),
    woba: num(pick(r, ['woba'])),
    xwoba: num(pick(r, ['est_woba', 'xwoba'])),
    whiffPct: num(pick(r, ['whiff_percent'])),
    hardHitPct: num(pick(r, ['hard_hit_percent'])),
    // The pitch-arsenal leaderboard may not carry a barrel column at all (barrel% is
    // more commonly published per-player, not per-pitch-type) — these are best-effort
    // candidate names; barrelPct stays null if none of them exist in the response,
    // same graceful-degradation behavior as every other field here.
    barrelPct: num(pick(r, ['barrel_batted_rate', 'brl_percent', 'barrel_percent', 'barrels_per_bbe_percent'])),
    // Same caveat as above — genuinely unknown until sync-pitcher-zone-hr.mjs (which
    // runs after this script) fills in real per-pitch-type HR counts for today's
    // probable starters from Statcast Search. Left null here on purpose rather than 0.
    homeRuns: num(pick(r, ['home_run', 'home_runs', 'hr'])),
  };
}

// Fails loudly if the CSV doesn't look like the schema this script expects, instead of
// silently producing an empty or garbage data file.
function assertSchema(rows, label) {
  if (!rows.length) throw new Error(`${label}: CSV had no data rows`);
  const sample = rows[0];
  const hasId = pick(sample, ['player_id', 'pitcher_id', 'batter_id', 'mlbam_id']) !== null;
  const hasPitchType = pick(sample, ['pitch_type']) !== null;
  if (!hasId || !hasPitchType) {
    throw new Error(`${label}: unexpected CSV columns — got [${Object.keys(sample).join(', ')}]. Baseball Savant may have changed its schema.`);
  }
}

async function buildPitcherStatcast() {
  const url = `${BASE}?type=pitcher&pitchType=&year=${SEASON}&team=&min=1&csv=true`;
  const csv = await fetchCSV(url);
  const rows = parseCSV(csv);
  assertSchema(rows, 'pitcher pitch-arsenal');
  const pitchers = {};
  for (const r of rows) {
    const id = pick(r, ['player_id', 'pitcher_id', 'mlbam_id']);
    if (!id) continue;
    const stat = rowToPitchStat(r);
    if (!pitchers[id]) pitchers[id] = { totalPitches: 0, byPitch: [] };
    pitchers[id].byPitch.push(stat);
    pitchers[id].totalPitches += stat.pitches || 0;
  }
  // Primary pitch leads each pitcher's table.
  Object.values(pitchers).forEach(p => p.byPitch.sort((a, b) => (b.usagePct || 0) - (a.usagePct || 0)));
  return pitchers;
}

// Builds a "career" (STATCAST_START_YEAR-present) per-pitch-type profile per pitcher
// by fetching this same whole-league leaderboard once per season and blending each
// pitch type's rate stats across years, weighted by that year's real pitch count for
// that pitch type — a pitcher who threw 2000 sliders in his peak season and 50 in a
// rookie cup of coffee shouldn't have those two seasons count equally.
async function buildPitcherCareerStatcast() {
  const buckets = {}; // id -> pitchName -> { pitchesSum, sums: {stat:weightedSum}, weights: {stat:pitchWeight} }
  for (let year = STATCAST_START_YEAR; year <= SEASON; year++) {
    let rows;
    try {
      const url = `${BASE}?type=pitcher&pitchType=&year=${year}&team=&min=1&csv=true`;
      const csv = await fetchCSV(url);
      rows = parseCSV(csv);
      assertSchema(rows, `pitcher pitch-arsenal (career, ${year})`);
    } catch (e) {
      console.warn(`Career pitch-arsenal fetch failed for ${year}, skipping that season:`, e.message);
      continue;
    }
    for (const r of rows) {
      const id = pick(r, ['player_id', 'pitcher_id', 'mlbam_id']);
      if (!id) continue;
      const stat = rowToPitchStat(r);
      const pitches = stat.pitches || 0;
      if (!pitches) continue;
      if (!buckets[id]) buckets[id] = {};
      if (!buckets[id][stat.name]) buckets[id][stat.name] = { pitchesSum: 0, sums: {}, weights: {} };
      const bucket = buckets[id][stat.name];
      bucket.pitchesSum += pitches;
      ['avg', 'slg', 'xslg', 'xba', 'woba', 'xwoba', 'whiffPct', 'hardHitPct', 'barrelPct'].forEach(k => {
        if (stat[k] != null) {
          bucket.sums[k] = (bucket.sums[k] || 0) + (stat[k] * pitches);
          bucket.weights[k] = (bucket.weights[k] || 0) + pitches;
        }
      });
    }
    // Polite delay between requests — cheap whole-league pulls, but still real
    // outbound calls to a public endpoint with no documented rate limit.
    await new Promise(r => setTimeout(r, 500));
  }

  const pitchers = {};
  for (const [id, byName] of Object.entries(buckets)) {
    const byPitch = Object.entries(byName).map(([name, bucket]) => {
      const stat = { name, pitches: bucket.pitchesSum, usagePct: null, homeRuns: null };
      ['avg', 'slg', 'xslg', 'xba', 'woba', 'xwoba', 'whiffPct', 'hardHitPct', 'barrelPct'].forEach(k => {
        stat[k] = bucket.weights[k] ? bucket.sums[k] / bucket.weights[k] : null;
      });
      return stat;
    });
    const totalPitches = byPitch.reduce((sum, p) => sum + (p.pitches || 0), 0);
    byPitch.forEach(p => { p.usagePct = totalPitches > 0 ? +((p.pitches / totalPitches) * 100).toFixed(1) : null; });
    byPitch.sort((a, b) => (b.usagePct || 0) - (a.usagePct || 0));
    pitchers[id] = { totalPitches, byPitch };
  }
  return pitchers;
}

async function buildBatterPitchSeason() {
  const url = `${BASE}?type=batter&pitchType=&year=${SEASON}&team=&min=1&csv=true`;
  const csv = await fetchCSV(url);
  const rows = parseCSV(csv);
  assertSchema(rows, 'batter pitch-arsenal');
  const players = {};
  for (const r of rows) {
    const id = pick(r, ['player_id', 'batter_id', 'mlbam_id']);
    if (!id) continue;
    const stat = rowToPitchStat(r);
    if (!players[id]) players[id] = { seasonPitchTypeStats: [] };
    players[id].seasonPitchTypeStats.push(stat);
  }
  Object.values(players).forEach(p => p.seasonPitchTypeStats.sort((a, b) => (b.usagePct || 0) - (a.usagePct || 0)));
  return players;
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  let pitchers = {}, players = {};
  let pitcherErr = null, batterErr = null;
  try {
    pitchers = await buildPitcherStatcast();
  } catch (e) {
    pitcherErr = e.message;
    console.error('Pitcher pitch-arsenal sync failed:', e.message);
  }
  try {
    players = await buildBatterPitchSeason();
  } catch (e) {
    batterErr = e.message;
    console.error('Batter pitch-arsenal sync failed:', e.message);
  }

  // Career is a nice-to-have layered on top of the season data above, not a
  // requirement for this script to succeed — a failure here (or a slow year or two
  // in the STATCAST_START_YEAR..SEASON loop) shouldn't stop the season sync from
  // being written. Merged onto the already-built pitchers object by ID; a pitcher
  // with no career data (e.g. a real fetch failure) simply has no `career` key
  // rather than a fabricated one, same graceful-degradation rule as everywhere else.
  if (!pitcherErr) {
    try {
      const careerPitchers = await buildPitcherCareerStatcast();
      for (const [id, careerStat] of Object.entries(careerPitchers)) {
        if (pitchers[id]) pitchers[id].career = careerStat;
      }
      console.log(`Synced career pitch-arsenal data for ${Object.keys(careerPitchers).length} pitcher(s).`);
    } catch (e) {
      console.error('Career pitch-arsenal sync failed (season data still written):', e.message);
    }
  }

  // Only overwrite an existing file with an empty result if this run actually errored —
  // a genuinely empty leaderboard response (e.g. off-season) shouldn't nuke yesterday's
  // real data, but a real successful empty result should still write through.
  const pitcherOut = { generatedAt: new Date().toISOString(), season: SEASON, pitchers };
  const batterOut = { generatedAt: new Date().toISOString(), season: SEASON, players };

  if (!pitcherErr) {
    await writeFile(path.join(DATA_DIR, 'pitcher-statcast.json'), JSON.stringify(pitcherOut, null, 2) + '\n');
  }
  if (!batterErr) {
    await writeFile(path.join(DATA_DIR, 'batter-pitch-type-season.json'), JSON.stringify(batterOut, null, 2) + '\n');
  }

  console.log(`Synced ${Object.keys(pitchers).length} pitchers, ${Object.keys(players).length} batters for ${SEASON}.`);
  if (pitcherErr || batterErr) process.exitCode = 1;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch(e => { console.error(e); process.exit(1); });
}

export { parseCSV, rowToPitchStat, assertSchema, buildPitcherStatcast, buildPitcherCareerStatcast, buildBatterPitchSeason, main, PITCH_NAME_MAP };
