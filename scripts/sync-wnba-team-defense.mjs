#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Real per-team opponent scoring defense -- the first opponent-defense signal
// behind the WNBA Points board's individual projections (app.js:
// WNBA_PROP_BOARDS.points, renderWNBAPropBoard). Reads ESPN's real WNBA
// standings, which carry a real `avgPointsAgainst` per team (points a team's
// real opponents have scored against them this season, divided by real games
// played) -- confirmed live during planning, not a guess. This is a genuine
// team-level defensive signal, distinct from and much coarser than the real
// per-pitcher matchup-edge scoring the MLB boards already do (no basketball
// equivalent of "this batter vs. this specific pitcher's real arsenal"
// exists -- a shooter doesn't face one individual defender for a whole game
// the way a batter faces one pitcher), so this stays at team level rather
// than pretending to a player-vs-player precision the sport doesn't offer.
//
// Only points-allowed exists as a real ESPN standings field -- rebounds/
// assists/3PM-allowed have no equivalent official aggregate, so this script
// intentionally does NOT fabricate those. (A real opponent-allowed rate for
// those stats would require summing every completed game's real box score
// this season -- a genuinely bigger data pipeline, deliberately out of scope
// here rather than approximated.)
//
// Endpoint: site.api.espn.com/apis/v2/sports/basketball/wnba/standings --
// note the *v2* path (not /apis/site/v2/... like the other WNBA sync
// scripts), confirmed live to be the one that actually returns standings
// with real per-team stats. Response is grouped by conference under
// `children[]`, each with its own `standings.entries[]` -- both conferences
// must be iterated to get every real team (confirmed live: 2 conferences,
// 15 real teams total).
// ─────────────────────────────────────────────────────────────────────────

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const TEAM_DEFENSE_PATH = path.join(DATA_DIR, 'wnba-team-defense.json');

function standingsURL() {
  return `https://site.api.espn.com/apis/v2/sports/basketball/wnba/standings?season=${new Date().getFullYear()}`;
}

async function fetchJSON(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// Pulls each real team's real avgPointsAgainst from the (possibly multi-
// conference) standings response. Returns null if the response has no
// usable entries at all, distinct from a real (if unlikely) empty stats
// array on an entry.
function extractTeamDefense(raw) {
  const children = raw?.children;
  if (!Array.isArray(children) || !children.length) return null;
  const teams = {};
  for (const child of children) {
    const entries = child?.standings?.entries;
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const abbr = entry?.team?.abbreviation;
      if (!abbr) continue;
      const stat = (entry?.stats || []).find(s => s?.name === 'avgPointsAgainst');
      const value = Number(stat?.value);
      if (Number.isFinite(value)) teams[abbr] = { avgPointsAgainst: +value.toFixed(2) };
    }
  }
  return Object.keys(teams).length ? teams : null;
}

function leagueAverage(teams) {
  const values = Object.values(teams).map(t => t.avgPointsAgainst).filter(Number.isFinite);
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

  const teams = extractTeamDefense(raw);
  if (!teams) {
    console.error('No usable team defense data in standings response.');
    process.exitCode = 1;
    return;
  }
  const leagueAvgPointsAgainst = leagueAverage(teams);

  console.log(`Team defense: ${Object.keys(teams).length} team(s), league avg points against ${leagueAvgPointsAgainst}.`);
  await writeFile(TEAM_DEFENSE_PATH, JSON.stringify({ updatedAt: new Date().toISOString(), leagueAvgPointsAgainst, teams }, null, 2) + '\n');
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch(e => { console.error(e); process.exit(1); });
}

export { extractTeamDefense, leagueAverage, standingsURL, main };
