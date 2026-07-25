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
// Also now extracts a real home-run spray chart (hc_x/hc_y hit-coordinate columns,
// present on every row of this same CSV, home_run events only) off the exact same
// fetch — data/batter-hr-spray.json, read by the matchup modal. hc_x/hc_y are
// converted to approximate feet-from-home-plate via the community-standard transform
// (x_ft=(hc_x-125.42)*2.5, y_ft=(198.27-hc_y)*2.5 — the same one pybaseball/baseballr
// and most public Statcast spray-chart tooling use), not something this script can
// verify against a live response in this sandbox. Written to its own file (not merged
// into batter-pitch-type-season.json like byZone) and read+merged across runs, since
// this only ever covers TODAY's active batters but a season's worth of home runs
// shouldn't disappear from a player's chart on a day he isn't in a lineup.
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
const HR_SPRAY_PATH = path.join(DATA_DIR, 'batter-hr-spray.json');
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
  const hrZoneCount = {}; // zone -> count of this batter's own HRs on a pitch located there
  let hrZoneTotal = 0; // HRs with a known zone -- the hrByZone pct denominator
  const hrSpray = [];
  const hasHitCoords = 'hc_x' in sample && 'hc_y' in sample;
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
    if (p.zone && p.isHomeRun) {
      hrZoneCount[p.zone] = (hrZoneCount[p.zone] || 0) + 1;
      hrZoneTotal++;
    }
    // hc_x/hc_y (hit-coordinate columns) are on every row of this same CSV, not just
    // extractPitchRow()'s subset -- read them straight off the raw row. Skipped
    // entirely (not just per-row) if the CSV doesn't carry these columns at all,
    // rather than silently writing an empty spray chart for every batter.
    if (hasHitCoords && raw.events === 'home_run') {
      const hcX = Number(raw.hc_x), hcY = Number(raw.hc_y);
      if (Number.isFinite(hcX) && Number.isFinite(hcY)) {
        // Community-standard hc_x/hc_y -> feet-from-home-plate transform (used by
        // pybaseball, baseballr, and most public Statcast spray-chart tooling) --
        // not something this script can verify against a live response here.
        // plate_x/plate_z (feet, front-of-plate crossing point) -- the exact strike-zone
        // coordinate of the pitch that got hit for this same home run, alongside its
        // field landing spot above. Same row, same event, just two different locations
        // (where the pitch was vs. where the ball ended up).
        const plateX = Number(raw.plate_x), plateZ = Number(raw.plate_z);
        const hasPlateCoords = Number.isFinite(plateX) && Number.isFinite(plateZ);
        hrSpray.push({
          date: raw.game_date || null,
          xFt: +(((hcX - 125.42) * 2.5).toFixed(1)),
          yFt: +(((198.27 - hcY) * 2.5).toFixed(1)),
          distance: Number.isFinite(Number(raw.hit_distance_sc)) ? Number(raw.hit_distance_sc) : null,
          exitVelo: Number.isFinite(Number(raw.launch_speed)) ? Number(raw.launch_speed) : null,
          launchAngle: Number.isFinite(Number(raw.launch_angle)) ? Number(raw.launch_angle) : null,
          matchup: [raw.away_team, raw.home_team].filter(Boolean).join(' @ ') || null,
          plateX: hasPlateCoords ? +plateX.toFixed(2) : null,
          plateZ: hasPlateCoords ? +plateZ.toFixed(2) : null,
        });
      }
    }
  }
  // Named `woba` (not `wobaAgainst`, which sync-pitcher-zone-hr.mjs uses) since this is
  // the batter's OWN production in that zone, not something happening "against" him.
  const byZone = {};
  for (const z of Object.keys(zoneAgg)) {
    const { wobaSum, denomSum } = zoneAgg[z];
    if (denomSum > 0) byZone[z] = { woba: +(wobaSum / denomSum).toFixed(3) };
  }
  // hrByZone: real share of THIS batter's OWN home runs by pitch location -- the
  // HR-specific counterpart to byZone above (which is quality-of-contact, not HR share).
  const hrByZone = {};
  for (const z of Object.keys(hrZoneCount)) {
    hrByZone[z] = { count: hrZoneCount[z], pct: +((hrZoneCount[z] / hrZoneTotal) * 100).toFixed(1) };
  }
  return {
    hrByPitch,
    byZone: Object.keys(byZone).length ? byZone : null,
    hrByZone: Object.keys(hrByZone).length ? hrByZone : null,
    hrSpray: hasHitCoords ? hrSpray : null,
  };
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

  // Read+merge, not overwrite -- this run only ever covers today's active batters,
  // but a season's worth of home runs shouldn't disappear from a player's spray
  // chart on a day he isn't in a lineup. Each batter's entry IS fully replaced when
  // he does get re-fetched (a batch of home_run rows straight from this season's
  // real data, not something to merge event-by-event).
  let hrSprayData;
  try {
    hrSprayData = JSON.parse(await readFile(HR_SPRAY_PATH, 'utf8'));
  } catch (e) {
    hrSprayData = { season: SEASON, players: {} };
  }
  hrSprayData.players = hrSprayData.players || {};

  const ids = await todaysActiveBatterIds();
  console.log(`Found ${ids.size} active-roster position player(s) for today's games.`);

  let updated = 0, failed = 0, spraySynced = 0;
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
      if (result.hrByZone) {
        batterStatcast.players[id] = batterStatcast.players[id] || { seasonPitchTypeStats: [] };
        batterStatcast.players[id].hrByZone = result.hrByZone;
      }
      // No entry / no seasonPitchTypeStats and no byZone means this player isn't in the
      // pitch-arsenal leaderboard at all yet and had no usable zone rows either --
      // nothing to merge, so skip rather than fabricate a row.
      if (result.hrSpray != null) {
        hrSprayData.players[id] = result.hrSpray;
        if (result.hrSpray.length) spraySynced++;
      }
    } catch (e) {
      failed++;
      console.error(`Batter zone/HR sync failed for ${name} (${id}):`, e.message);
    }
    // Small delay between requests — same "polite bounded-scope caller" reasoning as
    // sync-pitcher-zone-hr.mjs against this same public, unauthenticated endpoint.
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`Updated ${updated} batter(s), ${failed} failed, out of ${ids.size} active-roster position players. ${spraySynced} with at least one real home-run spray point today.`);
  if (updated > 0) {
    batterStatcast.generatedAt = new Date().toISOString();
    await writeFile(BATTER_STATCAST_PATH, JSON.stringify(batterStatcast, null, 2) + '\n');
  }
  if (spraySynced > 0 || Object.keys(hrSprayData.players).length) {
    hrSprayData.generatedAt = new Date().toISOString();
    hrSprayData.season = SEASON;
    await writeFile(HR_SPRAY_PATH, JSON.stringify(hrSprayData, null, 2) + '\n');
  }
  if (failed > 0 && updated === 0) process.exitCode = 1;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch(e => { console.error(e); process.exit(1); });
}

export { batterSearchURL, buildBatterZoneHR, todaysActiveBatterIds, main };
