#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Builds a real, multi-season "career-to-date" home-run-by-pitch-type split
// per batter into data/batter-pitch-type-hr.json — app.js's
// loadBatterPitchTypeHr() fetches this exact file, feeding batterPitchTypeHr,
// which the Pitcher Matchup modal's Pitch Mix Advantage table prefers as its
// "Exact career split" tier (getPitchTypeHrCount in app.js) ahead of the
// season-only fallback it already falls back to today. This file didn't
// exist until now -- this script was simply never written, so that preferred
// tier has always been skipped in favor of the season fallback. (Originally
// also written to two guessed alternate filenames, all-time-pitch-type-hr.json
// and career-pitch-type-hr.json, since app.js used to try all three -- both
// were pure dead weight, tripling git storage/churn for identical bytes with
// no reader ever actually needing the alternates. Consolidated to this one
// real name.)
//
// Deliberately NOT a full since-2015 pull. A true career query for one
// prolific batter can return 20k+ rows and take 10-20s+ per player (checked
// live) — at today's-active-batter scope (roughly 250-400 players/day, same
// scope as sync-batter-zone-hr.mjs), that's 40-130+ minutes, an unreasonable
// runtime and load against a public, unauthenticated endpoint other scripts
// in this repo already take care not to hammer. This instead pulls a bounded
// current + 2 prior seasons window — genuinely real, genuinely multi-season
// (so the "career split" framing is honest, not just this-season data
// wearing a different label), at a cost per player close to the existing
// season-only zone-hr script.
//
// Same Statcast Search CSV source, columns, and today's-active-batters scope
// (todaysActiveBatterIds/batterSearchURL) as sync-batter-zone-hr.mjs — reused
// directly rather than re-derived, just with a wider hfSea window built
// locally instead of that script's single-season one. Same live-verification
// caveat as every other Statcast Search-based script here: column names are
// the well-documented public schema already relied on elsewhere in this
// repo, confirmed live for a single season by sync-pitcher-zone-hr.mjs, not
// independently re-verified here for a multi-season response.
// ─────────────────────────────────────────────────────────────────────────

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseCSV, PITCH_NAME_MAP } from './sync-pitcher-statcast.mjs';
import { todaysActiveBatterIds } from './sync-batter-zone-hr.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const SEASON = new Date().getFullYear();
const CAREER_WINDOW_YEARS = 3; // current season + this many prior seasons
const SEARCH_BASE = 'https://baseballsavant.mlb.com/statcast_search/csv';

const FETCH_TIMEOUT_MS = 20000; // wider window means a heavier response than the season-only sibling script's 15s budget
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

function careerWindowSearchURL(batterId) {
  const years = [];
  for (let y = SEASON - CAREER_WINDOW_YEARS + 1; y <= SEASON; y++) years.push(y);
  const params = new URLSearchParams({
    all: 'true',
    hfGT: 'R|PO|S|', // Regular season, Postseason, Spring — real games only
    hfSea: years.join('|') + '|',
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

// Every pitch type that shows up at all gets an entry (starting at 0), so a
// genuine zero-HR pitch type is recorded as a confirmed 0, not left looking
// like unknown data — same convention as sync-pitcher-zone-hr.mjs/
// sync-batter-zone-hr.mjs's own hrByPitch tallies.
async function buildBatterCareerPitchTypeHR(batterId, name) {
  const csv = await fetchText(careerWindowSearchURL(batterId));
  const rows = parseCSV(csv);
  if (!rows.length) return null;
  const sample = rows[0];
  if (!('pitch_type' in sample) || !('events' in sample)) {
    throw new Error(`unexpected CSV columns for ${name} (${batterId}) — got [${Object.keys(sample).join(', ')}]`);
  }
  const hrByPitch = {};
  for (const r of rows) {
    const pitchType = r.pitch_type;
    if (!pitchType) continue;
    const pitchName = r.pitch_name || PITCH_NAME_MAP[pitchType] || pitchType;
    if (!(pitchName in hrByPitch)) hrByPitch[pitchName] = 0;
    if (r.events === 'home_run') hrByPitch[pitchName]++;
  }
  if (!Object.keys(hrByPitch).length) return null;
  return hrByPitch;
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  let ids;
  try {
    ids = await todaysActiveBatterIds();
  } catch (e) {
    console.error('Failed to fetch today\'s active batter list:', e.message);
    process.exitCode = 1;
    return;
  }
  console.log(`Found ${ids.size} active-roster position player(s) for today's games. Career window: ${SEASON - CAREER_WINDOW_YEARS + 1}-${SEASON}.`);

  const players = {};
  let updated = 0, failed = 0;
  for (const [id, name] of ids) {
    try {
      const hrByPitch = await buildBatterCareerPitchTypeHR(id, name);
      if (!hrByPitch) { console.warn(`No Statcast rows for ${name} (${id}) — skipping.`); continue; }
      players[id] = { name, hrByPitch };
      updated++;
    } catch (e) {
      failed++;
      console.error(`Career pitch-type HR sync failed for ${name} (${id}):`, e.message);
    }
    // Polite bounded-scope caller — same reasoning as the season-only sibling
    // script against this same public, unauthenticated endpoint.
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`Built career-window pitch-type HR splits for ${updated}/${ids.size} batter(s) (${failed} failed).`);

  const out = {
    generatedAt: new Date().toISOString(),
    seasonRange: `${SEASON - CAREER_WINDOW_YEARS + 1}-${SEASON}`,
    players,
  };
  const json = JSON.stringify(out, null, 2) + '\n';
  await writeFile(path.join(DATA_DIR, 'batter-pitch-type-hr.json'), json);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch(e => { console.error(e); process.exit(1); });
}

export { careerWindowSearchURL, buildBatterCareerPitchTypeHR, main };
