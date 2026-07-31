#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Generates data/performance-report.json (roadmap 2.5 "Performance Tracking
// and Weekly Reporting") -- a read-only aggregation layer over the exact same
// data/tracker.json update-tracker.mjs already captures and grades. This
// script computes nothing new about whether a pick won or lost; it only
// rolls up rows that are already graded there into daily/weekly/monthly/
// season views, a cross-market player leaderboard, and confidence/team
// breakdowns -- all gated by the same two sample-size thresholds everywhere
// (MIN_SAMPLE below), rather than each report inventing its own ad hoc
// cutoff the way analyze-drp/hr/k-matchups.mjs each currently do.
//
// The one thing this script's SIBLING (update-tracker.mjs) had to add for
// this feature to be possible: a `nearMiss` boolean, stamped onto each row
// at grading time (see gradeHRThreatPending/gradePending there), splitting
// every loss into "near miss" vs "miss" per the DEFINITIONS below. This
// script only reads that field back -- it never recomputes it -- so the
// report and the underlying grading can never drift apart.
//
// `market.premium` (the frozen, no-longer-captured Elite Picks history) is
// deliberately excluded -- see update-tracker.mjs's own comment on why that
// pipeline is dead. Including it would make a resumed-looking "hits/rbi/tb/
// sb" market appear in weekly/monthly views for weeks where nothing was
// actually captured, which is exactly the kind of misleading transparency
// gap this feature exists to prevent.
// ─────────────────────────────────────────────────────────────────────────

import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadTracker, cdtDateString } from './update-tracker.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const OUT_PATH = path.join(DATA_DIR, 'performance-report.json');
const NEAR_HRS_PATH = path.join(DATA_DIR, 'near-hrs.json');

// Sample-size thresholds -- reused for every breakdown/leaderboard in this
// file, so "is this split trustworthy" always means the same thing wherever
// it's asked (roadmap 2.5's "Metrics use consistent sample-size thresholds
// and definitions" acceptance criterion).
const MIN_SAMPLE = {
  // Matches analyze-hr-matchups.mjs's TAG_MIN_SAMPLE_PER_SIDE convention --
  // a confidence-tier/team split below this is still shown (never hidden --
  // transparency is the point of this feature) but flagged insufficientSample.
  breakdown: 20,
  // Player-level samples are naturally far smaller than a global bucket
  // split (even a full season rarely gives one player 20+ graded picks in a
  // single market), so the leaderboard uses its own, lower bar. Unlike the
  // breakdown gate, leaderboard entries below this are EXCLUDED outright
  // rather than flagged -- a ranking's whole purpose is comparison, and an
  // unfiltered 1-for-1 (100%) would otherwise sit above a real 40-for-55.
  leaderboard: 8,
};

// What "hit" / "near miss" / "miss" means per market -- shipped alongside the
// report itself so any consumer (the client UI, a future export) always has
// the real definition next to the numbers instead of having to go read this
// file's source.
const DEFINITIONS = {
  drp: {
    hit: 'Moneyline pick won.',
    nearMiss: 'Lost, but the game was decided by exactly one run.',
    miss: 'Lost by 2 or more runs.',
  },
  kprop: {
    hit: 'Strikeout O/U pick won.',
    nearMiss: 'Lost, but the final strikeout total landed within 1 K of the line.',
    miss: 'Lost by 2 or more strikeouts.',
  },
  hrThreat: {
    hit: 'Real home run.',
    nearMiss: 'No home run, but a real warning-track fly out (>=375ft -- the same distance the site\'s "🚀 NEAR HR" chip already uses) that same game.',
    miss: 'No home run and no qualifying near-HR fly out that game.',
  },
};

const MARKETS = ['drp', 'kprop', 'hrThreat'];
// Same 4 labels computeZoneFitServer (update-tracker.mjs) / computeZoneFit (app.js)
// already produce -- kept in this exact order (best to worst) for the client's own
// bar/table rendering, not re-derived from a score here.
const ZONE_FIT_TIERS = ['Elite Zone Fit', 'Strong Zone Fit', 'Playable Zone Fit', 'Pitcher Zone Edge'];

function emptyBucket() {
  return { hits: 0, nearMisses: 0, misses: 0, pushes: 0, total: 0 };
}
function addOutcome(bucket, outcome) {
  bucket.total++;
  if (outcome === 'push') bucket.pushes++;
  else if (outcome === 'hit') bucket.hits++;
  else if (outcome === 'nearMiss') bucket.nearMisses++;
  else if (outcome === 'miss') bucket.misses++;
}
// graded excludes pushes (a push is neither a hit nor a miss) -- same
// convention implied by every existing win/loss-only calibration script.
function finalizeBucket(bucket) {
  const graded = bucket.hits + bucket.nearMisses + bucket.misses;
  return {
    ...bucket,
    graded,
    hitRate: graded > 0 ? +((bucket.hits / graded) * 100).toFixed(1) : null,
    insufficientSample: graded < MIN_SAMPLE.breakdown,
  };
}
function classifyOutcome(row) {
  if (!row || row.result == null || row.result === 'pending') return null;
  if (row.result === 'push') return 'push';
  if (row.result === 'win') return 'hit';
  return row.nearMiss ? 'nearMiss' : 'miss';
}

// Tier boundaries mirror the buckets analyze-drp-matchups.mjs (50-54/55-59/
// 60-64/65+) and analyze-hr-matchups.mjs (.../20-21/22-24/25-29/30+) already
// use, collapsed from 4 buckets to 3 so every market's confidence dimension
// reads the same Low/Medium/High vocabulary. K Props has no prior bucketing
// convention to mirror (the calibration script there splits by raw
// projK-vs-line edge, not a named tier), so its boundaries are new here --
// documented plainly rather than silently invented.
function confidenceTier(market, row) {
  if (market === 'drp') {
    if (row.pickPct == null) return null;
    return row.pickPct >= 65 ? 'High' : row.pickPct >= 60 ? 'Medium' : 'Low';
  }
  if (market === 'hrThreat') {
    if (row.score == null) return null;
    return row.score >= 25 ? 'High' : row.score >= 20 ? 'Medium' : 'Low';
  }
  if (market === 'kprop') {
    if (row.projK == null || row.line == null) return null;
    const edge = Math.abs(row.projK - row.line);
    return edge >= 2 ? 'High' : edge >= 1 ? 'Medium' : 'Low';
  }
  return null;
}
const CONFIDENCE_TIERS = ['High', 'Medium', 'Low'];

// DRP is a game-level pick (no single team "owns" it the way a batter/pitcher
// prop does) -- attributed to the team we actually picked to win, since
// that's the meaningful "whose perspective" dimension for a hit-rate-by-team
// view. kprop/hrThreat already carry a real team field on the row.
function teamOf(market, row) {
  return market === 'drp' ? row.pick : (row.team || null);
}

// DRP has no single-player identity (it's a game winner pick), so it's
// excluded from the leaderboard entirely -- only kprop (pitcher) and
// hrThreat (batter) rows carry a real MLB person id.
function playerOf(market, row) {
  if (market === 'hrThreat' && row.playerId != null) return { id: row.playerId, name: row.playerName, team: row.team };
  if (market === 'kprop' && row.pitcherId != null) return { id: row.pitcherId, name: row.pitcherName, team: row.team };
  return null;
}

// Verbatim port of track-record.html's isoWeekKey so the two surfaces bucket
// weeks identically -- a mismatch here would make the same date fall in
// "different weeks" depending which report you're looking at.
function isoWeekKey(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const day = (d.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  d.setUTCDate(d.getUTCDate() - day + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const firstDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
  const week = 1 + Math.round((d - firstThursday) / (7 * 86400000));
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
function monthKey(dateStr) { return dateStr.slice(0, 7); }
function seasonKey(dateStr) { return dateStr.slice(0, 4); }

function daysBefore(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

async function loadNearHRsFile() {
  try {
    const raw = await readFile(NEAR_HRS_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.warn('performance-report: near-hrs.json not readable, Near HR event counts will be 0:', e.message);
    return { players: {} };
  }
}

// Counts real warning-track near-HR events (independent of any pick) whose
// date falls in [start,end] -- "how much real warning-track power happened
// this period" across every tracked batter, not just the ones picked. This
// is what makes the "Near HR" stat a genuine weekly-report metric per the
// acceptance criteria, not just a per-pick tag.
function countNearHREvents(nearHRsData, start, end) {
  let count = 0;
  for (const events of Object.values(nearHRsData.players || {})) {
    if (!Array.isArray(events)) continue;
    for (const e of events) {
      if (e.date >= start && e.date <= end) count++;
    }
  }
  return count;
}

function buildLeaderboard(rowsWithMarket) {
  const byPlayer = new Map(); // id -> { id, name, team, markets:Set, bucket }
  for (const { market, row } of rowsWithMarket) {
    const outcome = classifyOutcome(row);
    if (outcome === null || outcome === 'push') continue;
    const player = playerOf(market, row);
    if (!player) continue;
    const key = String(player.id);
    if (!byPlayer.has(key)) {
      byPlayer.set(key, { id: player.id, name: player.name, team: player.team, markets: new Set(), bucket: emptyBucket() });
    }
    const entry = byPlayer.get(key);
    entry.team = player.team || entry.team; // keep most-recent team on file
    entry.markets.add(market);
    addOutcome(entry.bucket, outcome);
  }
  const overall = Array.from(byPlayer.values())
    .map(e => ({ id: e.id, name: e.name, team: e.team, markets: Array.from(e.markets), ...finalizeBucket(e.bucket) }))
    .filter(e => e.graded >= MIN_SAMPLE.leaderboard)
    .sort((a, b) => b.hitRate - a.hitRate || b.graded - a.graded)
    .slice(0, 25);

  const byMarket = {};
  for (const m of ['hrThreat', 'kprop']) {
    const perPlayer = new Map();
    for (const { market, row } of rowsWithMarket) {
      if (market !== m) continue;
      const outcome = classifyOutcome(row);
      if (outcome === null || outcome === 'push') continue;
      const player = playerOf(market, row);
      if (!player) continue;
      const key = String(player.id);
      if (!perPlayer.has(key)) perPlayer.set(key, { id: player.id, name: player.name, team: player.team, bucket: emptyBucket() });
      const entry = perPlayer.get(key);
      entry.team = player.team || entry.team;
      addOutcome(entry.bucket, outcome);
    }
    byMarket[m] = Array.from(perPlayer.values())
      .map(e => ({ id: e.id, name: e.name, team: e.team, ...finalizeBucket(e.bucket) }))
      .filter(e => e.graded >= MIN_SAMPLE.leaderboard)
      .sort((a, b) => b.hitRate - a.hitRate || b.graded - a.graded)
      .slice(0, 25);
  }
  return { overall, byMarket };
}

function buildPeriod(rowsWithMarket, nearHRsData, range) {
  const byMarket = { drp: emptyBucket(), kprop: emptyBucket(), hrThreat: emptyBucket() };
  const byConfidence = {
    drp: { High: emptyBucket(), Medium: emptyBucket(), Low: emptyBucket() },
    kprop: { High: emptyBucket(), Medium: emptyBucket(), Low: emptyBucket() },
    hrThreat: { High: emptyBucket(), Medium: emptyBucket(), Low: emptyBucket() },
  };
  const byTeam = {};
  const nearHR = { signalWith: emptyBucket(), signalWithout: emptyBucket(), nearMissCount: 0 };
  // Zone Fit calibration -- does the live HR Threats board's "Zone Fit" chip
  // (Elite/Strong/Playable Zone Fit vs Pitcher Zone Edge, snapshotted at pick
  // time by update-tracker.mjs's computeZoneFitServer) actually predict more
  // real HRs? Same real graded hrThreat rows as everything else here, just
  // bucketed by the label already captured on the row instead of re-deriving
  // a score. Rows captured before zoneFitLabel existed are simply absent from
  // every bucket, same convention as every other snapshot field added here
  // over time (see matchupEdge/platoonOps comments in update-tracker.mjs).
  const byZoneFit = Object.fromEntries(ZONE_FIT_TIERS.map(t => [t, emptyBucket()]));
  // Expected-vs-actual HR calibration: real predicted probability (row.score,
  // captured at pick time) summed as an expected-value HR count, vs the real
  // count of picks that actually hit -- both derived straight from already-
  // graded hrThreat rows, no new signal invented. Same expected-value
  // technique analyze-hr-matchups.mjs's avgPredicted column already uses per
  // bucket, just accumulated per period here instead of per score-bucket.
  let hrExpectedSum = 0, hrGradedWithScore = 0, hrActualWithScore = 0;

  for (const { market, row } of rowsWithMarket) {
    const outcome = classifyOutcome(row);
    if (outcome === null) continue; // still pending, not part of any graded view
    addOutcome(byMarket[market], outcome);

    const tier = confidenceTier(market, row);
    if (tier) addOutcome(byConfidence[market][tier], outcome);

    const team = teamOf(market, row);
    if (team) {
      byTeam[team] ||= emptyBucket();
      addOutcome(byTeam[team], outcome);
    }

    if (market === 'hrThreat') {
      addOutcome(row.hasNearHR ? nearHR.signalWith : nearHR.signalWithout, outcome);
      if (outcome === 'nearMiss') nearHR.nearMissCount++;
      if (outcome !== 'push' && Number.isFinite(row.score)) {
        hrExpectedSum += row.score / 100;
        hrGradedWithScore++;
        if (outcome === 'hit') hrActualWithScore++;
      }
      if (row.zoneFitLabel && byZoneFit[row.zoneFitLabel]) addOutcome(byZoneFit[row.zoneFitLabel], outcome);
    }
  }

  return {
    range,
    byMarket: {
      drp: finalizeBucket(byMarket.drp),
      kprop: finalizeBucket(byMarket.kprop),
      hrThreat: finalizeBucket(byMarket.hrThreat),
    },
    byConfidence: Object.fromEntries(MARKETS.map(m => [
      m, Object.fromEntries(CONFIDENCE_TIERS.map(t => [t, finalizeBucket(byConfidence[m][t])])),
    ])),
    byTeam: Object.fromEntries(Object.entries(byTeam).map(([t, b]) => [t, finalizeBucket(b)])),
    leaderboard: buildLeaderboard(rowsWithMarket),
    // "Projected vs Actual Home Runs" -- the same real per-pick predicted
    // probability the model itself generated, summed into an expected count
    // and compared against the real number of those picks that actually hit.
    // n === 0 means no graded hrThreat picks with a real score this period
    // (either nothing graded, or picks captured before the score field
    // existed) -- the client renders that as a gap, never a fabricated 0-0 point.
    hrCalibration: {
      expectedHRs: hrGradedWithScore ? +hrExpectedSum.toFixed(2) : null,
      actualHRs: hrGradedWithScore ? hrActualWithScore : null,
      n: hrGradedWithScore,
    },
    nearHR: {
      realEventCount: countNearHREvents(nearHRsData, range.start, range.end),
      nearMissCount: nearHR.nearMissCount,
      signalPerformance: {
        withSignal: finalizeBucket(nearHR.signalWith),
        withoutSignal: finalizeBucket(nearHR.signalWithout),
      },
    },
    zoneFitCalibration: Object.fromEntries(ZONE_FIT_TIERS.map(t => [t, finalizeBucket(byZoneFit[t])])),
  };
}

async function main() {
  const store = await loadTracker();
  const nearHRsData = await loadNearHRsFile();
  const today = cdtDateString(new Date());

  // Flatten every graded-or-pending row from the 3 live markets into one list
  // tagged with its market, so every grouping below can share the same
  // buildPeriod()/buildLeaderboard() logic instead of 3 near-duplicate passes.
  const allRows = [];
  for (const market of MARKETS) {
    for (const row of store.market[market] || []) {
      if (!row.date) continue;
      allRows.push({ market, row });
    }
  }

  const byDateMap = new Map();
  const byWeekMap = new Map();
  const byMonthMap = new Map();
  const seasonRows = [];
  const dailyFloor = daysBefore(today, 45); // see header comment: daily view is capped to a trailing window, weekly/monthly/season are not

  for (const entry of allRows) {
    const { date } = entry.row;
    if (date >= dailyFloor) {
      if (!byDateMap.has(date)) byDateMap.set(date, []);
      byDateMap.get(date).push(entry);
    }
    const wk = isoWeekKey(date);
    if (!byWeekMap.has(wk)) byWeekMap.set(wk, []);
    byWeekMap.get(wk).push(entry);

    const mo = monthKey(date);
    if (!byMonthMap.has(mo)) byMonthMap.set(mo, []);
    byMonthMap.get(mo).push(entry);

    seasonRows.push(entry);
  }

  const byDate = {};
  for (const [date, rows] of byDateMap) byDate[date] = buildPeriod(rows, nearHRsData, { start: date, end: date });

  const byWeek = {};
  for (const [wk, rows] of byWeekMap) {
    const dates = rows.map(e => e.row.date).sort();
    byWeek[wk] = buildPeriod(rows, nearHRsData, { start: dates[0], end: dates[dates.length - 1] });
  }

  const byMonth = {};
  for (const [mo, rows] of byMonthMap) {
    const dates = rows.map(e => e.row.date).sort();
    byMonth[mo] = buildPeriod(rows, nearHRsData, { start: dates[0], end: dates[dates.length - 1] });
  }

  const seasonDates = seasonRows.map(e => e.row.date).sort();
  const season = seasonKey(today);
  const seasonTotal = seasonRows.length
    ? buildPeriod(seasonRows, nearHRsData, { start: seasonDates[0], end: seasonDates[seasonDates.length - 1] })
    : null;

  const report = {
    generatedAt: new Date().toISOString(),
    asOfDate: today,
    season,
    sampleThresholds: MIN_SAMPLE,
    definitions: DEFINITIONS,
    latestDate: [...byDateMap.keys()].sort().pop() || null,
    byDate,
    byWeek,
    byMonth,
    seasonTotal,
  };

  await writeFile(OUT_PATH, JSON.stringify(report, null, 2) + '\n');
  console.log(`Wrote data/performance-report.json: ${Object.keys(byDate).length} date(s), ${Object.keys(byWeek).length} week(s), ${Object.keys(byMonth).length} month(s), ${seasonRows.length} season row(s) considered.`);
}

main().catch(e => {
  console.error('generate-performance-report.mjs failed:', e);
  process.exit(1);
});

export {
  MIN_SAMPLE, DEFINITIONS, confidenceTier, classifyOutcome, isoWeekKey, monthKey, seasonKey,
  buildPeriod, buildLeaderboard, finalizeBucket, emptyBucket, addOutcome, teamOf, playerOf,
};
