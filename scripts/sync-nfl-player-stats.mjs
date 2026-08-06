#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Real season touchdown rate per skill-position player -- the base input the
// Anytime TD props board scores from. Reads data/nfl-rosters.json (written by
// sync-nfl-rosters.mjs) for the player universe, then pulls each player's own
// game log from ESPN's public site API and sums real touchdowns (passing for
// QBs, rushing+receiving for RB/WR/TE/FB) across games actually played this
// season, most-recent-season-with-real-games-first (regular season 2026 once
// it exists, falling back to 2025's real final numbers during preseason/
// before Week 1 has been played, rather than fabricating a rate from zero
// current-season games).
//
// Per-player gamelog endpoint shape (site.api.espn.com/.../athletes/{id}/
// gamelog) is the same shape public ESPN API wrappers document -- a
// `seasonTypes[].categories[]` list (one entry per stat group: passing/
// rushing/receiving/etc.), each with its own `labels` (stat column names)
// and per-category `events{}` map of real per-game stat rows, PLUS an
// aggregate `totals` array in the same column order as `labels`. This
// script looks up whichever category's labels contain a "TD" column and
// reads that category's `totals` entry directly (season total, no need to
// sum every game) plus that category's real games-played count (the
// `events` map's own key count) for the rate denominator.
//
// Same unverified-in-this-sandbox caveat as every other script in this new
// NFL groundwork: this sandbox has no route to site.api.espn.com to confirm
// the shape above against a live response. Loud schema check + per-player
// try/catch (same defensive pattern as the MLB Statcast scripts) so one
// player's unexpected shape can't take down the whole run -- but treat the
// very first scheduled run as unverified until its own log output (and the
// resulting data/nfl-player-stats.json) is manually checked against a real,
// known player's real season TD total.
// ─────────────────────────────────────────────────────────────────────────

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const ROSTERS_PATH = path.join(DATA_DIR, 'nfl-rosters.json');
const PLAYER_STATS_PATH = path.join(DATA_DIR, 'nfl-player-stats.json');

// Tried newest-season-first -- whichever season actually has real games
// played (a non-zero games count) wins. During preseason/before Week 1,
// the current season legitimately has zero real games yet, so this falls
// back to last season's real final numbers rather than reporting a
// fabricated zero rate for every player in the league.
const SEASONS_TRIED = [new Date().getFullYear(), new Date().getFullYear() - 1];

const TD_LABEL_RE = /TD/i;
// Which stat categories count toward "Anytime TD" for each position -- a
// rushing or receiving score counts for anyone, a passing TD only counts
// for the player who threw it (not an "Anytime TD" scoring event himself).
const TD_CATEGORIES_BY_POSITION = {
  QB: ['rushing'],
  RB: ['rushing', 'receiving'],
  WR: ['rushing', 'receiving'],
  TE: ['rushing', 'receiving'],
  FB: ['rushing', 'receiving'],
};

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

function gamelogURL(playerId, season) {
  return `https://site.api.espn.com/apis/site/v2/sports/football/nfl/athletes/${playerId}/gamelog?season=${season}`;
}

// Sums real TDs + real games-played across every category relevant to this
// player's position (see TD_CATEGORIES_BY_POSITION), for one season's
// gamelog response. Returns null (not zero) if the response has no usable
// categories at all -- distinct from a real, confirmed 0 TDs on a real
// nonzero games count.
function extractSeasonTDRate(raw, position) {
  const wantedCategoryNames = TD_CATEGORIES_BY_POSITION[position] || [];
  const seasonTypes = raw?.seasonTypes;
  if (!Array.isArray(seasonTypes)) throw new Error('unexpected gamelog shape (no seasonTypes[])');
  let td = 0, games = 0, foundAnyCategory = false;
  for (const st of seasonTypes) {
    for (const cat of st?.categories || []) {
      const catName = String(cat?.name || cat?.displayName || '').toLowerCase();
      if (!wantedCategoryNames.some(w => catName.includes(w))) continue;
      const labels = cat?.labels || cat?.displayLabels || [];
      const tdIdx = labels.findIndex(l => TD_LABEL_RE.test(String(l)));
      if (tdIdx === -1 || !Array.isArray(cat.totals)) continue;
      const catTD = Number(cat.totals[tdIdx]);
      const catGames = cat?.events && typeof cat.events === 'object' ? Object.keys(cat.events).length : 0;
      if (Number.isFinite(catTD)) { td += catTD; foundAnyCategory = true; }
      games = Math.max(games, catGames);
    }
  }
  if (!foundAnyCategory) return null;
  return { td, games };
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  let rosterData;
  try {
    rosterData = JSON.parse(await readFile(ROSTERS_PATH, 'utf8'));
  } catch (e) {
    console.error('data/nfl-rosters.json not found or unreadable — run sync-nfl-rosters.mjs first. ' + e.message);
    process.exitCode = 1;
    return;
  }
  const players = Object.values(rosterData.players || {});
  console.log(`Found ${players.length} skill-position player(s) to fetch season stats for.`);

  const out = {};
  let updated = 0, failed = 0, noData = 0;
  let seasonUsedCounts = {};
  for (const p of players) {
    try {
      let result = null, seasonUsed = null;
      for (const season of SEASONS_TRIED) {
        const raw = await fetchJSON(gamelogURL(p.id, season));
        const r = extractSeasonTDRate(raw, p.position);
        if (r && r.games > 0) { result = r; seasonUsed = season; break; }
      }
      if (!result) { noData++; continue; }
      out[p.id] = {
        name: p.name, position: p.position, teamAbbr: p.teamAbbr,
        season: seasonUsed, td: result.td, games: result.games,
        tdPerGame: +(result.td / result.games).toFixed(3),
      };
      seasonUsedCounts[seasonUsed] = (seasonUsedCounts[seasonUsed] || 0) + 1;
      updated++;
    } catch (e) {
      failed++;
      console.error(`Player-stats fetch failed for ${p.name} (${p.id}):`, e.message);
    }
    // Same polite bounded-scope delay every other sync script in this repo
    // uses against a free, unauthenticated public endpoint -- this loop is a
    // similar order of magnitude to the MLB batter Statcast sync's ~250-400
    // player scope.
    await new Promise(r => setTimeout(r, 350));
  }

  console.log(`Updated ${updated} player(s), ${noData} with no usable season data, ${failed} failed, out of ${players.length}. Season used: ${JSON.stringify(seasonUsedCounts)}.`);
  if (updated > 0) {
    await writeFile(PLAYER_STATS_PATH, JSON.stringify({ updatedAt: new Date().toISOString(), players: out }, null, 2) + '\n');
  }
  if (failed > 0 && updated === 0) process.exitCode = 1;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch(e => { console.error(e); process.exit(1); });
}

export { extractSeasonTDRate, gamelogURL, TD_CATEGORIES_BY_POSITION, main };
