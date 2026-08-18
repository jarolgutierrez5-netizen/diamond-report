#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Real season touchdown rate + rushing yards per skill-position player -- the
// base input the Anytime TD and Rushing Yards props boards score from. Reads
// data/nfl-rosters.json (written by sync-nfl-rosters.mjs) for the player
// universe, then pulls each player's own real game log from ESPN once and
// sums both real rushing+receiving touchdowns (never passing -- a QB
// throwing a TD isn't "scoring" it himself) and real rushing yards (only the
// real `rushing` category, never `receiving` yards) across games actually
// played -- one fetch per player serves both boards, no duplicate requests.
//
// REWRITTEN against a real, live-verified response (the original version of
// this script was written blind in a sandbox with no route to ESPN, per its
// own now-removed caveat, and its assumed shape turned out wrong in two real
// ways once actually checked against a live response):
//
// 1. Endpoint host: the plain site.api.espn.com/apis/site/v2/sports/football/
//    nfl/athletes/{id}/gamelog host this script originally used returns a
//    bare `{"code":404}` for every real player tested (including Patrick
//    Mahomes' real ESPN id) -- same class of gap already found and fixed for
//    WNBA's player-stats sync. The web API host below --
//    site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes/{id}/
//    gamelog -- is the one that actually works, confirmed live with real
//    2025-season passing/rushing/receiving lines. It also has no `?season=`
//    parameter needed -- omitting it returns whichever season the endpoint
//    itself considers current/most-recently-real (confirmed: for a player
//    with no 2026 games logged yet during preseason, it correctly defaulted
//    to 2025's real completed season data, with no season-fallback loop
//    needed on this end).
//
// 2. Response shape: NOT the assumed `seasonTypes[].categories[].labels`
//    (one labels[] per category). The real shape has ONE flat top-level
//    `labels` array covering every stat group concatenated together (e.g. a
//    QB: passing columns then rushing columns appended after), so "TD"
//    appears MORE THAN ONCE in `labels` with no reliable fixed index -- a
//    QB's rushing TD is at a different index than a WR's or a TE's (a TE's
//    rushing block even orders TD differently than an RB's: TE is
//    ...AVG,LNG,TD while RB is ...AVG,TD,LNG). The real, reliable way to
//    find each category's real column range is the response's own top-level
//    `categories` array -- `[{name:'passing',count:11},{name:'rushing',
//    count:5}]` -- which gives each category's real column count in the
//    same left-to-right order as `labels`, confirmed live across a QB
//    (passing+rushing), an RB (rushing+receiving+fumbles), and a TE
//    (receiving+rushing+fumbles, note the reversed order vs. the RB).
//
// Real per-game rows live at `seasonTypes[].categories[].events[]`, each
// `{eventId, stats:[...]}` with `stats` in the same order as the top-level
// `labels`. This script sums across every category under a non-Preseason
// `seasonType` (explicitly skips any whose displayName contains
// "Preseason", same defensive skip as sync-wnba-player-stats.mjs -- a real
// concern once the current NFL season's own preseason games start showing
// up here, which would otherwise mix a handful of backup-heavy exhibition
// snaps into what's meant to be a real regular-season rate).
// ─────────────────────────────────────────────────────────────────────────

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const ROSTERS_PATH = path.join(DATA_DIR, 'nfl-rosters.json');
const PLAYER_STATS_PATH = path.join(DATA_DIR, 'nfl-player-stats.json');

// "Anytime TD" only ever counts a player's own rushing or receiving scores --
// never passing. Derived from the response's own real `categories[]` rather
// than a hardcoded position map, so it adapts to whatever categories ESPN's
// data actually reports for that specific player instead of guessing.
const TD_CATEGORY_NAMES = new Set(['rushing', 'receiving']);

// Rushing Yards board's own real per-game input -- "YDS" scoped to only the
// real `rushing` category (never `receiving`/`passing`, both of which also
// have their own real "YDS" column at a different offset -- same ambiguous-
// label problem tdColumnIndexes already solves for "TD", reusing the same
// category-scoped-offset technique via columnIndexesForCategory below).
const RUSH_YDS_CATEGORY_NAMES = new Set(['rushing']);

// Rushing Yards O/U line -- picked from the real per-game distribution once
// this script's own regenerated data was in hand (same "compute the real
// percentiles, then pick" method the WNBA prop board lines used), not a
// guessed round number. See app.js's Rushing Yards board for the matching
// client-side line.
const RUSH_YDS_LINE = 39.5;

const FETCH_TIMEOUT_MS = 15000;
// A 404 is a stable, immediate answer (this player has no gamelog on record)
// not a transient failure, so it isn't worth the retry loop -- same
// distinction sync-wnba-player-stats.mjs makes via e.status.
async function fetchJSON(url, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' }, signal: controller.signal });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} for ${url}`);
        err.status = res.status;
        throw err;
      }
      return await res.json();
    } catch (e) {
      lastErr = e.name === 'AbortError' ? new Error(`Timed out after ${FETCH_TIMEOUT_MS}ms for ${url}`) : e;
      if (e.status === 404) break;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

function gamelogURL(playerId) {
  return `https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes/${playerId}/gamelog`;
}

// Real absolute column indices within the flat `labels` array for a given
// column name (e.g. "TD", "YDS"), scoped to only the real category name(s)
// in `categoryNames` -- the same column label can legitimately appear more
// than once across categories (a QB's real response has a "YDS" in both its
// passing and rushing blocks, at different offsets), so this walks the
// categories left-to-right tracking each one's real starting offset rather
// than doing a single flat indexOf. One index per matching category this
// player's real data actually has (a QB with only passing+rushing scores
// via TD_CATEGORY_NAMES gets one rushing TD index; an RB/TE with rushing+
// receiving gets two). Empty for a player with none of the target
// category(ies) present (e.g. a QB has no `receiving` category at all).
function columnIndexesForCategory(labels, categories, categoryNames, colLabel) {
  let offset = 0;
  const idxs = [];
  for (const cat of categories) {
    const count = Number(cat?.count) || 0;
    if (categoryNames.has(String(cat?.name))) {
      const local = labels.slice(offset, offset + count).indexOf(colLabel);
      if (local !== -1) idxs.push(offset + local);
    }
    offset += count;
  }
  return idxs;
}
function tdColumnIndexes(labels, categories) {
  return columnIndexesForCategory(labels, categories, TD_CATEGORY_NAMES, 'TD');
}
function rushYdsColumnIndexes(labels, categories) {
  return columnIndexesForCategory(labels, categories, RUSH_YDS_CATEGORY_NAMES, 'YDS');
}

// Pulls every real per-game {td, rushYds} pair (td summed across whichever
// real rushing/receiving columns this player's data has; rushYds from only
// the real rushing category) from the current season's real regular-season
// rows (Preseason seasonTypes explicitly skipped), plus the real season
// number the response itself reports. Returns null (not an empty/zero
// result) if the response has no usable rows at all -- distinct from a
// real, confirmed scoreless/no-rush game, and distinct from a QB with no
// rushing/receiving category (also legitimately excluded, not an error).
// A player can have a real td signal but no real rushYds signal (a pure
// receiver) or vice versa (extremely rare, but not assumed impossible) --
// each game row keeps both, null'd independently rather than skipping the
// whole row, so summarize() below can compute td/rushYds rates off however
// many real games actually carry each signal.
function extractSeasonRows(raw) {
  const labels = raw?.labels;
  const categories = raw?.categories;
  // A response with only a `filters` key and no `labels`/`seasonTypes` at
  // all is real and expected for a player with no logged games on record --
  // distinct from an actual shape surprise, which only throws when
  // seasonTypes exists but labels/categories doesn't (a real anomaly worth
  // a loud failure, not a silent skip).
  if (!Array.isArray(labels) || !Array.isArray(categories)) {
    if (!Array.isArray(raw?.seasonTypes)) return null;
    throw new Error('unexpected gamelog shape (seasonTypes present but no labels[]/categories[])');
  }
  const tdIdxs = tdColumnIndexes(labels, categories);
  const rushYdsIdxs = rushYdsColumnIndexes(labels, categories);
  if (!tdIdxs.length && !rushYdsIdxs.length) return null; // e.g. a QB with only a passing category

  const seasonValue = raw?.filters?.find(f => f?.name === 'season')?.value;
  const season = Number(seasonValue) || null;

  const seasonTypes = raw.seasonTypes;
  if (!Array.isArray(seasonTypes)) throw new Error('unexpected gamelog shape (no seasonTypes[])');

  const games = [];
  for (const st of seasonTypes) {
    const name = String(st?.displayName || '');
    if (/preseason/i.test(name)) continue;
    for (const cat of st?.categories || []) {
      for (const ev of cat?.events || []) {
        const stats = ev?.stats;
        if (!Array.isArray(stats)) continue;
        const td = tdIdxs.length ? tdIdxs.reduce((sum, i) => sum + (Number(stats[i]) || 0), 0) : null;
        const rushYds = rushYdsIdxs.length ? rushYdsIdxs.reduce((sum, i) => sum + (Number(stats[i]) || 0), 0) : null;
        games.push({ td, rushYds });
      }
    }
  }
  if (!games.length) return null;
  return { games, season };
}

// Real population stdDev + real empirical "games clearing this line" rate
// for one stat's plain array of real per-game values -- same helper (and
// same reasoning for using a real empirical hit rate over a fitted
// distribution) as sync-wnba-player-stats.mjs's own lineStats. Returns nulls
// (not zeros) when there's no usable data for this stat at all, same
// "missing, not zero" convention the rest of this file follows.
function lineStats(values, line) {
  const games = values.length;
  if (!games) return { stdDev: null, gamesWithLine: null, probLine: null };
  const mean = values.reduce((a, b) => a + b, 0) / games;
  const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / games;
  const gamesWithLine = values.filter(v => v >= line).length;
  return {
    stdDev: +Math.sqrt(variance).toFixed(2),
    gamesWithLine,
    probLine: Math.round((gamesWithLine / games) * 100),
  };
}

function summarize(rows) {
  const games = rows.games.length;
  const tdGames = rows.games.filter(g => g.td != null);
  const td = tdGames.reduce((a, g) => a + g.td, 0);
  const rushYdsGames = rows.games.filter(g => g.rushYds != null);
  const rushYds = rushYdsGames.reduce((a, g) => a + g.rushYds, 0);
  const rushLine = lineStats(rushYdsGames.map(g => g.rushYds), RUSH_YDS_LINE);
  return {
    season: rows.season,
    td, games, tdPerGame: tdGames.length ? +(td / tdGames.length).toFixed(3) : null,
    rushYds: rushYdsGames.length ? rushYds : null,
    gamesWithRushYds: rushYdsGames.length,
    rushYdsPerGame: rushYdsGames.length ? +(rushYds / rushYdsGames.length).toFixed(2) : null,
    rushStdDev: rushLine.stdDev,
    gamesWithRushLine: rushLine.gamesWithLine,
    probRushLine: rushLine.probLine,
  };
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
  const seasonUsedCounts = {};
  for (const p of players) {
    try {
      const raw = await fetchJSON(gamelogURL(p.id));
      const rows = extractSeasonRows(raw);
      if (rows) {
        const s = summarize(rows);
        out[p.id] = { name: p.name, position: p.position, teamAbbr: p.teamAbbr, headshot: p.headshot || null, ...s };
        seasonUsedCounts[s.season] = (seasonUsedCounts[s.season] || 0) + 1;
        updated++;
      } else {
        noData++;
      }
    } catch (e) {
      if (e.status === 404) {
        noData++;
      } else {
        failed++;
        console.error(`Player-stats fetch failed for ${p.name} (${p.id}):`, e.message);
      }
    }
    // Same polite bounded-scope delay every other sync script in this repo
    // uses against a free, unauthenticated public endpoint.
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

export { extractSeasonRows, columnIndexesForCategory, tdColumnIndexes, rushYdsColumnIndexes, lineStats, summarize, gamelogURL, TD_CATEGORY_NAMES, RUSH_YDS_CATEGORY_NAMES, RUSH_YDS_LINE, main };
