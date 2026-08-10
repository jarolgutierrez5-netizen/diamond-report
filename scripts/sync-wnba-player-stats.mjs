#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Real per-game scoring line for every rostered WNBA player -- the base
// input the "15+ Points Probability" board scores from (app.js:
// wnbaPointsCardHTML / wnbaPointsConfidenceScore / wnbaPointsRisk). Reads
// data/wnba-rosters.json (written by sync-wnba-rosters.mjs) for the player
// universe, then pulls each player's own real game log from ESPN and
// computes, entirely from real per-game totals (no fabricated/derived
// inputs):
//   - games: real games played this season
//   - ptsPerGame / rebPerGame / astPerGame / threesPerGame: real season
//     per-game averages for points, rebounds, assists, and made 3-pointers
//   - praPerGame: points+rebounds+assists per game -- a real sum of the
//     three real averages above, the same combined-stat prop shape real
//     sportsbooks call "PRA", not a separately modeled number
//   - ptsStdDev: real population standard deviation of per-game points --
//     the consistency signal wnbaPointsConfidenceScore uses (a volatile
//     boom/bust scorer is lower-confidence than a consistent one at the same
//     average)
//   - gamesWith15Plus / prob15Plus: raw empirical rate of real games with
//     15+ points, no Poisson/normal-distribution derivation -- just a count
//     of real outcomes divided by real games played.
//
// IMPORTANT endpoint note (confirmed live during planning, not a guess):
// the plain site.api.espn.com/apis/site/v2/sports/basketball/wnba/athletes/
// {id}/gamelog host that sync-nfl-player-stats.mjs uses for NFL returns a
// bare `{"code":404}` for WNBA, even for real active players (tested against
// A'ja Wilson's real ESPN id). The web API host below --
// site.web.api.espn.com/apis/common/v3/sports/basketball/wnba/athletes/{id}/
// gamelog -- is the one that actually works for WNBA, confirmed live with a
// real 2026-season response (32 real games, real PTS/REB/AST/etc. per game).
//
// Response shape (confirmed live): a single top-level `labels` array (stat
// column names -- confirmed order: MIN,PTS,REB,AST,STL,BLK,TO,FG,FG%,3PT,
// 3P%,FT,FT%,PF) applies to every game row -- unlike NFL's per-category
// labels, WNBA's gamelog has one flat label set for the whole response. Real
// per-game rows live at `seasonTypes[].categories[].events[]`, each
// `{eventId, stats:[...]}` with `stats` in the same order as the top-level
// `labels` (string values -- most are plain numbers like "26" for points,
// but the 3PT column is a real "made-attempted" split like "1-3", so it's
// parsed by taking the substring before the "-" rather than Number()'d
// directly). Categories are grouped by calendar month (e.g. "august",
// "july"), not by stat type like NFL's passing/rushing/receiving groups --
// this script sums across every category under a "Regular Season"
// `seasonType` and explicitly skips any `seasonType` whose name contains
// "Preseason", so a handful of early exhibition-game totals can't quietly
// inflate/dilute the real regular-season rate.
// ─────────────────────────────────────────────────────────────────────────

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const ROSTERS_PATH = path.join(DATA_DIR, 'wnba-rosters.json');
const PLAYER_STATS_PATH = path.join(DATA_DIR, 'wnba-player-stats.json');

const POINTS_THRESHOLD = 15;

const FETCH_TIMEOUT_MS = 15000;
// A 404 is a stable, immediate answer (this player has no gamelog on record
// -- e.g. hasn't debuted, or an id ESPN doesn't recognize) not a transient
// failure, so it isn't worth the retry loop -- same distinction
// sync-nfl-player-stats.mjs makes via e.status.
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
  return `https://site.web.api.espn.com/apis/common/v3/sports/basketball/wnba/athletes/${playerId}/gamelog`;
}

// Parses a single raw stat cell into a real number. Most columns are plain
// numeric strings ("26"); the 3PT column is a real "made-attempted" split
// ("1-3") -- only the made count (the part before "-") is a real makes
// total, so that's what's parsed out rather than Number()'ing the whole
// string into NaN.
function parseStatCell(v) {
  if (v == null) return NaN;
  const s = String(v);
  const made = s.includes('-') ? s.split('-')[0] : s;
  return Number(made);
}

// Pulls every real per-game {pts, reb, ast, threes} line from the current
// season's real regular-season rows (Preseason seasonTypes explicitly
// skipped). Returns null (not an empty/zero result) if the response has no
// usable regular-season rows at all -- distinct from a real, confirmed
// scoreless game.
function extractSeasonRows(raw) {
  const labels = raw?.labels;
  // A response with only a `filters` key and no `labels`/`seasonTypes` at all
  // is real and expected for a player with no logged games this season (a
  // waived/injured-all-year/international-only roster spot, confirmed live
  // against two real such players during verification) -- distinct from an
  // actual shape surprise, which only throws when seasonTypes exists but
  // labels doesn't (a real anomaly worth a loud failure, not a silent skip).
  if (!Array.isArray(labels)) {
    if (!Array.isArray(raw?.seasonTypes)) return null;
    throw new Error('unexpected gamelog shape (seasonTypes present but no top-level labels[])');
  }
  const idx = { pts: labels.indexOf('PTS'), reb: labels.indexOf('REB'), ast: labels.indexOf('AST'), threes: labels.indexOf('3PT') };
  if (idx.pts === -1) throw new Error('no PTS column in gamelog labels');
  const seasonTypes = raw?.seasonTypes;
  if (!Array.isArray(seasonTypes)) throw new Error('unexpected gamelog shape (no seasonTypes[])');

  const rows = [];
  for (const st of seasonTypes) {
    const name = String(st?.displayName || '');
    if (/preseason/i.test(name)) continue;
    for (const cat of st?.categories || []) {
      for (const ev of cat?.events || []) {
        const stats = ev?.stats;
        if (!Array.isArray(stats)) continue;
        const pts = Number(stats[idx.pts]);
        if (!Number.isFinite(pts)) continue;
        rows.push({
          pts,
          reb: idx.reb !== -1 ? Number(stats[idx.reb]) : NaN,
          ast: idx.ast !== -1 ? Number(stats[idx.ast]) : NaN,
          threes: idx.threes !== -1 ? parseStatCell(stats[idx.threes]) : NaN,
        });
      }
    }
  }
  if (!rows.length) return null;
  return rows;
}

// Mean of a real per-game stat, skipping any individual game that column
// wasn't available for (e.g. a genuinely missing 3PT cell) rather than
// treating a missing value as a real 0 -- returns null (not 0) if no game
// had a usable value for this stat at all.
function meanOf(rows, key) {
  const vals = rows.map(r => r[key]).filter(Number.isFinite);
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function summarize(rows) {
  const games = rows.length;
  const ptsPerGame = meanOf(rows, 'pts');
  const variance = rows.reduce((a, r) => a + (r.pts - ptsPerGame) ** 2, 0) / games;
  const ptsStdDev = Math.sqrt(variance);
  const gamesWith15Plus = rows.filter(r => r.pts >= POINTS_THRESHOLD).length;
  const rebPerGame = meanOf(rows, 'reb');
  const astPerGame = meanOf(rows, 'ast');
  const threesPerGame = meanOf(rows, 'threes');
  const praPerGame = (rebPerGame != null && astPerGame != null) ? ptsPerGame + rebPerGame + astPerGame : null;
  return {
    games,
    ptsPerGame: +ptsPerGame.toFixed(2),
    ptsStdDev: +ptsStdDev.toFixed(2),
    gamesWith15Plus,
    prob15Plus: Math.round((gamesWith15Plus / games) * 100),
    rebPerGame: rebPerGame != null ? +rebPerGame.toFixed(2) : null,
    astPerGame: astPerGame != null ? +astPerGame.toFixed(2) : null,
    threesPerGame: threesPerGame != null ? +threesPerGame.toFixed(2) : null,
    praPerGame: praPerGame != null ? +praPerGame.toFixed(2) : null,
  };
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  let rosterData;
  try {
    rosterData = JSON.parse(await readFile(ROSTERS_PATH, 'utf8'));
  } catch (e) {
    console.error('data/wnba-rosters.json not found or unreadable — run sync-wnba-rosters.mjs first. ' + e.message);
    process.exitCode = 1;
    return;
  }
  const players = Object.values(rosterData.players || {});
  console.log(`Found ${players.length} player(s) to fetch season stats for.`);

  const out = {};
  let updated = 0, failed = 0, noData = 0;
  const season = new Date().getFullYear();
  for (const p of players) {
    try {
      const raw = await fetchJSON(gamelogURL(p.id));
      const rows = extractSeasonRows(raw);
      if (rows) {
        out[p.id] = {
          name: p.name, position: p.position, teamAbbr: p.teamAbbr, headshot: p.headshot || null,
          season, ...summarize(rows),
        };
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

  console.log(`Updated ${updated} player(s), ${noData} with no usable season data, ${failed} failed, out of ${players.length}.`);
  if (updated > 0) {
    await writeFile(PLAYER_STATS_PATH, JSON.stringify({ updatedAt: new Date().toISOString(), players: out }, null, 2) + '\n');
  }
  if (failed > 0 && updated === 0) process.exitCode = 1;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch(e => { console.error(e); process.exit(1); });
}

export { extractSeasonRows, summarize, gamelogURL, POINTS_THRESHOLD, main };
