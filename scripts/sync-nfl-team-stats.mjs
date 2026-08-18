#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Real per-team record/point differential -- the team-level signal behind the
// NFL Game Projections board (app.js). NFL has no per-game "starting pitcher"
// equivalent the way MLB's DRP board does, so the model here is entirely
// team-based: real win%, real point differential, and home field, the same
// team-strength signals a genuine power-ranking model uses. Same "don't
// fabricate what the API doesn't give you" rule as sync-wnba-team-defense.mjs
// -- every field here is a real ESPN standings value, nothing derived or
// guessed.
//
// Endpoint: site.api.espn.com/apis/v2/sports/football/nfl/standings -- the
// *v2* path (confirmed live, same host/version WNBA's team-defense sync
// uses). Response is grouped by conference under `children[]` (AFC/NFC),
// each with its own `standings.entries[]` -- both conferences must be
// iterated to get every real team (confirmed live: 2 conferences, 32 real
// teams total, 16 per conference, no further division-level nesting in
// `entries`).
// ─────────────────────────────────────────────────────────────────────────

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const TEAM_STATS_PATH = path.join(DATA_DIR, 'nfl-team-stats.json');

// NFL's season straddles two calendar years (Sep-Feb) -- ESPN's `season`
// standings param wants the year the season STARTED in, so a request made
// during Jan/Feb still needs the previous calendar year.
function seasonYear(now = new Date()) {
  return now.getUTCMonth() < 2 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
}

function standingsURL() {
  return `https://site.api.espn.com/apis/v2/sports/football/nfl/standings?season=${seasonYear()}`;
}

async function fetchJSON(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function statValue(stats, name) {
  const stat = (stats || []).find(s => s?.name === name);
  const value = Number(stat?.value);
  return Number.isFinite(value) ? value : null;
}

// Pulls each real team's real wins/losses/ties/pointsFor/pointsAgainst/
// winPercent from the (multi-conference) standings response. Returns null if
// the response has no usable entries at all, distinct from a real (if
// unlikely) empty stats array on an entry.
function extractTeamStats(raw) {
  const children = raw?.children;
  if (!Array.isArray(children) || !children.length) return null;
  const teams = {};
  for (const child of children) {
    const entries = child?.standings?.entries;
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const abbr = entry?.team?.abbreviation;
      if (!abbr) continue;
      const wins = statValue(entry.stats, 'wins');
      const losses = statValue(entry.stats, 'losses');
      if (wins == null || losses == null) continue;
      teams[abbr] = {
        wins,
        losses,
        ties: statValue(entry.stats, 'ties') || 0,
        winPercent: statValue(entry.stats, 'winPercent'),
        pointsFor: statValue(entry.stats, 'pointsFor'),
        pointsAgainst: statValue(entry.stats, 'pointsAgainst'),
        pointDifferential: statValue(entry.stats, 'pointDifferential'),
      };
    }
  }
  return Object.keys(teams).length ? teams : null;
}

function leagueAverage(teams, key) {
  const values = Object.values(teams).map(t => t[key]).filter(Number.isFinite);
  if (!values.length) return null;
  return +(values.reduce((a, b) => a + b, 0) / values.length).toFixed(2);
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  let raw;
  try {
    raw = await fetchJSON(standingsURL());
  } catch (e) {
    console.error('Standings fetch failed:', e.message);
    process.exitCode = 1;
    return;
  }

  const teams = extractTeamStats(raw);
  if (!teams) {
    console.error('No usable team stats in standings response.');
    process.exitCode = 1;
    return;
  }
  const leagueAvgPointDifferential = leagueAverage(teams, 'pointDifferential');

  console.log(`Team stats: ${Object.keys(teams).length} team(s), league avg point differential ${leagueAvgPointDifferential}.`);
  await writeFile(TEAM_STATS_PATH, JSON.stringify({ updatedAt: new Date().toISOString(), leagueAvgPointDifferential, teams }, null, 2) + '\n');
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch(e => { console.error(e); process.exit(1); });
}

export { extractTeamStats, leagueAverage, standingsURL, seasonYear, main };
