#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Standalone, read-only, HR-only version of this project's real scoring
// pipeline -- built to run on a laptop with nothing but Node.js installed
// (no npm install, no Python, no ML framework, no local training step).
//
// This is NOT a simplified stand-in: it imports and runs the exact same
// functions the live site and its daily tracker use (buildBatterPool,
// scoreForMarket('hr'), the fitted logistic model + isotonic calibration),
// just skips everything unrelated to HR -- the other markets, the pick
// tracker, grading, calibration reports. It never writes to tracker.json or
// any data/*.json file; it only reads them and prints a ranked list.
//
// Setup: this needs a checkout of the real diamond-report repo (or at
// least the scripts/ and data/ directories) so buildBatterPool's real data
// files (data/statcast-hot-hitters.json, data/bullpen-hr-rate.json,
// data/hr-logistic-model.json, etc.) are present -- the same files the live
// site's own daily sync workflows keep fresh. A `git clone` of the repo
// already has all of them, auto-updated by CI, so nothing extra to fetch
// yourself. Everything else (today's schedule, season stats, weather) is
// fetched live from the free, public MLB Stats API / Baseball Savant, same
// as the real site -- an internet connection is the only other requirement.
//
// Run: node scripts/hr-model-standalone.mjs [--top=25] [--min-ab=40]
// ─────────────────────────────────────────────────────────────────────────

import {
  buildBatterPool, scoreForMarket,
  loadModelParams, loadHRLogisticModel, loadHRIsotonicCalibration,
  cdtDateString,
} from './update-tracker.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const m = a.match(/^--([\w-]+)=(.+)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
  })
);
const TOP_N = Number(args.top) || 25;
const MIN_AB = Number(args['min-ab']) || 40;
// Same "don't let one team's whole lineup crowd out everyone else" cap the
// live board uses, kept simple here: a flat per-team ceiling on this one-shot
// ranked list, not the live board's day-long persisted lock (a CLI run has
// no "did this reshuffle mid-day" problem to guard against -- it's a single
// snapshot, not a page left open all day).
const MAX_PER_TEAM = Number(args['max-per-team']) || 3;

async function fetchTodaysPreviewGames() {
  const today = cdtDateString(new Date());
  const res = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${today}&hydrate=team,probablePitcher,linescore,weather`);
  if (!res.ok) throw new Error(`MLB schedule fetch failed: ${res.status}`);
  const data = await res.json();
  const games = data?.dates?.find(d => d.date === today)?.games || [];
  // Preview only -- same real filter captureToday itself uses: this is a
  // pre-game projection tool, not a live in-game tracker.
  return { today, games: games.filter(g => g.status?.abstractGameState === 'Preview') };
}

async function main() {
  console.log('Loading fitted model + calibration (data/hr-logistic-model.json, data/hr-isotonic-calibration.json)...');
  await loadModelParams();
  await loadHRLogisticModel();
  await loadHRIsotonicCalibration();

  const { today, games } = await fetchTodaysPreviewGames();
  if (!games.length) {
    console.log(`No games scheduled (and not yet started) for ${today}.`);
    return;
  }
  console.log(`Building today's real batter/pitcher pool for ${games.length} game(s) on ${today} -- this fetches real season stats per batter/pitcher, so it takes a minute...`);
  const season = today.slice(0, 4);
  const pool = await buildBatterPool(games, season);

  const ranked = pool
    .filter(r => r.atBats >= MIN_AB)
    .map(r => ({ ...r, hrProb: scoreForMarket('hr', r) }))
    .sort((a, b) => b.hrProb - a.hrProb);

  const perTeamCount = {};
  const capped = ranked.filter(r => {
    const c = perTeamCount[r.teamAbbr] || 0;
    if (c >= MAX_PER_TEAM) return false;
    perTeamCount[r.teamAbbr] = c + 1;
    return true;
  });

  if (!capped.length) {
    console.log('No qualifying batters found (lineups may not be posted yet -- try again closer to game time).');
    return;
  }

  console.log(`\nHR Threats -- ${today} (top ${Math.min(TOP_N, capped.length)}, max ${MAX_PER_TEAM}/team)\n`);
  const nameW = Math.max(...capped.slice(0, TOP_N).map(r => r.name.length), 4);
  capped.slice(0, TOP_N).forEach((r, i) => {
    console.log(
      `${String(i + 1).padStart(2)}. ${r.name.padEnd(nameW)}  ${r.teamAbbr} vs ${r.oppAbbr}` +
      `  HR%: ${String(r.hrProb).padStart(2)}%  vs ${r.pitcherName || 'TBD'}`
    );
  });
  console.log('');
}

main().catch(e => { console.error('Failed:', e.message); process.exit(1); });
