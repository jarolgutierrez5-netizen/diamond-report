#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Fills in three things the pitch-arsenal leaderboard sync (sync-pitcher-statcast.mjs)
// can't provide, because that leaderboard is pre-aggregated by pitch type only:
//   1. Home runs allowed BY PITCH TYPE (the pitch-arsenal leaderboard has no HR-count
//      column at all, so byPitch[].homeRuns has stayed null for every pitcher).
//   2. Strike Zone location data (byZone) — real per-location wOBA-against, which the
//      Pitcher Matchup modal's Strike Zone heatmap has been waiting on since it was
//      built (see app.js's hasRealZones flag, gated on this exact field never existing).
//   3. Per-pitch-type attack zones (byPitch[].zones) — the same per-location breakdown
//      as #2, but scoped to a single pitch type, so "where does his slider actually go"
//      is answerable instead of only "where does everything he throws end up." usagePct
//      is the real signal here (what share of THIS pitch's own throws land in each of
//      the 9 zones — his actual location tendency for that pitch), wobaAgainst rides
//      along since the same rows already carry it.
//
// All three come from Baseball Savant's Statcast Search CSV export, which returns one row
// per PITCH (not pre-aggregated), so this only runs it for TODAY's probable starting
// pitchers — a bounded ~15-30 requests/day — rather than the whole league, to keep the
// run fast and avoid hammering a public endpoint with hundreds of requests.
//
// Known limitation, same caveat as sync-pitcher-statcast.mjs: this environment cannot
// reach baseballsavant.mlb.com to verify the Statcast Search CSV's exact column names
// live, so the ones below (pitch_type, events, zone, woba_value, woba_denom, pitcher)
// are the well-documented public schema from years of community tooling, not something
// this script has confirmed against a live response. A pitcher whose CSV doesn't match
// is skipped (logged, not thrown) so one bad response can't take down the whole run —
// treat the first scheduled run as unverified until its output is manually checked.
// ─────────────────────────────────────────────────────────────────────────

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseCSV, PITCH_NAME_MAP } from './sync-pitcher-statcast.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const PITCHER_STATCAST_PATH = path.join(DATA_DIR, 'pitcher-statcast.json');
const SEASON = new Date().getFullYear();
const MLB_API = 'https://statsapi.mlb.com/api/v1';
const SEARCH_BASE = 'https://baseballsavant.mlb.com/statcast_search/csv';

// Events that end a plate appearance with the batter making an out, mapped to how
// many outs the play recorded (double/triple plays record 2/3 off one row). Used
// only to reconstruct innings pitched BY BATTER HAND for hr9ByHand below -- the
// Statcast Search CSV has no innings-pitched column at all, split or otherwise, so
// this is the standard reconstruction public Statcast tooling uses: an out is an
// out regardless of what stat it's feeding. Any event string not in this map
// (reached base, or a non-PA-ending row) is simply not counted, rather than guessed.
const OUT_EVENTS = {
  strikeout: 1, strikeout_double_play: 2, field_out: 1, force_out: 1,
  grounded_into_double_play: 2, double_play: 2, triple_play: 3,
  fielders_choice_out: 1, sac_fly: 1, sac_fly_double_play: 2,
  sac_bunt: 1, sac_bunt_double_play: 2, batter_interference: 1,
};
// Small-sample HR/9 is wildly noisy (one homer allowed in 2 IP reads as an
// absurd 40+ HR/9) -- same sample-floor discipline as MIN_TWO_STRIKE_BIP in
// sync-pitcher-2k-suppression.mjs. Below this many innings against a given
// hand, the real hr/ip counts are still reported so a consumer can show
// "small sample" instead of nothing, but the hr9 rate itself stays null.
const MIN_IP_FOR_HR9 = 8;

function cdtDateString(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

// fetch() has no built-in timeout — a bad/slow response could otherwise stall this
// loop indefinitely (probable-starter count varies through the day, up to 25-30+,
// so one hanging request has real potential to block everything after it). Same
// safeguard added to sync-batter-splits.mjs's fetchJSON after a related incident.
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

async function todaysProbablePitcherIds() {
  const today = cdtDateString(new Date());
  const sched = await fetchJSON(`${MLB_API}/schedule?sportId=1&date=${today}&hydrate=team,probablePitcher`);
  const games = sched?.dates?.find(d => d.date === today)?.games || [];
  const ids = new Map(); // id -> name, de-duped
  for (const g of games) {
    for (const side of ['away', 'home']) {
      const p = g.teams?.[side]?.probablePitcher;
      if (p?.id) ids.set(p.id, p.fullName || String(p.id));
    }
  }
  return ids;
}

function pitcherSearchURL(pitcherId) {
  const params = new URLSearchParams({
    all: 'true',
    hfGT: 'R|PO|S|', // Regular season, Postseason, Spring — real games only
    hfSea: `${SEASON}|`,
    player_type: 'pitcher',
    group_by: 'name',
    sort_col: 'pitches',
    player_event_sort: 'api_p_release_speed',
    sort_order: 'desc',
    min_pitches: '0',
    min_results: '0',
    type: 'details',
  });
  params.append('pitchers_lookup[]', String(pitcherId));
  return `${SEARCH_BASE}?${params.toString()}`;
}

// One row per pitch. Only the columns this script actually needs. The pitch NAME
// (not just the two-letter code) is what sync-pitcher-statcast.mjs keys byPitch
// entries on, so home-run counts have to be merged back under that same name or
// they'll silently never match up with the pitch-arsenal rows.
function extractPitchRow(r) {
  const pitchType = r.pitch_type;
  if (!pitchType) return null;
  const pitchName = r.pitch_name || PITCH_NAME_MAP[pitchType] || pitchType;
  const zone = Number(r.zone);
  const wobaValue = r.woba_value === '' || r.woba_value == null ? null : Number(r.woba_value);
  const wobaDenom = r.woba_denom === '' || r.woba_denom == null ? null : Number(r.woba_denom);
  // description (not events) carries the real per-pitch outcome -- events only
  // populates on the last pitch of a plate appearance, but a swing-and-miss can
  // happen on any pitch. Both swinging_strike and swinging_strike_blocked (a
  // whiff on a pitch also in the dirt) are real misses, same standard public
  // Statcast tooling uses for whiff rate.
  const isWhiff = r.description === 'swinging_strike' || r.description === 'swinging_strike_blocked';
  return {
    pitchName,
    isHomeRun: r.events === 'home_run',
    isWhiff,
    zone: Number.isFinite(zone) && zone >= 1 && zone <= 9 ? zone : null,
    wobaValue: Number.isFinite(wobaValue) ? wobaValue : null,
    wobaDenom: Number.isFinite(wobaDenom) ? wobaDenom : null,
  };
}

async function buildPitcherZoneHR(pitcherId, name) {
  const csv = await fetchText(pitcherSearchURL(pitcherId));
  const rows = parseCSV(csv);
  if (!rows.length) return null;
  // Loud schema check, same spirit as sync-pitcher-statcast.mjs's assertSchema — bail
  // on this one pitcher rather than writing data built from columns that don't exist.
  const sample = rows[0];
  if (!('pitch_type' in sample) || !('events' in sample) || !('zone' in sample)) {
    throw new Error(`unexpected CSV columns for ${name} (${pitcherId}) — got [${Object.keys(sample).join(', ')}]`);
  }

  // Every pitch type that shows up at all gets an entry (starting at 0), so a genuine
  // zero-HR pitch type is recorded as a confirmed 0, not left looking like unknown data.
  const hrByPitch = {};
  const zoneAgg = {}; // zone -> { wobaSum, denomSum }
  const pitchZoneAgg = {}; // pitchName -> zone -> { wobaSum, denomSum, count }
  const pitchTotalCount = {}; // pitchName -> total pitches thrown (usage% denominator)
  const hrZoneCount = {}; // zone -> count of HRs allowed on a pitch located in that zone
  let hrZoneTotal = 0; // HRs allowed with a known zone -- the hrByZone pct denominator
  const hrLocations = []; // real plate_x/plate_z per HR allowed -- exact pitch coordinates, not a discrete 1-9 zone bucket
  const whiffLocations = []; // real plate_x/plate_z + pitch type per swing-and-miss -- same coordinate source as hrLocations, just a different outcome filter
  const hasPitchCoords = 'plate_x' in sample && 'plate_z' in sample;
  const hasWhiffData = 'description' in sample;
  // Same-toggle-as-Pitch-Mix-Advantage feature: stand (the OPPOSING BATTER's batting
  // side on each pitch) is the pitcher-side counterpart to sync-batter-zone-hr.mjs's
  // p_throws split -- lets the Strike Zone Matchup / Attack Zone by Pitch / HR Zones
  // grids offer an independent AUTO/vs RHB/vs LHB toggle on the pitcher's side. Same
  // loud/graceful guard as every other optional column here: absent -> null, never a
  // fabricated split.
  const hasHandSplit = 'stand' in sample;
  const zoneAggByHand = { R: {}, L: {} }; // batter stand -> zone -> { wobaSum, denomSum }
  const pitchZoneAggByHand = { R: {}, L: {} }; // batter stand -> pitchName -> zone -> { wobaSum, denomSum, count }
  const pitchTotalCountByHand = { R: {}, L: {} }; // batter stand -> pitchName -> total pitches (usage% denominator for that hand)
  const hrByHand = { R: 0, L: 0 }; // batter stand -> HRs allowed to that hand
  const outsByHand = { R: 0, L: 0 }; // batter stand -> outs recorded against that hand (see OUT_EVENTS) -- IP-by-hand = this / 3
  for (const raw of rows) {
    const p = extractPitchRow(raw);
    if (!p) continue;
    if (!(p.pitchName in hrByPitch)) hrByPitch[p.pitchName] = 0;
    if (p.isHomeRun) hrByPitch[p.pitchName]++;
    pitchTotalCount[p.pitchName] = (pitchTotalCount[p.pitchName] || 0) + 1;
    const stand = hasHandSplit && (raw.stand === 'R' || raw.stand === 'L') ? raw.stand : null;
    if (stand) {
      pitchTotalCountByHand[stand][p.pitchName] = (pitchTotalCountByHand[stand][p.pitchName] || 0) + 1;
      if (p.isHomeRun) hrByHand[stand]++;
      const outs = OUT_EVENTS[raw.events];
      if (outs) outsByHand[stand] += outs;
    }
    if (p.zone && p.wobaValue != null && p.wobaDenom != null) {
      if (!zoneAgg[p.zone]) zoneAgg[p.zone] = { wobaSum: 0, denomSum: 0 };
      zoneAgg[p.zone].wobaSum += p.wobaValue;
      zoneAgg[p.zone].denomSum += p.wobaDenom;
      if (stand) {
        const bucket = zoneAggByHand[stand];
        if (!bucket[p.zone]) bucket[p.zone] = { wobaSum: 0, denomSum: 0 };
        bucket[p.zone].wobaSum += p.wobaValue;
        bucket[p.zone].denomSum += p.wobaDenom;
      }
    }
    if (p.zone) {
      if (!pitchZoneAgg[p.pitchName]) pitchZoneAgg[p.pitchName] = {};
      if (!pitchZoneAgg[p.pitchName][p.zone]) pitchZoneAgg[p.pitchName][p.zone] = { wobaSum: 0, denomSum: 0, count: 0 };
      const cell = pitchZoneAgg[p.pitchName][p.zone];
      cell.count++;
      if (p.wobaValue != null && p.wobaDenom != null) { cell.wobaSum += p.wobaValue; cell.denomSum += p.wobaDenom; }
      if (stand) {
        const handPitchZone = pitchZoneAggByHand[stand];
        if (!handPitchZone[p.pitchName]) handPitchZone[p.pitchName] = {};
        if (!handPitchZone[p.pitchName][p.zone]) handPitchZone[p.pitchName][p.zone] = { wobaSum: 0, denomSum: 0, count: 0 };
        const handCell = handPitchZone[p.pitchName][p.zone];
        handCell.count++;
        if (p.wobaValue != null && p.wobaDenom != null) { handCell.wobaSum += p.wobaValue; handCell.denomSum += p.wobaDenom; }
      }
    }
    if (p.zone && p.isHomeRun) {
      hrZoneCount[p.zone] = (hrZoneCount[p.zone] || 0) + 1;
      hrZoneTotal++;
    }
    // plate_x/plate_z (feet, front-of-plate crossing point) are on every row of this
    // same CSV, same "read straight off the raw row" pattern as sync-batter-zone-hr.mjs's
    // hc_x/hc_y -- not something extractPitchRow's fixed field set carries.
    if (hasPitchCoords && p.isHomeRun) {
      const px = Number(raw.plate_x), pz = Number(raw.plate_z);
      if (Number.isFinite(px) && Number.isFinite(pz)) {
        hrLocations.push({
          date: raw.game_date || null,
          plateX: +px.toFixed(2),
          plateZ: +pz.toFixed(2),
          exitVelo: Number.isFinite(Number(raw.launch_speed)) ? Number(raw.launch_speed) : null,
          matchup: [raw.away_team, raw.home_team].filter(Boolean).join(' @ ') || null,
          batterStand: stand,
        });
      }
    }
    if (hasPitchCoords && hasWhiffData && p.isWhiff) {
      const px = Number(raw.plate_x), pz = Number(raw.plate_z);
      if (Number.isFinite(px) && Number.isFinite(pz)) {
        whiffLocations.push({
          date: raw.game_date || null,
          plateX: +px.toFixed(2),
          plateZ: +pz.toFixed(2),
          pitchName: p.pitchName,
          batterStand: stand,
        });
      }
    }
  }

  const byZone = {};
  for (const z of Object.keys(zoneAgg)) {
    const { wobaSum, denomSum } = zoneAgg[z];
    if (denomSum > 0) byZone[z] = { wobaAgainst: +(wobaSum / denomSum).toFixed(3) };
  }

  // hrByZone: real share of THIS pitcher's home-runs-allowed by pitch location, not a
  // damage/quality score like byZone above -- the HR-specific counterpart to the
  // Attack Zone by Pitch usagePct grid, but filtered to home_run outcomes only.
  const hrByZone = {};
  for (const z of Object.keys(hrZoneCount)) {
    hrByZone[z] = { count: hrZoneCount[z], pct: +((hrZoneCount[z] / hrZoneTotal) * 100).toFixed(1) };
  }

  const byPitchZone = {};
  for (const pitchName of Object.keys(pitchZoneAgg)) {
    const total = pitchTotalCount[pitchName] || 0;
    const zones = {};
    for (const z of Object.keys(pitchZoneAgg[pitchName])) {
      const cell = pitchZoneAgg[pitchName][z];
      zones[z] = {
        usagePct: total > 0 ? +((cell.count / total) * 100).toFixed(1) : null,
        wobaAgainst: cell.denomSum > 0 ? +(cell.wobaSum / cell.denomSum).toFixed(3) : null,
      };
    }
    if (Object.keys(zones).length) byPitchZone[pitchName] = zones;
  }

  let byZoneByHand = null;
  let byPitchZoneByHand = null;
  if (hasHandSplit) {
    byZoneByHand = { R: {}, L: {} };
    byPitchZoneByHand = { R: {}, L: {} };
    for (const hand of ['R', 'L']) {
      for (const z of Object.keys(zoneAggByHand[hand])) {
        const { wobaSum, denomSum } = zoneAggByHand[hand][z];
        if (denomSum > 0) byZoneByHand[hand][z] = { woba: +(wobaSum / denomSum).toFixed(3) };
      }
      for (const pitchName of Object.keys(pitchZoneAggByHand[hand])) {
        const total = pitchTotalCountByHand[hand][pitchName] || 0;
        const zones = {};
        for (const z of Object.keys(pitchZoneAggByHand[hand][pitchName])) {
          const cell = pitchZoneAggByHand[hand][pitchName][z];
          zones[z] = {
            usagePct: total > 0 ? +((cell.count / total) * 100).toFixed(1) : null,
            wobaAgainst: cell.denomSum > 0 ? +(cell.wobaSum / cell.denomSum).toFixed(3) : null,
          };
        }
        if (Object.keys(zones).length) byPitchZoneByHand[hand][pitchName] = zones;
      }
    }
    if (!Object.keys(byZoneByHand.R).length && !Object.keys(byZoneByHand.L).length) byZoneByHand = null;
    if (!Object.keys(byPitchZoneByHand.R).length && !Object.keys(byPitchZoneByHand.L).length) byPitchZoneByHand = null;
  }

  // hr9ByHand: real HR/9 allowed vs RHB and vs LHB, reconstructed from outs-by-hand
  // (see OUT_EVENTS) rather than any published split-IP stat -- Statcast Search has
  // no innings-pitched column, split or otherwise. hr/ip are always real counts;
  // hr9 itself is only populated once IP-by-hand clears MIN_IP_FOR_HR9, to avoid a
  // single home run in a tiny sample reading as a wild, misleading rate.
  let hr9ByHand = null;
  if (hasHandSplit) {
    hr9ByHand = {};
    for (const hand of ['R', 'L']) {
      const ip = outsByHand[hand] / 3;
      hr9ByHand[hand] = {
        hr: hrByHand[hand],
        ip: +ip.toFixed(1),
        hr9: ip >= MIN_IP_FOR_HR9 ? +((hrByHand[hand] * 9) / ip).toFixed(2) : null,
      };
    }
    if (!hr9ByHand.R.ip && !hr9ByHand.L.ip) hr9ByHand = null;
  }

  return {
    hrByPitch,
    byZone: Object.keys(byZone).length ? byZone : null,
    byZoneByHand,
    hr9ByHand,
    hrByZone: Object.keys(hrByZone).length ? hrByZone : null,
    hrLocations: hasPitchCoords ? hrLocations : null,
    whiffLocations: (hasPitchCoords && hasWhiffData) ? whiffLocations : null,
    byPitchZone,
    byPitchZoneByHand,
  };
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  let pitcherStatcast;
  try {
    pitcherStatcast = JSON.parse(await readFile(PITCHER_STATCAST_PATH, 'utf8'));
  } catch (e) {
    console.error('pitcher-statcast.json not found or unreadable — run sync-pitcher-statcast.mjs first. ' + e.message);
    process.exitCode = 1;
    return;
  }
  pitcherStatcast.pitchers = pitcherStatcast.pitchers || {};

  const ids = await todaysProbablePitcherIds();
  console.log(`Found ${ids.size} probable starter(s) for today.`);

  let updated = 0, failed = 0;
  for (const [id, name] of ids) {
    try {
      const result = await buildPitcherZoneHR(id, name);
      if (!result) { console.warn(`No Statcast rows for ${name} (${id}) — skipping.`); continue; }
      const entry = pitcherStatcast.pitchers[id];
      if (entry?.byPitch?.length) {
        entry.byPitch.forEach(p => {
          // homeRuns starts out null (genuinely unknown) rather than 0, so only ever
          // overwrite it when this pitch type actually showed up in the search results —
          // a pitch type with zero HRs allowed will appear with count 0 naturally once
          // it has any pitches at all; one that's simply absent stays unknown, not 0.
          const hr = result.hrByPitch[p.name];
          if (hr != null) p.homeRuns = hr;
          const zones = result.byPitchZone[p.name];
          if (zones) p.zones = zones;
          if (result.byPitchZoneByHand) {
            const zonesR = result.byPitchZoneByHand.R[p.name];
            const zonesL = result.byPitchZoneByHand.L[p.name];
            if (zonesR || zonesL) p.zonesByHand = { R: zonesR || null, L: zonesL || null };
          }
        });
      }
      if (result.byZone) {
        pitcherStatcast.pitchers[id] = pitcherStatcast.pitchers[id] || { totalPitches: 0, byPitch: [] };
        pitcherStatcast.pitchers[id].byZone = result.byZone;
      }
      if (result.byZoneByHand) {
        pitcherStatcast.pitchers[id] = pitcherStatcast.pitchers[id] || { totalPitches: 0, byPitch: [] };
        pitcherStatcast.pitchers[id].byZoneByHand = result.byZoneByHand;
      }
      if (result.hr9ByHand) {
        pitcherStatcast.pitchers[id] = pitcherStatcast.pitchers[id] || { totalPitches: 0, byPitch: [] };
        pitcherStatcast.pitchers[id].hr9ByHand = result.hr9ByHand;
      }
      if (result.hrByZone) {
        pitcherStatcast.pitchers[id] = pitcherStatcast.pitchers[id] || { totalPitches: 0, byPitch: [] };
        pitcherStatcast.pitchers[id].hrByZone = result.hrByZone;
      }
      if (result.hrLocations) {
        pitcherStatcast.pitchers[id] = pitcherStatcast.pitchers[id] || { totalPitches: 0, byPitch: [] };
        pitcherStatcast.pitchers[id].hrLocations = result.hrLocations;
      }
      if (result.whiffLocations) {
        pitcherStatcast.pitchers[id] = pitcherStatcast.pitchers[id] || { totalPitches: 0, byPitch: [] };
        pitcherStatcast.pitchers[id].whiffLocations = result.whiffLocations;
      }
      updated++;
    } catch (e) {
      failed++;
      console.error(`Zone/HR sync failed for ${name} (${id}):`, e.message);
    }
    // Small delay between requests — this is a public, unauthenticated endpoint with
    // no documented rate limit; be a polite bounded-scope caller, not a hammer.
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`Updated ${updated} pitcher(s), ${failed} failed, out of ${ids.size} probable starters.`);
  if (updated > 0) {
    pitcherStatcast.generatedAt = new Date().toISOString();
    await writeFile(PITCHER_STATCAST_PATH, JSON.stringify(pitcherStatcast, null, 2) + '\n');
  }
  if (failed > 0 && updated === 0) process.exitCode = 1;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch(e => { console.error(e); process.exit(1); });
}

export { pitcherSearchURL, extractPitchRow, buildPitcherZoneHR, todaysProbablePitcherIds, main, OUT_EVENTS, MIN_IP_FOR_HR9 };
