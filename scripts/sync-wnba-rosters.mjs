#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// WNBA rosters -- the player universe the 15+ Points Probability board scores
// from. Pulls each of the league's teams' active roster from ESPN's public
// site API. Unlike sync-nfl-rosters.mjs's SKILL_POSITIONS filter (only
// offensive skill positions can score an "Anytime TD"), every WNBA roster
// spot is a real candidate to score points, so nothing is filtered out here.
//
// Reads data/wnba-teams.json (written by sync-wnba-schedule.mjs) for the
// team id list rather than re-fetching it -- same "don't refetch what's
// already on disk" discipline the MLB and NFL sync scripts follow.
//
// Verified live against a real response during planning: WNBA's roster shape
// is a FLAT `athletes: [...]` array of player objects (position as a nested
// {abbreviation,...} object, headshot as {href,...}), not grouped by
// position-category like NFL's `athletes: [{position:'offense', items:[...]}]`
// -- this is a real, confirmed shape difference from the NFL script, not a
// guess.
// ─────────────────────────────────────────────────────────────────────────

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const TEAMS_PATH = path.join(DATA_DIR, 'wnba-teams.json');
const ROSTERS_PATH = path.join(DATA_DIR, 'wnba-rosters.json');

const FETCH_TIMEOUT_MS = 15000;
async function fetchJSON(url, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' }, signal: controller.signal });
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

function rosterURL(teamId) {
  return `https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/teams/${teamId}/roster`;
}

function extractPlayers(raw, teamAbbr) {
  const athletes = raw?.athletes;
  if (!Array.isArray(athletes)) throw new Error(`unexpected roster shape (no flat athletes[]) for ${teamAbbr}`);
  const players = [];
  for (const a of athletes) {
    if (!a?.id) continue;
    players.push({
      id: String(a.id),
      name: a.displayName || a.fullName || null,
      position: a.position?.abbreviation || null,
      jersey: a.jersey || null,
      headshot: a.headshot?.href || null,
      teamAbbr,
    });
  }
  return players;
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  let teamsData;
  try {
    teamsData = JSON.parse(await readFile(TEAMS_PATH, 'utf8'));
  } catch (e) {
    console.error('data/wnba-teams.json not found or unreadable — run sync-wnba-schedule.mjs first. ' + e.message);
    process.exitCode = 1;
    return;
  }
  const teams = teamsData.teams || [];
  console.log(`Found ${teams.length} team(s) to fetch rosters for.`);

  const players = {}; // playerId -> player record
  let updated = 0, failed = 0;
  for (const team of teams) {
    if (!team.id) continue;
    try {
      const raw = await fetchJSON(rosterURL(team.id));
      const teamPlayers = extractPlayers(raw, team.abbreviation);
      for (const p of teamPlayers) players[p.id] = p;
      updated++;
    } catch (e) {
      failed++;
      console.error(`Roster fetch failed for ${team.abbreviation || team.id}:`, e.message);
    }
    // Same polite bounded-scope delay every other sync script in this repo
    // uses against a free, unauthenticated public endpoint.
    await new Promise(r => setTimeout(r, 400));
  }

  console.log(`Fetched rosters for ${updated}/${teams.length} team(s), ${failed} failed. ${Object.keys(players).length} player(s) total.`);

  if (updated > 0) {
    await writeFile(ROSTERS_PATH, JSON.stringify({ updatedAt: new Date().toISOString(), players }, null, 2) + '\n');
  }
  if (failed > 0 && updated === 0) process.exitCode = 1;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch(e => { console.error(e); process.exit(1); });
}

export { extractPlayers, rosterURL, main };
