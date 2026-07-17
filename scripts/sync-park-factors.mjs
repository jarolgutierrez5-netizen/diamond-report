#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Syncs Baseball Savant's Statcast Park Factors leaderboard into
// data/park-factors.json, keyed by MLB team_id (the same numeric ids already
// used throughout app.js's `teamIds` abbreviation map) — a hitter-friendly park
// like Coors Field should meaningfully raise HR-probability projections for a
// game played there, and a pitcher-friendly park should lower them, which
// nothing in this app currently accounts for.
//
// One whole-league CSV pull, not one request per team.
//
// Known limitation, same as every other Savant-based script here: this
// environment cannot reach baseballsavant.mlb.com to verify this leaderboard's
// exact columns/park-factor scale live. Park factors are conventionally
// index-scaled around 100 (100 = league average, 120 = 20% more of that
// outcome than average, 80 = 20% less) — that convention, not the exact column
// name, is what the app.js integration leans on, so a schema mismatch here
// fails loudly (real header always logged) rather than silently writing
// meaningless numbers into a scoring formula.
// ─────────────────────────────────────────────────────────────────────────

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseCSV } from './sync-pitcher-statcast.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const SEASON = new Date().getFullYear();
const BASE = 'https://baseballsavant.mlb.com/leaderboard';

const PARK_FACTORS_URL_CANDIDATES = [
  `${BASE}/statcast-park-factors?type=year&year=${SEASON}&batSide=&stat=index_wOBA&condition=All&rolling=1&csv=true`,
  `${BASE}/statcast-park-factors?type=year&year=${SEASON}&csv=true`,
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

async function buildParkFactors() {
  let lastErr;
  for (const url of PARK_FACTORS_URL_CANDIDATES) {
    let csv;
    try {
      csv = await fetchCSV(url);
    } catch (e) {
      console.warn(`Park-factors candidate ${url} failed to fetch: ${e.message}`);
      lastErr = e;
      continue;
    }
    const rows = parseCSV(csv);
    if (!rows.length) { lastErr = new Error('no data rows'); continue; }
    const sample = rows[0];
    const hasId = pick(sample, ['team_id', 'venue_id', 'home_team_id']) !== null;
    const hasAny = ['index_hr', 'index_HR', 'HR', 'index_wOBA', 'index_woba'].some(k => sample[k] !== undefined);
    if (!hasId || !hasAny) {
      console.warn(`Park-factors candidate ${url} returned data but not the expected columns: ${Object.keys(sample).join(', ')}`);
      lastErr = new Error('unexpected columns');
      continue;
    }
    const out = {};
    for (const r of rows) {
      const teamId = pick(r, ['team_id', 'home_team_id']);
      if (!teamId) continue;
      out[teamId] = {
        name: pick(r, ['name_display_club', 'venue_name', 'team_name']),
        hrIndex: num(pick(r, ['index_hr', 'index_HR', 'HR'])),
        wobaIndex: num(pick(r, ['index_wOBA', 'index_woba'])),
      };
    }
    const vals = Object.values(out);
    console.log(`Park-factors candidate ${url} matched schema — columns: ${Object.keys(sample).join(', ')}; ${vals.length} teams, ${vals.filter(v => v.hrIndex != null).length} with hrIndex (e.g. ${vals.find(v=>v.hrIndex!=null)?.name}: ${vals.find(v=>v.hrIndex!=null)?.hrIndex}), ${vals.filter(v => v.wobaIndex != null).length} with wobaIndex.`);
    return out;
  }
  throw lastErr;
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  let parkFactors;
  try {
    parkFactors = await buildParkFactors();
  } catch (e) {
    console.error('Park-factors sync failed:', e.message);
    process.exitCode = 1;
    return;
  }

  const out = { generatedAt: new Date().toISOString(), season: SEASON, teams: parkFactors };
  await writeFile(path.join(DATA_DIR, 'park-factors.json'), JSON.stringify(out, null, 2) + '\n');
  console.log(`Wrote park factors for ${Object.keys(parkFactors).length} teams.`);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch(e => { console.error(e); process.exit(1); });
}

export { buildParkFactors, main };
