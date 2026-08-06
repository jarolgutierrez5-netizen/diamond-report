#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// NFL skill-position rosters -- the player universe the Anytime TD props
// board scores from. Pulls each of the 32 teams' active roster from ESPN's
// public site API and keeps only the positions that can actually score an
// offensive touchdown (QB/RB/WR/TE) -- offensive linemen, defense, and
// special teams are real roster spots but never the subject of an "Anytime
// TD" prop, so there's no reason to carry them into data/nfl-rosters.json.
//
// Reads data/nfl-teams.json (written by sync-nfl-schedule.mjs) for the team
// id list rather than re-fetching it -- same "don't refetch what's already
// on disk" discipline the MLB sync scripts follow.
//
// Same unverified-in-this-sandbox caveat as sync-nfl-schedule.mjs: ESPN's
// site.api.espn.com is free/keyless but unofficial, and this sandbox has no
// route to it. The roster endpoint's grouped-by-position-category shape
// (athletes: [{ position: 'offense'|'defense'|..., items: [...] }], each
// item carrying its own position.abbreviation) is the same shape public
// ESPN API wrappers document, not something confirmed live from here --
// run via workflow_dispatch and check data/nfl-rosters.json's real player
// count before building anything further on top of it.
// ─────────────────────────────────────────────────────────────────────────

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const TEAMS_PATH = path.join(DATA_DIR, 'nfl-teams.json');
const ROSTERS_PATH = path.join(DATA_DIR, 'nfl-rosters.json');

const SKILL_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE', 'FB']);

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
  return `https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${teamId}/roster`;
}

function extractSkillPlayers(raw, teamAbbr) {
  const groups = raw?.athletes;
  if (!Array.isArray(groups)) throw new Error(`unexpected roster shape (no athletes[] groups) for ${teamAbbr}`);
  const players = [];
  for (const group of groups) {
    for (const a of group?.items || []) {
      const pos = a?.position?.abbreviation;
      if (!pos || !SKILL_POSITIONS.has(pos)) continue;
      if (!a.id) continue;
      players.push({
        id: String(a.id),
        name: a.displayName || a.fullName || null,
        position: pos,
        jersey: a.jersey || null,
        headshot: a.headshot?.href || null,
        teamAbbr,
      });
    }
  }
  return players;
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  let teamsData;
  try {
    teamsData = JSON.parse(await readFile(TEAMS_PATH, 'utf8'));
  } catch (e) {
    console.error('data/nfl-teams.json not found or unreadable — run sync-nfl-schedule.mjs first. ' + e.message);
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
      const skillPlayers = extractSkillPlayers(raw, team.abbreviation);
      for (const p of skillPlayers) players[p.id] = p;
      updated++;
    } catch (e) {
      failed++;
      console.error(`Roster fetch failed for ${team.abbreviation || team.id}:`, e.message);
    }
    // Same polite bounded-scope delay every other sync script in this repo uses
    // against a free, unauthenticated public endpoint.
    await new Promise(r => setTimeout(r, 400));
  }

  const bySkillPosition = {};
  Object.values(players).forEach(p => { bySkillPosition[p.position] = (bySkillPosition[p.position] || 0) + 1; });
  console.log(`Fetched rosters for ${updated}/${teams.length} team(s), ${failed} failed. ${Object.keys(players).length} skill-position player(s): ${JSON.stringify(bySkillPosition)}.`);

  if (updated > 0) {
    await writeFile(ROSTERS_PATH, JSON.stringify({ updatedAt: new Date().toISOString(), players }, null, 2) + '\n');
  }
  if (failed > 0 && updated === 0) process.exitCode = 1;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch(e => { console.error(e); process.exit(1); });
}

export { extractSkillPlayers, rosterURL, SKILL_POSITIONS, main };
