#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Diamond Report Tracker updater — the "developer side" grading job the
// site's Tracker system was always meant to have (see the code comment in
// app.js: "Tracker linkage will stay on the developer side later").
//
// Runs once daily, before first pitch, and does two things in one pass:
//
//   1. CAPTURE — for TODAY's games, independently re-derives the Diamond
//      Report Pick (game winner) and K Props (strikeout over/under) models
//      using only data available *before* the games start, and stores them
//      as "pending" picks. This has to happen pre-game — season stats
//      fetched *after* a game already include that game's own result, which
//      would silently make every backtest look artificially accurate
//      (lookahead bias). Capturing pre-game and grading later is the only
//      honest way to measure this.
//
//   2. GRADE — for any *earlier* day's picks still marked "pending", fetches
//      the real final results and resolves them to win/loss/push.
//
// Zero npm dependencies (uses Node's built-in fetch), so no package.json /
// npm install step is needed in CI.
//
// Known simplification vs. the live client-side model: weather is not
// factored in here (Diamond Report Pick's live model gives it a small,
// symmetric-ish nudge). Sportsbook K lines aren't available server-side
// either, so K Props grades against the model's own fallback line
// (floor(projK) - 0.5), same as the client falls back to when no real book
// line is loaded. Both are noted so nobody mistakes this for a 1:1 replay
// of the live site's exact numbers — it's an independent, real, but
// slightly simpler model.
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

async function loadTracker() {
  try {
    const raw = await readFile(TRACKER_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    parsed.market ||= { drp: [], kprop: [] };
    parsed.market.drp ||= [];
    parsed.market.kprop ||= [];
    parsed.allTime ||= {};
    parsed.allTime.drp ||= { wins: 0, losses: 0, pushes: 0, total: 0 };
    parsed.allTime.kprop ||= { wins: 0, losses: 0, pushes: 0, total: 0 };
    return parsed;
  } catch (e) {
    return {
      version: 1,
      generatedAt: null,
      market: { drp: [], kprop: [] },
      allTime: {
        drp: { wins: 0, losses: 0, pushes: 0, total: 0 },
        kprop: { wins: 0, losses: 0, pushes: 0, total: 0 },
      },
    };
  }
}

async function saveTracker(store) {
  store.generatedAt = new Date().toISOString();
  await mkdir(path.dirname(TRACKER_PATH), { recursive: true });
  await writeFile(TRACKER_PATH, JSON.stringify(store, null, 2) + '\n');
}

function recomputeAllTime(store) {
  for (const marketKey of ['drp', 'kprop']) {
    const rows = store.market[marketKey].filter(r => r.result === 'win' || r.result === 'loss' || r.result === 'push');
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

async function captureToday(store) {
  const today = cdtDateString(new Date());
  const sched = await fetchJSON(`${API}/schedule?sportId=1&date=${today}&hydrate=team,probablePitcher,linescore`);
  const games = sched?.dates?.find(d => d.date === today)?.games || [];
  const season = today.slice(0, 4);
  let added = 0;

  for (const g of games) {
    const state = g.status?.abstractGameState;
    // Only capture genuinely pre-game matchups — a game already Live/Final by the time
    // this runs can't be used without leaking the outcome into the "prediction".
    if (state !== 'Preview') continue;

    try {
      const drp = await computeDRPick(g, season);
      if (drp && !store.market.drp.some(r => r.key === drp.key)) {
        store.market.drp.push(drp);
        added++;
      }
    } catch (e) {
      console.warn(`DRP capture failed for gamePk ${g.gamePk}:`, e.message);
    }

    for (const side of ['away', 'home']) {
      try {
        const kp = await computeKProp(g, side, season);
        if (kp && !store.market.kprop.some(r => r.key === kp.key)) {
          store.market.kprop.push(kp);
          added++;
        }
      } catch (e) {
        console.warn(`K Props capture failed for gamePk ${g.gamePk}/${side}:`, e.message);
      }
    }
  }
  console.log(`Captured ${added} new pending pick(s) for ${today}.`);
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
  cdtDateString,
};
