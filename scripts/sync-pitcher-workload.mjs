#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Real average batters-faced/innings-pitched per start (last ROLLING_STARTS
// starts) for today's probable starters, into data/pitcher-workload.json.
//
// Why this exists: the HR Threats formula (loadHRPotential in app.js,
// scoreForMarket in update-tracker.mjs) blends a batter's own HR rate with
// the OPPOSING STARTER's HR9-derived rate at a flat weight, applied across
// that batter's entire ~4 plate appearances for the game — as if he faced
// the starter for the whole game, every game. In reality a quick-hook
// pitcher (short outings, usually the ones with worse peripherals) only
// sees a batter for 1-2 of his ~4 PA before the bullpen takes over, so the
// flat weight was overstating a bad starter's real effect on the game.
// The weekly calibration report caught this indirectly: HR Threats picks
// against pitchers with WORSE HR/9 and WHIP actually hit at a LOWER real
// rate than picks against pitchers with better peripherals (backwards from
// what the model assumes) — see data/calibration-report.md. This file is
// the real signal needed to correct that: scale the starter's weight in the
// blend by how much of a full game's PA he actually represents, instead of
// treating every probable starter as a fixed-length outing.
//
// Source: MLB Stats API's own gameLog endpoint (real per-appearance
// battersFaced/inningsPitched/gamesStarted), not Statcast — this is a
// counting-stat question the box score already answers exactly, no need
// for the Statcast Search CSV reconstruction sibling scripts use for
// pitch-level questions. Filtered to gamesStarted===1 rows only (excludes
// any relief appearance mixed into the same season log), most recent
// ROLLING_STARTS kept.
//
// Same bounded ~15-30/day probable-starter scope as sync-pitcher-zone-hr.mjs
// (reuses its todaysProbablePitcherIds), so cheap enough to run on every
// intraday trigger like that script, not just the morning pass.
// ─────────────────────────────────────────────────────────────────────────

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { todaysProbablePitcherIds } from './sync-pitcher-zone-hr.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const MLB_API = 'https://statsapi.mlb.com/api/v1';
const SEASON = new Date().getFullYear();
const ROLLING_STARTS = 5;
// Below this many real starts, a rolling average is too noisy to trust over
// the model's existing league-average assumption (a rookie's first career
// start, or an early-season pitcher with only 1-2 outings) -- same
// small-sample floor discipline as MIN_IP_FOR_HR9 in sync-pitcher-zone-hr.mjs.
const MIN_STARTS_FOR_SIGNAL = 3;

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

// MLB's inningsPitched is a string like "63.2" where the digit after the
// decimal is OUTS within the inning (0/1/2), not a decimal fraction --
// same parsing convention already established in update-tracker.mjs's
// parseInningsPitched.
function parseInningsPitched(ip) {
  if (ip == null || ip === '') return null;
  const [wholeStr, outStr] = String(ip).split('.');
  const whole = parseInt(wholeStr, 10);
  const outs = outStr ? parseInt(outStr, 10) : 0;
  if (!Number.isFinite(whole)) return null;
  return whole + (Number.isFinite(outs) ? outs / 3 : 0);
}

async function buildPitcherWorkload(pitcherId, name) {
  const d = await fetchJSON(`${MLB_API}/people/${pitcherId}/stats?stats=gameLog&group=pitching&season=${SEASON}`);
  const splits = d?.stats?.[0]?.splits || [];
  const starts = splits.filter(s => Number(s?.stat?.gamesStarted) === 1);
  if (!starts.length) return null;
  const recent = starts.slice(-ROLLING_STARTS);
  const bfValues = recent.map(s => Number(s.stat?.battersFaced)).filter(Number.isFinite);
  const ipValues = recent.map(s => parseInningsPitched(s.stat?.inningsPitched)).filter(v => v != null);
  if (!bfValues.length) return null;
  const avgBFperStart = bfValues.reduce((a, b) => a + b, 0) / bfValues.length;
  const avgIPperStart = ipValues.length ? ipValues.reduce((a, b) => a + b, 0) / ipValues.length : null;
  return {
    name,
    avgBFperStart: Math.round(avgBFperStart * 10) / 10,
    avgIPperStart: avgIPperStart != null ? Math.round(avgIPperStart * 10) / 10 : null,
    startsSampled: bfValues.length,
    reliable: bfValues.length >= MIN_STARTS_FOR_SIGNAL,
  };
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  let ids;
  try {
    ids = await todaysProbablePitcherIds();
  } catch (e) {
    console.error('Failed to fetch today\'s probable starters:', e.message);
    process.exitCode = 1;
    return;
  }
  console.log(`Found ${ids.size} probable starter(s) for today's games.`);

  const pitchers = {};
  let updated = 0, failed = 0;
  for (const [id, name] of ids) {
    try {
      const workload = await buildPitcherWorkload(id, name);
      if (!workload) { console.warn(`No real start data for ${name} (${id}) — skipping.`); continue; }
      pitchers[id] = workload;
      updated++;
    } catch (e) {
      failed++;
      console.error(`Workload sync failed for ${name} (${id}):`, e.message);
    }
    await new Promise(r => setTimeout(r, 300));
  }

  const reliablePitchers = Object.values(pitchers).filter(p => p.reliable);
  console.log(`Built workload data for ${updated}/${ids.size} probable starter(s) (${failed} failed), ${reliablePitchers.length} with >= ${MIN_STARTS_FOR_SIGNAL} real starts sampled.`);

  // Real today's-slate average (over reliable-sample pitchers only, to keep a single
  // noisy 1-2-start outlier from skewing the anchor), not a guessed constant — this
  // is the denominator app.js/update-tracker.mjs divide each starter's avgBFperStart
  // by to get his workload share. Falls back to null (client uses its own hardcoded
  // constant) on a day with no reliable samples at all, which shouldn't happen in
  // practice but costs nothing to guard.
  const sourcePitchers = reliablePitchers.length ? reliablePitchers : Object.values(pitchers);
  const leagueAvgBFperStart = sourcePitchers.length
    ? Math.round((sourcePitchers.reduce((a, p) => a + p.avgBFperStart, 0) / sourcePitchers.length) * 10) / 10
    : null;

  await writeFile(path.join(DATA_DIR, 'pitcher-workload.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    season: SEASON,
    rollingStarts: ROLLING_STARTS,
    leagueAvgBFperStart,
    pitchers,
  }, null, 2) + '\n');
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch(e => { console.error(e); process.exit(1); });
}

export { parseInningsPitched, buildPitcherWorkload, main };
