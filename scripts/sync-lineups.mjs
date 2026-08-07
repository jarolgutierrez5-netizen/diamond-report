#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Builds today's real, officially-posted batting lineups into data/lineups.json
// — app.js's getRepoLineupForGame()/lineupBadgeHTML() already read this exact
// file (games.<gamePk>.teams.{home,away}.{lineup,confirmed,...}) to show the
// "✅ Lineup Confirmed" badge on board rows and feed the Pitcher Matchup
// panel's lineup list, but the file has never existed — this script was
// simply never written.
//
// Source: GET /schedule?sportId=1&date=<today>&hydrate=lineups. MLB only
// populates lineups.{home,away}Players once the official lineup is posted
// (typically 1-4 hours before first pitch) — before that it's an empty
// object. That's the ONLY source used here: this script captures real,
// official lineups only and never fabricates a projected/expected one, per
// the same "no data yet, don't guess" rule lineupBadgeHTML()'s own comment
// already states for the client side. Every captured team is therefore
// always confirmed:true; there is no "expected" state to produce.
//
// Batting order is the array order MLB returns lineups.{home,away}Players
// in — confirmed live (2026-08-07) against a completed game's schedule
// hydrate response.
// ─────────────────────────────────────────────────────────────────────────

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const MLB_API = 'https://statsapi.mlb.com/api/v1';

function todayCentral() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

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

// MLB's lineups.{home,away}Players entries carry primaryPosition, not the
// game-specific position they're actually playing today (a player can play a
// different position than their primary one) — but the schedule hydrate
// response doesn't expose the game-specific slot, only primaryPosition, so
// that's what's used here. Same limitation the rest of this app already
// accepts wherever it reads primaryPosition instead of a per-game fielding
// assignment.
function buildTeamLineup(players, teamAbbr) {
  if (!Array.isArray(players) || !players.length) return null;
  return {
    abbr: teamAbbr,
    confirmed: true,
    confirmedAt: new Date().toISOString(),
    source: 'mlb-schedule-lineups',
    lineup: players.map(p => ({
      id: p.id ?? null,
      name: p.fullName || p.useName || '–',
      pos: p.primaryPosition?.abbreviation || '–',
    })),
  };
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  const date = todayCentral();
  let schedule;
  try {
    schedule = await fetchJSON(`${MLB_API}/schedule?sportId=1&date=${date}&hydrate=lineups,team`);
  } catch (e) {
    console.error('Failed to fetch schedule with lineups:', e.message);
    process.exitCode = 1;
    return;
  }

  const games = {};
  let confirmedCount = 0;
  for (const dateEntry of schedule.dates || []) {
    for (const g of dateEntry.games || []) {
      const homeAbbr = g.teams?.home?.team?.abbreviation;
      const awayAbbr = g.teams?.away?.team?.abbreviation;
      const homeTeam = buildTeamLineup(g.lineups?.homePlayers, homeAbbr);
      const awayTeam = buildTeamLineup(g.lineups?.awayPlayers, awayAbbr);
      if (!homeTeam && !awayTeam) continue; // neither side posted yet — nothing real to record
      if (homeTeam) confirmedCount++;
      if (awayTeam) confirmedCount++;
      games[String(g.gamePk)] = {
        updatedAt: new Date().toISOString(),
        teams: { home: homeTeam, away: awayTeam },
      };
    }
  }

  console.log(`Captured ${confirmedCount} confirmed team lineups across ${Object.keys(games).length} games for ${date}.`);

  await writeFile(path.join(DATA_DIR, 'lineups.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    date,
    games,
  }, null, 2) + '\n');
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch(e => { console.error(e); process.exit(1); });
}

export { buildTeamLineup, main };
