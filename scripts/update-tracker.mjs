#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Diamond Report Tracker updater — the "developer side" grading job the
// site's Tracker system was always meant to have (see the code comment in
// app.js: "Tracker linkage will stay on the developer side later").
//
// Runs once daily, before first pitch, and does two things in one pass:
//
//   1. CAPTURE — for TODAY's games, independently re-derives the Diamond
//      Report Pick (game winner), K Props (strikeout over/under), and the
//      Premium tab's Elite Picks (top 5 per market across Hits/RBI/Total
//      Bases/Stolen Bases/HR/Hits+Runs+RBI, cross-market deduped) using
//      only data available *before* the games start, and stores them as
//      "pending" picks. This has to happen pre-game — season stats fetched
//      *after* a game already include that game's own result, which would
//      silently make every backtest look artificially accurate (lookahead
//      bias). Capturing pre-game and grading later is the only honest way
//      to measure this.
//
//   2. GRADE — for any *earlier* day's picks still marked "pending", fetches
//      the real final results and resolves them to win/loss/push.
//
// Zero npm dependencies (uses Node's built-in fetch), so no package.json /
// npm install step is needed in CI.
//
// Known simplifications vs. the live client-side models:
//   - Diamond Report Pick: no weather factor (the live model gives it a
//     small, largely symmetric nudge).
//   - K Props: no independent server-side sportsbook feed, so it grades
//     against the model's own fallback line (floor(projK) - 0.5), same as
//     the client falls back to when no real book line has loaded.
//   - Elite Picks: no Statcast hot-hitter sync data available server-side,
//     so the "recent hot form" quality-gate signal uses a real,
//     independently-computable proxy (last-10-game AVG meaningfully above
//     season AVG, or a HR in the last 10 games) instead of the site's
//     onFireScore/hotBoostPct. Official starting lineups also often aren't
//     posted yet this early in the day — when a game's real lineup isn't up
//     yet, batter candidates fall back to the team's active roster position
//     players (same fallback tier HR Threats itself uses pre-lineup), and
//     lineup-slot-dependent signals are simply left at their unknown-slot
//     defaults rather than guessed.
// All noted so nobody mistakes this for a 1:1 replay of the live site's
// exact numbers — it's an independent, real, but slightly simpler model.
// ─────────────────────────────────────────────────────────────────────────

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRACKER_PATH = path.join(__dirname, '..', 'data', 'tracker.json');
const API = 'https://statsapi.mlb.com/api/v1';

const PARK_FACTORS = {
  COL:145,CIN:112,TEX:108,PHI:107,BOS:106,NYY:105,MIL:104,CWS:103,
  ATL:102,LAD:101,MIN:101,CHC:100,KC:100,DET:99,SEA:99,STL:98,
  SD:98,NYM:97,BAL:97,CLE:96,PIT:96,MIA:95,HOU:95,LAA:94,
  SF:93,WSH:93,OAK:92,TOR:91,TB:91,ARI:90,ATH:92,
};

function n(v, fallback = 0) {
  const num = Number(v);
  return Number.isFinite(num) ? num : fallback;
}

function cdtDateString(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

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

function emptyTracker() {
  return {
    version: 1,
    generatedAt: null,
    market: { drp: [], kprop: [], premium: [] },
    allTime: {
      drp: { wins: 0, losses: 0, pushes: 0, total: 0 },
      kprop: { wins: 0, losses: 0, pushes: 0, total: 0 },
      premium: { wins: 0, losses: 0, pushes: 0, total: 0 },
    },
  };
}

async function loadTracker() {
  try {
    const raw = await readFile(TRACKER_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const empty = emptyTracker();
    parsed.market ||= {};
    parsed.market.drp ||= [];
    parsed.market.kprop ||= [];
    parsed.market.premium ||= [];
    parsed.allTime ||= {};
    parsed.allTime.drp ||= { ...empty.allTime.drp };
    parsed.allTime.kprop ||= { ...empty.allTime.kprop };
    parsed.allTime.premium ||= { ...empty.allTime.premium };
    return parsed;
  } catch (e) {
    return emptyTracker();
  }
}

async function saveTracker(store) {
  store.generatedAt = new Date().toISOString();
  await mkdir(path.dirname(TRACKER_PATH), { recursive: true });
  await writeFile(TRACKER_PATH, JSON.stringify(store, null, 2) + '\n');
}

function recomputeAllTime(store) {
  for (const marketKey of ['drp', 'kprop', 'premium']) {
    const rows = (store.market[marketKey] || []).filter(r => r.result === 'win' || r.result === 'loss' || r.result === 'push');
    store.allTime[marketKey] = {
      wins: rows.filter(r => r.result === 'win').length,
      losses: rows.filter(r => r.result === 'loss').length,
      pushes: rows.filter(r => r.result === 'push').length,
      total: rows.length,
    };
  }
}

// ── Recent-form blend — same shape as app.js's recentPitchingForm/blendRecentForm ──
async function recentPitchingForm(pid, season, starts = 5) {
  try {
    const d = await fetchJSON(`${API}/people/${pid}/stats?stats=lastXGames&group=pitching&season=${season}&limit=${starts}&gameType=R`);
    const splits = d?.stats?.[0]?.splits || [];
    if (!splits.length) return null;
    let ip = 0, er = 0, bb = 0, h = 0, k = 0;
    splits.forEach(s => {
      const st = s.stat || {};
      ip += parseFloat(st.inningsPitched) || 0;
      er += parseInt(st.earnedRuns) || 0;
      bb += parseInt(st.baseOnBalls) || 0;
      h += parseInt(st.hits) || 0;
      k += parseInt(st.strikeOuts) || 0;
    });
    if (ip <= 0) return null;
    return { ip, era: (er * 9) / ip, whip: (bb + h) / ip, k9: (k * 9) / ip };
  } catch (e) {
    return null;
  }
}
function blendRecentForm(seasonVal, recent, key) {
  if (!recent || !Number.isFinite(recent[key]) || !(recent.ip > 0)) return seasonVal;
  const weight = Math.max(0, Math.min(0.5, recent.ip / 25));
  return seasonVal * (1 - weight) + recent[key] * weight;
}

async function seasonPitchingStat(pid, season) {
  try {
    const d = await fetchJSON(`${API}/people/${pid}?hydrate=stats(group=pitching,type=season,season=${season})`);
    return d?.people?.[0]?.stats?.[0]?.splits?.[0]?.stat || {};
  } catch (e) {
    return {};
  }
}

// ── Diamond Report Pick model (ported from loadGameProps in app.js, minus weather) ──
async function computeDRPick(g, season) {
  const awayAbbr = g.teams.away.team.abbreviation;
  const homeAbbr = g.teams.home.team.abbreviation;
  const awayP = g.teams.away.probablePitcher;
  const homeP = g.teams.home.probablePitcher;
  if (!awayP || !homeP) return null;

  const [awayStats, homeStats, awayRecent, homeRecent] = await Promise.all([
    seasonPitchingStat(awayP.id, season),
    seasonPitchingStat(homeP.id, season),
    recentPitchingForm(awayP.id, season),
    recentPitchingForm(homeP.id, season),
  ]);

  let awayScore = 50, homeScore = 50;

  const awayERA = blendRecentForm(n(awayStats.era, 4.5), awayRecent, 'era');
  const homeERA = blendRecentForm(n(homeStats.era, 4.5), homeRecent, 'era');
  const eraDiff = awayERA - homeERA;
  if (Math.abs(eraDiff) > 0.3) {
    if (eraDiff > 0) homeScore += Math.min(eraDiff * 3, 8);
    else awayScore += Math.min(Math.abs(eraDiff) * 3, 8);
  }

  const awayWHIP = blendRecentForm(n(awayStats.whip, 1.3), awayRecent, 'whip');
  const homeWHIP = blendRecentForm(n(homeStats.whip, 1.3), homeRecent, 'whip');
  if (Math.abs(awayWHIP - homeWHIP) > 0.1) {
    if (awayWHIP > homeWHIP) homeScore += 4;
    else awayScore += 4;
  }

  const awayK9 = blendRecentForm(n(awayStats.strikeoutsPer9Inn, 8), awayRecent, 'k9');
  const homeK9 = blendRecentForm(n(homeStats.strikeoutsPer9Inn, 8), homeRecent, 'k9');
  if (homeK9 > awayK9 + 1) homeScore += 3;
  else if (awayK9 > homeK9 + 1) awayScore += 3;

  const awayRecord = g.teams.away.leagueRecord || {};
  const homeRecord = g.teams.home.leagueRecord || {};
  const awayW = n(awayRecord.wins), awayL = n(awayRecord.losses);
  const homeW = n(homeRecord.wins), homeL = n(homeRecord.losses);
  if ((awayW + awayL) >= 10 && (homeW + homeL) >= 10) {
    const recordDiff = (awayW / (awayW + awayL)) - (homeW / (homeW + homeL));
    const recordPts = Math.max(-18, Math.min(18, recordDiff * 60));
    if (recordPts >= 1) awayScore += recordPts;
    else if (recordPts <= -1) homeScore += Math.abs(recordPts);
  }

  const gameHourCT = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/Chicago' }).format(new Date(g.gameDate)));
  if (gameHourCT < 17) homeScore += 2;
  homeScore += 3; // home field edge

  const total = awayScore + homeScore;
  const awayPct = Math.round((awayScore / total) * 100);
  const homePct = 100 - awayPct;
  const winner = awayPct > homePct ? awayAbbr : homeAbbr;
  const winnerPct = awayPct > homePct ? awayPct : homePct;

  return {
    key: `${cdtDateString(new Date(g.gameDate))}|DRP|${[awayAbbr, homeAbbr].sort().join('-')}`,
    date: cdtDateString(new Date(g.gameDate)),
    gamePk: g.gamePk,
    awayTeam: awayAbbr,
    homeTeam: homeAbbr,
    pick: winner,
    pickPct: winnerPct,
    result: 'pending',
    actualWinner: null,
  };
}

// ── K Props model (ported from buildRow in app.js) ──
async function computeKProp(g, side, season) {
  const opp = side === 'away' ? 'home' : 'away';
  const pitcher = g.teams[side].probablePitcher;
  if (!pitcher) return null;

  const stat = await seasonPitchingStat(pitcher.id, season);
  const recent = await recentPitchingForm(pitcher.id, season);
  const k9 = blendRecentForm(n(stat.strikeoutsPer9Inn, 8), recent, 'k9');
  const ip = n(stat.inningsPitched, 0);
  const gs = n(stat.gamesStarted, 0) || Math.max(n(stat.wins) + n(stat.losses), 1);
  const projIP = ip > 0 ? Math.min(Math.max(ip / Math.max(gs, 1), 4), 7) : 5.4;

  // Real opposing-lineup K rate when the boxscore has posted batters pre-game; falls
  // back to the 22% league average (same fallback the live site uses) when it hasn't.
  let oppKpct = 0.22;
  try {
    const bd = await fetchJSON(`${API}/game/${g.gamePk}/boxscore`);
    const teamBox = bd?.teams?.[opp];
    const oppBatters = (teamBox?.batters || []).map(id => teamBox.players?.['ID' + id]).filter(Boolean).slice(0, 9);
    const kpcts = oppBatters.map(b => {
      const s = b?.seasonStats?.batting || {};
      return (s.strikeOuts && s.plateAppearances) ? s.strikeOuts / s.plateAppearances : 0.22;
    });
    if (kpcts.length) oppKpct = kpcts.reduce((a, b) => a + b, 0) / kpcts.length;
  } catch (e) {}

  const projK = Math.max(1, (k9 * projIP / 9) + ((oppKpct - 0.22) * 10));
  // No independent server-side sportsbook feed, so this grades against the same
  // model-derived fallback line the client uses when no real book line has loaded.
  const line = Math.max(0.5, Math.floor(projK) - 0.5);

  return {
    key: `${cdtDateString(new Date(g.gameDate))}|KPROP|${String(pitcher.fullName || '').toLowerCase()}`,
    date: cdtDateString(new Date(g.gameDate)),
    gamePk: g.gamePk,
    pitcherId: pitcher.id,
    pitcherName: pitcher.fullName,
    team: g.teams[side].team.abbreviation,
    opp: g.teams[opp].team.abbreviation,
    projK: Math.round(projK * 10) / 10,
    line,
    pick: 'OVER',
    result: 'pending',
    finalK: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Premium Elite Picks — server-side port of the client's cross-market
// Monte Carlo engine + selection algorithm (app.js: the __DR_MONTE_CARLO__
// IIFE and the Premium: Elite Picks IIFE). Ported as closely as possible;
// two real simplifications, both noted where they apply below:
//   - No Statcast hot-hitter sync data available server-side, so the
//     "recent hot form" signal uses a real, independently-computable proxy
//     (last-10-game AVG trending meaningfully above season AVG, or a HR in
//     the last 10 games) instead of the site's onFireScore/hotBoostPct.
//   - Official starting lineups often aren't posted yet this early in the
//     day. When a game's real lineup isn't up yet, this falls back to the
//     team's active roster position players (deterministically sorted) —
//     same fallback tier the live HR Threats board itself uses before
//     lineups post. battingOrder-dependent signals (PA estimate, lineup
//     slot quality point) are simply left at their unknown-slot defaults
//     for those players rather than guessed.
// ─────────────────────────────────────────────────────────────────────────

const ELITE_MARKETS = ['hr', 'hits', 'rbis', 'tb', 'sb', 'hrrbi'];
const MC_TRIALS = 3000;
const MC_AB_PER_PA = 0.88;
const ELITE_MIN_AB = 40;
const ELITE_MIN_QUALITY = 2;
const ELITE_CANDIDATE_DEPTH = 25;
const ELITE_TOP_N = 5;
const LEAGUE_AVG_AVG = 0.245, LEAGUE_AVG_OBP = 0.315, LEAGUE_AVG_SLG = 0.400, LEAGUE_AVG_HR_RATE = 0.031;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function shrinkToLeague(raw, ab, leagueAvg, minAB = 40) {
  const w = Math.min(ab, minAB) / minAB;
  return raw * w + leagueAvg * (1 - w);
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function estimatePA(battingOrder) {
  if (!battingOrder) return 4.2;
  return clamp(4.75 - (battingOrder - 1) * 0.11, 3.6, 4.75);
}

function buildBatterModel(row) {
  const avg = clamp(row.avg ?? 0.245, 0.12, 0.4);
  const obp = clamp(row.obp ?? avg + 0.065, avg, 0.5);
  const slg = clamp(row.slg ?? avg + 0.155, avg, 0.8);
  const pHit = avg * MC_AB_PER_PA;
  const pWalk = Math.max(0, obp - pHit);
  const seasonAB = row.atBats || 0;
  const seasonHR = row.hrSeason || 0;
  const hrRatePerPA = seasonAB > 0 ? (seasonHR / seasonAB) * MC_AB_PER_PA : pHit * 0.11;
  const pHR = clamp(hrRatePerPA, 0, pHit * 0.55);
  const hitBudget = Math.max(0, pHit - pHR);
  const extraBaseBudget = Math.max(0, (slg - avg) * MC_AB_PER_PA - pHR * 3);
  const p3B = hitBudget * 0.025;
  const p2B = clamp(extraBaseBudget - p3B * 2, 0, hitBudget - p3B);
  const p1B = Math.max(0, hitBudget - p2B - p3B);
  const pOut = Math.max(0, 1 - pHit - pWalk);
  return { pOut, pWalk, p1B, p2B, p3B, pHR };
}

function simulateGame(model, pa) {
  let hits = 0, tb = 0, hr = 0;
  for (let i = 0; i < pa; i++) {
    const r = Math.random();
    let c = model.pOut;
    if (r < c) continue;
    c += model.pWalk; if (r < c) continue;
    c += model.p1B; if (r < c) { hits++; tb += 1; continue; }
    c += model.p2B; if (r < c) { hits++; tb += 2; continue; }
    c += model.p3B; if (r < c) { hits++; tb += 3; continue; }
    hits++; tb += 4; hr++;
  }
  return { hits, tb, hr };
}

function estimateRBIRatePerPA(row, model) {
  const slotFactor = ({ 2: 1.15, 3: 1.55, 4: 1.70, 5: 1.40, 6: 1.10 })[row.battingOrder] || 0.85;
  const base = model.pHR * 1.35 + (model.p2B + model.p3B) * 0.55 + model.p1B * 0.16 + model.pOut * 0.05;
  return clamp(base * slotFactor, 0.02, 0.42);
}
function estimateRunRatePerPA(row, model) {
  const slotFactor = ({ 1: 1.35, 2: 1.25, 3: 1.15, 4: 1.05, 5: 1.0 })[row.battingOrder] || 0.85;
  return clamp((model.pWalk + model.p1B + model.p2B + model.p3B + model.pHR) * 0.42 * slotFactor, 0.02, 0.45);
}
function poissonSample(lambda) {
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= Math.random(); } while (p > L);
  return k - 1;
}

function simulatePropOdds(marketType, row) {
  const model = buildBatterModel(row);
  const pa = estimatePA(row.battingOrder);
  const rbiRate = estimateRBIRatePerPA(row, model);
  const runRate = estimateRunRatePerPA(row, model);
  let successes = 0;
  for (let t = 0; t < MC_TRIALS; t++) {
    const gamePA = Math.max(1, Math.round(pa + (Math.random() - 0.5) * 1.6));
    const g = simulateGame(model, gamePA);
    let success = false;
    if (marketType === 'hits') success = g.hits >= 1;
    else if (marketType === 'tb') success = g.tb >= 2;
    else if (marketType === 'hr') success = g.hr >= 1;
    else if (marketType === 'rbis' || marketType === 'hrrbi') {
      let rbi = 0, runs = 0;
      for (let i = 0; i < gamePA; i++) {
        if (Math.random() < rbiRate) rbi++;
        if (Math.random() < runRate) runs++;
      }
      success = marketType === 'rbis' ? rbi >= 1 : (g.hits + runs + rbi) >= 2;
    }
    if (success) successes++;
  }
  return Math.max(1, Math.min(99, Math.round((successes / MC_TRIALS) * 100)));
}

function simulateSBOdds(row) {
  const sb = row.stolenBases || 0, cs = row.caughtStealing || 0;
  const att = sb + cs;
  const successRate = att >= 5 ? sb / att : (sb > 0 ? 0.70 : 0.60);
  const seasonAB = row.atBats || 0;
  const gamesPlayed = seasonAB > 0 ? Math.max(1, seasonAB / 3.8) : 1;
  const sbPerGame = seasonAB > 0 ? (sb / gamesPlayed) : 0;
  const pAtt = (row.pitcherSbAllowed || 0) + (row.pitcherCsAllowed || 0);
  const batterySuppression = pAtt >= 5 ? clamp(1 - ((row.pitcherSbAllowed / pAtt) - 0.72) * 0.6, 0.7, 1.3) : 1;
  const lambda = clamp(sbPerGame * batterySuppression, 0.01, 1.2);
  let successes = 0;
  for (let t = 0; t < MC_TRIALS; t++) {
    const attempts = poissonSample(lambda);
    let stolen = 0;
    for (let i = 0; i < attempts; i++) if (Math.random() < successRate) stolen++;
    if (stolen >= 1) successes++;
  }
  return Math.max(1, Math.min(99, Math.round((successes / MC_TRIALS) * 100)));
}

function simulateHRGameOdds(pPerPA, battingOrder) {
  pPerPA = clamp(pPerPA || 0.03, 0, 0.5);
  const pa = estimatePA(battingOrder);
  let successes = 0;
  for (let t = 0; t < MC_TRIALS; t++) {
    const gamePA = Math.max(1, Math.round(pa + (Math.random() - 0.5) * 1.6));
    let hit = false;
    for (let i = 0; i < gamePA; i++) { if (Math.random() < pPerPA) { hit = true; break; } }
    if (hit) { successes++; }
  }
  return Math.min(Math.round((successes / MC_TRIALS) * 100), 25);
}

function scoreForMarket(marketKey, row) {
  if (marketKey === 'hr') {
    const batterRate = row.atBats > 0 ? row.hrSeason / row.atBats : LEAGUE_AVG_HR_RATE;
    const pitcherRate = row.pitcherHr9 > 0 ? row.pitcherHr9 / 27 : 0.03;
    const hrPerPA = batterRate * 0.6 + pitcherRate * 0.4;
    return simulateHRGameOdds(hrPerPA, row.battingOrder);
  }
  if (marketKey === 'sb') return simulateSBOdds(row);
  return simulatePropOdds(marketKey, row);
}

function eliteQualityScore(marketKey, row) {
  let score = 0;
  if (row.isFavorable) score++;
  if (row.isHot) score++;
  if (row.battingOrder && row.battingOrder >= 1 && row.battingOrder <= 5) score++;
  if (marketKey === 'sb') {
    if ((row.stolenBases + row.caughtStealing) >= 5) score++;
  } else if (marketKey === 'hr') {
    if (row.iso >= 0.180 || row.hrSeason >= 15) score++;
  } else {
    if (row.ops >= 0.780 || row.iso >= 0.180) score++;
  }
  return score;
}

// ── Building today's batter candidate pool ──
async function seasonBattingStat(pid, season) {
  try {
    const d = await fetchJSON(`${API}/people/${pid}?hydrate=stats(group=hitting,type=season,season=${season})`);
    return d?.people?.[0]?.stats?.[0]?.splits?.[0]?.stat || {};
  } catch (e) { return {}; }
}
async function recentBattingForm(pid, season, games = 10) {
  try {
    const d = await fetchJSON(`${API}/people/${pid}/stats?stats=lastXGames&group=hitting&season=${season}&limit=${games}&gameType=R`);
    const splits = d?.stats?.[0]?.splits || [];
    if (!splits.length) return null;
    let ab = 0, h = 0, hr = 0;
    splits.forEach(s => {
      const st = s.stat || {};
      ab += n(st.atBats); h += n(st.hits); hr += n(st.homeRuns);
    });
    return { ab, avg: ab > 0 ? h / ab : null, hr };
  } catch (e) { return null; }
}

async function battersForSide(g, side) {
  try {
    const bd = await fetchJSON(`${API}/game/${g.gamePk}/boxscore`);
    const teamBox = bd?.teams?.[side];
    let batters = (teamBox?.batters || [])
      .map(id => { const p = teamBox.players?.['ID' + id]; return p ? { id, player: p, fromLineup: true } : null; })
      .filter(Boolean);
    if (batters.length) {
      const starters = batters.filter(b => {
        const bo = Number(b.player?.battingOrder ?? NaN);
        return Number.isFinite(bo) && bo % 100 === 0;
      });
      if (starters.length) return starters;
    }
  } catch (e) {}

  // Lineup not posted yet — fall back to the team's active roster position players,
  // same tier the live HR Threats board falls back to pre-lineup.
  try {
    const teamId = g.teams[side].team.id;
    const d = await fetchJSON(`${API}/teams/${teamId}/roster?rosterType=active`);
    return (d?.roster || [])
      .filter(p => p.position?.abbreviation !== 'P')
      .sort((a, b) => (a.person?.id || 0) - (b.person?.id || 0))
      .slice(0, 9)
      .map(p => ({ id: p.person.id, player: { person: p.person, position: p.position }, fromLineup: false }));
  } catch (e) { return []; }
}

async function buildEliteBatterPool(games, season) {
  const rows = [];
  for (const g of games) {
    for (const [side, opp] of [['away', 'home'], ['home', 'away']]) {
      const pitcher = g.teams[opp].probablePitcher;
      if (!pitcher) continue;
      const pitcherStat = await seasonPitchingStat(pitcher.id, season);
      const teamAbbr = g.teams[side].team.abbreviation;
      const oppAbbr = g.teams[opp].team.abbreviation;
      const batters = await battersForSide(g, side);

      const sideRows = await mapLimit(batters, 6, async (b) => {
        const pid = b.id;
        const person = b.player?.person;
        if (!pid || !person?.fullName) return null;
        const [stat, recent] = await Promise.all([
          seasonBattingStat(pid, season),
          recentBattingForm(pid, season),
        ]);
        const ab = n(stat.atBats);
        const avg = shrinkToLeague(n(stat.avg), ab, LEAGUE_AVG_AVG, ELITE_MIN_AB);
        const obp = shrinkToLeague(n(stat.obp, avg + 0.065), ab, LEAGUE_AVG_OBP, ELITE_MIN_AB);
        const slg = shrinkToLeague(n(stat.slg, avg + 0.155), ab, LEAGUE_AVG_SLG, ELITE_MIN_AB);
        const ops = n(stat.ops, avg + obp);
        const iso = Math.max(0, slg - avg);
        const hrSeason = n(stat.homeRuns);
        const battingOrderRaw = b.fromLineup ? Number(b.player?.battingOrder) : NaN;
        const battingOrder = Number.isFinite(battingOrderRaw) ? Math.max(1, Math.min(9, Math.floor(battingOrderRaw / 100))) : null;
        const batterOPS = n(stat.ops);
        const pitcherWhip = n(pitcherStat.whip, 1.25);
        const pitcherAvgAllowed = n(pitcherStat.avg, 0.24);
        const isFavorable = batterOPS >= 0.800 && (pitcherWhip >= 1.25 || pitcherAvgAllowed >= 0.260);
        // Real, independently-computable "hot" proxy (no Statcast sync available
        // server-side): recent AVG meaningfully above season AVG, or a HR within the
        // last 10 games.
        const isHot = !!recent && recent.ab >= 15 && ((recent.avg != null && recent.avg >= avg + 0.030) || recent.hr >= 1);
        return {
          id: pid, name: person.fullName, teamAbbr, oppAbbr,
          avg, obp, slg, ops, iso, hrSeason, battingOrder,
          atBats: ab, stolenBases: n(stat.stolenBases), caughtStealing: n(stat.caughtStealing),
          pitcherHr9: n(pitcherStat.homeRunsPer9), pitcherSbAllowed: n(pitcherStat.stolenBases), pitcherCsAllowed: n(pitcherStat.caughtStealing),
          isFavorable, isHot,
        };
      });
      sideRows.filter(Boolean).forEach(r => rows.push(r));
    }
  }
  return rows;
}

function buildEliteRankedLists(pool) {
  const eligible = pool.filter(r => r.atBats >= ELITE_MIN_AB);
  const ranked = {};
  ELITE_MARKETS.forEach(m => {
    ranked[m] = eligible
      .map(row => ({ row, score: scoreForMarket(m, row), quality: eliteQualityScore(m, row) }))
      .filter(x => x.score > 0 && x.quality >= ELITE_MIN_QUALITY)
      .sort((a, b) => b.score - a.score)
      .slice(0, ELITE_CANDIDATE_DEPTH);
  });
  return ranked;
}

function assignEliteBestMarket(ranked) {
  const bestRank = {};
  ELITE_MARKETS.forEach(m => {
    ranked[m].forEach((entry, idx) => {
      const pid = entry.row.id;
      if (!bestRank[pid] || idx < bestRank[pid].rank) bestRank[pid] = { market: m, rank: idx };
    });
  });
  return bestRank;
}

function buildEliteLists(pool) {
  const ranked = buildEliteRankedLists(pool);
  const bestMarket = assignEliteBestMarket(ranked);
  const out = {};
  ELITE_MARKETS.forEach(m => {
    const picks = [];
    ranked[m].forEach(entry => {
      if (picks.length >= ELITE_TOP_N) return;
      const pid = entry.row.id;
      if (bestMarket[pid] && bestMarket[pid].market === m) picks.push(entry);
    });
    out[m] = picks;
  });
  return out;
}

async function captureEliteToday(store, previewGames, season) {
  store.market.premium ||= [];
  if (!previewGames.length) return 0;
  const pool = await buildEliteBatterPool(previewGames, season);
  const lists = buildEliteLists(pool);
  const today = cdtDateString(new Date());
  let added = 0;

  ELITE_MARKETS.forEach(m => {
    (lists[m] || []).forEach((entry, rank) => {
      const r = entry.row;
      const key = `${today}|PREMIUM|${m}|${r.id}`;
      if (store.market.premium.some(x => x.key === key)) return;
      store.market.premium.push({
        key, date: today, market: m, rank: rank + 1,
        playerId: r.id, playerName: r.name, team: r.teamAbbr, opp: r.oppAbbr,
        gamePk: previewGames.find(g => g.teams.away.team.abbreviation === r.teamAbbr || g.teams.home.team.abbreviation === r.teamAbbr)?.gamePk ?? null,
        score: entry.score, quality: entry.quality,
        result: 'pending', actual: null,
      });
      added++;
    });
  });
  return added;
}

// Real per-market "hit" definitions — same success conditions the client-side Monte
// Carlo engine targets (g.hits>=1, g.tb>=2, g.hr>=1, rbi>=1, hits+runs+rbi>=2, sb>=1).
function eliteHit(marketKey, box) {
  if (marketKey === 'hits') return box.hits >= 1;
  if (marketKey === 'tb') return box.totalBases >= 2;
  if (marketKey === 'hr') return box.homeRuns >= 1;
  if (marketKey === 'rbis') return box.rbi >= 1;
  if (marketKey === 'sb') return box.stolenBases >= 1;
  if (marketKey === 'hrrbi') return (box.hits + box.runs + box.rbi) >= 2;
  return false;
}

async function gradeElitePending(store) {
  store.market.premium ||= [];
  const today = cdtDateString(new Date());
  const pending = store.market.premium.filter(r => r.result === 'pending' && r.date < today);
  if (!pending.length) return 0;

  const byGame = {};
  pending.forEach(r => { (byGame[r.gamePk] ||= []).push(r); });
  let graded = 0;

  for (const [gamePk, recs] of Object.entries(byGame)) {
    if (gamePk === 'null') continue;
    let box;
    try {
      box = await fetchJSON(`${API}/game/${gamePk}/boxscore`);
    } catch (e) {
      console.warn(`Elite grading: boxscore fetch failed for gamePk ${gamePk}:`, e.message);
      continue;
    }
    // Only grade once the game is actually final — a boxscore can exist mid-game too.
    let isFinal = false;
    try {
      const liveGame = await fetchJSON(`${API}/schedule?sportId=1&date=${recs[0].date}&hydrate=team`);
      const g = (liveGame?.dates?.[0]?.games || []).find(x => String(x.gamePk) === String(gamePk));
      isFinal = g?.status?.abstractGameState === 'Final';
    } catch (e) {}
    if (!isFinal) continue;

    const allPlayers = { ...(box?.teams?.away?.players || {}), ...(box?.teams?.home?.players || {}) };
    for (const rec of recs) {
      const p = allPlayers['ID' + rec.playerId];
      const bat = p?.stats?.batting;
      if (!bat) continue;
      const line = {
        hits: n(bat.hits), totalBases: n(bat.totalBases), homeRuns: n(bat.homeRuns),
        rbi: n(bat.rbi), runs: n(bat.runs), stolenBases: n(bat.stolenBases),
      };
      rec.actual = line;
      rec.result = eliteHit(rec.market, line) ? 'win' : 'loss';
      graded++;
    }
  }
  return graded;
}

async function captureToday(store) {
  const today = cdtDateString(new Date());
  const sched = await fetchJSON(`${API}/schedule?sportId=1&date=${today}&hydrate=team,probablePitcher,linescore`);
  const games = sched?.dates?.find(d => d.date === today)?.games || [];
  const season = today.slice(0, 4);
  const previewGames = games.filter(g => g.status?.abstractGameState === 'Preview');
  let added = 0;

  for (const g of previewGames) {
    const gameDay = cdtDateString(new Date(g.gameDate));
    const drpKey = `${gameDay}|DRP|${[g.teams.away.team.abbreviation, g.teams.home.team.abbreviation].sort().join('-')}`;
    // Check-before-compute: this script runs more than once a day (see the afternoon
    // Elite Picks pass below), and DRP/K Props are already fully captured on the first
    // pass — skip the expensive model recompute entirely instead of doing the work and
    // discarding it as a duplicate.
    if (!store.market.drp.some(r => r.key === drpKey)) {
      try {
        const drp = await computeDRPick(g, season);
        if (drp) { store.market.drp.push(drp); added++; }
      } catch (e) {
        console.warn(`DRP capture failed for gamePk ${g.gamePk}:`, e.message);
      }
    }

    for (const side of ['away', 'home']) {
      const pitcher = g.teams[side].probablePitcher;
      if (!pitcher) continue;
      const kpKey = `${gameDay}|KPROP|${String(pitcher.fullName || '').toLowerCase()}`;
      if (store.market.kprop.some(r => r.key === kpKey)) continue;
      try {
        const kp = await computeKProp(g, side, season);
        if (kp) { store.market.kprop.push(kp); added++; }
      } catch (e) {
        console.warn(`K Props capture failed for gamePk ${g.gamePk}/${side}:`, e.message);
      }
    }
  }
  console.log(`Captured ${added} new pending DRP/K Props pick(s) for ${today}.`);

  const eliteAdded = await captureEliteToday(store, previewGames, season);
  console.log(`Captured ${eliteAdded} new pending Elite Pick(s) for ${today}.`);
}

async function gradePending(store) {
  const today = cdtDateString(new Date());
  const pendingDrp = store.market.drp.filter(r => r.result === 'pending' && r.date < today);
  const pendingKprop = store.market.kprop.filter(r => r.result === 'pending' && r.date < today);
  if (!pendingDrp.length && !pendingKprop.length) {
    console.log('No pending picks from prior days to grade.');
    return;
  }

  // Group by date so each day's schedule is only fetched once.
  const dates = [...new Set([...pendingDrp.map(r => r.date), ...pendingKprop.map(r => r.date)])];
  let graded = 0;

  for (const date of dates) {
    let games = [];
    try {
      const sched = await fetchJSON(`${API}/schedule?sportId=1&date=${date}&hydrate=team,probablePitcher,linescore`);
      games = sched?.dates?.find(d => d.date === date)?.games || [];
    } catch (e) {
      console.warn(`Schedule fetch failed for ${date}:`, e.message);
      continue;
    }
    const gamesByPk = Object.fromEntries(games.map(g => [g.gamePk, g]));

    for (const rec of pendingDrp.filter(r => r.date === date)) {
      const g = gamesByPk[rec.gamePk];
      if (!g || g.status?.abstractGameState !== 'Final') continue;
      const awayScore = n(g.teams?.away?.score, NaN);
      const homeScore = n(g.teams?.home?.score, NaN);
      if (!Number.isFinite(awayScore) || !Number.isFinite(homeScore)) continue;
      const actualWinner = awayScore === homeScore ? 'TIE' : (awayScore > homeScore ? rec.awayTeam : rec.homeTeam);
      rec.actualWinner = actualWinner;
      rec.result = actualWinner === 'TIE' ? 'push' : (actualWinner === rec.pick ? 'win' : 'loss');
      graded++;
    }

    for (const rec of pendingKprop.filter(r => r.date === date)) {
      const g = gamesByPk[rec.gamePk];
      if (!g || g.status?.abstractGameState !== 'Final') continue;
      let finalK = null;
      try {
        const box = await fetchJSON(`${API}/game/${rec.gamePk}/boxscore`);
        const teamKey = rec.team && g.teams?.away?.team?.abbreviation === rec.team ? 'away' : 'home';
        const players = box?.teams?.[teamKey]?.players || {};
        const p = players['ID' + rec.pitcherId];
        finalK = n(p?.stats?.pitching?.strikeOuts, NaN);
      } catch (e) {
        console.warn(`Boxscore fetch failed for gamePk ${rec.gamePk}:`, e.message);
      }
      if (!Number.isFinite(finalK)) continue;
      rec.finalK = finalK;
      rec.result = finalK === rec.line ? 'push' : (finalK > rec.line ? 'win' : 'loss');
      graded++;
    }
  }
  console.log(`Graded ${graded} pick(s).`);

  const eliteGraded = await gradeElitePending(store);
  console.log(`Graded ${eliteGraded} Elite Pick(s).`);
}

async function main() {
  const store = await loadTracker();
  await gradePending(store);
  await captureToday(store);
  recomputeAllTime(store);
  await saveTracker(store);
  console.log('tracker.json updated:', TRACKER_PATH);
  console.log('All-time:', JSON.stringify(store.allTime));
}

// Only auto-run when executed directly (`node update-tracker.mjs`) — importing this
// module (e.g. from a test harness that mocks fetch) must not trigger a live run.
const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main().catch(e => {
    console.error('update-tracker failed:', e);
    process.exit(1);
  });
}

export {
  loadTracker, saveTracker, recomputeAllTime, recentPitchingForm, blendRecentForm,
  seasonPitchingStat, computeDRPick, computeKProp, captureToday, gradePending, main,
  cdtDateString, emptyTracker,
  buildEliteBatterPool, buildEliteLists, captureEliteToday, gradeElitePending,
  simulatePropOdds, simulateSBOdds, simulateHRGameOdds, scoreForMarket, eliteQualityScore,
  eliteHit,
};
