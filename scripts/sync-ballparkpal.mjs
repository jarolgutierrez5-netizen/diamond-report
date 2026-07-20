#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Syncs Ballpark Pal's licensed API (a real paid subscription + issued key,
// not scraping — see BALLPARKPAL_API_KEY in Settings → Secrets and variables
// → Actions, and https://www.ballparkpal.com/api/docs/) into
// data/ballparkpal-hr-factors.json.
//
// Ballpark Pal's own park-factor model isolates the weather-only component of
// each hitter's HR multiplier from the stadium-only component
// (GET /api/v1/parkfactors/hitters — homeRunsWeather is the deviation weather
// alone contributes, homeRunsStadium is dimensions/altitude with no weather
// applied, homeRuns is the combined multiplier) — the same split our own DIY
// air-density model (airDensityHRMult/windHRMult in app.js) approximates from
// raw Open-Meteo data. Pulling their modeled figure gives us a second,
// independently-computed cross-check to show alongside our own, the same
// informational role the Market chip already plays for win probability.
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
const OUT_PATH = path.join(DATA_DIR, 'ballparkpal-hr-factors.json');
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
  let rows;
  try {
    rows = await fetchData(`/parkfactors/hitters?date=${date}`);
  } catch (e) {
    console.error('Ballpark Pal sync failed:', e.message);
    process.exitCode = 1;
    return;
  }

  if (!Array.isArray(rows)) {
    // TEMP diagnostic — response shape doesn't match the docs' field list as a
    // flat array; dump the actual structure so the real shape can be confirmed.
    console.error(`Unexpected /parkfactors/hitters response shape — got ${typeof rows}`);
    console.error('TEMP raw data keys:', Object.keys(rows || {}));
    console.error('TEMP raw data sample:', JSON.stringify(rows).slice(0, 2000));
    process.exitCode = 1;
    return;
  }

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
    })),
  };
  await writeFile(OUT_PATH, JSON.stringify(out, null, 2) + '\n');
  console.log(`Wrote data/ballparkpal-hr-factors.json: ${out.rows.length} hitter row(s) for ${date}.`);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch(e => { console.error(e); process.exit(1); });
}

export { main };
