#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Situational true-probability engine — the batter-side counterpart to a
// sportsbook's implied probability, for the three prop markets a real
// per-plate-appearance Statcast Search row can actually support: Home Runs,
// Hits, and Total Bases (all directly readable off the `events` column: a
// hit type and its base count). RBI, Runs, and Stolen Bases are deliberately
// NOT covered here — Statcast Search's pitch-level schema has no outcome
// column for those (they depend on base-runner/team context Statcast doesn't
// track per PA), so a "situational rate" for them off this data source would
// be an estimate dressed up as something real. Those three keep using the
// existing season-rate model until/unless a genuinely different data source
// (MLB Stats API per-game logs) backs a real version.
//
// Every existing probability on this site for these markets (hrProb, the
// HR Threats score, etc.) is built from BLENDED SEASON-WIDE RATES: the
// batter's overall rate and the pitcher's overall rate allowed, multiplied
// together with a park adjustment. That's a reasonable model, but it isn't
// what "true probability" means to a sharp bettor — this instead asks: out of
// every plate appearance this batter has actually had in a situation like
// TODAY's (same opposing-pitcher handedness, same park HR-friendliness tier,
// same opposing-pitcher velocity tier), how often did he actually deliver?
// That's an empirical, situational rate pulled from his own real history,
// not a formula blending two independent season averages.
//
// Scope, once per day: today's confirmed starting lineups (needs each
// batter's REAL opposing pitcher/park for today), intersected with
// data/statcast-hot-hitters.json's tracked batter universe. One Statcast
// Search CSV pull per qualifying batter (full-season, one row per pitch) —
// the same pull also surfaces every opposing pitcher this batter has ever
// faced, including their average fastball velocity, so the pitcher
// power-tier bucketing needs zero extra fetches.
//
// Shrinkage: a batter's own history in a specific 3-dimensional situational
// bucket (hand + park tier + pitcher tier) can be a tiny sample. Same
// empirical-Bayes treatment as every other small-sample guard in this repo
// (hrpSampleWeight, HR_MULT_SHRINKAGE): situational rates/distributions are
// pulled toward the batter's own season baseline until the situational
// sample is large enough to trust on its own (see SITUATIONAL_SHRINK_K).
//
// Whole-game probabilities (not just per-PA rates) are computed here,
// server-side, using a fixed expected-PA-per-game assumption
// (PA_PER_GAME, same 4.3 figure the Fantasy Points batter projection already
// uses, for consistency across the app rather than a second invented
// constant) — HR/Hits use the exact closed-form "at least one success in N
// trials" formula; Total Bases uses a small Monte Carlo simulation over the
// batter's own (shrunk) per-PA total-bases distribution, since bases
// accumulate in unequal amounts per PA and don't reduce to a single repeated
// Bernoulli trial the way a binary hit/HR does.
//
// Same live-verification caveat as the other Statcast Search-based scripts in
// this repo: this sandbox cannot reach baseballsavant.mlb.com or
// statsapi.mlb.com to confirm the CSV/JSON schema (events, p_throws, pitcher,
// release_speed, pitch_type, home_team, away_team) against a live response —
// they're the well-documented public schema, not something this script has
// verified itself. Loud schema check + per-batter try/catch, same defensive
// pattern as the other Statcast Search scripts, so one bad response can't
// take down the whole run.
// ─────────────────────────────────────────────────────────────────────────

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseCSV } from './sync-pitcher-statcast.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const HOT_HITTERS_PATH = path.join(DATA_DIR, 'statcast-hot-hitters.json');
const PITCHER_ROLLING_PATH = path.join(DATA_DIR, 'pitcher-rolling.json');
const SITUATIONAL_PROPS_PATH = path.join(DATA_DIR, 'batter-situational-props.json');
const SEASON = new Date().getFullYear();
const MLB_API = 'https://statsapi.mlb.com/api/v1';
const SEARCH_BASE = 'https://baseballsavant.mlb.com/statcast_search/csv';

// Shrinkage strength for the situational bucket — equivalent to needing ~25
// situational PAs before the empirical situational rate/distribution
// outweighs the batter's own season baseline. Same style of constant as
// HR_MULT_SHRINKAGE.
const SITUATIONAL_SHRINK_K = 25;
// A fastball-family pitch averaging this fast or faster today is a "power"
// arm for bucketing purposes; below it is "finesse."
const POWER_VELO_THRESHOLD = 94;
// Same fixed plate-appearance assumption the Fantasy Points batter projection
// already uses (FANTASY_PROJECTED_PA in app.js) — kept identical rather than
// inventing a second PA constant for the same "everyday-ish starter" idea.
const PA_PER_GAME = 4.3;
const TB_SIM_TRIALS = 8000;

const PARK_FACTORS = {
  COL:145,CIN:112,TEX:108,PHI:107,BOS:106,NYY:105,MIL:104,CWS:103,
  ATL:102,LAD:101,MIN:101,CHC:100,KC:100,DET:99,SEA:99,STL:98,
  SD:98,NYM:97,BAL:97,CLE:96,PIT:96,MIA:95,HOU:95,LAA:94,
  SF:93,WSH:93,OAK:92,TOR:91,TB:91,ARI:90,ATH:92,
};
function parkTierFor(teamAbbr) {
  const f = PARK_FACTORS[teamAbbr] ?? 100;
  return f >= 107 ? 'hitter' : f <= 93 ? 'pitcher' : 'neutral';
}

function cdtDateString(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

const FETCH_TIMEOUT_MS = 15000;
async function fetchJSON(url, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (e) {
      lastErr = e.name === 'AbortError' ? new Error(`Timed out after ${FETCH_TIMEOUT_MS}ms for ${url}`) : e;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 1500 * (i + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}
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

const BALLPARKPAL_HR_FACTORS_PATH = path.join(DATA_DIR, 'ballparkpal-hr-factors.json');
// Ballpark Pal's own per-hitter park-factor sync (sync-ballparkpal.mjs) already fetches
// today's /parkfactors/hitters — a per-game, per-player list keyed by the same MLB
// gamePk/person ids as everything else in this repo (confirmed in that script's own
// comments) — at zero extra API cost, on the morning trigger only. Used here purely as
// a fallback WHEN CONFIRMED for "is this batter playing today," for the same reason
// the rest of this function refuses to guess: MLB's own boxscore.batters array (the
// primary source above) often doesn't populate until close to first pitch, well after
// this script's later intraday reruns have already fired.
let ballparkPalGameIdsCache = null;
async function loadBallparkPalPlayerIdsByGame() {
  if (ballparkPalGameIdsCache) return ballparkPalGameIdsCache;
  const map = new Map(); // gameId (string) -> Set<playerId (string)>
  try {
    const raw = await readFile(BALLPARKPAL_HR_FACTORS_PATH, 'utf8');
    const data = JSON.parse(raw);
    for (const row of (data.rows || [])) {
      if (row.gameId == null || row.playerId == null) continue;
      const key = String(row.gameId);
      if (!map.has(key)) map.set(key, new Set());
      map.get(key).add(String(row.playerId));
    }
  } catch (e) {
    console.warn('data/ballparkpal-hr-factors.json not available for lineup fallback — skipping:', e.message);
  }
  ballparkPalGameIdsCache = map;
  return map;
}

// Ballpark Pal's hitter rows don't carry which side (home/away) a player is on — only
// gameId + playerId — so which TEAM he's actually confirmed for still has to come from
// somewhere. Intersecting against the team's own active roster (a stable, always-
// available MLB endpoint, unlike the lineup-specific boxscore.batters array) answers
// that without guessing: if Ballpark Pal modeled a park factor for him today AND he's
// on this team's active roster, he's playing for this team today.
const activeRosterCache = new Map(); // teamId -> Promise<Set<playerId (string)>>
async function fetchActiveRosterIds(teamId) {
  if (!activeRosterCache.has(teamId)) {
    activeRosterCache.set(teamId, (async () => {
      try {
        const data = await fetchJSON(`${MLB_API}/teams/${teamId}/roster/active`);
        return new Set((data.roster || []).map(r => String(r.person?.id)).filter(Boolean));
      } catch (e) {
        console.warn(`Active roster fetch failed for team ${teamId}:`, e.message);
        return new Set();
      }
    })());
  }
  return activeRosterCache.get(teamId);
}

function batterSearchURL(batterId) {
  const params = new URLSearchParams({
    all: 'true',
    hfGT: 'R|PO|S|',
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

// Today's confirmed starting lineup batters, each with their real opposing
// pitcher (id + throwing hand) and today's park.
async function todaysLineupContexts() {
  const today = cdtDateString(new Date());
  const sched = await fetchJSON(`${MLB_API}/schedule?sportId=1&date=${today}&hydrate=team,probablePitcher`);
  const games = sched?.dates?.find(d => d.date === today)?.games || [];
  const contexts = new Map(); // batterId -> { oppPitcherId, oppHand, parkAbbr }

  for (const g of games) {
    const homeAbbr = g.teams?.home?.team?.abbreviation;
    const awayAbbr = g.teams?.away?.team?.abbreviation;
    const homeProbable = g.teams?.home?.probablePitcher;
    const awayProbable = g.teams?.away?.probablePitcher;
    if (!homeAbbr || !awayAbbr) continue;
    let box;
    try {
      box = (await fetchJSON(`${MLB_API}/game/${g.gamePk}/boxscore`))?.teams;
    } catch (e) {
      console.warn(`Boxscore fetch failed for game ${g.gamePk}:`, e.message);
      continue;
    }
    const sides = [
      { side: 'home', oppProbable: awayProbable },
      { side: 'away', oppProbable: homeProbable },
    ];
    for (const { side, oppProbable } of sides) {
      if (!oppProbable?.id) continue; // no confirmed opposing starter yet — skip, not guess
      const team = box?.[side];
      let batterIds = team?.batters || [];
      if (!batterIds.length) {
        // MLB boxscore.batters hasn't posted yet — fall back to Ballpark Pal's daily
        // hitter list (already synced, zero extra cost) intersected with this team's
        // active roster, so a still-unconfirmed-by-MLB lineup doesn't get skipped
        // entirely on every run before first pitch.
        const bpIds = (await loadBallparkPalPlayerIdsByGame()).get(String(g.gamePk));
        const teamId = g.teams?.[side]?.team?.id;
        if (bpIds && bpIds.size && teamId) {
          const rosterIds = await fetchActiveRosterIds(teamId);
          batterIds = [...bpIds].filter(id => rosterIds.has(id)).map(Number);
        }
        if (!batterIds.length) continue; // still nothing confirmed — skip, not guess
      }
      const oppHandRaw = String(oppProbable.pitchHand?.code || '').toUpperCase();
      const oppHand = oppHandRaw === 'L' ? 'L' : oppHandRaw === 'R' ? 'R' : null;
      if (!oppHand) continue;
      for (const bid of batterIds) {
        if (!contexts.has(bid)) contexts.set(bid, { oppPitcherId: oppProbable.id, oppHand, parkAbbr: homeAbbr });
      }
    }
  }
  return contexts;
}

async function loadTrackedBatterNames() {
  const raw = await readFile(HOT_HITTERS_PATH, 'utf8');
  const data = JSON.parse(raw);
  const map = new Map();
  (data.players || []).forEach(p => { if (p.playerId) map.set(String(p.playerId), p.name); });
  return map;
}

// Today's opposing pitcher's own power tier, from the exact same real
// last-3-starts-vs-season velocity data sync-pitcher-rolling.mjs already
// computed — a fastball-family entry's season velocity, not a new fetch.
async function loadPitcherPowerTiers() {
  const tiers = new Map();
  try {
    const raw = await readFile(PITCHER_ROLLING_PATH, 'utf8');
    const data = JSON.parse(raw);
    for (const [pid, profile] of Object.entries(data.pitchers || {})) {
      const fb = (profile.byPitch || []).find(p => /fastball|sinker|2-seam|two-seam/i.test(p.name));
      tiers.set(pid, fb?.seasonVelo != null ? (fb.seasonVelo >= POWER_VELO_THRESHOLD ? 'power' : 'finesse') : null);
    }
  } catch (e) {
    console.warn('pitcher-rolling.json not found/unreadable — opposing pitcher power tier will be unknown for every batter:', e.message);
  }
  return tiers;
}

// "At least one success in a game" from a per-PA rate — HR and Hits both
// reduce to this exact closed form. PA_PER_GAME isn't a whole number, so this
// blends the floor/ceil PA-count results weighted by the fractional part
// rather than rounding, which would otherwise bias every batter's game
// probability the same direction.
function gameProbFromPerPARate(pPerPA, paPerGame = PA_PER_GAME) {
  const paLow = Math.floor(paPerGame), paHigh = Math.ceil(paPerGame);
  const frac = paPerGame - paLow;
  const probLow = 1 - Math.pow(1 - pPerPA, paLow);
  const probHigh = paHigh > paLow ? 1 - Math.pow(1 - pPerPA, paHigh) : probLow;
  return probLow * (1 - frac) + probHigh * frac;
}

// Total Bases don't reduce to a repeated Bernoulli trial (a double already
// clears the real "Over 1.5 TB" threshold by itself; two singles also clear
// it) — this simulates PA_PER_GAME plate appearances (probabilistically
// choosing the floor/ceil PA count same as gameProbFromPerPARate) by sampling
// each PA's base count from the batter's own (already-shrunk) situational
// total-bases distribution, and reports how often the game total clears the
// threshold.
function simulateTBGameProb(distribution, threshold = 2, paPerGame = PA_PER_GAME, trials = TB_SIM_TRIALS) {
  const paLow = Math.floor(paPerGame), paHigh = Math.ceil(paPerGame);
  const frac = paPerGame - paLow;
  function sampleOnePA() {
    const r = Math.random();
    let cum = 0;
    for (let bases = 0; bases < distribution.length; bases++) {
      cum += distribution[bases];
      if (r <= cum) return bases;
    }
    return 0;
  }
  let successes = 0;
  for (let t = 0; t < trials; t++) {
    const pa = Math.random() < frac ? paHigh : paLow;
    let total = 0;
    for (let i = 0; i < pa; i++) total += sampleOnePA();
    if (total >= threshold) successes++;
  }
  return successes / trials;
}

// Builds the season + situational (bucket-matched) HR/Hits/TB profile for one
// batter from his full-season Statcast Search rows.
function buildSituationalProfile(csv, name, context, pitcherPowerTiers) {
  const rows = parseCSV(csv);
  if (!rows.length) return null;
  const sample = rows[0];
  if (!('events' in sample) || !('p_throws' in sample) || !('pitcher' in sample) || !('home_team' in sample) || !('pitch_type' in sample)) {
    throw new Error(`unexpected CSV columns for ${name} — got [${Object.keys(sample).join(', ')}]`);
  }

  // Historical opposing-pitcher velocity lookup, built entirely from this same
  // CSV — every pitcher this batter has ever faced shows up in his own rows.
  const histVeloSum = {}, histVeloCount = {};
  for (const r of rows) {
    if (!/fastball|sinker|2-seam|two-seam/i.test(r.pitch_name || '') && !['FF', 'SI', 'FT'].includes(r.pitch_type)) continue;
    const velo = Number(r.release_speed);
    if (!Number.isFinite(velo) || !r.pitcher) continue;
    histVeloSum[r.pitcher] = (histVeloSum[r.pitcher] || 0) + velo;
    histVeloCount[r.pitcher] = (histVeloCount[r.pitcher] || 0) + 1;
  }
  function historicalPitcherTier(pitcherId) {
    const count = histVeloCount[pitcherId];
    if (!count) return null;
    return (histVeloSum[pitcherId] / count) >= POWER_VELO_THRESHOLD ? 'power' : 'finesse';
  }

  const todaysOppTier = pitcherPowerTiers.get(String(context.oppPitcherId)) ?? null;
  const TB_BY_EVENT = { single: 1, double: 2, triple: 3, home_run: 4 };

  const paRows = rows.filter(r => r.events && r.events !== '');
  let seasonPA = 0, seasonHR = 0, seasonHits = 0;
  const seasonTBHist = [0, 0, 0, 0, 0];
  let situationalPA = 0, situationalHR = 0, situationalHits = 0;
  const situationalTBHist = [0, 0, 0, 0, 0];

  for (const r of paRows) {
    const isHR = r.events === 'home_run';
    const bases = TB_BY_EVENT[r.events] || 0;
    const isHit = bases > 0;

    seasonPA++;
    if (isHR) seasonHR++;
    if (isHit) seasonHits++;
    seasonTBHist[bases]++;

    const handMatch = r.p_throws === context.oppHand;
    const parkMatch = parkTierFor(r.home_team) === parkTierFor(context.parkAbbr);
    const historicalTier = historicalPitcherTier(r.pitcher);
    const tierMatch = todaysOppTier == null || historicalTier == null || historicalTier === todaysOppTier;
    if (handMatch && parkMatch && tierMatch) {
      situationalPA++;
      if (isHR) situationalHR++;
      if (isHit) situationalHits++;
      situationalTBHist[bases]++;
    }
  }
  if (!seasonPA) return null;

  function shrinkRate(situationalCount, seasonCount) {
    const seasonRate = seasonCount / seasonPA;
    const shrunkRate = (situationalCount + (SITUATIONAL_SHRINK_K * seasonRate)) / (situationalPA + SITUATIONAL_SHRINK_K);
    return { seasonRate: +seasonRate.toFixed(4), situationalRate: situationalPA > 0 ? +(situationalCount / situationalPA).toFixed(4) : null, shrunkRate: +shrunkRate.toFixed(4) };
  }
  function shrinkDistribution(situationalHist, seasonHist) {
    const seasonDist = seasonHist.map(c => c / seasonPA);
    const shrunk = situationalHist.map((c, i) => c + (SITUATIONAL_SHRINK_K * seasonDist[i]));
    const total = shrunk.reduce((a, b) => a + b, 0) || 1;
    return shrunk.map(v => v / total);
  }

  const hr = shrinkRate(situationalHR, seasonHR);
  const hits = shrinkRate(situationalHits, seasonHits);
  const tbDistribution = shrinkDistribution(situationalTBHist, seasonTBHist);

  return {
    seasonPA, situationalPA,
    hr: { ...hr, trueProbPct: Math.round(gameProbFromPerPARate(hr.shrunkRate) * 100) },
    hits: { ...hits, trueProbPct: Math.round(gameProbFromPerPARate(hits.shrunkRate) * 100) },
    tb: { situationalTBHist, seasonTBHist, trueProbPct: Math.round(simulateTBGameProb(tbDistribution, 2) * 100) },
    context: { oppPitcherId: context.oppPitcherId, oppHand: context.oppHand, parkAbbr: context.parkAbbr, parkTier: parkTierFor(context.parkAbbr), oppPowerTier: todaysOppTier },
  };
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  let trackedNames;
  try {
    trackedNames = await loadTrackedBatterNames();
  } catch (e) {
    console.error('statcast-hot-hitters.json not found/unreadable — run sync-statcast-hot-hitters.mjs first:', e.message);
    process.exitCode = 1;
    return;
  }
  const pitcherPowerTiers = await loadPitcherPowerTiers();
  const lineupContexts = await todaysLineupContexts();

  const candidates = [...lineupContexts.entries()]
    .filter(([bid]) => trackedNames.has(String(bid)))
    .map(([bid, context]) => ({ id: bid, name: trackedNames.get(String(bid)), context }));
  console.log(`Found ${lineupContexts.size} batter(s) in confirmed lineups today, ${candidates.length} in the tracked Statcast pool.`);

  const out = { generatedAt: new Date().toISOString(), shrinkK: SITUATIONAL_SHRINK_K, powerVeloThreshold: POWER_VELO_THRESHOLD, paPerGame: PA_PER_GAME, players: {} };
  let updated = 0, failed = 0;
  for (const { id, name, context } of candidates) {
    try {
      const csv = await fetchText(batterSearchURL(id));
      const profile = buildSituationalProfile(csv, name, context, pitcherPowerTiers);
      if (!profile) { console.warn(`No usable PA data for ${name} (${id}) — skipping.`); continue; }
      out.players[id] = profile;
      updated++;
    } catch (e) {
      failed++;
      console.error(`Situational props sync failed for ${name} (${id}):`, e.message);
    }
    await new Promise(r => setTimeout(r, 600));
  }

  console.log(`Updated ${updated} batter(s), ${failed} failed, out of ${candidates.length} candidates.`);
  if (updated > 0) {
    await writeFile(SITUATIONAL_PROPS_PATH, JSON.stringify(out, null, 2) + '\n');
  }
  if (failed > 0 && updated === 0) process.exitCode = 1;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch(e => { console.error(e); process.exit(1); });
}

export { batterSearchURL, buildSituationalProfile, parkTierFor, gameProbFromPerPARate, simulateTBGameProb, loadBallparkPalPlayerIdsByGame, todaysLineupContexts, main };
