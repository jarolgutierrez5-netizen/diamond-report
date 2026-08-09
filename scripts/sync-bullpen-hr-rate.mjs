#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Builds a real, relievers-only HR-allowed rate per team, into
// data/bullpen-hr-rate.json — the app.js loadHRPotential / update-tracker.mjs
// computeLiveHRScore "HR Probability" formula already discounts a quick-hook
// starter's own influence via startBFShare (real workload data, see
// sync-pitcher-workload.mjs), but the weight that discount frees up was
// previously just flowing into the batter's own rate instead of being
// replaced by any real signal about who the batter actually faces for the
// rest of the game. This file is that signal.
//
// Same boxscore-walking technique sync-bullpen-fatigue.mjs already uses
// (teams.{home|away}.pitchers[] lists each side's pitchers in the order they
// appeared -- index 0 is the starter, everything after is a reliever;
// per-pitcher stats for that one game live at
// teams.{home|away}.players['ID<id>'].stats.pitching), but:
//   - a much WIDER rolling window (14 days, not fatigue's 2) -- HR is a rare
//     event, so a couple of days' worth of relief innings is nowhere near
//     enough of a sample to trust as a rate (the same reasoning behind this
//     app's SHRINK_PRIOR_PA.hr=300 constant elsewhere, see app.js's Simulate
//     Game engine); fatigue's short window is fine for "who's tired right
//     now" but wrong for "how good is this bullpen."
//   - extracts homeRuns/battersFaced per reliever appearance (not just
//     numberOfPitches like fatigue does), to build an actual rate.
//
// Verified live (2026-08-08) against a real Final boxscore (gamePk 824649):
// teams.home.players['ID<relieverId>'].stats.pitching has both `homeRuns`
// and `battersFaced` fields directly alongside `numberOfPitches`, same
// nested location the fatigue script already reads from.
// ─────────────────────────────────────────────────────────────────────────

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const MLB_API = 'https://statsapi.mlb.com/api/v1';

function isoDate(d) { return d.toISOString().slice(0, 10); }
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d; }
const WINDOW_DAYS = 14;
const WINDOW_START = isoDate(daysAgo(WINDOW_DAYS));
const WINDOW_END = isoDate(daysAgo(1));

// Same league-average HR-per-PA constant already used by both live formulas
// (HRP_LEAGUE_AVG_HR_RATE in app.js / update-tracker.mjs) -- battersFaced
// isn't exactly plate appearances, but close enough for this purpose (same
// approximation the rest of this formula already makes elsewhere).
const LEAGUE_AVG_HR_RATE = 0.031;
// Same order of magnitude as SHRINK_PRIOR_PA.hr (app.js's Simulate Game
// engine) -- how many BF worth of league-average belief to blend in before
// trusting a team's own real relief sample.
const PRIOR_BF = 300;
// Below this many real relief BF in the window, a team's rate is almost
// entirely the shrinkage prior anyway -- flagged unreliable rather than
// presented as a real read, same reliable-gate convention as
// pitcher-workload.json's MIN_STARTS_FOR_SIGNAL.
const MIN_BF_FOR_RELIABLE = 40;

const FETCH_TIMEOUT_MS = 15000;
async function fetchJSON(url, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DiamondReportBot/1.0; +https://diamondreport.app)' }, signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (e) {
      lastErr = e.name === 'AbortError' ? new Error(`Timed out after ${FETCH_TIMEOUT_MS}ms for ${url}`) : e;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

async function activeTeams() {
  const d = await fetchJSON(`${MLB_API}/teams?sportId=1&activeStatus=Yes`);
  return (d.teams || []).map(t => ({ id: t.id, abbr: t.abbreviation })).filter(t => t.id && t.abbr);
}

async function teamRecentGamePks(teamId) {
  const d = await fetchJSON(`${MLB_API}/schedule?sportId=1&teamId=${teamId}&startDate=${WINDOW_START}&endDate=${WINDOW_END}`);
  const games = [];
  for (const date of d.dates || []) {
    for (const g of date.games || []) {
      if (g.status?.abstractGameState === 'Final' && g.gamePk) games.push(g.gamePk);
    }
  }
  return games;
}

// Returns [{ homeRuns, battersFaced }] for every reliever (i.e. every
// pitcher after the first) on the given team's side of this one boxscore.
function extractRelieverHRStats(boxscore, teamId) {
  const sides = ['home', 'away'];
  const side = sides.find(s => boxscore?.teams?.[s]?.team?.id === teamId);
  if (!side) return [];
  const teamBox = boxscore.teams[side];
  const pitcherIds = Array.isArray(teamBox.pitchers) ? teamBox.pitchers : [];
  if (pitcherIds.length < 2) return []; // no relievers used, or shape didn't match
  const relievers = pitcherIds.slice(1);
  return relievers.map(id => {
    const stat = teamBox.players?.[`ID${id}`]?.stats?.pitching;
    const bf = Number(stat?.battersFaced);
    const hr = Number(stat?.homeRuns);
    return Number.isFinite(bf) ? { homeRuns: Number.isFinite(hr) ? hr : 0, battersFaced: bf } : null;
  }).filter(Boolean);
}

async function buildTeamBullpenRate(team) {
  const gamePks = await teamRecentGamePks(team.id);
  if (!gamePks.length) return { relieverBF: 0, relieverHR: 0, gamesFound: 0 };

  let relieverBF = 0, relieverHR = 0;
  for (const gamePk of gamePks) {
    try {
      const box = await fetchJSON(`${MLB_API}/game/${gamePk}/boxscore`);
      for (const appearance of extractRelieverHRStats(box, team.id)) {
        relieverBF += appearance.battersFaced;
        relieverHR += appearance.homeRuns;
      }
    } catch (e) {
      console.warn(`Boxscore fetch failed for game ${gamePk} (team ${team.abbr}):`, e.message);
    }
  }
  return { relieverBF, relieverHR, gamesFound: gamePks.length };
}

function shrinkRate(hr, bf, leagueRate, priorBF) {
  return (hr + priorBF * leagueRate) / (bf + priorBF);
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  let teams;
  try {
    teams = await activeTeams();
  } catch (e) {
    console.error('Failed to fetch active team list:', e.message);
    process.exitCode = 1;
    return;
  }
  console.log(`Found ${teams.length} active MLB teams. Bullpen HR-rate window: ${WINDOW_START} to ${WINDOW_END}.`);

  const out = {};
  let teamFailures = 0;
  for (const team of teams) {
    try {
      const { relieverBF, relieverHR, gamesFound } = await buildTeamBullpenRate(team);
      const rawRate = relieverBF > 0 ? relieverHR / relieverBF : null;
      const shrunkRate = shrinkRate(relieverHR, relieverBF, LEAGUE_AVG_HR_RATE, PRIOR_BF);
      out[team.abbr] = {
        gamesFound, relieverBF, relieverHR,
        rawRate: rawRate != null ? Math.round(rawRate * 10000) / 10000 : null,
        shrunkRate: Math.round(shrunkRate * 10000) / 10000,
        reliable: relieverBF >= MIN_BF_FOR_RELIABLE,
      };
    } catch (e) {
      teamFailures++;
      console.warn(`Bullpen HR-rate sync failed for ${team.abbr}:`, e.message);
    }
    await new Promise(r => setTimeout(r, 300));
  }

  const reliableCount = Object.values(out).filter(v => v.reliable).length;
  console.log(`Built bullpen HR-rate for ${Object.keys(out).length}/${teams.length} teams ` +
    `(${teamFailures} failed) — ${reliableCount} reliable (>= ${MIN_BF_FOR_RELIABLE} relief BF in the window).`);

  await writeFile(path.join(DATA_DIR, 'bullpen-hr-rate.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    leagueAvgRate: LEAGUE_AVG_HR_RATE,
    teams: out,
  }, null, 2) + '\n');
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch(e => { console.error(e); process.exit(1); });
}

export { activeTeams, buildTeamBullpenRate, extractRelieverHRStats, shrinkRate, main };
