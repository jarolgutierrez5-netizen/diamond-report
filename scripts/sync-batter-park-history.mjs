#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Batter's real career performance at each specific MLB ballpark -- distinct
// from the existing league-wide park-factor number (sync-park-factors.mjs),
// which says "this park inflates HRs by X% for everyone" but nothing about
// how THIS batter in particular has actually hit there. The Matchup modal
// already knows todayParkAbbr (whichever team is hosting today's game); this
// lets it show real AB/H/HR/AVG/SLG for that specific venue.
//
// Same Statcast Search CSV source and today's-active-batters scope as
// sync-batter-zone-hr.mjs (one row per pitch, real events/home_team on the
// final pitch of each plate appearance) -- reuses its todaysActiveBatterIds
// and batterSearchURL rather than re-fetching or re-deriving either. Grouped
// by home_team (the team hosting THAT game, i.e. that game's real venue) on
// every row, not the batter's own team -- a batter's road games at a park
// count same as a batter whose own team happens to play there.
//
// events only populates on the last pitch of a plate appearance (every other
// pitch in that PA has an empty events field) -- same convention already
// relied on throughout sync-pitcher-zone-hr.mjs/sync-batter-zone-hr.mjs for
// isHomeRun. AB here follows the standard official-scoring exclusions (walks,
// HBP, sacrifices, catcher's interference don't count as at-bats); anything
// else with a real events value is counted as a plate appearance that
// resulted in an official at-bat.
//
// Same live-verification caveat as every other Statcast Search-based script
// in this repo: this sandbox cannot reach baseballsavant.mlb.com to confirm
// the CSV's exact column names/values against a live response -- home_team is
// the same well-documented public column sync-batter-zone-hr.mjs's own
// `matchup` field already builds from ([raw.away_team, raw.home_team]), and
// is assumed here to use the same short abbreviation convention
// (parkFactors/homeAbbr) the rest of this app already keys its own park
// lookups on. Treat the first scheduled run as unverified until its own log
// output (and the resulting data/batter-park-history.json) is manually
// checked against a known matchup.
// ─────────────────────────────────────────────────────────────────────────

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseCSV } from './sync-pitcher-statcast.mjs';
import { todaysActiveBatterIds, batterSearchURL } from './sync-batter-zone-hr.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const PARK_HISTORY_PATH = path.join(DATA_DIR, 'batter-park-history.json');
const SEASON = new Date().getFullYear();

// Standard official-scoring at-bat exclusions -- a plate appearance that ends
// in one of these does NOT count as an at-bat (though it does still end the
// PA, i.e. `events` is still populated on that row).
const NON_AB_EVENTS = new Set(['walk', 'intent_walk', 'hit_by_pitch', 'sac_fly', 'sac_bunt', 'sac_fly_double_play', 'sac_bunt_double_play', 'catcher_interf']);
const HIT_TOTAL_BASES = { single: 1, double: 2, triple: 3, home_run: 4 };

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

// venueAbbr -> { ab, hits, hr, totalBases }
function buildBatterParkHistory(csv, name) {
  const rows = parseCSV(csv);
  if (!rows.length) return null;
  const sample = rows[0];
  if (!('events' in sample) || !('home_team' in sample)) {
    throw new Error(`unexpected CSV columns for ${name} — got [${Object.keys(sample).join(', ')}]`);
  }

  const byVenue = {};
  for (const r of rows) {
    const events = r.events;
    const venue = r.home_team;
    if (!events || !venue) continue; // mid-PA pitch row, or missing venue -- nothing to attribute
    if (!byVenue[venue]) byVenue[venue] = { ab: 0, hits: 0, hr: 0, totalBases: 0 };
    const v = byVenue[venue];
    if (!NON_AB_EVENTS.has(events) && events !== 'catcher_interf') v.ab++;
    const bases = HIT_TOTAL_BASES[events];
    if (bases != null) {
      v.hits++;
      v.totalBases += bases;
      if (events === 'home_run') v.hr++;
    }
  }

  const venues = {};
  for (const [venue, v] of Object.entries(byVenue)) {
    if (v.ab < 5) continue; // too thin a sample at this specific park to report a rate stat
    venues[venue] = {
      ab: v.ab, hits: v.hits, hr: v.hr,
      avg: +(v.hits / v.ab).toFixed(3),
      slg: +(v.totalBases / v.ab).toFixed(3),
    };
  }
  return Object.keys(venues).length ? venues : null;
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  // Read+merge, not overwrite -- same reasoning as sync-batter-zone-hr.mjs's
  // hrSprayData/battedBallData: this run only ever covers today's active
  // batters, but a batter's career history at a park he isn't playing in
  // today shouldn't disappear from the file until he's actually re-fetched.
  let out;
  try {
    const { readFile } = await import('node:fs/promises');
    out = JSON.parse(await readFile(PARK_HISTORY_PATH, 'utf8'));
  } catch (e) {
    out = { season: SEASON, players: {} };
  }
  out.players = out.players || {};

  const ids = await todaysActiveBatterIds();
  console.log(`Found ${ids.size} active-roster position player(s) for today's games.`);

  let updated = 0, failed = 0;
  for (const [id, name] of ids) {
    try {
      const csv = await fetchText(batterSearchURL(id));
      const venues = buildBatterParkHistory(csv, name);
      if (!venues) { console.warn(`No usable park-history rows for ${name} (${id}) — skipping.`); continue; }
      out.players[id] = venues;
      updated++;
    } catch (e) {
      failed++;
      console.error(`Batter park-history sync failed for ${name} (${id}):`, e.message);
    }
    // Same polite bounded-scope delay as sync-batter-zone-hr.mjs against this
    // same public, unauthenticated endpoint.
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`Updated ${updated} batter(s), ${failed} failed, out of ${ids.size} active-roster position players.`);
  if (updated > 0) {
    out.generatedAt = new Date().toISOString();
    out.season = SEASON;
    await writeFile(PARK_HISTORY_PATH, JSON.stringify(out, null, 2) + '\n');
  }
  if (failed > 0 && updated === 0) process.exitCode = 1;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch(e => { console.error(e); process.exit(1); });
}

export { buildBatterParkHistory, main };
