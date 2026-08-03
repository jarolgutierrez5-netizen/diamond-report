#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Generates data/daily-headlines.json — Diamond Report's own proprietary
// editorial headlines, replacing generate-daily-insights.mjs (roadmap 3.2:
// "Replace generic ESPN headline dependency with proprietary, data-driven
// editorial content"). The homepage still shows ESPN's league-wide news feed
// (renamed "Around MLB" so it doesn't collide with this section's name) --
// this is a NEW, separate feed placed above it, built entirely from data this
// site already computes/syncs. No third-party reporting is read or quoted
// anywhere in this script, so there is nothing here that needs source
// attribution -- every headline traces back to a stat this app's own sync
// pipeline produced.
//
// Ten categories, one builder each producing 0 or 1(+) headline objects --
// every builder degrades to producing nothing rather than a fabricated or
// filler headline when its underlying signal isn't genuinely notable today
// (same standard the rest of this codebase holds itself to: real numbers or
// nothing, never spun-up text). trend and streak both produce EVERY real
// qualifying player, not a curated top-N -- "all trends, good or bad" per
// request, not just a handful of favorable stories. All 10 share one shape:
//   { id, category, title, blurb, link: { hash, playerId?, playerName? },
//     clip?: { videoUrl, webUrl? } }
// `link.hash` is a board hash (e.g. "#gamepick=hr") the client navigates to on
// click; `link.playerName`, when present, gets stuffed into that board's own
// existing player-search box (see loadHubHeadlines/applyHeadlineLink in
// app.js) so the click actually surfaces the player the headline is about,
// reusing the per-board search feature rather than building new deep-link
// wiring per board.
// ─────────────────────────────────────────────────────────────────────────

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  buildBatterPool, loadTracker, cdtDateString, scoreForMarket,
} from './update-tracker.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const OUT_PATH = path.join(DATA_DIR, 'daily-headlines.json');
const TRENDING_PATH = path.join(DATA_DIR, 'trending-players.json');
const FEATURED_PATH = path.join(DATA_DIR, 'featured-player.json');
const MILESTONES_PATH = path.join(DATA_DIR, 'mlb-milestones.json');
// Mirrors update-tracker.mjs's own POOL_MIN_AB -- not exported from that
// module, so duplicated here rather than adding an export purely for this.
const FEATURED_MIN_AB = 40;
const API = 'https://statsapi.mlb.com/api/v1';

async function fetchJSON(url, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw lastErr;
}

async function readDataFile(name) {
  try {
    return JSON.parse(await readFile(path.join(DATA_DIR, name), 'utf8'));
  } catch {
    return null;
  }
}

function pct(wins, total) {
  return total > 0 ? Math.round((wins / total) * 1000) / 10 : null;
}

// "Last, First" (Baseball Savant's format, e.g. data/statcast-hot-hitters.json's
// own `name` field) -> "First Last" for display consistency with every other
// name in this script's output. Same conversion app.js's drFormatNearHRName
// does client-side for the same-shaped near-HR names, just needed here too
// since this runs in Node, not the browser.
function reformatName(rawName) {
  if (!rawName) return '';
  const parts = String(rawName).split(',');
  if (parts.length < 2) return rawName;
  return `${parts[1].trim()} ${parts[0].trim()}`;
}

function daysBetween(dateStr, todayStr) {
  const a = new Date(dateStr + 'T00:00:00Z'), b = new Date(todayStr + 'T00:00:00Z');
  return Math.round((b - a) / 86400000);
}

// ── 1. Recap — yesterday's graded record across all markets ───────────────
// Unchanged from generate-daily-insights.mjs's buildRecap, just reshaped into
// a headline object instead of its own separate top-level field.
function buildRecapHeadline(tracker, yesterdayStr) {
  const markets = [
    { key: 'drp', label: 'Game Picks' },
    { key: 'kprop', label: 'Strikeout Props' },
    { key: 'hrThreat', label: 'HR Threats' },
  ];
  let wins = 0, losses = 0;
  for (const m of markets) {
    const rows = (tracker?.market?.[m.key] || []).filter(r => r.date === yesterdayStr && (r.result === 'win' || r.result === 'loss'));
    for (const r of rows) { if (r.result === 'win') wins++; else losses++; }
  }
  const total = wins + losses;
  if (total === 0) return null;
  const p = pct(wins, total);
  const dateLabel = new Date(yesterdayStr + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
  return {
    id: 'recap',
    category: 'recap',
    title: `Diamond Report went ${wins}-${losses} on ${dateLabel}`,
    blurb: `${p}% across Game Picks, Strikeout Props, and HR Threats combined (${total} graded picks).`,
    link: { hash: '#gamepick=results' },
  };
}

// ── 2. Trend headlines — same isHot/isDue/isFavorable tags the HR Threats
// board itself uses, ranked by scoreForMarket('hr', ...) like the board's own
// default sort. Title is a short, punchy angle; blurb is the full grounded
// explanation (kept from generate-daily-insights.mjs's storylineFor, split
// into a separate one-line headline instead of one long paragraph doing both
// jobs, per roadmap 3.2's "headline" + "why it matters" split).
const MIN_STORYLINE_AB = 40;

function parkDescriptor(pf) {
  if (pf == null) return null;
  if (pf >= 103) return 'a park that plays up for power';
  if (pf <= 97) return 'a pitcher-friendly park';
  return null;
}
function suppressionClause(delta) {
  if (delta == null || Math.abs(delta) < 5) return '';
  return delta < 0
    ? ` This pitcher has also been genuinely tougher to hit hard once he gets to two strikes this season, not just generically good.`
    : ` Worth noting: this pitcher hasn't actually suppressed hard contact with two strikes this season the way his overall numbers suggest he should.`;
}
function trendTitleAndBlurb(row) {
  const pf = parkDescriptor(row.parkFactor);
  const oppLine = row.pitcherName ? `${row.oppAbbr} sends out ${row.pitcherName}` : `against ${row.oppAbbr}`;
  if (row.isDue) {
    return {
      title: `Due for a breakout: ${row.name}`,
      blurb: `A real home run drought — none in his last 10 games — but a .${Math.round(row.iso * 1000)} ISO and ${row.ops.toFixed(3)} OPS this season say the power is still there, it just hasn't landed yet. ${oppLine} today${pf ? `, in ${pf}` : ''}.${suppressionClause(row.pitcher2kSuppressionDelta)}`,
    };
  }
  if (row.isHot) {
    return {
      title: `${row.name} is running hot`,
      blurb: `Hitting well above his ${row.avg.toFixed(3)} season average over his last games, with at least one home run in that stretch. He faces ${oppLine} today${pf ? `, in ${pf}` : ''}, a pitcher who's allowed a ${(row.pitcherAvgAllowed ?? 0).toFixed(3)} average against this season.${suppressionClause(row.pitcher2kSuppressionDelta)}`,
    };
  }
  if (row.isFavorable) {
    return {
      title: `Buy-low spot: ${row.name} vs ${row.pitcherName || row.oppAbbr}`,
      blurb: `His ${row.ops.toFixed(3)} OPS lines up against ${row.pitcherName || 'an opposing pitcher'}'s ${(row.pitcherWhip ?? 0).toFixed(2)} WHIP and ${(row.pitcherAvgAllowed ?? 0).toFixed(3)} average allowed${pf ? `, and the game is in ${pf}` : ''}.${suppressionClause(row.pitcher2kSuppressionDelta)}`,
    };
  }
  return {
    title: `${row.name}'s power profile stays live`,
    blurb: `A .${Math.round(row.iso * 1000)} ISO and ${row.hrSeason} home runs this season heading into today's matchup with ${oppLine}, who's allowed a ${(row.pitcherHr9 ?? 0).toFixed(1)} HR/9 this year${pf ? `, in ${pf}` : ''}.${suppressionClause(row.pitcher2kSuppressionDelta)}`,
  };
}
function buildTrendHeadlines(pool) {
  // Every real qualifying matchup, not a top-N cut -- "all trends" per request. The
  // AB floor and score>0 filter are the real bar for inclusion, not an arbitrary count.
  const eligible = pool.filter(r => r.atBats >= MIN_STORYLINE_AB && r.name && r.oppAbbr);
  const ranked = eligible
    .map(row => ({ row, score: scoreForMarket('hr', row) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return ranked.map(({ row, score }) => {
    const { title, blurb } = trendTitleAndBlurb(row);
    return {
      id: `trend-${row.id}`,
      category: 'trend',
      title,
      blurb,
      // Real HR probability already computed above to rank this headline in
      // the first place (score>0 filter, sort) -- previously discarded once
      // the array was mapped down to {row}. Same 1-99 whole-number percentage
      // shown as "HR Probability" on the HR Threats board itself, so a
      // headline card can now show the number it was actually written from
      // instead of prose alone.
      stat: { kind: 'hrProb', value: score },
      // pitcherId/pitcherName let the client open the Matchup modal directly
      // for this exact batter-vs-pitcher pairing instead of only landing on
      // the HR Threats board filtered to the batter -- real fields already on
      // every pool row (same ones the blurb text above reads from), just not
      // previously threaded through to the client.
      link: { hash: '#gamepick=hr', playerId: row.id, playerName: row.name, pitcherId: row.pitcherId ?? null, pitcherName: row.pitcherName ?? null },
    };
  });
}

// ── 2b. Streak headlines — the same Hot Streak/Trending Up/Cooling Off/Cold
// indicator app.js's computePlayerTrendIndicator computes client-side (roadmap
// 5.2), ported here so it can also drive a headline, not just a chip on the HR
// Threats board. Deliberately covers BAD streaks too (Cooling Off/Cold), not
// just favorable stories -- a real cold stretch is exactly as headline-worthy
// as a hot one. Every qualifying player gets one, same "all trends, not a
// curated top-N" standard as buildTrendHeadlines above; on a normal day this is
// naturally bounded to a handful of players since the thresholds below require
// a real, not marginal, swing in recent HR rate vs season rate.
function computeStreakIndicator(row) {
  const last10HR = row.last10HR;
  if (last10HR == null) return null;
  const ab = row.atBats || 0;
  const hrSeason = row.hrSeason || 0;
  if (ab <= 0) return null;
  const expectedHRPer10 = (hrSeason / ab) * 40;
  const ratio = last10HR / Math.max(expectedHRPer10, 0.4);
  const smallSample = ab < 40;
  let label = null;
  if (last10HR >= 2 && ratio >= 1.75) label = 'Hot Streak';
  else if (ratio >= 1.15) label = 'Trending Up';
  else if (last10HR === 0 && expectedHRPer10 >= 1.0) label = 'Cold';
  else if (ratio <= 0.5) label = 'Cooling Off';
  if (!label) return null;
  return { label, last10HR, expectedHRPer10, smallSample, ratio };
}
function streakTitleAndBlurb(row, streak) {
  const sampleNote = streak.smallSample ? ` (a small sample — under 40 at-bats this season, so treat this with some caution)` : '';
  const expected = streak.expectedHRPer10.toFixed(1);
  if (streak.label === 'Hot Streak') {
    return {
      title: `${row.name} is on a hot streak`,
      blurb: `${streak.last10HR} home runs in his last 10 games against an expected pace of ${expected} — real recent power, not just a hot box score.${sampleNote}`,
    };
  }
  if (streak.label === 'Trending Up') {
    return {
      title: `${row.name} is trending up`,
      blurb: `${streak.last10HR} home run${streak.last10HR === 1 ? '' : 's'} in his last 10 games, running ahead of his ${expected}-per-10-games season pace.${sampleNote}`,
    };
  }
  if (streak.label === 'Cooling Off') {
    return {
      title: `${row.name} is cooling off`,
      blurb: `Just ${streak.last10HR} home run${streak.last10HR === 1 ? '' : 's'} in his last 10 games against an expected pace of ${expected} — a real dip, worth knowing before starting him.${sampleNote}`,
    };
  }
  return {
    title: `${row.name} is ice cold`,
    blurb: `No home runs in his last 10 games despite an expected pace of ${expected} based on his season rate — a genuine cold stretch, not just normal variance.${sampleNote}`,
  };
}
function buildStreakHeadlines(pool) {
  const ranked = [];
  for (const row of pool) {
    if (!row.name) continue;
    const streak = computeStreakIndicator(row);
    if (!streak) continue;
    ranked.push({ row, streak });
  }
  // Ranked by how extreme the real ratio is (distance from 1.0 = exactly on
  // pace), not left in pool order -- a real ice-cold stretch is exactly as
  // headline-worthy as a real hot one, so this ranks both directions by
  // signal strength rather than only surfacing favorable stories first.
  ranked.sort((a, b) => Math.abs(b.streak.ratio - 1) - Math.abs(a.streak.ratio - 1));
  return ranked.map(({ row, streak }) => {
    const { title, blurb } = streakTitleAndBlurb(row, streak);
    return {
      id: `streak-${row.id}`,
      category: 'streak',
      title,
      blurb,
      // Real last-10-games HR count that already drives both the ranking
      // (via streak.ratio) and the blurb text -- exposed as its own field so
      // a headline card can show it as a number, not just read it out of
      // prose. Sign matches the streak direction (Hot Streak/Trending Up are
      // positive stories, Cold/Cooling Off are real too) so the client can
      // decide how to color it rather than guessing from category alone.
      stat: { kind: 'last10HR', value: streak.last10HR, favorable: streak.label === 'Hot Streak' || streak.label === 'Trending Up' },
      // pitcherId/pitcherName let the client open the Matchup modal directly
      // for this exact batter-vs-pitcher pairing instead of only landing on
      // the HR Threats board filtered to the batter -- real fields already on
      // every pool row (same ones the blurb text above reads from), just not
      // previously threaded through to the client.
      link: { hash: '#gamepick=hr', playerId: row.id, playerName: row.name, pitcherId: row.pitcherId ?? null, pitcherName: row.pitcherName ?? null },
    };
  });
}

// ── 3. Notable performance — the longest real home run from the most
// recent day data/recent-hrs.json has entries for, using the real Statcast
// description text already synced (see sync-near-hrs.mjs) rather than
// writing a new sentence from scratch.
function buildNotablePerformanceHeadline(recentHrsData) {
  const players = recentHrsData?.players || {};
  let best = null, bestDate = null;
  for (const [playerId, events] of Object.entries(players)) {
    for (const e of events || []) {
      if (!e?.date) continue;
      if (bestDate == null || e.date > bestDate) { bestDate = e.date; }
    }
  }
  if (!bestDate) return null;
  for (const [playerId, events] of Object.entries(players)) {
    for (const e of events || []) {
      if (e.date !== bestDate) continue;
      if (!best || (e.distance || 0) > (best.event.distance || 0)) best = { playerId, event: e };
    }
  }
  if (!best || !best.event.distance) return null;
  const dateLabel = new Date(best.event.date + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
  return {
    id: `notable-${best.playerId}-${best.event.date}`,
    category: 'notable',
    title: `Longest home run of the day: ${best.event.distance} ft`,
    blurb: `${best.event.description || `A ${best.event.distance}-foot home run on ${dateLabel}`}${best.event.exitVelo != null ? ` (${best.event.exitVelo.toFixed(1)} mph off the bat)` : ''}.`,
    link: { hash: '#gamepick=hr', playerId: Number(best.playerId) || null, playerName: null },
    clip: best.event.videoUrl ? { videoUrl: best.event.videoUrl } : undefined,
  };
}

// ── 4. Weather — today's single best HR-scoring environment from Ballpark
// Pal's per-game environment sync (sync-ballparkpal.mjs), only surfaced when
// genuinely notable (>= +15% HR boost) rather than always picking whichever
// game happens to rank #1 on an unremarkable day.
const WEATHER_NOTABLE_HR_PCT = 15;
function buildWeatherHeadline(gameFactors) {
  const rows = gameFactors?.rows || [];
  if (!rows.length) return null;
  const best = rows.slice().sort((a, b) => (b.homeRunsPercent || 0) - (a.homeRunsPercent || 0))[0];
  if (!best || (best.homeRunsPercent || 0) < WEATHER_NOTABLE_HR_PCT) return null;
  return {
    id: `weather-${best.gameId}`,
    category: 'weather',
    title: `Best home run weather today: ${best.teamAway} @ ${best.teamHome}`,
    blurb: `Ballpark Pal projects a +${best.homeRunsPercent}% home run environment for this game${best.runsPercent != null ? ` and a +${best.runsPercent}% scoring boost overall` : ''} — conditions and park factors both favor the long ball.`,
    link: { hash: '#gamepick=games' },
  };
}

// ── 5. Injury — a player who recently came off the injured list, per the
// real roster-status history sync-batter-splits.mjs already builds (merged
// into data/statcast-hot-hitters.json's players). Silent when nobody
// genuinely qualifies today rather than reaching for a stale example.
function buildInjuryHeadline(hotHittersData, todayStr) {
  const players = hotHittersData?.players || [];
  const candidate = players.find(p => p.recentlyReturnedFromInjury);
  if (!candidate) return null;
  const name = reformatName(candidate.name);
  const daysAgo = daysBetween(candidate.recentlyReturnedFromInjury, todayStr);
  return {
    id: `injury-${candidate.playerId}`,
    category: 'injury',
    title: `${name} is back in the lineup`,
    blurb: `Recently returned from the injured list${Number.isFinite(daysAgo) && daysAgo >= 0 ? ` (${daysAgo} day${daysAgo === 1 ? '' : 's'} ago)` : ''} — worth watching how his early at-bats and swing metrics look coming back.`,
    link: { hash: '#gamepick=hr', playerId: Number(candidate.playerId) || null, playerName: name },
  };
}

// ── 6. Model movement — the single biggest day-over-day HR Threat score
// swing for a player who appears in tracker.json on both their most recent
// two dated snapshots. Only surfaced above a real threshold so an ordinary
// day-to-day score wobble never gets narrated as if it meant something.
const MODEL_MOVE_THRESHOLD = 4;
function buildModelMovementHeadline(tracker, todayStr) {
  const rows = tracker?.market?.hrThreat || [];
  const byPlayer = new Map();
  for (const r of rows) {
    if (r.score == null || !r.date) continue;
    if (!byPlayer.has(r.playerId)) byPlayer.set(r.playerId, []);
    byPlayer.get(r.playerId).push(r);
  }
  let best = null;
  for (const [, playerRows] of byPlayer) {
    if (playerRows.length < 2) continue;
    const sorted = playerRows.slice().sort((a, b) => a.date.localeCompare(b.date));
    const latest = sorted[sorted.length - 1];
    // Require the newer side of the comparison to actually be today's capture --
    // without this, a player who simply hasn't been re-captured (a day off, or
    // didn't qualify) could keep resurfacing the same day-old-or-older movement
    // as if it were live news, on days where nothing about their matchup
    // actually changed. This is the one piece of `today` this function needs;
    // "prior" is left as whatever their real last captured outing was, however
    // long ago that is -- that gap is genuinely part of the real story, not a
    // data artifact to paper over.
    if (todayStr && latest.date !== todayStr) continue;
    const prior = sorted[sorted.length - 2];
    const delta = latest.score - prior.score;
    if (Math.abs(delta) >= MODEL_MOVE_THRESHOLD && (!best || Math.abs(delta) > Math.abs(best.delta))) {
      best = { latest, prior, delta };
    }
  }
  if (!best) return null;
  const direction = best.delta > 0 ? 'up' : 'down';
  return {
    id: `model-${best.latest.playerId}`,
    category: 'model',
    title: `Diamond Report's model is moving ${direction} on ${best.latest.playerName}`,
    blurb: `His HR Threat score has gone ${direction} from ${best.prior.score} to ${best.latest.score} since his last outing (${best.prior.date}) — a real shift in the underlying matchup inputs, not just noise.`,
    link: { hash: '#gamepick=hr', playerId: best.latest.playerId, playerName: best.latest.playerName },
  };
}

// ── 7. Leaderboard — today's real MLB home run leader, straight from the
// league's own live stats API (not a copied article, so no attribution
// needed -- this is the same public leaderboard data statsapi.mlb.com
// serves to any client).
async function buildLeaderboardHeadline(season) {
  const data = await fetchJSON(`${API}/stats/leaders?leaderCategories=homeRuns&season=${season}&sportId=1&statGroup=hitting&limit=1`).catch(() => null);
  const leader = data?.leagueLeaders?.[0]?.leaders?.[0];
  if (!leader?.person?.fullName) return null;
  return {
    id: `leaderboard-${leader.person.id}`,
    category: 'leaderboard',
    title: `${leader.person.fullName} leads MLB with ${leader.value} home runs`,
    blurb: `The current league home run leader this season, per MLB's own live stats.`,
    link: { hash: '#gamepick=hr', playerId: leader.person.id || null, playerName: leader.person.fullName },
  };
}

// ── Transactions — real trades from data/mlb-transactions.json (synced on
// its own frequent schedule by sync-mlb-transactions.mjs, separate from this
// script's own 3x/day cadence, so a trade shows up here within that sync's
// interval rather than waiting for the next full tracker pass). Windowed to
// the last 2 days (today or yesterday) so a trade stays visible through the
// rest of the day it happened plus one more full day, then ages out on its
// own the same way the injury-return headline does -- no separate "already
// shown" bookkeeping needed.
function buildTransactionHeadlines(txData, todayStr) {
  const trades = txData?.trades || [];
  const recent = trades.filter(t => t.date && daysBetween(t.date, todayStr) <= 1 && daysBetween(t.date, todayStr) >= 0);
  return recent.map(t => {
    const move = t.fromTeam && t.toTeam
      ? `traded from the ${t.fromTeam} to the ${t.toTeam}`
      : (t.toTeam ? `traded to the ${t.toTeam}` : 'involved in a trade');
    return {
      id: `transaction-${t.id}`,
      category: 'transaction',
      title: `${t.playerName} ${move}`,
      // The real MLB transaction description is preferred when present --
      // it's the league's own official record of the deal, not a generated
      // sentence -- falling back to our own constructed line only when a
      // transaction genuinely has none.
      blurb: t.description || `${t.playerName} was ${move} on ${t.date}.`,
      link: t.playerId ? { hash: '#gamepick=hr', playerId: t.playerId, playerName: t.playerName } : undefined,
    };
  });
}

// ── No-hitters — real completed games (>= 9 innings, Final) where the
// official box score shows the losing team with 0 hits, straight from MLB
// Stats API's own linescore hydration (the league's own record of the game,
// not a copied recap). Checked against yesterday's AND today's schedule so
// a no-hitter thrown after this script's last run still surfaces the next
// time it's checked, then ages out on its own once the game's date falls
// out of that 2-day window -- no separate "already shown" bookkeeping
// needed, same pattern as the transaction headlines above.
//
// Scoped to no-hitters only, not perfect games -- MLB Stats API's linescore
// hydration carries hits/runs/errors per team but not walks/HBP allowed, so
// there's no real way to also confirm "no one reached base" from this same
// call without a second, per-game boxscore fetch. Left out rather than
// guessed at from an incomplete signal.
async function buildNoHitterHeadlines(dateStrs) {
  const headlines = [];
  for (const dateStr of dateStrs) {
    let sched;
    try {
      sched = await fetchJSON(`${API}/schedule?sportId=1&date=${dateStr}&hydrate=team,linescore`);
    } catch (e) {
      console.warn(`No-hitter check failed for ${dateStr}: ${e.message}`);
      continue;
    }
    const games = sched?.dates?.find(d => d.date === dateStr)?.games || [];
    for (const g of games) {
      if (g.status?.abstractGameState !== 'Final') continue;
      const line = g.linescore;
      // A real no-hitter requires a completed game of at least 9 innings --
      // without this, a rained-out shortened game with a clean box score
      // would be wrongly flagged (MLB itself doesn't recognize those as
      // official no-hitters).
      if (!line || (line.currentInning || 0) < 9) continue;
      const awayHits = line.teams?.away?.hits, homeHits = line.teams?.home?.hits;
      const awayName = g.teams?.away?.team?.name, homeName = g.teams?.home?.team?.name;
      let noHit = null;
      if (awayHits === 0 && awayName && homeName) noHit = { batting: awayName, pitching: homeName };
      else if (homeHits === 0 && awayName && homeName) noHit = { batting: homeName, pitching: awayName };
      if (!noHit) continue;
      headlines.push({
        id: `nohitter-${g.gamePk}`,
        category: 'nohitter',
        title: `${noHit.pitching} throw a no-hitter against the ${noHit.batting}`,
        blurb: `A real, official no-hitter — a completed 9+ inning game with zero hits allowed, per MLB's own box score (${dateStr}).`,
        link: { hash: '#gamepick=k' },
      });
    }
  }
  return headlines;
}

// ── Milestones — real, in-season home run milestones for batters this site
// already has in today's real candidate pool (buildBatterPool), not the
// whole league -- keeps this tied to what the site actually predicts (per
// the "no-hitter that affects tonight's K Props line, a milestone for
// someone already on our board" scoping) instead of trying to replicate a
// general newsroom's whole feed.
//
// "Just crossed" is only ever real, never backdated: a player's previous
// real hrSeason count is read from data/mlb-milestones.json (written by
// this same script at the end of every run), and a headline only fires when
// today's count is strictly higher than that real prior observation AND a
// threshold sits between the two. A player seen for the very first time
// (no prior real observation on file) gets recorded with no headline --
// otherwise every batter already sitting on, say, 32 HR would wrongly
// "just hit" 30 on this script's very first-ever run.
const MILESTONE_HR_THRESHOLDS = [20, 25, 30, 35, 40, 45, 50, 55, 60];
function buildMilestoneHeadlines(pool, milestoneState) {
  const prevPlayers = (milestoneState && milestoneState.players) || {};
  const nextPlayers = { ...prevPlayers };
  const headlines = [];
  for (const row of pool) {
    if (!row.id || !row.name || row.hrSeason == null) continue;
    const prev = prevPlayers[row.id];
    nextPlayers[row.id] = { name: row.name, hrSeason: row.hrSeason };
    if (prev == null || prev.hrSeason == null) continue;
    if (row.hrSeason <= prev.hrSeason) continue;
    const crossed = MILESTONE_HR_THRESHOLDS.filter(t => prev.hrSeason < t && row.hrSeason >= t);
    if (!crossed.length) continue;
    const milestone = crossed[crossed.length - 1];
    headlines.push({
      id: `milestone-${row.id}-${milestone}`,
      category: 'milestone',
      title: `${row.name} just hit his ${milestone}th home run of the season`,
      blurb: `A real season milestone — ${row.hrSeason} home runs so far, and he's still in today's real HR Threats pool.`,
      link: { hash: '#gamepick=hr', playerId: row.id, playerName: row.name },
    });
  }
  return { headlines, nextState: { generatedAt: new Date().toISOString(), players: nextPlayers } };
}

// ── 8. Trending Players — a small real visual per player, similar in spirit to
// Baseball Savant's own "Trending Players" widget. Written to its own output
// file (data/trending-players.json) rather than folded into the headlines
// array above, since these are visual cards (a real mini spray chart / whiff
// scatter), not another title+blurb text headline.
//
// Batters are ranked by the exact same real HR-streak ratio
// computeStreakIndicator already computes above -- restricted here to Hot
// Streak/Trending Up only (upside framing, matching the reference), unlike
// the streak headlines above which deliberately also cover cold stretches.
// Pitchers are ranked by a real rolling-usage-weighted whiff% delta from
// data/pitcher-rolling.json (each pitch type's real whiffDelta, weighted by
// how often that pitch is actually thrown, not a flat average across pitch
// types of wildly different usage). Every card's visual is real synced
// coordinates -- a real HR landing spot (data/batter-hr-spray.json) or a real
// swing-and-miss location (data/pitcher-statcast.json's whiffLocations,
// synced by sync-pitcher-zone-hr.mjs) -- capped to the most recent
// TRENDING_MAX_DOTS events per player so the small card stays readable, never
// a random or fabricated sample. A player with a real qualifying trend but no
// synced visual data yet is simply left out, rather than shown with an empty
// chart.
const TRENDING_MAX_BATTERS = 3;
const TRENDING_MAX_PITCHERS = 2;
const TRENDING_MAX_DOTS = 15;
// ratio's denominator is floored at 0.4 (see buildTrendingBatters) to avoid a
// divide-by-zero for a light hitter with a near-zero expected HR pace -- but
// that same floor lets a single hot 10-game stretch produce a technically-
// correct but absurd-looking "Trending +900%" for exactly that kind of player.
// Capped here (client shows a trailing '+' via trendPctCapped) rather than
// hidden or fabricated, so the number displayed is always true, just not
// necessarily the full magnitude.
const TRENDING_PCT_CAP = 200;

function buildTrendingBatters(pool, hrSprayData) {
  const spray = hrSprayData?.players || {};
  const candidates = [];
  for (const row of pool) {
    if (!row.name || !row.id) continue;
    const streak = computeStreakIndicator(row);
    if (!streak || (streak.label !== 'Hot Streak' && streak.label !== 'Trending Up')) continue;
    const ratio = streak.last10HR / Math.max(streak.expectedHRPer10, 0.4);
    candidates.push({ row, streak, ratio });
  }
  candidates.sort((a, b) => b.ratio - a.ratio);
  const out = [];
  for (const { row, streak, ratio } of candidates) {
    const dots = (spray[String(row.id)] || [])
      .slice()
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
      .slice(0, TRENDING_MAX_DOTS)
      .map(d => ({ xFt: d.xFt, yFt: d.yFt, distance: d.distance }));
    if (!dots.length) continue; // real trend, but no synced visual yet -- skip rather than show empty
    const rawPct = Math.round((ratio - 1) * 100);
    out.push({
      playerId: row.id,
      name: row.name,
      type: 'batter',
      trendLabel: streak.label,
      trendMetric: 'HR pace vs season rate (last 10 games)',
      trendPct: Math.min(rawPct, TRENDING_PCT_CAP),
      trendPctCapped: rawPct > TRENDING_PCT_CAP,
      visual: { type: 'spray', label: `${row.name.split(' ').pop()} Home Runs`, dots },
    });
    if (out.length >= TRENDING_MAX_BATTERS) break;
  }
  return out;
}

function buildTrendingPitchers(pitcherRollingData, pitcherStatcastData, pitcherNameById) {
  const rolling = pitcherRollingData?.pitchers || {};
  const statcast = pitcherStatcastData?.pitchers || {};
  const candidates = [];
  for (const [id, profile] of Object.entries(rolling)) {
    const name = pitcherNameById.get(Number(id)) || pitcherNameById.get(id);
    if (!name) continue;
    const rows = (profile.byPitch || []).filter(p => p.whiffDelta != null && p.rollingUsagePct != null);
    if (!rows.length) continue;
    const weightSum = rows.reduce((s, p) => s + p.rollingUsagePct, 0);
    if (weightSum <= 0) continue;
    const weightedDelta = rows.reduce((s, p) => s + p.whiffDelta * p.rollingUsagePct, 0) / weightSum;
    if (weightedDelta <= 0) continue; // upside-only, same framing as batters above
    candidates.push({ id, name, weightedDelta });
  }
  candidates.sort((a, b) => b.weightedDelta - a.weightedDelta);
  const out = [];
  for (const { id, name, weightedDelta } of candidates) {
    const whiffs = (statcast[id]?.whiffLocations || [])
      .slice()
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
      .slice(0, TRENDING_MAX_DOTS)
      .map(w => ({ plateX: w.plateX, plateZ: w.plateZ, pitchName: w.pitchName }));
    if (!whiffs.length) continue;
    out.push({
      playerId: Number(id) || id,
      name,
      type: 'pitcher',
      trendLabel: 'Trending Up',
      trendMetric: 'Whiff rate vs season rate (last 3 starts)',
      trendPct: Math.round(weightedDelta),
      visual: { type: 'whiff', label: `${name.split(' ').pop()} Whiffs`, dots: whiffs },
    });
    if (out.length >= TRENDING_MAX_PITCHERS) break;
  }
  return out;
}

async function buildTrendingPlayers(pool, games, today) {
  const hrSprayData = await readDataFile('batter-hr-spray.json');
  const pitcherRollingData = await readDataFile('pitcher-rolling.json');
  const pitcherStatcastData = await readDataFile('pitcher-statcast.json');

  const pitcherNameById = new Map();
  for (const g of games || []) {
    for (const side of ['away', 'home']) {
      const p = g.teams?.[side]?.probablePitcher;
      if (p?.id) pitcherNameById.set(p.id, p.fullName);
    }
  }

  const batters = pool ? buildTrendingBatters(pool, hrSprayData) : [];
  const pitchers = pitcherRollingData ? buildTrendingPitchers(pitcherRollingData, pitcherStatcastData, pitcherNameById) : [];
  return { date: today, generatedAt: new Date().toISOString(), players: [...batters, ...pitchers] };
}

// ── Featured Player — one daily rotating hub focal point (roadmap 2's
// "Featured Player" card) ──────────────────────────────────────────────
// Reuses the exact same real batter pool (buildBatterPool) and HR probability
// model (liveScore, computeLiveHRScore) that already drives the HR Threats
// board and its own Featured HR Pick flagship card -- no separate model, no
// fabricated score. The composite spotlight score below only breaks a close
// liveScore tie using OTHER real, already-corroborating signals (hot streak,
// favorable matchup, near-HR power, a strong Matchup Edge), never an
// arbitrary tiebreak.
function computeSpotlightScore(r) {
  let score = r.liveScore || 0;
  if (r.isHot) score += 4;
  if (r.isFavorable) score += 3;
  if (r.hasNearHR) score += 2;
  if (r.matchupEdge != null && r.matchupEdge >= 64) score += 3;
  return score;
}

// Every sentence here is gated on a real threshold already computed by
// buildBatterPool -- same "real number or nothing" discipline as every other
// headline builder in this file. This becomes the card's visible "why this
// player" explanation and its rule-based "AI Explanation" prose (there is no
// real LLM anywhere in this app -- see this file's own header comment).
function buildFeaturedReasons(r) {
  const reasons = [];
  reasons.push({ icon: '💣', text: `Projects at a real ${r.liveScore.toFixed(1)}% HR probability today, from the same model behind the HR Threats board.` });
  if (r.isHot) reasons.push({ icon: '🔥', text: `On a real hot streak — ${r.last10HR ?? '0'} HR over the last 10 games.` });
  if (r.isFavorable) reasons.push({ icon: '✅', text: `Favorable matchup — a real ${r.ops.toFixed(3)} OPS bat against a pitcher who's given up real contact this season.` });
  if (r.matchupEdge != null && r.matchupEdge >= 64) reasons.push({ icon: '⚔️', text: `Real Matchup Edge score of ${r.matchupEdge} against today's specific starter, ${r.pitcherName}.` });
  if (r.hasNearHR) reasons.push({ icon: '🚀', text: 'Real warning-track power in the last 10 games — recent long fly outs that haven\'t left the yard yet.' });
  if (r.isDue) reasons.push({ icon: '⚡', text: 'In a real power drought the model flags as due to break.' });
  return reasons;
}

// Picks lock in the moment they're first captured for the day, same
// discipline as captureHRThreatToday above (this script runs multiple times
// a day) -- once today's pick exists, a later same-day run never recomputes
// or swaps it, even if a fresher pool would technically score someone else
// higher. Only `confirmedToday` is re-derived on every run (does this player
// still appear anywhere in today's freshly rebuilt real pool) so a scratch or
// postponement degrades the card gracefully client-side instead of silently
// picking a different player intraday.
function buildFeaturedPlayer(pool, today, previousFile) {
  if (previousFile && previousFile.date === today && previousFile.player) {
    const stillActive = pool.some(r => String(r.id) === String(previousFile.player.id));
    return {
      date: today,
      generatedAt: new Date().toISOString(),
      player: { ...previousFile.player, confirmedToday: stillActive },
    };
  }
  const candidates = pool.filter(r => r.atBats >= FEATURED_MIN_AB && r.liveScore > 0);
  if (!candidates.length) return null;
  const best = candidates.reduce((top, r) => (computeSpotlightScore(r) > computeSpotlightScore(top) ? r : top), candidates[0]);
  return {
    date: today,
    generatedAt: new Date().toISOString(),
    player: {
      id: best.id, name: best.name, teamAbbr: best.teamAbbr, oppAbbr: best.oppAbbr, gamePk: best.gamePk,
      pitcherId: best.pitcherId, pitcherName: best.pitcherName,
      liveScore: best.liveScore, spotlightScore: +computeSpotlightScore(best).toFixed(1),
      avg: best.avg, obp: best.obp, slg: best.slg, ops: best.ops, iso: best.iso,
      hrSeason: best.hrSeason, atBats: best.atBats, last10HR: best.last10HR,
      isHot: best.isHot, isFavorable: best.isFavorable, isDrought: best.isDrought, isDue: best.isDue, hasNearHR: best.hasNearHR,
      matchupEdge: best.matchupEdge, statcast: best.statcast || null,
      reasons: buildFeaturedReasons(best),
      confirmedToday: true,
    },
  };
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  const today = cdtDateString(new Date());
  const yesterday = cdtDateString(new Date(Date.now() - 24 * 60 * 60 * 1000));
  const season = today.slice(0, 4);

  const tracker = await loadTracker();
  const headlines = [];

  const recapHeadline = buildRecapHeadline(tracker, yesterday);
  if (recapHeadline) headlines.push(recapHeadline);

  // Notable/weather/injury/model-move/leaderboard are today's small set of hand-picked
  // one-off stories -- each builder produces at most a single headline, unlike
  // trend/streak below which intentionally cover EVERY real qualifying player and can
  // legitimately run into the hundreds on an active day. Pushed here, right after
  // recap and before that flood, so these don't end up buried at the tail of the "All"
  // feed where a reader would have to page through everything else (via "View More")
  // to ever reach them -- the client's category filter chips are a fallback way in,
  // not the only one.
  const recentHrsData = await readDataFile('recent-hrs.json');
  const notable = buildNotablePerformanceHeadline(recentHrsData);
  if (notable) headlines.push(notable);

  const gameFactors = await readDataFile('ballparkpal-game-factors.json');
  const weather = buildWeatherHeadline(gameFactors);
  if (weather) headlines.push(weather);

  const hotHittersData = await readDataFile('statcast-hot-hitters.json');
  const injury = buildInjuryHeadline(hotHittersData, today);
  if (injury) headlines.push(injury);

  const modelMove = buildModelMovementHeadline(tracker, today);
  if (modelMove) headlines.push(modelMove);

  // Reads data/mlb-transactions.json, kept fresh on its own short-interval
  // schedule (sync-transactions.yml) separate from this script's -- a real
  // trade can land at any hour, unlike the stat-driven categories above.
  const txData = await readDataFile('mlb-transactions.json');
  const transactions = buildTransactionHeadlines(txData, today);
  headlines.push(...transactions);

  try {
    const leaderboard = await buildLeaderboardHeadline(season);
    if (leaderboard) headlines.push(leaderboard);
  } catch (e) {
    console.warn(`Leaderboard headline failed: ${e.message}`);
  }

  // Checks yesterday's AND today's completed games -- a no-hitter thrown
  // after this script's last run (e.g. a night game finishing after the
  // evening pass) still surfaces the next time this runs, then ages out on
  // its own once its date falls out of that 2-day window.
  try {
    const noHitters = await buildNoHitterHeadlines([yesterday, today]);
    headlines.push(...noHitters);
  } catch (e) {
    console.warn(`No-hitter headline check failed: ${e.message}`);
  }

  // Trend + streak headlines depend on a live MLB schedule/roster fetch, unlike
  // everything else here (local data/tracker.json reads) -- isolated in its own
  // try/catch so a transient MLB API hiccup can't cost the other categories too.
  // pool/games are hoisted out so the Trending Players write below (which needs
  // the exact same real batter pool + today's probable-pitcher names) doesn't
  // need a second schedule fetch.
  let pool = null, games = [];
  // Populated only when pool is real (see below) -- written to disk in its own
  // try/catch near the other optional writes at the end of main(), same
  // "never let an optional write take down anything else" discipline as
  // Trending Players/Featured Player.
  let milestoneResult = null;
  try {
    const sched = await fetchJSON(`${API}/schedule?sportId=1&date=${today}&hydrate=team,probablePitcher,linescore,weather`);
    games = sched?.dates?.find(d => d.date === today)?.games || [];
    const previewGames = games.filter(g => g.status?.abstractGameState === 'Preview');
    if (previewGames.length) {
      pool = await buildBatterPool(previewGames, season);
      headlines.push(...buildTrendHeadlines(pool));
      headlines.push(...buildStreakHeadlines(pool));
      const milestoneState = await readDataFile('mlb-milestones.json');
      milestoneResult = buildMilestoneHeadlines(pool, milestoneState);
      headlines.push(...milestoneResult.headlines);
    }
  } catch (e) {
    console.warn(`Trend/streak/milestone headlines failed, other categories will still be written: ${e.message}`);
  }

  console.log(`Built ${headlines.length} headline(s) for ${today}: ${headlines.map(h => h.category).join(', ')}`);

  const out = { date: today, generatedAt: new Date().toISOString(), headlines };
  await writeFile(OUT_PATH, JSON.stringify(out, null, 2) + '\n');

  // Isolated in its own try/catch, same discipline as every other optional
  // category above -- a failure here (missing pitcher-rolling.json on a slow
  // sync day, etc.) must never take down the headlines write that already
  // succeeded above it.
  try {
    const trendingPlayers = await buildTrendingPlayers(pool, games, today);
    console.log(`Built ${trendingPlayers.players.length} trending player card(s) for ${today}.`);
    await writeFile(TRENDING_PATH, JSON.stringify(trendingPlayers, null, 2) + '\n');
  } catch (e) {
    console.warn(`Trending Players write failed: ${e.message}`);
  }

  // Isolated in its own try/catch, same discipline as the categories above --
  // a failure here must never take down the headlines/trending writes that
  // already succeeded. Uses the same real pool already built above (no extra
  // fetch) unless the schedule fetch failed entirely, in which case there's
  // no real candidate pool to feature anyone from today and this is skipped
  // (never a fabricated pick) -- a same-day pick already on disk still keeps
  // showing (see buildFeaturedPlayer's lock-in branch).
  try {
    const previousFeatured = await readDataFile('featured-player.json');
    const featured = pool && pool.length ? buildFeaturedPlayer(pool, today, previousFeatured) : previousFeatured;
    if (featured) {
      console.log(`Featured Player for ${today}: ${featured.player.name} (${featured.player.confirmedToday ? 'confirmed' : 'NOT confirmed'} in today's real pool).`);
      await writeFile(FEATURED_PATH, JSON.stringify(featured, null, 2) + '\n');
    } else {
      console.log(`No Featured Player candidate cleared the real bar for ${today}.`);
    }
  } catch (e) {
    console.warn(`Featured Player write failed: ${e.message}`);
  }

  // Isolated in its own try/catch, same discipline as the writes above -- a
  // failure here must never take down anything that already succeeded. Only
  // written when milestoneResult is real (today's schedule fetch actually
  // produced a pool) so a fetch-failure day never overwrites real prior
  // hrSeason observations with nothing.
  if (milestoneResult) {
    try {
      await writeFile(MILESTONES_PATH, JSON.stringify(milestoneResult.nextState, null, 2) + '\n');
    } catch (e) {
      console.warn(`Milestones state write failed: ${e.message}`);
    }
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch(e => { console.error(e); process.exit(1); });
}

export {
  buildRecapHeadline, buildTrendHeadlines, trendTitleAndBlurb, parkDescriptor, suppressionClause,
  buildStreakHeadlines, computeStreakIndicator, streakTitleAndBlurb,
  buildNotablePerformanceHeadline, buildWeatherHeadline, buildInjuryHeadline, buildModelMovementHeadline,
  buildTransactionHeadlines, buildNoHitterHeadlines, buildMilestoneHeadlines,
  buildLeaderboardHeadline, buildTrendingBatters, buildTrendingPitchers, buildTrendingPlayers, main,
  computeSpotlightScore, buildFeaturedReasons, buildFeaturedPlayer,
};
