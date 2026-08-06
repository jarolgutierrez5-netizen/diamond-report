#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Real per-umpire strikeout/walk tendency -- a signal nothing else in this app
// captures at all. A wide/tight home-plate strike zone genuinely shifts K%/BB%
// for both teams in a game, which in turn shifts a pitcher's real strikeout
// odds and a batter's real plate-discipline odds -- but there's no single MLB
// Stats API endpoint that hands this over pre-built.
//
// There's no way to backfill this retroactively without re-scanning the whole
// season's worth of games for their officials (expensive, and this sandbox
// can't verify the officials endpoint shape live to do that responsibly yet
// anyway) -- so, same "start capturing going forward" approach already used
// this project for matchupEdge/zoneFitScore coverage, this runs once daily
// and slowly accumulates real per-umpire history from here on. A freshly
// added umpire has zero games captured and simply doesn't render anything
// until enough real games have accumulated (see MIN_GAMES below) -- never a
// fabricated or league-average-substituted tendency.
//
// Two jobs each run:
//   1. Look up TODAY's games' assigned home-plate umpire (so the Matchup
//      modal can show "who's calling this game" even before it's final) --
//      written to data/umpire-tendency.json's todayAssignments, keyed by
//      gamePk.
//   2. Look up YESTERDAY's games (same one-day-lag window sync-bullpen-
//      fatigue.mjs uses, since a game needs to have actually finished before
//      its real K/BB totals mean anything) and append each Final game's real
//      home-plate umpire + that game's actual combined K/BB/PA totals to the
//      umpire's running history.
//
// Field shapes used here (liveData.boxscore.officials -- an array of
// { official: { fullName }, officialType: "Home Plate" | ... }, and
// liveData.boxscore.teams.{home|away}.teamStats.batting.{strikeOuts,
// baseOnBalls,plateAppearances}) are the same well-documented public MLB
// Stats API shape community wrappers (e.g. MLB-StatsAPI's game_officials)
// already rely on -- not something this sandbox can verify against a live
// response. Treat the first scheduled run as unverified until its own log
// output (and the resulting data/umpire-tendency.json) is manually checked
// against a known game's real home-plate umpire and box score.
// ─────────────────────────────────────────────────────────────────────────

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const OUT_PATH = path.join(DATA_DIR, 'umpire-tendency.json');
const MLB_API = 'https://statsapi.mlb.com/api/v1';
const MLB_LIVE_API = 'https://statsapi.mlb.com/api/v1.1';

// An umpire's own tendency isn't reported (Days Rest-style graceful omission,
// not a fabricated small-sample number) until this many real games have been
// captured for him -- one HP assignment roughly every 5 days per umpire crew
// rotation, so this fills in gradually over the season, same as every other
// "start capturing going forward" signal in this app.
const MIN_GAMES = 8;

function isoDate(d) { return d.toISOString().slice(0, 10); }
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d; }
const TODAY = isoDate(new Date());
const YESTERDAY = isoDate(daysAgo(1));

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

async function gamesForDate(dateStr) {
  const d = await fetchJSON(`${MLB_API}/schedule?sportId=1&date=${dateStr}`);
  return (d.dates || []).find(x => x.date === dateStr)?.games || [];
}

function homePlateUmpireName(officials) {
  const hp = (officials || []).find(o => o.officialType === 'Home Plate');
  return hp?.official?.fullName || null;
}

async function fetchGameOfficialsAndTotals(gamePk) {
  const feed = await fetchJSON(`${MLB_LIVE_API}/game/${gamePk}/feed/live`);
  const box = feed?.liveData?.boxscore;
  const umpire = homePlateUmpireName(box?.officials);
  const homeBat = box?.teams?.home?.teamStats?.batting;
  const awayBat = box?.teams?.away?.teamStats?.batting;
  const k = (Number(homeBat?.strikeOuts) || 0) + (Number(awayBat?.strikeOuts) || 0);
  const bb = (Number(homeBat?.baseOnBalls) || 0) + (Number(awayBat?.baseOnBalls) || 0);
  const pa = (Number(homeBat?.plateAppearances) || 0) + (Number(awayBat?.plateAppearances) || 0);
  return { umpire, k, bb, pa };
}

function recomputeUmpireRates(entry) {
  const totals = entry.games.reduce((s, g) => ({ k: s.k + g.k, bb: s.bb + g.bb, pa: s.pa + g.pa }), { k: 0, bb: 0, pa: 0 });
  entry.totalGames = entry.games.length;
  entry.totalK = totals.k;
  entry.totalBB = totals.bb;
  entry.totalPA = totals.pa;
  entry.kPct = totals.pa > 0 ? +((totals.k / totals.pa) * 100).toFixed(1) : null;
  entry.bbPct = totals.pa > 0 ? +((totals.bb / totals.pa) * 100).toFixed(1) : null;
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  let out;
  try {
    out = JSON.parse(await readFile(OUT_PATH, 'utf8'));
  } catch (e) {
    out = { umpires: {}, todayAssignments: {} };
  }
  out.umpires = out.umpires || {};

  // ── Job 1: today's assigned HP umpire per game (best-effort — MLB doesn't
  // always confirm umpire assignments this far ahead of first pitch; a game
  // missing from todayAssignments just means it wasn't available yet, not an
  // error). ──────────────────────────────────────────────────────────────
  const todayGames = await gamesForDate(TODAY);
  console.log(`Found ${todayGames.length} game(s) today (${TODAY}).`);
  const todayAssignments = {};
  let todayFound = 0;
  for (const g of todayGames) {
    if (!g.gamePk) continue;
    try {
      const { umpire } = await fetchGameOfficialsAndTotals(g.gamePk);
      if (umpire) { todayAssignments[g.gamePk] = umpire; todayFound++; }
    } catch (e) {
      console.warn(`Officials fetch failed for today's game ${g.gamePk}:`, e.message);
    }
    await new Promise(r => setTimeout(r, 300));
  }
  out.todayAssignments = todayAssignments;
  console.log(`Found today's HP umpire for ${todayFound}/${todayGames.length} game(s).`);

  // ── Job 2: yesterday's now-Final games — real K/BB totals attributed to the
  // real HP umpire, appended to his running history. Skips a game already
  // recorded (by gamePk) so a workflow re-run within the retention window
  // doesn't double-count it. ─────────────────────────────────────────────
  const recordedGamePks = new Set();
  for (const entry of Object.values(out.umpires)) {
    for (const g of entry.games || []) recordedGamePks.add(g.gamePk);
  }
  const yesterdayGames = (await gamesForDate(YESTERDAY)).filter(g => g.status?.abstractGameState === 'Final' && g.gamePk && !recordedGamePks.has(g.gamePk));
  console.log(`Found ${yesterdayGames.length} new Final game(s) from yesterday (${YESTERDAY}) to record.`);
  let recorded = 0, failed = 0;
  for (const g of yesterdayGames) {
    try {
      const { umpire, k, bb, pa } = await fetchGameOfficialsAndTotals(g.gamePk);
      if (!umpire || pa <= 0) { console.warn(`No usable umpire/box-score totals for game ${g.gamePk} — skipping.`); continue; }
      out.umpires[umpire] = out.umpires[umpire] || { games: [] };
      out.umpires[umpire].games.push({ date: YESTERDAY, gamePk: g.gamePk, k, bb, pa });
      recomputeUmpireRates(out.umpires[umpire]);
      recorded++;
    } catch (e) {
      failed++;
      console.error(`Umpire tendency capture failed for game ${g.gamePk}:`, e.message);
    }
    await new Promise(r => setTimeout(r, 300));
  }
  console.log(`Recorded ${recorded} new game(s), ${failed} failed, into umpire history.`);

  // League-average K%/BB% computed from this same accumulated real sample
  // (never a hardcoded external number) -- the baseline the Matchup modal
  // compares an individual umpire's real rate against.
  const withRates = Object.values(out.umpires).filter(u => u.totalGames >= MIN_GAMES);
  const leagueTotals = withRates.reduce((s, u) => ({ k: s.k + u.totalK, bb: s.bb + u.totalBB, pa: s.pa + u.totalPA }), { k: 0, bb: 0, pa: 0 });
  out.leagueAvgKPct = leagueTotals.pa > 0 ? +((leagueTotals.k / leagueTotals.pa) * 100).toFixed(1) : null;
  out.leagueAvgBBPct = leagueTotals.pa > 0 ? +((leagueTotals.bb / leagueTotals.pa) * 100).toFixed(1) : null;
  out.minGames = MIN_GAMES;
  console.log(`${withRates.length} umpire(s) have reached the ${MIN_GAMES}-game reporting threshold. League avg K%: ${out.leagueAvgKPct ?? '–'}, BB%: ${out.leagueAvgBBPct ?? '–'}.`);

  out.generatedAt = new Date().toISOString();
  await writeFile(OUT_PATH, JSON.stringify(out, null, 2) + '\n');
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch(e => { console.error(e); process.exit(1); });
}

export { fetchGameOfficialsAndTotals, homePlateUmpireName, recomputeUmpireRates, gamesForDate, main, MIN_GAMES };
