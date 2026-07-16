#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Generates data/season-projections.json — World Series championship odds
// (per team) and AL/NL MVP odds (per candidate), consumed by the League
// Leaders / Season Odds panel on the News Central hub.
//
// Methodology (both pieces are genuine probabilistic models, not vibes):
//
// World Series: builds each league's real 6-team playoff bracket (3 division
// winners + 3 wild cards, seeded by strength — the actual 2022+ MLB format:
// Wild Card best-of-3, Division Series best-of-5 with reseeding so the #1
// seed always faces the lowest surviving seed, Championship Series best-of-7,
// World Series best-of-7), assigns each team a power rating from a blend of
// actual win% and Pythagorean win% (runsScored^1.83 / (RS^1.83+RA^1.83)),
// shrunk toward .500 with a 20-game prior so small-sample records early in
// the season don't produce absurd single-game odds, then runs a Monte Carlo
// simulation (log5 formula for each individual game) of the entire bracket
// many thousands of times and tallies how often each team wins it all.
//
// MVP: real MVP voting has no public API and isn't something we can fetch —
// this is a composite-score model, not a simulation. For each league, pulls
// the top-50 leaderboards for OPS, HR, RBI, and SB, scores each candidate by
// where they rank in each category (linear percentile within that top-50,
// zero if unranked), weights those percentiles (OPS 35%, HR 30%, RBI 20%,
// SB 10%, team win% 5% — team success is a real, well-documented bias in
// actual MVP voting), then converts composite scores to probabilities with a
// softmax so they sum to 100% within each league's candidate pool. This is
// the same category-percentile approach real forecast sites use in lieu of
// a proprietary WAR feed, and is disclosed here as an approximation, not a
// claim of precision.
//
// Known limitation: this environment cannot reach statsapi.mlb.com to
// verify the standings/leaders response shapes live — they're built from
// the same documented shape already confirmed working elsewhere in this repo
// (leaders) plus MLB's publicly documented standings shape. Treat the first
// scheduled run's output as unverified until manually spot-checked.
// ─────────────────────────────────────────────────────────────────────────

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const OUT_PATH = path.join(DATA_DIR, 'season-projections.json');
const API = 'https://statsapi.mlb.com/api/v1';
const SEASON = new Date().getFullYear();
const AL_LEAGUE_ID = 103;
const NL_LEAGUE_ID = 104;
const SIM_TRIALS = 20000;
const RATING_PRIOR_GAMES = 20;
const MIN_GAMES_PLAYED = 10; // below this (early spring/offseason), skip — the model is too noisy to be worth publishing

async function fetchJSON(url, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw lastErr;
}

function n(v, fallback = 0) {
  const num = Number(v);
  return Number.isFinite(num) ? num : fallback;
}

// Blends actual win% with Pythagorean win% (if run data is present), then
// regresses toward .500 with a fixed-size prior so a 8-2 start doesn't read
// as an .800 team. Returns a rating in (0, 1).
function teamRating(teamRecord) {
  const wins = n(teamRecord.wins);
  const losses = n(teamRecord.losses);
  const gamesPlayed = wins + losses;
  if (gamesPlayed <= 0) return 0.5;
  const winPct = wins / gamesPlayed;
  const rs = n(teamRecord.runsScored, NaN);
  const ra = n(teamRecord.runsAllowed, NaN);
  let raw = winPct;
  if (Number.isFinite(rs) && Number.isFinite(ra) && rs > 0 && ra > 0) {
    const pyth = Math.pow(rs, 1.83) / (Math.pow(rs, 1.83) + Math.pow(ra, 1.83));
    raw = 0.5 * winPct + 0.5 * pyth;
  }
  return (raw * gamesPlayed + 0.5 * RATING_PRIOR_GAMES) / (gamesPlayed + RATING_PRIOR_GAMES);
}

// Log5: classic Bill James formula for P(A beats B) given each team's
// underlying win-quality rating.
function log5(rA, rB) {
  const denom = rA + rB - 2 * rA * rB;
  if (denom <= 0) return 0.5;
  return (rA - rA * rB) / denom;
}

function simulateGame(pA) {
  return Math.random() < pA;
}

// Simulates a single best-of-N series (winsNeeded = (N+1)/2) between two
// seeded teams, independent-game log5 trials. Returns the winning seed object.
function simulateSeries(seedA, seedB, winsNeeded) {
  const pA = log5(seedA.rating, seedB.rating);
  let winsA = 0, winsB = 0;
  while (winsA < winsNeeded && winsB < winsNeeded) {
    if (simulateGame(pA)) winsA++; else winsB++;
  }
  return winsA === winsNeeded ? seedA : seedB;
}

// One league's 6-team bracket, real 2022+ MLB format: seeds 1-2 get byes,
// 3v6 and 4v5 play a Wild Card series, survivors are reseeded so the #1
// seed always faces the lower remaining seed, then DS/CS to a pennant.
function simulateLeagueBracket(seeds) {
  const [s1, s2, s3, s4, s5, s6] = seeds;
  const wc1 = simulateSeries(s3, s6, 2);
  const wc2 = simulateSeries(s4, s5, 2);
  const survivors = [wc1, wc2].sort((a, b) => a.seedNum - b.seedNum);
  const worseSurvivor = survivors[survivors.length - 1];
  const betterSurvivor = survivors[0];
  const ds1 = simulateSeries(s1, worseSurvivor, 3);
  const ds2 = simulateSeries(s2, betterSurvivor, 3);
  return simulateSeries(ds1, ds2, 4);
}

// Groups a league's standings records into the 6 real playoff seeds: the 3
// division winners (sorted by rating), then the 3 best remaining teams as
// wild cards (also sorted by rating).
function buildLeagueSeeds(divisionRecords, teamMeta) {
  const divisionWinners = [];
  const restPool = [];
  for (const div of divisionRecords) {
    const ranked = div.teamRecords
      .map(tr => ({
        teamId: tr.team.id,
        wins: n(tr.wins),
        losses: n(tr.losses),
        rating: teamRating(tr),
      }))
      .sort((a, b) => b.rating - a.rating);
    if (!ranked.length) continue;
    divisionWinners.push(ranked[0]);
    restPool.push(...ranked.slice(1));
  }
  divisionWinners.sort((a, b) => b.rating - a.rating);
  restPool.sort((a, b) => b.rating - a.rating);
  const wildCards = restPool.slice(0, 3);
  const seeds = [...divisionWinners, ...wildCards].slice(0, 6);
  return seeds.map((s, i) => ({
    ...s,
    seedNum: i + 1,
    name: teamMeta[s.teamId]?.name || `Team ${s.teamId}`,
    abbr: teamMeta[s.teamId]?.abbreviation || '',
  }));
}

async function fetchTeamMeta() {
  const data = await fetchJSON(`${API}/teams?sportId=1&season=${SEASON}`);
  const meta = {};
  for (const t of data.teams || []) {
    meta[t.id] = { name: t.name, abbreviation: t.abbreviation };
  }
  return meta;
}

async function buildWorldSeriesOdds(standings, teamMeta) {
  const records = standings.records || [];
  const alDivisions = records.filter(r => r.league && r.league.id === AL_LEAGUE_ID);
  const nlDivisions = records.filter(r => r.league && r.league.id === NL_LEAGUE_ID);

  const totalGames = records.reduce((sum, div) => sum + div.teamRecords.reduce((s, tr) => s + n(tr.wins) + n(tr.losses), 0), 0);
  const totalTeams = records.reduce((sum, div) => sum + div.teamRecords.length, 0);
  if (!totalTeams || totalGames / totalTeams < MIN_GAMES_PLAYED) {
    return null; // too early in the season (or offseason) for meaningful odds
  }

  const alSeeds = buildLeagueSeeds(alDivisions, teamMeta);
  const nlSeeds = buildLeagueSeeds(nlDivisions, teamMeta);
  if (alSeeds.length < 6 || nlSeeds.length < 6) return null;

  const wsWins = {};
  for (let i = 0; i < SIM_TRIALS; i++) {
    const alChamp = simulateLeagueBracket(alSeeds);
    const nlChamp = simulateLeagueBracket(nlSeeds);
    const wsWinner = simulateSeries(alChamp, nlChamp, 4);
    wsWins[wsWinner.teamId] = (wsWins[wsWinner.teamId] || 0) + 1;
  }

  const results = [];
  for (const seed of [...alSeeds, ...nlSeeds]) {
    const wins = wsWins[seed.teamId] || 0;
    results.push({
      teamId: seed.teamId,
      name: seed.name,
      abbr: seed.abbr,
      league: alSeeds.includes(seed) ? 'AL' : 'NL',
      pct: Math.round((wins / SIM_TRIALS) * 1000) / 10,
    });
  }
  results.sort((a, b) => b.pct - a.pct);
  return results;
}

const HITTING_CATS = ['onBasePlusSlugging', 'homeRuns', 'runsBattedIn', 'stolenBases'];
const MVP_WEIGHTS = { onBasePlusSlugging: 0.35, homeRuns: 0.30, runsBattedIn: 0.20, stolenBases: 0.10 };
const MVP_TEAM_WEIGHT = 0.05;
const MVP_CANDIDATE_LIMIT = 50;
const MVP_POOL_SIZE = 10;
const SOFTMAX_TEMPERATURE = 0.35;

// Where a candidate ranks (1-50) in one category's leaderboard becomes a
// 0-1 percentile score; unranked (outside the top 50) scores 0 for that
// category rather than being excluded outright.
function percentileScore(rank, poolSize) {
  if (!rank || rank < 1) return 0;
  return Math.max(0, (poolSize + 1 - rank) / poolSize);
}

function softmax(scores, temperature) {
  const max = Math.max(...scores);
  const exp = scores.map(s => Math.exp((s - max) / temperature));
  const sum = exp.reduce((a, b) => a + b, 0);
  return exp.map(e => e / sum);
}

async function buildMvpOdds(teamMeta, teamWinPct) {
  const data = await fetchJSON(
    `${API}/stats/leaders?leaderCategories=${HITTING_CATS.join(',')}&season=${SEASON}&sportId=1&statGroup=hitting&limit=${MVP_CANDIDATE_LIMIT}`
  );
  const categories = data.leagueLeaders || [];
  const candidates = new Map();
  for (const cat of categories) {
    if (!MVP_WEIGHTS[cat.leaderCategory]) continue;
    for (const leader of cat.leaders || []) {
      const id = leader.person && leader.person.id;
      if (!id) continue;
      if (!candidates.has(id)) {
        const teamId = leader.team && leader.team.id;
        // The leaders endpoint's team object only reliably carries an id — no
        // abbreviation (confirmed against a live response: every candidate came
        // back with team.abbreviation undefined). Resolve the real abbreviation
        // from teamMeta instead, which was built from the /teams endpoint.
        candidates.set(id, {
          id,
          name: leader.person.fullName,
          teamId,
          teamAbbr: (teamMeta[teamId] && teamMeta[teamId].abbreviation) || (leader.team && leader.team.abbreviation) || '',
          ranks: {},
        });
      }
      candidates.get(id).ranks[cat.leaderCategory] = n(leader.rank, MVP_CANDIDATE_LIMIT + 1);
    }
  }

  const byLeague = { AL: [], NL: [] };
  for (const c of candidates.values()) {
    const league = teamMeta[c.teamId]?.league;
    if (league !== 'AL' && league !== 'NL') continue;
    let score = 0;
    for (const [cat, weight] of Object.entries(MVP_WEIGHTS)) {
      score += weight * percentileScore(c.ranks[cat], MVP_CANDIDATE_LIMIT);
    }
    score += MVP_TEAM_WEIGHT * (teamWinPct[c.teamId] || 0.5);
    byLeague[league].push({ ...c, score });
  }

  const out = { AL: [], NL: [] };
  for (const league of ['AL', 'NL']) {
    const pool = byLeague[league].sort((a, b) => b.score - a.score).slice(0, MVP_POOL_SIZE);
    if (!pool.length) continue;
    const probs = softmax(pool.map(c => c.score), SOFTMAX_TEMPERATURE);
    out[league] = pool.map((c, i) => ({
      id: c.id,
      name: c.name,
      teamAbbr: c.teamAbbr,
      pct: Math.round(probs[i] * 1000) / 10,
    }));
  }
  return out;
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  let worldSeries = null, mvp = null, err = null;
  try {
    const [standings, teamMetaBasic] = await Promise.all([
      fetchJSON(`${API}/standings?leagueId=${AL_LEAGUE_ID},${NL_LEAGUE_ID}&season=${SEASON}&standingsTypes=regularSeason`),
      fetchTeamMeta(),
    ]);
    const records = standings.records || [];
    const teamMeta = {};
    const teamWinPct = {};
    for (const div of records) {
      const league = div.league && div.league.id === AL_LEAGUE_ID ? 'AL' : div.league && div.league.id === NL_LEAGUE_ID ? 'NL' : null;
      for (const tr of div.teamRecords || []) {
        const gp = n(tr.wins) + n(tr.losses);
        teamMeta[tr.team.id] = { ...(teamMetaBasic[tr.team.id] || {}), league };
        teamWinPct[tr.team.id] = gp > 0 ? n(tr.wins) / gp : 0.5;
      }
    }

    worldSeries = await buildWorldSeriesOdds(standings, teamMeta);
    mvp = await buildMvpOdds(teamMeta, teamWinPct);
  } catch (e) {
    err = e.message;
    console.error('Season projections generation failed:', e.message);
  }

  // Same policy as the Statcast sync: don't overwrite yesterday's real data
  // with an empty result unless this run actually produced something (or
  // genuinely determined it's too early in the season to have odds yet).
  if (!err) {
    const out = {
      generatedAt: new Date().toISOString(),
      season: SEASON,
      worldSeries: worldSeries || [],
      mvp: mvp || { AL: [], NL: [] },
    };
    await writeFile(OUT_PATH, JSON.stringify(out, null, 2) + '\n');
    console.log(`Wrote season-projections.json: ${(worldSeries || []).length} teams, AL MVP pool ${(mvp?.AL || []).length}, NL MVP pool ${(mvp?.NL || []).length}.`);
  } else {
    process.exitCode = 1;
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch(e => { console.error(e); process.exit(1); });
}

export {
  teamRating, log5, simulateGame, simulateSeries, simulateLeagueBracket,
  buildLeagueSeeds, percentileScore, softmax, buildMvpOdds, buildWorldSeriesOdds, main,
};
