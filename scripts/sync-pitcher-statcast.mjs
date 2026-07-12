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
// HR(-allowed/hit) and Barrel% per pitch type: the bulk pitch-arsenal leaderboard above
// does NOT have these for either pitchers or batters (confirmed by inspecting its real
// CSV output, and by inspecting the equivalent static "Pitch Arsenal Stats" table on a
// real batter's Savant page — no hr/barrel columns in either). They *do* exist on
// Baseball Savant's own per-player pages, via a separate endpoint
// (player-services/statcast-pitches-breakdown) — confirmed real and verified via actual
// captured browser responses for both a real pitcher's page and a real batter's page,
// unlike the leaderboard endpoint above. See enrichHRAndBarrel.
// ─────────────────────────────────────────────────────────────────────────

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const SEASON = new Date().getFullYear();
const BASE = 'https://baseballsavant.mlb.com/leaderboard/pitch-arsenal-stats';
const PITCH_BREAKDOWN_BASE = 'https://baseballsavant.mlb.com/player-services/statcast-pitches-breakdown';
const SAVANT_HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; DiamondReportBot/1.0; +https://diamondreport.app)' };
// The 2026-07-12 run enriched 0/721 pitchers and 0/594 batters — every single request to
// PITCH_BREAKDOWN_BASE failed, while the CSV leaderboard fetch (same SAVANT_HEADERS)
// succeeded for all of them. That points at this specific endpoint rejecting requests
// that don't look like they came from a real page load — it's an internal AJAX endpoint
// a browser only calls after already loading a player page, unlike the public CSV
// leaderboard export. Adding the headers a real browser would send for that AJAX call
// (Referer of the actual player page, Accept/X-Requested-With matching jQuery's default
// AJAX headers, which Savant's own front-end uses) as an untested hypothesis — paired
// with the failure logging below so the next run's logs confirm whether this was the
// actual cause or something else (rate limiting, schema change, etc).
const PITCH_BREAKDOWN_HEADERS = Object.assign({}, SAVANT_HEADERS, {
  'Accept': 'application/json, text/javascript, */*; q=0.01',
  'X-Requested-With': 'XMLHttpRequest',
});

async function fetchCSV(url, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { headers: SAVANT_HEADERS });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw lastErr;
}

async function fetchJSON(url, attempts = 2, headers = SAVANT_HEADERS) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw lastErr;
}

// Bounded-concurrency map — same shape as the one in update-tracker.mjs. Keeps this
// script's zero-dependency, self-contained style while being polite to Savant's
// servers across ~700+ individual per-pitcher requests.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
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
    // Kept around (not shown in the UI) purely to key the HR/barrel enrichment pass
    // below against Baseball Savant's own api_pitch_type codes (FF/CH/ST/SI/...).
    pitchTypeCode: pitchType,
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
    // Always null from this leaderboard row alone — the pitch-arsenal-stats endpoint
    // has no HR/barrel columns. Populated for real by enrichPitcherHRAndBarrel, which
    // fetches each pitcher's actual per-pitch breakdown from a different, confirmed
    // endpoint (see the file header comment).
    homeRuns: num(pick(r, ['home_run', 'home_runs', 'hr'])),
    barrelPct: null,
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
  // Strict enhancement over the CSV data above — never let a bug or outage here take
  // down a sync that otherwise succeeded.
  try {
    await enrichHRAndBarrel(pitchers, { position: 1, arrayKey: 'byPitch', label: 'pitchers' });
  } catch (e) {
    console.error('HR/Barrel% enrichment failed entirely, continuing without it:', e.message);
  }
  return pitchers;
}

// Fills in real HR-allowed/hit and Barrel% per pitch type — genuinely absent from the
// bulk leaderboard CSV above, but present on Baseball Savant's own per-player pages via
// this endpoint (confirmed real: verified this session against actual captured browser
// responses for both a pitcher and a batter page, not inferred). `position` is the fixed
// sentinel Savant's own front-end sends for each role — 1 for "as pitcher", 3 for
// "as batter" — not a real fielding position (confirmed for batters via a second,
// unrelated widget on Shohei Ohtani's page using the same position=3 for his batting
// context despite his actual position being DH). One request per player, keyed by
// numeric player ID rather than a name-based URL slug (which would be fragile for
// accented/suffixed names) — bounded concurrency to stay reasonable across hundreds of
// players without hammering Savant. Failures are per-player and non-fatal: a player who
// can't be enriched just keeps the CSV-only data (HR/barrel stay null), exactly like
// before this existed — this is a strict enhancement, never a reason to fail the sync.
async function enrichHRAndBarrel(entities, { position, arrayKey, label }) {
  const ids = Object.keys(entities);
  if (!ids.length) return;
  let enriched = 0, failed = 0;
  const sampleErrors = [];
  await mapLimit(ids, 8, async (id) => {
    try {
      const url = `${PITCH_BREAKDOWN_BASE}?playerId=${id}&position=${position}&hand=&pitchBreakdown=pitches&timeFrame=yearly&season=&pitchType=&count=&gameType=&updatePitches=true`;
      const headers = Object.assign({}, PITCH_BREAKDOWN_HEADERS, { 'Referer': `https://baseballsavant.mlb.com/savant-player/${id}` });
      const data = await fetchJSON(url, 2, headers);
      const breakdown = Array.isArray(data) ? data : (data?.pitchDetails || data?.data || []);
      const thisSeason = breakdown.filter(row => String(row.year) === String(SEASON));
      if (!thisSeason.length) return;
      const byCode = {};
      thisSeason.forEach(row => {
        const code = row.api_pitch_type;
        if (!code) return;
        byCode[code] = { hr: num(row.hr), barrelPct: num(row.brl_percent) };
      });
      let touched = false;
      entities[id][arrayKey].forEach(stat => {
        const hit = byCode[stat.pitchTypeCode];
        if (!hit) return;
        stat.homeRuns = hit.hr;
        stat.barrelPct = hit.barrelPct;
        touched = true;
      });
      if (touched) enriched++;
    } catch (e) {
      failed++;
      // Every one of these was previously swallowed silently — the 2026-07-12 run
      // reported "0/721 enriched (721 failed)" with zero clue why. Keep a few real
      // error messages so the next run's logs actually say what's wrong.
      if (sampleErrors.length < 5) sampleErrors.push(`${id}: ${e.message}`);
    }
  });
  if (sampleErrors.length) console.log(`HR/Barrel% enrichment (${label}) sample failures:\n  ${sampleErrors.join('\n  ')}`);
  console.log(`HR/Barrel% enrichment (${label}): ${enriched}/${ids.length} enriched (${failed} failed).`);
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
  // Strict enhancement over the CSV data above — never let a bug or outage here take
  // down a sync that otherwise succeeded. See enrichHRAndBarrel's comment for why
  // position=3 is correct here.
  try {
    await enrichHRAndBarrel(players, { position: 3, arrayKey: 'seasonPitchTypeStats', label: 'batters' });
  } catch (e) {
    console.error('HR/Barrel% enrichment failed entirely, continuing without it:', e.message);
  }
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

export { parseCSV, rowToPitchStat, assertSchema, buildPitcherStatcast, buildBatterPitchSeason, enrichHRAndBarrel, main };
