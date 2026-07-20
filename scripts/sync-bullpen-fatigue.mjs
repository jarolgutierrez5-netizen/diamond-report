#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Builds a per-team "bullpen fatigue" signal from real recent relief-pitcher
// appearances, into data/bullpen-fatigue.json — a team that's burned through
// its bullpen the last two days (heavy total pitch count, or arms that
// pitched on both days back-to-back) is more likely to have a shaky/unusable
// relief corps tonight, which the app currently has no signal for at all.
//
// There's no single "bullpen fatigue" endpoint — this is assembled from real
// per-game boxscores:
//   1. GET /schedule?teamId=X&startDate=(today-2)&endDate=(today-1)&sportId=1
//      to find each team's last two calendar days of games (usually one each,
//      more on a doubleheader day), filtered to status=Final.
//   2. GET /game/{gamePk}/boxscore for each of those games. The community-
//      documented MLB Stats API boxscore shape lists each side's pitchers as
//      teams.{home|away}.pitchers: [id, id, ...] in the order they appeared —
//      the first id is the starter, every id after it is a reliever. Each
//      pitcher's own numberOfPitches for that game lives at
//      teams.{home|away}.players['ID<id>'].stats.pitching.numberOfPitches.
//   3. Sum reliever pitches across both days per team, and count relievers who
//      appear on both days (the most fatigued/least available arms).
//
// Verified live (2026-07-17) against a normal mid-season window
// (2026-07-08 to 2026-07-09): 30/30 teams returned at least one Final game,
// 56 total games found, 3479 total reliever pitches summed across all teams
// — confirmed the pitchers[]/numberOfPitches shape above is correct. A
// same-day run against the actual "last 2 days" window returned near-zero
// for 28/30 teams; that was the All-Star break, not a bug in this script.
// ─────────────────────────────────────────────────────────────────────────

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const MLB_API = 'https://statsapi.mlb.com/api/v1';

function isoDate(d) { return d.toISOString().slice(0, 10); }
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d; }
const WINDOW_START = isoDate(daysAgo(2));
const WINDOW_END = isoDate(daysAgo(1));

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

let loggedSample = false;

// Returns [{ pitcherId, pitches }] for every reliever (i.e. every pitcher after
// the first) on the given team's side of this one boxscore.
function extractRelieverAppearances(boxscore, teamId) {
  const sides = ['home', 'away'];
  const side = sides.find(s => boxscore?.teams?.[s]?.team?.id === teamId);
  if (!side) return [];
  const teamBox = boxscore.teams[side];
  if (!loggedSample) {
    console.log(`Sample boxscore team shape (${side}): pitchers=${JSON.stringify(teamBox.pitchers)}, ` +
      `sample player keys=${Object.keys(teamBox.players || {}).slice(0, 2).join(', ')}, ` +
      `sample player pitching stat=${JSON.stringify(Object.values(teamBox.players || {})[0]?.stats?.pitching).slice(0, 300)}`);
    loggedSample = true;
  }
  const pitcherIds = Array.isArray(teamBox.pitchers) ? teamBox.pitchers : [];
  if (pitcherIds.length < 2) return []; // no relievers used, or shape didn't match
  const relievers = pitcherIds.slice(1);
  return relievers.map(id => {
    const player = teamBox.players?.[`ID${id}`];
    const pitches = player?.stats?.pitching?.numberOfPitches;
    return { pitcherId: id, pitches: Number.isFinite(pitches) ? pitches : null };
  }).filter(r => r.pitches != null);
}

async function buildTeamFatigue(team) {
  const gamePks = await teamRecentGamePks(team.id);
  if (!gamePks.length) return { gamesFound: 0, totalRelieverPitches: 0, relieverAppearances: 0, backToBackArms: 0 };

  const perGameRelievers = [];
  for (const gamePk of gamePks) {
    try {
      const box = await fetchJSON(`${MLB_API}/game/${gamePk}/boxscore`);
      perGameRelievers.push(extractRelieverAppearances(box, team.id));
    } catch (e) {
      console.warn(`Boxscore fetch failed for game ${gamePk} (team ${team.abbr}):`, e.message);
    }
  }

  const totalRelieverPitches = perGameRelievers.flat().reduce((sum, r) => sum + r.pitches, 0);
  const relieverAppearances = perGameRelievers.flat().length;
  // An arm that shows up in more than one of these games' reliever lists pitched
  // on back-to-back days — the clearest single "probably unavailable tonight" signal.
  const appearanceCounts = {};
  perGameRelievers.flat().forEach(r => { appearanceCounts[r.pitcherId] = (appearanceCounts[r.pitcherId] || 0) + 1; });
  const backToBackArms = Object.values(appearanceCounts).filter(c => c > 1).length;

  return { gamesFound: gamePks.length, totalRelieverPitches, relieverAppearances, backToBackArms };
}

// Recalibrated 2026-07-20: the original 35/80/130 cutoffs were set far below
// real totals. A normal team uses 3-5 relievers/game at ~15-25 pitches each —
// 60-100 relief pitches per game is unremarkable, so summed across the
// ~2-game window this script covers, normal totals routinely land at
// 120-160+. Checked against a live 30-team snapshot (2026-07-20): mean score
// 156, median 136 — both already past the old "Gassed" cutoff of 130, which
// is why nearly every team was showing Gassed/Taxed regardless of actual
// bullpen usage. New cutoffs center the typical range on Normal and reserve
// Taxed/Gassed for real upper-tail outliers (that snapshot's real
// distribution: 47-411, most teams 85-160) — verify against a fresh snapshot
// if usage patterns drift over the season.
function fatigueTier(f) {
  const score = f.totalRelieverPitches + f.backToBackArms * 25;
  if (score >= 230) return 'Gassed';
  if (score >= 160) return 'Taxed';
  if (score >= 75) return 'Normal';
  return 'Fresh';
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
  console.log(`Found ${teams.length} active MLB teams. Fatigue window: ${WINDOW_START} to ${WINDOW_END}.`);

  const out = {};
  let teamFailures = 0;
  for (const team of teams) {
    try {
      const fatigue = await buildTeamFatigue(team);
      out[team.abbr] = { ...fatigue, tier: fatigueTier(fatigue) };
    } catch (e) {
      teamFailures++;
      console.warn(`Bullpen fatigue sync failed for ${team.abbr}:`, e.message);
    }
    await new Promise(r => setTimeout(r, 300));
  }

  const tiers = Object.values(out).map(v => v.tier);
  console.log(`Built bullpen fatigue for ${Object.keys(out).length}/${teams.length} teams ` +
    `(${teamFailures} failed) — ${tiers.filter(t => t === 'Gassed').length} Gassed, ` +
    `${tiers.filter(t => t === 'Taxed').length} Taxed, ${tiers.filter(t => t === 'Normal').length} Normal, ` +
    `${tiers.filter(t => t === 'Fresh').length} Fresh.`);

  await writeFile(path.join(DATA_DIR, 'bullpen-fatigue.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    teams: out,
  }, null, 2) + '\n');
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch(e => { console.error(e); process.exit(1); });
}

export { activeTeams, buildTeamFatigue, extractRelieverAppearances, fatigueTier, main };
