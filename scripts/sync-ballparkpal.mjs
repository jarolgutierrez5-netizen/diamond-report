#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Syncs Ballpark Pal's licensed API (a real paid subscription + issued key,
// not scraping — see BALLPARKPAL_API_KEY in Settings → Secrets and variables
// → Actions, and https://www.ballparkpal.com/api/docs/) into two data files:
//
//  - data/ballparkpal-hr-factors.json (GET /api/v1/parkfactors/hitters) —
//    per-hitter HR/2B3B/1B multipliers, plus the weather-only HR component
//    isolated from the stadium-only component (homeRunsWeather vs.
//    homeRunsStadium) — the same split our own DIY air-density model
//    (airDensityHRMult/windHRMult in app.js) approximates from raw
//    Open-Meteo data.
//  - data/ballparkpal-game-factors.json (GET /api/v1/parkfactors) —
//    game-level (not per-hitter) run/HR/2B3B/1B environment percentages,
//    used for boards like K Props where there's no single "batter" to key a
//    per-hitter lookup off of.
//
// Both are pulled purely as an independently-computed cross-check to show
// alongside our own numbers — the same informational role the Market chip
// already plays for win probability, never fed into scoring.
//
// Their gameId/playerId line up directly with MLB Stats API gamePk/person
// ids (confirmed against the docs' example response: gameId 776345,
// teamAwayId 108, teamHomeId 136 are real MLB team ids) — no name-
// normalization needed to match this to app.js's existing game/player data,
// just gamePk + playerId.
// ─────────────────────────────────────────────────────────────────────────

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const HR_OUT_PATH = path.join(DATA_DIR, 'ballparkpal-hr-factors.json');
const GAME_OUT_PATH = path.join(DATA_DIR, 'ballparkpal-game-factors.json');
const API_KEY = process.env.BALLPARKPAL_API_KEY;
const BASE = 'https://www.ballparkpal.com/api/v1';

// Ballpark Pal's date cutoff (today/future only, else `date_out_of_range`) is
// defined in US Eastern — same as MLB's own scheduling day boundary.
function todayEasternDateString(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

async function fetchData(pathAndQuery, attempts = 3) {
  const url = `${BASE}${pathAndQuery}`;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { headers: { 'X-API-Key': API_KEY } });
      if (res.status === 429) {
        const retryAfterSec = Number(res.headers.get('Retry-After')) || (2 * (i + 1));
        await new Promise(r => setTimeout(r, retryAfterSec * 1000));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const json = await res.json();
      return json.data;
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw lastErr;
}

async function main() {
  if (!API_KEY) {
    console.log('BALLPARKPAL_API_KEY not set — skipping Ballpark Pal sync (site falls back to the DIY air-density model only).');
    return;
  }
  await mkdir(DATA_DIR, { recursive: true });

  const date = todayEasternDateString();

  let hitterPayload;
  try {
    hitterPayload = await fetchData(`/parkfactors/hitters?date=${date}`);
  } catch (e) {
    console.error('Ballpark Pal hitter sync failed:', e.message);
    process.exitCode = 1;
  }
  if (hitterPayload) {
    // The docs list this endpoint's fields as a flat array, but the live
    // response wraps them in an `items` array instead (confirmed against a
    // real request — data: { items: [...] }).
    const rows = hitterPayload.items;
    if (!Array.isArray(rows)) {
      console.error(`Unexpected /parkfactors/hitters response shape — got keys [${Object.keys(hitterPayload).join(', ')}]`);
      process.exitCode = 1;
    } else {
      const out = {
        generatedAt: new Date().toISOString(),
        date,
        rows: rows.map(r => ({
          gameId: r.gameId,
          playerId: r.playerId,
          playerName: r.playerName,
          homeRuns: r.homeRuns,
          homeRunsStadium: r.homeRunsStadium,
          homeRunsWeather: r.homeRunsWeather,
          doublesTriples: r.doublesTriples,
          singles: r.singles,
        })),
      };
      await writeFile(HR_OUT_PATH, JSON.stringify(out, null, 2) + '\n');
      console.log(`Wrote data/ballparkpal-hr-factors.json: ${out.rows.length} hitter row(s) for ${date}.`);
    }
  }

  let gamePayload;
  try {
    gamePayload = await fetchData(`/parkfactors?date=${date}`);
  } catch (e) {
    console.error('Ballpark Pal game-factors sync failed:', e.message);
    process.exitCode = 1;
  }
  if (gamePayload) {
    // Same items-wrapper shape as /parkfactors/hitters above.
    const rows = Array.isArray(gamePayload) ? gamePayload : gamePayload.items;
    if (!Array.isArray(rows)) {
      console.error(`Unexpected /parkfactors response shape — got keys [${Object.keys(gamePayload).join(', ')}]`);
      process.exitCode = 1;
    } else {
      const out = {
        generatedAt: new Date().toISOString(),
        date,
        rows: rows.map(r => ({
          gameId: r.gameId,
          teamAway: r.teamAway,
          teamHome: r.teamHome,
          runsPercent: r.runsPercent,
          homeRunsPercent: r.homeRunsPercent,
          doublesTriplesPercent: r.doublesTriplesPercent,
          singlesPercent: r.singlesPercent,
        })),
      };
      await writeFile(GAME_OUT_PATH, JSON.stringify(out, null, 2) + '\n');
      console.log(`Wrote data/ballparkpal-game-factors.json: ${out.rows.length} game row(s) for ${date}.`);
    }
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch(e => { console.error(e); process.exit(1); });
}

export { main };
