#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Syncs Baseball Savant's Statcast Park Factors leaderboard into
// data/park-factors.json, keyed by MLB team_id (the same numeric ids already
// used throughout app.js's `teamIds` abbreviation map) — a hitter-friendly park
// like Coors Field should meaningfully raise HR-probability projections for a
// game played there, and a pitcher-friendly park should lower them, which
// nothing in this app currently accounts for.
//
// This leaderboard is one of Baseball Savant's newer React-rendered pages —
// unlike every other leaderboard this repo scrapes, its `&csv=true` param does
// NOT trigger a CSV export; it returns the same HTML page regardless (confirmed
// live: every query-param variation tried still came back as text/html, never
// text/csv). The real data is embedded inline in that HTML as a plain
// `var data = [...]` JS array assignment, so this fetches the page itself and
// parses that array out with a regex + JSON.parse instead of a CSV export.
//
// Confirmed live column names on that embedded array (2026 season, Coors Field
// and Oracle Park rows): grouping_venue_conditions, key_is_year_rolling,
// key_num_years_rolling, key_year, key_bat_side, venue_id, venue_name,
// main_team_id, name_display_club, n_pa, index_runs, index_hardhit,
// index_woba, index_wobatto, index_wobacon, index_xwobacon, index_xbacon,
// index_obp, index_so, index_bb, index_bacon, index_hits, index_1b, index_2b,
// index_3b, index_hr, year_range. team_id lives under main_team_id (not
// team_id/home_team_id, which is what every earlier attempt here guessed and
// is why this never worked) and the real per-park HR factor is index_hr.
// ─────────────────────────────────────────────────────────────────────────

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const SEASON = new Date().getFullYear();
const URL = `https://baseballsavant.mlb.com/leaderboard/statcast-park-factors?type=year&year=${SEASON}&batSide=&stat=index_wOBA&condition=All&rolling=1`;

async function fetchText(url, attempts = 3) {
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

function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : null; }

async function buildParkFactors() {
  const html = await fetchText(URL);
  const m = html.match(/var\s+data\s*=\s*(\[[\s\S]*?\]);/);
  if (!m) throw new Error('embedded "var data = [...]" array not found in park-factors HTML — Baseball Savant may have changed how this page renders');

  let rows;
  try {
    rows = JSON.parse(m[1]);
  } catch (e) {
    throw new Error(`embedded park-factors data failed to parse as JSON: ${e.message}`);
  }
  if (!rows.length) throw new Error('embedded park-factors array had no rows');

  // Loud schema check, same spirit as every other sync script here — bail rather
  // than silently writing data built from fields that don't exist.
  const sample = rows[0];
  if (!('main_team_id' in sample) || !('index_hr' in sample)) {
    throw new Error(`unexpected park-factors row shape — got [${Object.keys(sample).join(', ')}]`);
  }

  const out = {};
  for (const r of rows) {
    const teamId = r.main_team_id;
    if (!teamId) continue;
    out[teamId] = {
      name: r.venue_name || r.name_display_club || null,
      hrIndex: num(r.index_hr),
      wobaIndex: num(r.index_woba),
    };
  }
  const vals = Object.values(out);
  console.log(`Park-factors matched — ${vals.length} teams, ${vals.filter(v => v.hrIndex != null).length} with hrIndex (e.g. ${vals.find(v=>v.hrIndex!=null)?.name}: ${vals.find(v=>v.hrIndex!=null)?.hrIndex}), ${vals.filter(v => v.wobaIndex != null).length} with wobaIndex.`);
  return out;
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
