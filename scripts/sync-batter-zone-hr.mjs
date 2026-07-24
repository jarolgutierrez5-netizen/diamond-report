#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Batter-side counterpart to sync-pitcher-zone-hr.mjs: fills in real home-run-by-
// pitch-type counts for batters, which the pitch-arsenal leaderboard sync
// (sync-pitcher-statcast.mjs) can't provide (that leaderboard is pre-aggregated by
// pitch type with no HR-count column, so seasonPitchTypeStats[].homeRuns has stayed
// null for every batter). Until this ran, the Pitcher Matchup modal's Pitch Mix
// Advantage table (app.js's buildPitchMixAdvantageSection) had to redistribute each
// batter's overall HR total by pitch usage share as an estimate, flagged "est" in
// the UI — this replaces that estimate with a real per-pitch count wherever the
// Statcast Search data covers it.
//
// Also now computes real per-location wOBA (byZone), the batter-side counterpart to
// sync-pitcher-zone-hr.mjs's byZone — the Pitcher Matchup modal's Strike Zone heatmap
// used to only be able to show where the PITCHER is weak; this lets it show where the
// BATTER actually does damage too, so the two heatmaps can be compared side by side
// instead of relying on the heuristic Zone Fit score alone.
//
// Same Statcast Search CSV source as the pitcher script (one row per pitch, not
// pre-aggregated), just player_type=batter/batters_lookup[] instead of pitcher.
// Scope: today's active-roster position players across every team playing today,
// not the full ~600-player tracked universe -- batters relevant today (roughly
// 250-400 depending on the day's slate) is already a lot more Statcast Search
// requests than the pitcher script's ~15-30 probable starters, so this runs once in
// the morning only, not on every intraday rerun (a roster doesn't "fill in through
// the day" the way probable-pitcher assignments do, so there's nothing to gain from
// repeating it).
//
// Known limitation, same caveat as sync-pitcher-statcast.mjs/sync-pitcher-zone-hr.mjs:
// this environment cannot reach baseballsavant.mlb.com or statsapi.mlb.com to verify
// either endpoint's exact response shape live -- the Statcast Search columns are the
// same well-documented public schema sync-pitcher-zone-hr.mjs already relies on, and
// the roster endpoint/position-filter shape mirrors update-tracker.mjs's own
// battersForSide, which is already proven working in production. A batter whose CSV
// doesn't match, or a team whose roster fetch fails, is skipped (logged, not thrown)
// so one bad response can't take down the whole run.
// ─────────────────────────────────────────────────────────────────────────

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseCSV } from './sync-pitcher-statcast.mjs';
import { extractPitchRow } from './sync-pitcher-zone-hr.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const BATTER_STATCAST_PATH = path.join(DATA_DIR, 'batter-pitch-type-season.json');
const SEASON = new Date().getFullYear();
const MLB_API = 'https://statsapi.mlb.com/api/v1';
const SEARCH_BASE = 'https://baseballsavant.mlb.com/statcast_search/csv';

function cdtDateString(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

// Same timeout/retry shape as sync-pitcher-zone-hr.mjs's fetchText -- fetch() has no
// built-in timeout, and this loop runs over a meaningfully larger player count, so a
// single hanging response has even more potential to stall the whole run.
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

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// Every team playing today's active-roster position players, deduped by id -- same
// "today's relevant players, not the whole league" scope as the pitcher script's
// todaysProbablePitcherIds, just derived from rosters (batters don't have a
// probablePitcher-equivalent single-player field on the schedule).
async function todaysActiveBatterIds() {
  const today = cdtDateString(new Date());
  const sched = await fetchJSON(`${MLB_API}/schedule?sportId=1&date=${today}&hydrate=team`);
  const games = sched?.dates?.find(d => d.date === today)?.games || [];
  const teamIds = new Set();
  for (const g of games) {
    for (const side of ['away', 'home']) {
      const id = g.teams?.[side]?.team?.id;
      if (id) teamIds.add(id);
    }
  }
  const ids = new Map(); // id -> name, de-duped across both teams' rosters
  for (const teamId of teamIds) {
    try {
      const d = await fetchJSON(`${MLB_API}/teams/${teamId}/roster?rosterType=active`);
      for (const p of d?.roster || []) {
        if (p.position?.abbreviation === 'P' || !p.person?.id) continue;
        ids.set(p.person.id, p.person.fullName || String(p.person.id));
      }
    } catch (e) {
      console.warn(`Roster fetch failed for team ${teamId}:`, e.message);
    }
  }
  return ids;
}

function batterSearchURL(batterId) {
  const params = new URLSearchParams({
    all: 'true',
    hfGT: 'R|PO|S|', // Regular season, Postseason, Spring — real games only
    hfSea: `${SEASON}|`,
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

// Real per-pitch-type HR count, plus real per-location wOBA (byZone) -- the batter-side
// counterpart to sync-pitcher-zone-hr.mjs's byZone, which the Pitcher Matchup modal's
// Strike Zone heatmap used to only be able to show for the PITCHER. Same aggregation
// (woba_value/woba_denom summed per zone), just scoped to this batter's own at-bats
// instead of what he allowed.
async function buildBatterZoneHR(batterId, name) {
  const csv = await fetchText(batterSearchURL(batterId));
  const rows = parseCSV(csv);
  if (!rows.length) return null;
  const sample = rows[0];
  if (!('pitch_type' in sample) || !('events' in sample) || !('zone' in sample)) {
    throw new Error(`unexpected CSV columns for ${name} (${batterId}) — got [${Object.keys(sample).join(', ')}]`);
  }
  // Every pitch type that shows up at all gets an entry (starting at 0), so a genuine
  // zero-HR pitch type is recorded as a confirmed 0, not left looking like unknown data.
  const hrByPitch = {};
  const zoneAgg = {}; // zone -> { wobaSum, denomSum }
  for (const raw of rows) {
    const p = extractPitchRow(raw);
    if (!p) continue;
    if (!(p.pitchName in hrByPitch)) hrByPitch[p.pitchName] = 0;
    if (p.isHomeRun) hrByPitch[p.pitchName]++;
    if (p.zone && p.wobaValue != null && p.wobaDenom != null) {
      if (!zoneAgg[p.zone]) zoneAgg[p.zone] = { wobaSum: 0, denomSum: 0 };
      zoneAgg[p.zone].wobaSum += p.wobaValue;
      zoneAgg[p.zone].denomSum += p.wobaDenom;
    }
  }
  // Named `woba` (not `wobaAgainst`, which sync-pitcher-zone-hr.mjs uses) since this is
  // the batter's OWN production in that zone, not something happening "against" him.
  const byZone = {};
  for (const z of Object.keys(zoneAgg)) {
    const { wobaSum, denomSum } = zoneAgg[z];
    if (denomSum > 0) byZone[z] = { woba: +(wobaSum / denomSum).toFixed(3) };
  }
  return { hrByPitch, byZone: Object.keys(byZone).length ? byZone : null };
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  let batterStatcast;
  try {
    batterStatcast = JSON.parse(await readFile(BATTER_STATCAST_PATH, 'utf8'));
  } catch (e) {
    console.error('batter-pitch-type-season.json not found or unreadable — run sync-pitcher-statcast.mjs first. ' + e.message);
    process.exitCode = 1;
    return;
  }
  batterStatcast.players = batterStatcast.players || {};

  const ids = await todaysActiveBatterIds();
  console.log(`Found ${ids.size} active-roster position player(s) for today's games.`);

  let updated = 0, failed = 0;
  for (const [id, name] of ids) {
    try {
      const result = await buildBatterZoneHR(id, name);
      if (!result) { console.warn(`No Statcast rows for ${name} (${id}) — skipping.`); continue; }
      const entry = batterStatcast.players[id];
      if (entry?.seasonPitchTypeStats?.length) {
        entry.seasonPitchTypeStats.forEach(p => {
          // homeRuns starts out null (genuinely unknown) rather than 0, so only ever
          // overwrite it when this pitch type actually showed up in the search results
          // -- same "absent stays unknown, present-with-zero becomes a confirmed 0"
          // distinction as sync-pitcher-zone-hr.mjs.
          const hr = result.hrByPitch[p.name];
          if (hr != null) p.homeRuns = hr;
        });
        updated++;
      }
      // Unlike the HR-by-pitch merge above, byZone doesn't need an existing leaderboard
      // entry to attach to -- same "create the entry if it's missing" pattern as
      // sync-pitcher-zone-hr.mjs's byZone merge, so a batter with too few tracked pitches
      // for the pitch-arsenal leaderboard can still get a zone heatmap.
      if (result.byZone) {
        batterStatcast.players[id] = batterStatcast.players[id] || { seasonPitchTypeStats: [] };
        batterStatcast.players[id].byZone = result.byZone;
        if (!entry?.seasonPitchTypeStats?.length) updated++;
      }
      // No entry / no seasonPitchTypeStats and no byZone means this player isn't in the
      // pitch-arsenal leaderboard at all yet and had no usable zone rows either --
      // nothing to merge, so skip rather than fabricate a row.
    } catch (e) {
      failed++;
      console.error(`Batter zone/HR sync failed for ${name} (${id}):`, e.message);
    }
    // Small delay between requests — same "polite bounded-scope caller" reasoning as
    // sync-pitcher-zone-hr.mjs against this same public, unauthenticated endpoint.
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`Updated ${updated} batter(s), ${failed} failed, out of ${ids.size} active-roster position players.`);
  if (updated > 0) {
    batterStatcast.generatedAt = new Date().toISOString();
    await writeFile(BATTER_STATCAST_PATH, JSON.stringify(batterStatcast, null, 2) + '\n');
  }
  if (failed > 0 && updated === 0) process.exitCode = 1;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch(e => { console.error(e); process.exit(1); });
}

export { batterSearchURL, buildBatterZoneHR, todaysActiveBatterIds, main };
