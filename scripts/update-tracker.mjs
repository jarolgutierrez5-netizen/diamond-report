#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Diamond Report Tracker updater — the "developer side" grading job the
// site's Tracker system was always meant to have (see the code comment in
// app.js: "Tracker linkage will stay on the developer side later").
//
// Runs three times a day — before first pitch, again in the afternoon once most
// lineups are posted, and once more in the early evening for the latest-posting
// (mainly west-coast) lineups (see update-tracker.yml) — and does two things in one
// pass each run:
//
//   1. CAPTURE — for TODAY's games, independently derives the Diamond Report Pick
//      (game winner) and K Props (strikeout over/under), and *selects and locks in*
//      the HR Threats board's per-batter picks using only data available *before* the
//      games start, so every visitor sees the identical picks with the identical
//      score, and once a pick is captured it's locked for the day: a later run in
//      the same day only fills genuinely open slots (batters newly clearing the
//      score gate as lineups post), it never bumps an already-captured pick for one
//      that's since scored higher. This has to happen pre-game — season stats
//      fetched *after* a game already include that game's own result, which would
//      silently make every backtest look artificially accurate (lookahead bias).
//      Capturing pre-game and grading later is the only honest way to measure this.
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
//   - HR Threats: no Statcast hot-hitter sync data available server-side,
//     so the "recent hot form" signal uses a real, independently-computable
//     proxy (last-10-game AVG meaningfully above season AVG, or a HR in the
//     last 10 games) instead of the site's onFireScore/hotBoostPct. Official
//     starting lineups also often aren't posted yet this early in the day —
//     when a game's real lineup isn't up yet, batter candidates fall back to
//     the team's active roster position players (same fallback tier the live
//     HR Threats board itself uses pre-lineup), and lineup-slot-dependent
//     signals are simply left at their unknown-slot defaults rather than
//     guessed.
// All noted so nobody mistakes this for a 1:1 replay of the live site's
// exact numbers — it's an independent, real, but slightly simpler model.
// ─────────────────────────────────────────────────────────────────────────

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRACKER_PATH = path.join(__dirname, '..', 'data', 'tracker.json');
// Exported from the same fetchOddsLookup() call already made below (no extra API
// usage) so the live client's K Props board can show the real book's line/price as
// a display-only "Market" label, same pattern as the Game Projections Market chip —
// this file was never being written before, so loadSportsbookKLines() on the client
// had nothing to actually read despite already knowing how to parse it.
const K_PROPS_ODDS_PATH = path.join(__dirname, '..', 'data', 'k-props.json');
// Same idea as K_PROPS_ODDS_PATH above, for the batter markets — real sportsbook
// hits/home_runs/total_bases/rbis/stolen_bases lines for EVERY quoted batter, from
// the exact same batterLines map fetchOddsLookup() already builds. Lets the live
// client compute a real implied-probability edge (see
// scripts/sync-batter-situational-props.mjs) for any batter on today's board.
const PROP_MARKET_ODDS_PATH = path.join(__dirname, '..', 'data', 'prop-market-odds.json');
// Separate file, separate pipeline — deliberately never merged into
// data/tracker.json. Captures our own Diamond Report Pick alongside Ballpark
// Pal's own Moneyline projection for the same game every morning, then grades
// both against the real final score the next day, purely so accuracy can be
// compared side by side over time. Never read by anything that feeds a
// score or a pick — informational/analytics only.
const BP_COMPARISON_PATH = path.join(__dirname, '..', 'data', 'ballparkpal-comparison.json');
const BALLPARKPAL_API_KEY = process.env.BALLPARKPAL_API_KEY || '';
const BALLPARKPAL_BASE = 'https://www.ballparkpal.com/api/v1';
const API = 'https://statsapi.mlb.com/api/v1';
// Real sportsbook lines, when available — see fetchOddsLookup() below. Entirely
// optional: everything gracefully falls back to the model's own line/analysis when
// ODDS_API_KEY isn't set, a request fails, or a specific player/market isn't quoted.
const ODDS_API_KEY = process.env.ODDS_API_KEY || '';
const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';
// Budget note: the-odds-api.com's free tier is metered per month. One events-list call
// plus one per-event odds call (all markets requested together in a single call per
// event) runs roughly 15-16 requests/day if fetched daily — call this only from the
// morning capture pass, not the later same-day re-passes, to stay well within a
// typical free-tier monthly quota.

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

function normalizeName(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z\s]/g, '').trim();
}

// Real sportsbook lines for K Props and batter prop markets, from the-odds-api.com.
// Two lookup maps come back: pitcherLines (strikeout O/U) and
// batterLines (hits/home runs/RBIs/total bases/stolen bases O/U), each keyed by
// normalized player name. Every failure mode here — no key, quota exceeded, an event
// or market simply not offered yet — resolves to an empty lookup rather than throwing,
// since this whole feature is a strict enhancement over the model-only fallback that
// already works.
async function fetchOddsLookup() {
  const pitcherLines = new Map();
  const batterLines = new Map();
  if (!ODDS_API_KEY) {
    console.log('ODDS_API_KEY not set — skipping real sportsbook lines, using model-only fallback.');
    return { pitcherLines, batterLines };
  }
  try {
    const events = await fetchJSON(`${ODDS_API_BASE}/sports/baseball_mlb/events?apiKey=${ODDS_API_KEY}`, 1);
    if (!Array.isArray(events) || !events.length) {
      console.warn('the-odds-api: no MLB events returned for today.');
      return { pitcherLines, batterLines };
    }
    const markets = 'pitcher_strikeouts,batter_hits,batter_home_runs,batter_rbis,batter_total_bases,batter_stolen_bases';
    for (const ev of events) {
      try {
        const odds = await fetchJSON(
          `${ODDS_API_BASE}/sports/baseball_mlb/events/${ev.id}/odds?apiKey=${ODDS_API_KEY}&regions=us&markets=${markets}&oddsFormat=american`,
          1,
        );
        const bookmakers = odds?.bookmakers || [];
        // One consensus line per player/market: the first bookmaker that quotes it.
        // Real lines vary slightly book to book; picking a single consistent source
        // (rather than averaging) keeps grading simple and reproducible.
        for (const book of bookmakers) {
          for (const mkt of book.markets || []) {
            const targetMap = mkt.key === 'pitcher_strikeouts' ? pitcherLines : batterLines;
            const marketKey = mkt.key === 'pitcher_strikeouts' ? 'strikeouts' : mkt.key.replace('batter_', '');
            const byName = {};
            (mkt.outcomes || []).forEach(o => {
              const name = normalizeName(o.description || o.name);
              if (!name) return;
              (byName[name] ||= {})[String(o.name).toLowerCase()] = o;
            });
            Object.entries(byName).forEach(([name, sides]) => {
              const over = sides.over;
              if (!over || !Number.isFinite(over.point)) return;
              const key = name;
              const existing = targetMap.get(key) || {};
              if (existing[marketKey]) return; // already have a consensus line for this player/market
              existing[marketKey] = { line: over.point, overPrice: over.price, underPrice: sides.under?.price ?? null, book: book.key };
              targetMap.set(key, existing);
            });
          }
        }
      } catch (e) {
        console.warn(`the-odds-api: props fetch failed for event ${ev.id}:`, e.message);
      }
    }
    console.log(`the-odds-api: loaded lines for ${pitcherLines.size} pitcher(s), ${batterLines.size} batter(s).`);
  } catch (e) {
    console.warn('the-odds-api: events fetch failed, continuing model-only:', e.message);
  }
  return { pitcherLines, batterLines };
}

// ── Real market moneyline (ESPN/DraftKings) for the Diamond Report Pick ────
// Ported from app.js's loadEspnEventIds()/getMarketOdds() -- the CLIENT already
// fetches this same real moneyline on every page load to show a "Market %"
// comparison next to the model's own pick on the Game Projections card, but it
// was never recorded anywhere: fetched fresh in the browser, then discarded.
// This is the server-side capture of that exact same number, at pick-lock
// time, so it's tracked alongside win/loss going forward. Free, unauthenticated
// ESPN endpoint (unlike ODDS_API_KEY above) -- no quota to budget against.
const ESPN_ABBR_TO_DR = { CHW: 'CWS' };
function normalizeEspnAbbr(abbr) { return ESPN_ABBR_TO_DR[abbr] || abbr; }

async function loadEspnEventIds() {
  const byAbbrPair = {};
  try {
    const data = await fetchJSON('https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard', 1);
    (data.events || []).forEach(ev => {
      const competitors = ev.competitions?.[0]?.competitors || [];
      const away = competitors.find(c => c.homeAway === 'away');
      const home = competitors.find(c => c.homeAway === 'home');
      const awayAbbr = normalizeEspnAbbr(away?.team?.abbreviation);
      const homeAbbr = normalizeEspnAbbr(home?.team?.abbreviation);
      if (awayAbbr && homeAbbr) byAbbrPair[`${awayAbbr}@${homeAbbr}`] = ev.id;
    });
  } catch (e) {
    console.warn('ESPN scoreboard fetch failed -- today\'s DRP rows will have no real market odds:', e.message);
  }
  return byAbbrPair;
}

// Same no-vig (vig-removed) implied win% math as app.js's getMarketOdds, so
// the number recorded here always matches what a user would have actually
// seen on the site that day. Returns null (never a fabricated price) when
// ESPN/DraftKings hasn't posted a line for this game yet.
async function fetchGameMoneyline(eventId) {
  if (!eventId) return null;
  try {
    const summary = await fetchJSON(`https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/summary?event=${eventId}`, 1);
    const pc = summary.pickcenter?.[0] || null;
    const awayML = pc?.awayTeamOdds?.moneyLine;
    const homeML = pc?.homeTeamOdds?.moneyLine;
    if (typeof awayML !== 'number' || typeof homeML !== 'number') return null;
    const impliedProb = (ml) => ml < 0 ? (-ml) / (-ml + 100) : 100 / (ml + 100);
    const awayImplied = impliedProb(awayML);
    const homeImplied = impliedProb(homeML);
    const vigTotal = awayImplied + homeImplied; // >1 due to vig -- normalize it out
    return {
      provider: pc.provider?.name || 'Market',
      awayML, homeML,
      awayPct: Math.round((awayImplied / vigTotal) * 100),
      homePct: Math.round((homeImplied / vigTotal) * 100),
    };
  } catch {
    return null;
  }
}

function emptyTracker() {
  return {
    version: 1,
    generatedAt: null,
    market: { drp: [], kprop: [], premium: [], hrThreat: [] },
    allTime: {
      drp: { wins: 0, losses: 0, pushes: 0, total: 0 },
      kprop: { wins: 0, losses: 0, pushes: 0, total: 0 },
      premium: { wins: 0, losses: 0, pushes: 0, total: 0 },
      // wins/losses here mean "hit a HR / didn't" — reusing the same result vocabulary as
      // every other market for recomputeAllTime, even though HR Threat entries aren't
      // picks. hits/total is the meaningful figure (the day's actual hit rate).
      hrThreat: { wins: 0, losses: 0, pushes: 0, total: 0 },
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
    parsed.market.hrThreat ||= [];
    parsed.allTime ||= {};
    parsed.allTime.drp ||= { ...empty.allTime.drp };
    parsed.allTime.kprop ||= { ...empty.allTime.kprop };
    parsed.allTime.premium ||= { ...empty.allTime.premium };
    parsed.allTime.hrThreat ||= { ...empty.allTime.hrThreat };
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
  for (const marketKey of ['drp', 'kprop', 'premium', 'hrThreat']) {
    const rows = (store.market[marketKey] || []).filter(r => r.result === 'win' || r.result === 'loss' || r.result === 'push');
    store.allTime[marketKey] = {
      wins: rows.filter(r => r.result === 'win').length,
      losses: rows.filter(r => r.result === 'loss').length,
      pushes: rows.filter(r => r.result === 'push').length,
      total: rows.length,
    };
  }
}

// ── Ballpark Pal projections comparison (separate file, see BP_COMPARISON_PATH) ──
async function loadBallparkPalComparison() {
  try {
    const raw = await readFile(BP_COMPARISON_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    parsed.entries ||= [];
    return parsed;
  } catch (e) {
    return {
      version: 1,
      generatedAt: null,
      entries: [],
      summary: {
        ours: { wins: 0, losses: 0, pushes: 0, total: 0 },
        ballparkPal: { wins: 0, losses: 0, pushes: 0, total: 0 },
      },
    };
  }
}

async function saveBallparkPalComparison(store) {
  store.generatedAt = new Date().toISOString();
  await mkdir(path.dirname(BP_COMPARISON_PATH), { recursive: true });
  await writeFile(BP_COMPARISON_PATH, JSON.stringify(store, null, 2) + '\n');
}

function recomputeBallparkPalSummary(store) {
  const summary = {
    ours: { wins: 0, losses: 0, pushes: 0, total: 0 },
    ballparkPal: { wins: 0, losses: 0, pushes: 0, total: 0 },
  };
  for (const e of store.entries) {
    if (e.ourResult === 'win') summary.ours.wins++;
    else if (e.ourResult === 'loss') summary.ours.losses++;
    else if (e.ourResult === 'push') summary.ours.pushes++;
    if (e.ourResult && e.ourResult !== 'pending') summary.ours.total++;

    if (e.bpResult === 'win') summary.ballparkPal.wins++;
    else if (e.bpResult === 'loss') summary.ballparkPal.losses++;
    else if (e.bpResult === 'push') summary.ballparkPal.pushes++;
    if (e.bpResult && e.bpResult !== 'pending') summary.ballparkPal.total++;
  }
  store.summary = summary;
}

async function fetchBallparkPal(pathAndQuery, attempts = 3) {
  if (!BALLPARKPAL_API_KEY) return null;
  const url = `${BALLPARKPAL_BASE}${pathAndQuery}`;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { headers: { 'X-API-Key': BALLPARKPAL_API_KEY } });
      if (res.status === 429) {
        const retryAfterSec = Number(res.headers.get('Retry-After')) || (2 * (i + 1));
        await new Promise(r => setTimeout(r, retryAfterSec * 1000));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      return json.data;
    } catch (e) {
      if (i === attempts - 1) { console.warn(`Ballpark Pal fetch failed for ${pathAndQuery}:`, e.message); return null; }
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  return null;
}

// Ballpark Pal models Moneyline as a per-team "runs scored over/under 0.5"
// market rather than a flat win probability — confirmed live: for a given
// gameId, marketKey "mkt_1"/displayName "Moneyline" returns four rows (each
// team x over/under), where a team's "over 0.5" probability is mathematically
// its win probability (the two teams' "over" probabilities sum to ~1, and
// each team's "under" is the complement of its own "over" — baseball has no
// ties, so "scores more than half a run more than being shut out" only
// resolves to "wins"). teamId here is the real MLB Stats API team id (already
// hydrated on the schedule game object), not something separately looked up.
async function fetchBallparkPalMoneyline(gamePk, awayTeamId, homeTeamId) {
  const payload = await fetchBallparkPal(`/projections/probabilities?gameId=${gamePk}`);
  const items = payload?.items;
  if (!Array.isArray(items)) return null;
  const findPct = (teamId) => {
    const row = items.find(it => it.displayName === 'Moneyline' && it.side === 'over' && it.subject?.type === 'team' && it.subject?.id === teamId);
    return row && Number.isFinite(row.probability) ? Math.round(row.probability * 100) : null;
  };
  const awayPct = findPct(awayTeamId);
  const homePct = findPct(homeTeamId);
  if (awayPct == null || homePct == null) return null;
  return { awayPct, homePct };
}

async function gradeBallparkPalComparison(compStore) {
  const today = cdtDateString(new Date());
  const pending = compStore.entries.filter(e => e.ourResult === 'pending' && e.date < today);
  if (!pending.length) return 0;

  const dates = [...new Set(pending.map(e => e.date))];
  let graded = 0;
  for (const date of dates) {
    let games = [];
    try {
      const sched = await fetchJSON(`${API}/schedule?sportId=1&date=${date}&hydrate=linescore`);
      games = sched?.dates?.find(d => d.date === date)?.games || [];
    } catch (e) {
      console.warn(`Ballpark Pal comparison: schedule fetch failed for ${date}:`, e.message);
      continue;
    }
    const gamesByPk = Object.fromEntries(games.map(g => [g.gamePk, g]));

    for (const e of pending.filter(r => r.date === date)) {
      const g = gamesByPk[e.gamePk];
      if (!g || g.status?.abstractGameState !== 'Final') continue;
      const awayScore = n(g.teams?.away?.score, NaN);
      const homeScore = n(g.teams?.home?.score, NaN);
      if (!Number.isFinite(awayScore) || !Number.isFinite(homeScore)) continue;
      const actualWinner = awayScore === homeScore ? 'TIE' : (awayScore > homeScore ? e.awayTeam : e.homeTeam);
      e.actualWinner = actualWinner;
      e.ourResult = actualWinner === 'TIE' ? 'push' : (actualWinner === e.ourPick ? 'win' : 'loss');
      e.bpResult = actualWinner === 'TIE' ? 'push' : (actualWinner === e.bpPick ? 'win' : 'loss');
      graded++;
    }
  }
  return graded;
}

// Called from inside captureToday (has previewGames/store.market.drp already
// in scope) — only compares games we ourselves captured a DRP pick for, so
// this never becomes its own independent source of picks.
async function captureBallparkPalComparisonToday(compStore, previewGames, store) {
  if (!BALLPARKPAL_API_KEY) return 0;
  let added = 0;
  for (const g of previewGames) {
    const awayAbbr = g.teams.away.team.abbreviation;
    const homeAbbr = g.teams.home.team.abbreviation;
    const gameDay = cdtDateString(new Date(g.gameDate));
    const key = `${gameDay}|${g.gamePk}`;
    if (compStore.entries.some(e => e.key === key)) continue;
    const ourDrp = store.market.drp.find(r => r.gamePk === g.gamePk);
    if (!ourDrp) continue;
    let bp;
    try {
      bp = await fetchBallparkPalMoneyline(g.gamePk, g.teams.away.team.id, g.teams.home.team.id);
    } catch (e) {
      console.warn(`Ballpark Pal comparison capture failed for gamePk ${g.gamePk}:`, e.message);
      continue;
    }
    if (!bp) continue;
    const bpPick = bp.awayPct >= bp.homePct ? awayAbbr : homeAbbr;
    const bpPickPct = Math.max(bp.awayPct, bp.homePct);
    compStore.entries.push({
      key, date: gameDay, gamePk: g.gamePk, awayTeam: awayAbbr, homeTeam: homeAbbr,
      ourPick: ourDrp.pick, ourPickPct: ourDrp.pickPct,
      bpPick, bpPickPct,
      actualWinner: null, ourResult: 'pending', bpResult: 'pending',
    });
    added++;
  }
  return added;
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

// Populated as a side effect of seasonPitchingStat (below) — pitchHand comes back on
// the same /people/{id} response the season stat call already makes, so caching it
// here means the batter pool's handedness-split lookup costs zero extra pitcher
// requests, only the one new per-batter split request (see battingSplitVsHand).
const pitcherHandCache = new Map();

async function seasonPitchingStat(pid, season) {
  try {
    const d = await fetchJSON(`${API}/people/${pid}?hydrate=stats(group=pitching,type=season,season=${season})`);
    const person = d?.people?.[0];
    if (person?.pitchHand?.code) pitcherHandCache.set(pid, person.pitchHand.code);
    return person?.stats?.[0]?.splits?.[0]?.stat || {};
  } catch (e) {
    return {};
  }
}

// ── DRP Game Simulation, Phase 1: log5 plate-appearance outcome model ──
// First step toward replacing DRP's additive point-scoring formula (below)
// with a bottom-up game simulation, the same shape of approach Ballpark Pal
// uses (simulate the game play-by-play and let win probability emerge,
// rather than a formula that scores factors and adds them up). NOT wired
// into any live pick yet — a standalone, tested model that a later phase
// will use to drive an actual inning-by-inning simulation loop.
//
// log5 is the standard sabermetric formula for combining a batter's and a
// pitcher's rate for the same outcome into a matchup-specific probability,
// weighted against the league-average rate for that outcome — see Bill
// James' original formulation. It's a principled middle ground between
// "just use the batter's rate" and "just use the pitcher's rate."
//
// League-average per-PA rates below are static reference values (recent-era
// MLB averages), not fetched live — same precedent as the static
// PARK_FACTORS table above. Good enough for log5's denominator; a future
// version could compute them from the season's actual league totals.
const LEAGUE_AVG_PA_RATES = {
  hr: 0.031,
  xbh: 0.049, // doubles + triples
  single: 0.140,
  bb: 0.085,
  k: 0.225,
  // remaining ~0.470 is outs in play — not modeled as its own log5 rate,
  // "out" is whatever probability mass the other five don't use.
};

function log5(pBatter, pPitcher, pLeague) {
  if (!(pLeague > 0) || !(pLeague < 1)) return pBatter; // degenerate league rate — fall back to the batter's own rate
  const a = clamp(pBatter, 0.001, 0.999);
  const b = clamp(pPitcher, 0.001, 0.999);
  const c = clamp(pLeague, 0.001, 0.999);
  const num = (a * b) / c;
  const den = num + ((1 - a) * (1 - b)) / (1 - c);
  return den > 0 ? num / den : a;
}

// batterStat/pitcherStat are the raw MLB Stats API stat objects already
// returned by seasonBattingStat/seasonPitchingStat. Returns a probability
// distribution over {hr, xbh, single, bb, k, out} that sums to 1.
function computeMatchupOutcomeDist(batterStat, pitcherStat) {
  const bPA = n(batterStat.plateAppearances) || 1;
  const bHits = n(batterStat.hits), bHR = n(batterStat.homeRuns);
  const bXBH = n(batterStat.doubles) + n(batterStat.triples);
  const bSingle = Math.max(0, bHits - bHR - bXBH);
  const bBB = n(batterStat.baseOnBalls) + n(batterStat.hitByPitch);
  const bK = n(batterStat.strikeOuts);
  const batterRates = {
    hr: bHR / bPA, xbh: bXBH / bPA, single: bSingle / bPA,
    bb: bBB / bPA, k: bK / bPA,
  };

  // MLB Stats API pitching splits don't reliably carry doubles/triples
  // allowed, so the extra-base-vs-single composition of a pitcher's hits
  // allowed falls back to the batter's own XBH-vs-single split (or the
  // league split, if the batter has too few hits to have a meaningful one)
  // rather than a true pitcher-specific split — a real simplification,
  // flagged the same way this file already flags its other known ones.
  const pBF = n(pitcherStat.battersFaced) || 1;
  const pHits = n(pitcherStat.hits), pHR = n(pitcherStat.homeRuns);
  const pNonHRHits = Math.max(0, pHits - pHR);
  const bXBHShareOfHits = (bXBH + bSingle) > 0
    ? bXBH / (bXBH + bSingle)
    : LEAGUE_AVG_PA_RATES.xbh / (LEAGUE_AVG_PA_RATES.xbh + LEAGUE_AVG_PA_RATES.single);
  const pXBH = pNonHRHits * bXBHShareOfHits;
  const pSingle = pNonHRHits - pXBH;
  const pBB = n(pitcherStat.baseOnBalls) + n(pitcherStat.hitBatsmen);
  const pK = n(pitcherStat.strikeOuts);
  const pitcherRates = {
    hr: pHR / pBF, xbh: pXBH / pBF, single: pSingle / pBF,
    bb: pBB / pBF, k: pK / pBF,
  };

  const dist = {};
  for (const key of ['hr', 'xbh', 'single', 'bb', 'k']) {
    dist[key] = log5(batterRates[key], pitcherRates[key], LEAGUE_AVG_PA_RATES[key]);
  }
  const usedMass = dist.hr + dist.xbh + dist.single + dist.bb + dist.k;
  dist.out = Math.max(0, 1 - usedMass);
  // Normalize in case the five modeled outcomes summed above 1 (rare, but
  // possible when several matchup rates skew the same direction) — scale
  // everything proportionally rather than letting "out" go negative.
  const total = usedMass + dist.out;
  if (total > 0 && Math.abs(total - 1) > 1e-9) {
    for (const key of ['hr', 'xbh', 'single', 'bb', 'k', 'out']) dist[key] /= total;
  }
  return dist;
}

// ── DRP Game Simulation, Phase 2: base-out-state simulation loop ──
// Samples one outcome per plate appearance from computeMatchupOutcomeDist()
// and advances runners accordingly, inning by inning, for a full 9(+)-inning
// game — the actual "bottom-up" mechanism Phase 1 was built to feed. Still
// not wired into any live pick; simulateDRPGame() below is the entry point
// a future phase will call from captureToday alongside (not instead of) the
// existing computeDRPick().
//
// Base-advancement rules here are simplified, fixed heuristics (e.g. "a
// runner on 2nd scores on a single 60% of the time"), not a real 24-state
// Retrosheet transition matrix — that data isn't something this script has
// programmatic access to. Good enough to make PA outcomes translate into
// realistic-looking run totals; not claimed to be more precise than that.
// Same spirit as this file's other documented simplifications (see the top
// of the file).

function sampleOutcome(dist) {
  const r = Math.random();
  let cum = 0;
  for (const key of ['hr', 'xbh', 'single', 'bb', 'k', 'out']) {
    cum += dist[key];
    if (r < cum) return key;
  }
  return 'out'; // floating-point fallback — cum should reach ~1 before this
}

// bases: { first: bool, second: bool, third: bool }. Returns the new base
// state plus runs scored on this play. outsBeforePlay is outs already
// recorded in the half-inning before this plate appearance (used for the
// sac-fly-style scoring chance on a ball-in-play out).
function advanceRunners(bases, outcome, outsBeforePlay) {
  const b = { first: bases.first, second: bases.second, third: bases.third };
  let runs = 0;

  if (outcome === 'hr') {
    if (b.third) runs++;
    if (b.second) runs++;
    if (b.first) runs++;
    runs++; // batter
    return { bases: { first: false, second: false, third: false }, runs };
  }

  if (outcome === 'xbh') {
    // Treats 2B/3B as one bucket (see computeMatchupOutcomeDist) — modeled
    // as double-shaped advancement, the more common of the two.
    if (b.third) runs++;
    if (b.second) runs++;
    const runnerFrom1st = b.first; // advances to 3rd, doesn't score
    return { bases: { first: false, second: runnerFrom1st, third: true }, runs };
  }

  if (outcome === 'single') {
    if (b.third) runs++;
    let newThird = false;
    if (b.second) {
      if (Math.random() < 0.60) runs++; else newThird = true;
    }
    return { bases: { first: true, second: b.first, third: newThird }, runs };
  }

  if (outcome === 'bb') {
    // Force advancement only.
    if (b.first) {
      if (b.second) {
        if (b.third) runs++; // bases loaded, forced home
        return { bases: { first: true, second: true, third: true }, runs };
      }
      return { bases: { first: true, second: true, third: b.third }, runs };
    }
    return { bases: { first: true, second: b.second, third: b.third }, runs };
  }

  if (outcome === 'k') {
    return { bases: b, runs: 0 }; // no advancement on strikeout
  }

  // outcome === 'out' (ball in play) — approximate sac-fly scoring chance.
  if (b.third && outsBeforePlay < 2 && Math.random() < 0.35) {
    return { bases: { first: b.first, second: b.second, third: false }, runs: 1 };
  }
  return { bases: b, runs: 0 };
}

// lineupStats: array of 9 batter stat objects (real order if available).
// pitcherStatFn: () => current pitcher's stat object for this PA (lets the
// caller swap starter -> bullpen mid-inning without this function knowing).
// battingIdxRef: { i: number } — mutated in place so the lineup keeps
// cycling correctly across half-innings within the same simulated game.
function simulateHalfInning(lineupStats, battingIdxRef, pitcherStatFn) {
  let outs = 0, runs = 0;
  let bases = { first: false, second: false, third: false };
  while (outs < 3) {
    const batterStat = lineupStats[battingIdxRef.i % lineupStats.length];
    battingIdxRef.i++;
    const dist = computeMatchupOutcomeDist(batterStat, pitcherStatFn());
    const outcome = sampleOutcome(dist);
    if (outcome === 'k' || outcome === 'out') outs++;
    const result = advanceRunners(bases, outcome, outs - (outcome === 'k' || outcome === 'out' ? 1 : 0));
    bases = result.bases;
    runs += result.runs;
  }
  return runs;
}

// Picks the starter's stat until they've faced roughly a full outing's worth
// of batters, then the bullpen stat for the rest of the game — a simplified
// stand-in for real pull decisions (pitch count, leverage, matchups), same
// caveat as above. ~22 batters faced is roughly a 5-inning outing.
const STARTER_BATTERS_FACED_LIMIT = 22;

function makePitcherStatFn(starterStat, bullpenStat, battersFacedRef) {
  return () => {
    battersFacedRef.i++;
    return battersFacedRef.i <= STARTER_BATTERS_FACED_LIMIT ? starterStat : bullpenStat;
  };
}

// One full simulated game. Returns { awayRuns, homeRuns }.
function simulateOneGame(awayLineup, awayStarterStat, awayBullpenStat, homeLineup, homeStarterStat, homeBullpenStat) {
  const awayIdx = { i: 0 }, homeIdx = { i: 0 };
  const awayBF = { i: 0 }, homeBF = { i: 0 };
  const awayPitcherFn = makePitcherStatFn(homeStarterStat, homeBullpenStat, homeBF); // away bats vs home's pitcher
  const homePitcherFn = makePitcherStatFn(awayStarterStat, awayBullpenStat, awayBF); // home bats vs away's pitcher
  let awayRuns = 0, homeRuns = 0;
  const MAX_INNINGS = 12; // simulation cap — see note below

  for (let inning = 1; inning <= 9 || (awayRuns === homeRuns && inning <= MAX_INNINGS); inning++) {
    awayRuns += simulateHalfInning(awayLineup, awayIdx, awayPitcherFn);
    // Standard "no need to bat in the bottom 9th if already leading" skipped
    // for simplicity — negligible effect on aggregate win%/totals across
    // thousands of trials, and it keeps this loop simple.
    homeRuns += simulateHalfInning(homeLineup, homeIdx, homePitcherFn);
  }
  return { awayRuns, homeRuns };
}

// Entry point for a future capture-time integration. lineups/starter/bullpen
// stats are the raw MLB Stats API stat objects this file already fetches
// elsewhere (seasonBattingStat per lineup slot, seasonPitchingStat for
// starters, a team pitching aggregate for "bullpen" — see the caller this
// will eventually have in captureToday). trials defaults low enough to run
// quickly in CI; raise for a more stable estimate once this is validated.
function simulateDRPGame({ awayLineup, awayStarterStat, awayBullpenStat, homeLineup, homeStarterStat, homeBullpenStat }, trials = 1000) {
  let awayWins = 0, homeWins = 0, ties = 0, totalAwayRuns = 0, totalHomeRuns = 0;
  for (let t = 0; t < trials; t++) {
    const { awayRuns, homeRuns } = simulateOneGame(awayLineup, awayStarterStat, awayBullpenStat, homeLineup, homeStarterStat, homeBullpenStat);
    if (awayRuns > homeRuns) awayWins++;
    else if (homeRuns > awayRuns) homeWins++;
    else ties++; // hit the MAX_INNINGS cap still tied — rare
    totalAwayRuns += awayRuns;
    totalHomeRuns += homeRuns;
  }
  return {
    awayWinPct: Math.round((awayWins / trials) * 100),
    homeWinPct: Math.round((homeWins / trials) * 100),
    tiePct: Math.round((ties / trials) * 100),
    avgAwayRuns: +(totalAwayRuns / trials).toFixed(2),
    avgHomeRuns: +(totalHomeRuns / trials).toFixed(2),
    trials,
  };
}

// ── Diamond Report Pick model (ported from loadGameProps in app.js, minus weather) ──
async function computeDRPick(g, season, espnEventIds) {
  const awayAbbr = g.teams.away.team.abbreviation;
  const homeAbbr = g.teams.home.team.abbreviation;
  const awayP = g.teams.away.probablePitcher;
  const homeP = g.teams.home.probablePitcher;
  if (!awayP || !homeP) return null;

  const [awayStats, homeStats, awayRecent, homeRecent, marketOdds] = await Promise.all([
    seasonPitchingStat(awayP.id, season),
    seasonPitchingStat(homeP.id, season),
    recentPitchingForm(awayP.id, season),
    recentPitchingForm(homeP.id, season),
    espnEventIds ? fetchGameMoneyline(espnEventIds[`${awayAbbr}@${homeAbbr}`]) : Promise.resolve(null),
  ]);

  let awayScore = 50, homeScore = 50;

  // ERA/WHIP/K9 all continuous now, no hard gate -- exact mirror of the same fix in
  // app.js's loadGameProps (see that file's own comment for the full reasoning). The
  // old gate-then-flat-bonus design (WHIP/K9 added the same fixed points regardless of
  // how far past the threshold the diff was) is why pickPct almost never left the
  // 50-55% band: 81 of 116 graded picks landed in the single 50-54% bucket.
  const awayERA = blendRecentForm(n(awayStats.era, 4.5), awayRecent, 'era');
  const homeERA = blendRecentForm(n(homeStats.era, 4.5), homeRecent, 'era');
  const eraDiff = awayERA - homeERA;
  const eraPts = Math.min(Math.abs(eraDiff) * 3, 10);
  if (eraDiff > 0) homeScore += eraPts; else if (eraDiff < 0) awayScore += eraPts;

  const awayWHIP = blendRecentForm(n(awayStats.whip, 1.3), awayRecent, 'whip');
  const homeWHIP = blendRecentForm(n(homeStats.whip, 1.3), homeRecent, 'whip');
  const whipDiff = awayWHIP - homeWHIP;
  const whipPts = Math.min(Math.abs(whipDiff) * 10, 6);
  if (whipDiff > 0) homeScore += whipPts; else if (whipDiff < 0) awayScore += whipPts;

  const awayK9 = blendRecentForm(n(awayStats.strikeoutsPer9Inn, 8), awayRecent, 'k9');
  const homeK9 = blendRecentForm(n(homeStats.strikeoutsPer9Inn, 8), homeRecent, 'k9');
  const k9Diff = homeK9 - awayK9;
  const k9Pts = Math.min(Math.abs(k9Diff) * 1.2, 5);
  if (k9Diff > 0) homeScore += k9Pts; else if (k9Diff < 0) awayScore += k9Pts;

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
    // Matchup snapshot at pick time -- eraDiff/whipDiff/k9Diff/record all feed directly
    // into awayScore/homeScore above but were previously discarded once winner/winnerPct
    // were computed, so there was no way to check afterward whether the pick is
    // systematically off for certain kinds of matchups (a huge ERA mismatch vs. a close
    // one, a big record gap vs. two .500 teams, day vs. night games, etc.) -- same gap
    // the HR Threat/K Props/Elite Picks trackers had (see analyze-drp-matchups.mjs).
    eraDiff: Math.round(eraDiff * 100) / 100,
    whipDiff: Math.round((awayWHIP - homeWHIP) * 1000) / 1000,
    k9Diff: Math.round((awayK9 - homeK9) * 100) / 100,
    awayRecordPct: (awayW + awayL) > 0 ? Math.round((awayW / (awayW + awayL)) * 1000) / 1000 : null,
    homeRecordPct: (homeW + homeL) > 0 ? Math.round((homeW / (homeW + homeL)) * 1000) / 1000 : null,
    isDayGame: gameHourCT < 17,
    // Real ESPN/DraftKings moneyline at capture time -- the same number the
    // Game Projections card shows the user that day (see fetchGameMoneyline's
    // header comment). null when the book hadn't posted a line yet at capture
    // time, never fabricated. Locked in permanently once this row is first
    // captured, same as every other field here -- never refreshed on a later
    // same-day pass, so this always reflects the real line at pick time, not
    // whatever the line drifted to by game time.
    marketOdds,
  };
}

// ── K Props model (ported from buildRow in app.js) ──
async function computeKProp(g, side, season, oddsLookup) {
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
  // Also keeps the actual 9 batters (id/name/battingOrder/own K%), not just their
  // averaged rate -- so a later "what went right or wrong" pass can check whether a
  // miss traces to one specific hitter in the lineup being unusually contact-heavy,
  // not just to the pitcher's own stuff being off that night.
  let oppKpct = 0.22;
  let lineup = [];
  try {
    const bd = await fetchJSON(`${API}/game/${g.gamePk}/boxscore`);
    const teamBox = bd?.teams?.[opp];
    const oppBatters = (teamBox?.batters || []).map(id => teamBox.players?.['ID' + id]).filter(Boolean).slice(0, 9);
    const kpcts = oppBatters.map(b => {
      const s = b?.seasonStats?.batting || {};
      return (s.strikeOuts && s.plateAppearances) ? s.strikeOuts / s.plateAppearances : 0.22;
    });
    if (kpcts.length) oppKpct = kpcts.reduce((a, b) => a + b, 0) / kpcts.length;
    lineup = oppBatters.map((b, i) => ({
      id: b?.person?.id ?? null,
      name: b?.person?.fullName ?? null,
      battingOrder: i + 1,
      kPct: Math.round((kpcts[i] ?? 0.22) * 1000) / 1000,
    })).filter(x => x.id);
  } catch (e) {}

  const projK = Math.max(1, (k9 * projIP / 9) + ((oppKpct - 0.22) * 10));
  // Real sportsbook line when available (grades against what a bettor would actually
  // get, and lets us measure genuine edge vs. the market); falls back to the model's
  // own derived line — same fallback the client uses when no real book line has
  // loaded — when no odds feed is configured or this pitcher isn't quoted yet.
  const sbLine = oddsLookup?.pitcherLines?.get(normalizeName(pitcher.fullName))?.strikeouts;
  const line = sbLine ? sbLine.line : Math.max(0.5, Math.floor(projK) - 0.5);
  const lineSource = sbLine ? 'sportsbook' : 'model';

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
    lineSource,
    book: sbLine?.book ?? null,
    pick: 'OVER',
    result: 'pending',
    finalK: null,
    // Real post-game pitcher performance, filled in at grading time alongside finalK
    // (see gradePending's K prop block) -- lets a later pass tell apart "the model's
    // stuff read was wrong" from "the model was right but an early hook/short outing
    // cut off the strikeout opportunity" for any given miss.
    finalIP: null, finalPitches: null, finalBB: null, finalHits: null, finalBF: null,
    // Matchup snapshot at pick time -- k9/projIP/oppKpct all feed directly into projK
    // above but were previously discarded once the final projK number was computed, so
    // there was no way to check afterward whether the model is systematically off for
    // certain pitcher or opponent-lineup profiles (analogous to the HR Threat matchup
    // snapshot added alongside analyze-hr-matchups.mjs -- see analyze-k-matchups.mjs).
    k9: Math.round(k9 * 100) / 100,
    projIP: Math.round(projIP * 100) / 100,
    oppKpct: Math.round(oppKpct * 1000) / 1000,
    // The actual 9 opposing batters faced (id/name/battingOrder/own season K%) behind
    // oppKpct above -- lets a later pass check whether a specific lineup spot, not just
    // the lineup's blended average, is driving a systematic miss.
    lineup,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// buildBatterPool() below builds the shared active-roster batter candidate pool,
// scored across markets by the same cross-market Monte Carlo engine as the client's
// __DR_MONTE_CARLO__ IIFE (ported as closely as possible). Two real simplifications,
// both noted where they apply below:
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

const MC_TRIALS = 3000;
const MC_AB_PER_PA = 0.88;
const POOL_MIN_AB = 40;
const LEAGUE_AVG_AVG = 0.245, LEAGUE_AVG_OBP = 0.315, LEAGUE_AVG_SLG = 0.400, LEAGUE_AVG_HR_RATE = 0.031;

// ── Statcast batted-ball power (data/batter-pitch-type-season.json) ──
// Synced by sync-statcast.yml ~1hr before this job's morning run, so it's reliably
// fresh by the time buildBatterPool() runs. This was previously synced but never
// actually read by this file (see the "no Statcast hot-hitter sync data available
// server-side" comment above, which was true for the *recent-form* signal
// specifically, but this season-long power data was sitting unused too).
// xSLG/hard-hit% measure the quality of contact directly (exit velocity, launch angle)
// instead of relying on AVG/SLG outcomes, which are tangled up with luck, defense, and
// ballpark sequencing -- a real, independent power signal box-score rates can't see.
const STATCAST_PATH = path.join(__dirname, '..', 'data', 'batter-pitch-type-season.json');
// Pitcher-side counterpart: same xSLG/hard-hit% ALLOWED, broken down per pitch type
// *thrown* instead of per pitch type *seen*. Same sync script, same "collected but
// never actually read here" gap as the batter file.
const PITCHER_STATCAST_PATH = path.join(__dirname, '..', 'data', 'pitcher-statcast.json');
// Exploratory "2-strike contact suppression" signal (scripts/sync-pitcher-2k-suppression.mjs)
// — not read anywhere in scoreForMarket, just snapshotted onto captured HR Threat picks
// below so analyze-hr-matchups.mjs can bucket real graded outcomes by it later, same
// pattern as pitcherHr9/pitcherWhip. Only covers today's probable starters (the sync
// script's scope), so most rows will have a null value until/unless that changes.
const PITCHER_2K_SUPPRESSION_PATH = path.join(__dirname, '..', 'data', 'pitcher-2k-suppression.json');
// Real avg batters-faced-per-start over a starter's last 5 real starts
// (scripts/sync-pitcher-workload.mjs) -- load-bearing for scoreForMarket('hr')'s
// startBFShare (see there), the fix for the calibration-report-confirmed HR/9-and-
// WHIP-inversion bug: a flat pitcher weight overstated a quick-hook starter's real
// effect on a batter's whole game. Same today's-probable-starters-only scope as
// PITCHER_2K_SUPPRESSION_PATH above, so most rows outside that scope fall back to a
// neutral (no-scaling) share, same graceful degradation.
const PITCHER_WORKLOAD_PATH = path.join(__dirname, '..', 'data', 'pitcher-workload.json');
// scripts/sync-bullpen-hr-rate.mjs -- real, relievers-only HR-allowed rate per team
// (14-day rolling window, already shrunk toward league average). Used by
// computeLiveHRScore below to give startBFShare's discounted starter-weight
// somewhere real to go instead of just inflating batterWeight (see that function's
// own comment). Keyed by team abbreviation, not pitcher id.
const BULLPEN_HR_RATE_PATH = path.join(__dirname, '..', 'data', 'bullpen-hr-rate.json');
const LEAGUE_AVG_XSLG = 0.400; // same scale as LEAGUE_AVG_SLG; MLB-wide xSLG runs close to actual SLG
const LEAGUE_AVG_HARD_HIT_PCT = 36; // percent; roughly MLB seasonal average hard-hit rate
const STATCAST_MIN_PITCHES = 100; // below this, a player's aggregate is too thin a sample to trust
// data/statcast-hot-hitters.json -- the exact same file (and sync-statcast-hot-hitters.mjs
// schema) app.js's loadStatcastHotHitters() fetches client-side to drive the HR Threats
// "hot hitter" read. Read directly off disk here (this script already runs from a checked-
// out repo, same as every other data/*.json read in this file) so computeLiveHRScore below
// can be an exact, verifiable port of the live client formula -- not a second, independently
// -drifting approximation of it -- for the sole purpose of letting analyze-hr-matchups.mjs
// calibration-check what site visitors actually see, not just this file's own (better-
// designed but different) scoreForMarket formula.
const STATCAST_HOT_HITTERS_PATH = path.join(__dirname, '..', 'data', 'statcast-hot-hitters.json');
// data/near-hrs.json -- same file (and sync-near-hrs.mjs schema) app.js's loadNearHRs()
// fetches client-side to drive the board's "🚀 NEAR HR" chip. Read here purely so a
// captured HR Threat pick can snapshot whether this batter had real warning-track power
// at pick time, the same "measure before it's ever treated as signal" step already taken
// for isFavorable/isDue/matchupEdge/etc -- nothing here reads it back into scoring.
const NEAR_HRS_PATH = path.join(__dirname, '..', 'data', 'near-hrs.json');

// Both files store xSLG/hard-hit% per pitch-type row (batter: seasonPitchTypeStats,
// pitcher: byPitch) -- this aggregates either one into a single pitches-weighted
// {xslg, hardHitPct, pitches} per player, shared by both loaders below.
function aggregateStatcastRows(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  let pitches = 0, xslgSum = 0, xslgWeight = 0, hardHitSum = 0, hardHitWeight = 0;
  rows.forEach(r => {
    const w = n(r.pitches);
    pitches += w;
    if (r.xslg != null) { xslgSum += r.xslg * w; xslgWeight += w; }
    if (r.hardHitPct != null) { hardHitSum += r.hardHitPct * w; hardHitWeight += w; }
  });
  if (pitches < STATCAST_MIN_PITCHES) return null;
  return {
    xslg: xslgWeight > 0 ? xslgSum / xslgWeight : null,
    hardHitPct: hardHitWeight > 0 ? hardHitSum / hardHitWeight : null,
    pitches,
  };
}

let statcastPowerCache = null;
// Raw (non-aggregated) per-pitch-type rows, keyed the same way as statcastPowerCache --
// built in the same read/parse pass as the aggregate above so this doesn't cost a second
// file read. Needed by computeMatchupEdgeScore below, which (unlike battedBallPowerIndex)
// needs the individual per-pitch-type AVG/SLG/xSLG rows, not a single pitches-weighted
// blend across all of them.
let batterPitchTypeRawCache = null;
// Real per-zone wOBA production (sync-batter-zone-hr.mjs's byZone/byZoneByHand) --
// same STATCAST_PATH file as the xSLG/hard-hit% aggregate above, just a different field
// on the same per-player record, so this costs no second file read. Feeds
// zoneMatchupMultiplier below (client-mirrored, see app.js's own copy of this function).
let batterZoneCache = null;
let batterZoneByHandCache = null;
async function loadStatcastPowerIndex() {
  if (statcastPowerCache) return statcastPowerCache;
  statcastPowerCache = new Map();
  batterPitchTypeRawCache = new Map();
  batterZoneCache = new Map();
  batterZoneByHandCache = new Map();
  try {
    const raw = await readFile(STATCAST_PATH, 'utf8');
    const data = JSON.parse(raw);
    for (const [id, player] of Object.entries(data?.players || {})) {
      const agg = aggregateStatcastRows(player?.seasonPitchTypeStats);
      if (agg) statcastPowerCache.set(String(id), agg);
      if (Array.isArray(player?.seasonPitchTypeStats) && player.seasonPitchTypeStats.length) {
        batterPitchTypeRawCache.set(String(id), player.seasonPitchTypeStats);
      }
      if (player?.byZone) batterZoneCache.set(String(id), player.byZone);
      if (player?.byZoneByHand) batterZoneByHandCache.set(String(id), player.byZoneByHand);
    }
  } catch (e) {
    console.warn('Statcast power index: failed to load, HR scoring will use box-score rates only:', e.message);
  }
  return statcastPowerCache;
}

let statcastHotHittersCache = null;
async function loadStatcastHotHittersIndex() {
  if (statcastHotHittersCache) return statcastHotHittersCache;
  statcastHotHittersCache = new Map();
  try {
    const raw = await readFile(STATCAST_HOT_HITTERS_PATH, 'utf8');
    const data = JSON.parse(raw);
    const list = Array.isArray(data.players) ? data.players : [];
    // Same dual-key (id + lowercased name) lookup as app.js's statcastHotHitters, since
    // callers here look batters up by whichever key they have on hand, same as there.
    list.forEach(p => {
      if (p.playerId) statcastHotHittersCache.set(String(p.playerId), p);
      if (p.name) statcastHotHittersCache.set(String(p.name).toLowerCase(), p);
    });
  } catch (e) {
    console.warn('Statcast hot-hitters index: failed to load, live HR score will use fallback profiles only:', e.message);
  }
  return statcastHotHittersCache;
}

let nearHRsCache = null;
async function loadNearHRsIndex() {
  if (nearHRsCache) return nearHRsCache;
  nearHRsCache = new Map();
  try {
    const raw = await readFile(NEAR_HRS_PATH, 'utf8');
    const data = JSON.parse(raw);
    for (const [id, list] of Object.entries(data?.players || {})) {
      if (Array.isArray(list) && list.length) nearHRsCache.set(String(id), list);
    }
  } catch (e) {
    console.warn('Near-HRs index: failed to load, hasNearHR will be false for every batter:', e.message);
  }
  return nearHRsCache;
}

let pitcherStatcastPowerCache = null;
// Raw byPitch arrays (name + usagePct per pitch type thrown) -- same "cache alongside the
// aggregate, no second read" reasoning as batterPitchTypeRawCache above.
let pitcherByPitchRawCache = null;
// Real per-zone wOBA-against (sync-pitcher-zone-hr.mjs's byZone/byZoneByHand) -- same
// PITCHER_STATCAST_PATH file as the xSLG/hard-hit%-allowed aggregate above, feeds
// zoneMatchupMultiplier below, mirroring batterZoneCache/batterZoneByHandCache.
let pitcherZoneCache = null;
let pitcherZoneByHandCache = null;
async function loadPitcherStatcastPowerIndex() {
  if (pitcherStatcastPowerCache) return pitcherStatcastPowerCache;
  pitcherStatcastPowerCache = new Map();
  pitcherByPitchRawCache = new Map();
  pitcherZoneCache = new Map();
  pitcherZoneByHandCache = new Map();
  try {
    const raw = await readFile(PITCHER_STATCAST_PATH, 'utf8');
    const data = JSON.parse(raw);
    for (const [id, pitcher] of Object.entries(data?.pitchers || {})) {
      const agg = aggregateStatcastRows(pitcher?.byPitch);
      if (agg) pitcherStatcastPowerCache.set(String(id), agg);
      if (Array.isArray(pitcher?.byPitch) && pitcher.byPitch.length) {
        pitcherByPitchRawCache.set(String(id), pitcher.byPitch);
      }
      if (pitcher?.byZone) pitcherZoneCache.set(String(id), pitcher.byZone);
      if (pitcher?.byZoneByHand) pitcherZoneByHandCache.set(String(id), pitcher.byZoneByHand);
    }
  } catch (e) {
    console.warn('Pitcher Statcast power index: failed to load, HR scoring will use box-score rates only:', e.message);
  }
  return pitcherStatcastPowerCache;
}

// ── Matchup Edge (exact server-side port of app.js's computeMatchupEdgeScore) ──────
// Usage-weighted average of how well a batter performs against each pitch type today's
// opposing pitcher actually throws, hand-adjusted by the batter's real split vs that
// pitcher's throwing hand -- the same 0-99 score shown as "MATCHUP EDGE" in the live
// site's Pitcher Matchup modal and as a sortable stat on the HR Threats board. Not used
// in scoreForMarket -- snapshotted onto captured HR Threat picks below
// purely so analyze-hr-matchups.mjs can check later whether it actually predicts real
// outcomes, same "measure before it's a scoring input" treatment as platoonFavorable.
function normalizePitchTypeKeyMatchupEdge(name) {
  const n2 = String(name || '').toLowerCase();
  if (n2.includes('four') || n2.includes('4-seam') || n2.includes('fastball')) return 'fastball';
  if (n2.includes('sinker') || n2.includes('2-seam') || n2.includes('two-seam')) return 'sinker';
  if (n2.includes('slider')) return 'slider';
  if (n2.includes('change')) return 'changeup';
  if (n2.includes('curve')) return 'curveball';
  if (n2.includes('cutter')) return 'cutter';
  if (n2.includes('split')) return 'splitter';
  if (n2.includes('sweep')) return 'sweeper';
  if (n2.includes('knuckle')) return 'knuckleball';
  return n2.replace(/[^a-z0-9]/g, '');
}
function gradePitchAdvantageServer(stat, usagePct) {
  if (!stat) return null;
  const xslg = stat.xslg ?? stat.xSLG ?? stat.expectedSlugging ?? null;
  const slg = stat.slg ?? stat.slugging ?? null;
  const avg = stat.avg ?? stat.battingAverage ?? null;
  const hr = n(stat.homeRuns ?? stat.hr ?? stat.hrs ?? 0);
  const hard = stat.hardHitPct ?? stat.hardHitRate ?? null;
  const barrel = stat.barrelPct ?? stat.barrelRate ?? null;
  let raw = 45;
  if (xslg != null) raw += (xslg - 0.400) * 75;
  else if (slg != null) raw += (slg - 0.400) * 60;
  if (avg != null) raw += (avg - 0.250) * 35;
  raw += Math.min(hr, 8) * 2.5;
  if (hard != null) raw += (hard - 38) * 0.45;
  if (barrel != null) raw += (barrel - 7) * 1.2;
  const usageBoost = Math.max(0, n(usagePct) - 15) * 0.15;
  return clamp(Math.round(raw + usageBoost), 1, 99);
}
// `split` here is battingSplitVsHand's return ({ab, avg, obp, slg} or null) -- already
// resolved to the right pitcher-hand split by the caller, unlike the client's version
// which searches an array of all splits by hand code. Same math either way.
function handAdjustedPitchStatServer(stat, splitHand, seasonAvg, seasonSlg, split) {
  const base = Object.assign({}, stat || {});
  if (!split || (splitHand !== 'L' && splitHand !== 'R')) return base;
  const splitAvg = split.avg, splitSlg = split.slg;
  const baseAvg = base.avg ?? base.battingAverage ?? null;
  const baseSlg = base.slg ?? base.slugging ?? null;
  const baseXslg = base.xslg ?? base.xSLG ?? base.expectedSlugging ?? null;
  const avgRatio = seasonAvg && splitAvg ? clamp(splitAvg / seasonAvg, 0.55, 1.55) : 1;
  const slgRatio = seasonSlg && splitSlg ? clamp(splitSlg / seasonSlg, 0.55, 1.65) : 1;
  if (baseAvg != null) base.avg = clamp(baseAvg * avgRatio, 0.050, 0.500);
  else if (splitAvg != null) base.avg = splitAvg;
  if (baseSlg != null) base.slg = clamp(baseSlg * slgRatio, 0.120, 1.050);
  else if (splitSlg != null) base.slg = splitSlg;
  if (baseXslg != null) base.xslg = clamp(baseXslg * slgRatio, 0.120, 1.100);
  return base;
}
function computeMatchupEdgeScore(pid, pitcherId, pitcherHand, seasonAvg, seasonSlg, split) {
  const pitches = pitcherByPitchRawCache?.get(String(pitcherId));
  const batterRows = batterPitchTypeRawCache?.get(String(pid));
  if (!pitches || !pitches.length || !batterRows || !batterRows.length) return null;
  let weighted = 0, weight = 0;
  pitches.forEach(p => {
    const usage = n(p.usagePct ?? p.usage ?? 0);
    if (usage <= 0) return;
    const key = normalizePitchTypeKeyMatchupEdge(p.name);
    const exact = batterRows.find(r => normalizePitchTypeKeyMatchupEdge(r.name) === key);
    if (!exact) return;
    const stat = handAdjustedPitchStatServer(exact, pitcherHand, seasonAvg, seasonSlg, split);
    const score = gradePitchAdvantageServer(stat, usage);
    if (score != null) { weighted += score * usage; weight += usage; }
  });
  return weight ? Math.round(weighted / weight) : null;
}

// Recording-only — see PITCHER_2K_SUPPRESSION_PATH comment above. Missing/unparseable
// file is expected on any day the sync step didn't run or wasn't wired up yet, so this
// fails silently to an empty map rather than warning like the two indexes above (those
// are load-bearing for scoring; this one isn't).
let pitcher2kSuppressionCache = null;
async function loadPitcher2kSuppressionIndex() {
  if (pitcher2kSuppressionCache) return pitcher2kSuppressionCache;
  pitcher2kSuppressionCache = new Map();
  try {
    const raw = await readFile(PITCHER_2K_SUPPRESSION_PATH, 'utf8');
    const data = JSON.parse(raw);
    for (const [id, p] of Object.entries(data?.pitchers || {})) {
      if (Number.isFinite(p?.suppressionDeltaPct)) pitcher2kSuppressionCache.set(String(id), p.suppressionDeltaPct);
    }
  } catch {
    // no-op — see comment above
  }
  return pitcher2kSuppressionCache;
}

// Real today's-slate leagueAvgBFperStart, computed server-side by the sync script
// itself off reliable-sample starters -- see that script's own header for why. Set
// by loadPitcherWorkloadIndex below; hardcoded fallback only for a day the file
// hasn't synced yet or came back with no reliable samples at all, same fallback
// value app.js's client-side port uses for consistency between the two.
let pitcherWorkloadLeagueAvgBF = 23;
let pitcherWorkloadCache = null;
async function loadPitcherWorkloadIndex() {
  if (pitcherWorkloadCache) return pitcherWorkloadCache;
  pitcherWorkloadCache = new Map();
  try {
    const raw = await readFile(PITCHER_WORKLOAD_PATH, 'utf8');
    const data = JSON.parse(raw);
    for (const [id, p] of Object.entries(data?.pitchers || {})) {
      if (Number.isFinite(p?.avgBFperStart)) pitcherWorkloadCache.set(String(id), p);
    }
    if (data?.leagueAvgBFperStart > 0) pitcherWorkloadLeagueAvgBF = data.leagueAvgBFperStart;
  } catch {
    // no-op — file not yet synced this run; every row falls back to a neutral share
  }
  return pitcherWorkloadCache;
}

let bullpenHrRateCache = null;
async function loadBullpenHrRateIndex() {
  if (bullpenHrRateCache) return bullpenHrRateCache;
  bullpenHrRateCache = new Map();
  try {
    const raw = await readFile(BULLPEN_HR_RATE_PATH, 'utf8');
    const data = JSON.parse(raw);
    for (const [abbr, t] of Object.entries(data?.teams || {})) {
      if (Number.isFinite(t?.shrunkRate)) bullpenHrRateCache.set(abbr, t);
    }
  } catch {
    // no-op — file not yet synced this run; every row falls back to league average
  }
  return bullpenHrRateCache;
}

// Converts an aggregate xSLG/hard-hit% into a bounded multiplier on the corresponding
// box-score HR rate -- generic over both sides of the matchup: for a batter, >1 means
// Statcast reads them as hitting the ball harder than their AVG/SLG outcomes alone
// would suggest; for a pitcher (statcast = contact ALLOWED), >1 means they're
// surrendering harder contact than their AVG/SLG-allowed suggests. Clamped to keep a
// small sample or one outlier metric from swinging the rate too far in either
// direction; box score AVG/SLG/HR still carries the majority (0.6/0.4 split) weight
// in scoreForMarket.
function battedBallPowerIndex(statcast) {
  // loadStatcastPowerIndex/loadPitcherStatcastPowerIndex already exclude thin samples
  // from their caches, but check independently here too so this function is correct
  // for any caller, not just one that's pre-filtered its input.
  if (!statcast || !(statcast.pitches >= STATCAST_MIN_PITCHES)) return 1;
  const ratios = [];
  if (statcast.xslg != null) ratios.push(statcast.xslg / LEAGUE_AVG_XSLG);
  if (statcast.hardHitPct != null) ratios.push(statcast.hardHitPct / LEAGUE_AVG_HARD_HIT_PCT);
  if (!ratios.length) return 1;
  const avgRatio = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  return clamp(avgRatio, 0.7, 1.5);
}

// Zone-matchup correction -- exact port of app.js's own copy of this function (kept as
// two independent copies, same reasoning as battedBallPowerIndex above: one client, one
// server, no shared module between them). Real per-zone wOBA overlap between a batter's
// own hot zones (batterZoneCache/batterZoneByHandCache) and a pitcher's own weak zones
// (pitcherZoneCache/pitcherZoneByHandCache), both from the same real Statcast zone sync
// already driving the live matchup modal's Strike Zone Matchup grid. Same ratio-to-
// league-average + clamp shape as battedBallPowerIndex, averaged over whichever of the 9
// real zones both sides have data for. Neutral (1x) below MIN_ZONE_OVERLAP shared zones.
const ZONE_LEAGUE_AVG_WOBA = 0.320; // matches the /0.640 normalization the Strike Zone
                                     // Matchup grid already uses (0.320/0.640 = 0.5 = "OK")
const MIN_ZONE_OVERLAP = 4; // of 9 real Statcast zones
function zoneMatchupMultiplier(batterZoneMap, pitcherZoneMap) {
  if (!batterZoneMap || !pitcherZoneMap) return 1;
  const ratios = [];
  for (let z = 1; z <= 9; z++) {
    const bCell = batterZoneMap[z], pCell = pitcherZoneMap[z];
    if (!bCell || !pCell) continue;
    const bVal = bCell.xwobaContact ?? bCell.woba ?? bCell.xwoba ?? bCell.wobaAgainst;
    const pVal = pCell.xwobaContact ?? pCell.wobaAgainst ?? pCell.xwoba ?? pCell.woba;
    if (bVal == null || pVal == null) continue;
    ratios.push(((bVal + pVal) / 2) / ZONE_LEAGUE_AVG_WOBA);
  }
  if (ratios.length < MIN_ZONE_OVERLAP) return 1;
  const avgRatio = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  return clamp(avgRatio, 0.85, 1.15);
}

// Zone Fit -- exact port of app.js's own zoneValsFromByZone/computeZoneFit (same "two
// independent copies, no shared module" reasoning as zoneMatchupMultiplier above). Real
// per-zone xwOBA-against overlap with the batter's pull side + power profile, snapshotted
// at pick time (see captureHRThreatToday below) so a later analysis pass can check
// whether the live client's "Strong Zone Fit"/"Elite Zone Fit" labels actually predict
// more real HRs -- score/label only here, the display-only topNames/read/tone fields the
// client also returns aren't needed for tracking.
function zoneValsFromByZoneServer(zMap) {
  if (!zMap) return null;
  const vals = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(z => {
    const cell = zMap[z];
    if (!cell) return null;
    const val = cell.xwobaContact ?? cell.wobaAgainst ?? cell.xwoba ?? cell.woba;
    return val != null ? Math.min(val / 0.640, 1.0) : null;
  });
  return vals.every(v => v == null) ? null : vals;
}
function computeZoneFitServer(zoneVals, batterHand, batterISO) {
  if (!zoneVals) return null;
  const weights = zoneVals.map((v, i) => ({ i, v: v ?? 0 })).sort((a, b) => b.v - a.v);
  const topZones = weights.slice(0, 3);
  const elevated = topZones.some(z => z.i <= 2);
  const middle = topZones.some(z => z.i === 4);
  const pullSide = batterHand === 'L' ? [2, 5, 8] : batterHand === 'R' ? [0, 3, 6] : [0, 2, 3, 5, 6, 8];
  const pullMatch = topZones.some(z => pullSide.includes(z.i));
  const avgTop = topZones.reduce((sum, z) => sum + z.v, 0) / Math.max(1, topZones.length);
  const powerBoost = Math.max(0, Math.min(12, ((batterISO || 0) - 0.170) * 70));
  const fitScore = Math.max(1, Math.min(99, Math.round(avgTop * 72 + (elevated ? 8 : 0) + (middle ? 7 : 0) + (pullMatch ? 7 : 0) + powerBoost)));
  const fitLabel = fitScore >= 85 ? 'Elite Zone Fit' : fitScore >= 72 ? 'Strong Zone Fit' : fitScore >= 58 ? 'Playable Zone Fit' : 'Pitcher Zone Edge';
  return { score: fitScore, label: fitLabel };
}

// Wind is one of the single biggest real per-game HR factors -- a strong wind blowing
// out can matter more than any other adjustment in this file. MLB's schedule endpoint
// returns it (when hydrate=weather is requested) as a free-text field, typically
// something like "10 mph, Out To CF" or "5 mph, In From LF". NOTE: this sandbox has no
// live network access to MLB's API, so the exact field name/wording couldn't be
// verified against a real response here -- parsed defensively (case-insensitive,
// tolerant of "Varies"/"Calm"/missing data) so anything unrecognized safely falls back
// to neutral (1x) instead of throwing or silently corrupting a score. Validate the
// parsed values look sane against real games once this runs live (e.g. temporarily log
// weather.wind alongside the computed factor) before trusting it fully.
const WIND_MAX_BOOST = 1.25; // ceiling: +25% for a strong wind blowing out
const WIND_MAX_SUPPRESS = 0.80; // floor: -20% for a strong wind blowing in
const WIND_REFERENCE_SPEED = 20; // mph -- effect scales linearly up to this, then caps
function windPowerFactor(weather) {
  const windStr = String(weather?.wind || '').trim();
  if (!windStr) return 1;
  const speedMatch = windStr.match(/(\d+(?:\.\d+)?)\s*mph/i);
  const speed = speedMatch ? Number(speedMatch[1]) : 0;
  if (!speed) return 1; // "Calm", "Varies", or a shape this doesn't recognize
  const lower = windStr.toLowerCase();
  let direction = 0; // -1 = blowing in (suppresses), 0 = crosswind/unclear, 1 = out (boosts)
  if (/\bout\b/.test(lower)) direction = 1;
  else if (/\bin\b/.test(lower)) direction = -1;
  if (direction === 0) return 1;
  const strength = Math.min(speed, WIND_REFERENCE_SPEED) / WIND_REFERENCE_SPEED;
  return direction > 0
    ? 1 + strength * (WIND_MAX_BOOST - 1)
    : 1 - strength * (1 - WIND_MAX_SUPPRESS);
}

// Warmer air is less dense, so a batted ball carries further -- a real, well-documented
// (if smaller than wind's) per-game HR factor. Reuses the exact same hydrate=weather
// fetch already added for wind (weather.temp, alongside weather.wind), so this is free
// -- no extra API call. Same sandbox caveat as wind: no live network access here to
// verify the exact field shape, so this is defensive and falls back to neutral for
// anything unparseable.
const TEMP_REFERENCE_F = 70; // roughly neutral game-time temperature
const TEMP_EFFECT_PER_10F = 0.03; // +/-3% per 10 degrees F away from reference
const TEMP_MAX_DELTA_F = 30; // clamps the degree difference before applying, so one
                              // extreme/bad reading can't blow past a sane range
function temperaturePowerFactor(weather) {
  const raw = weather?.temp;
  if (raw == null || raw === '') return 1;
  // Require an actual digit before parsing -- Number('') is 0 (not NaN), so a
  // non-numeric string like "roof closed" (dome/indoor games) would otherwise silently
  // parse as 0 degrees instead of correctly falling back to neutral.
  const match = String(raw).match(/-?\d+(?:\.\d+)?/);
  if (!match) return 1;
  const temp = Number(match[0]);
  if (!Number.isFinite(temp)) return 1;
  const delta = clamp(temp - TEMP_REFERENCE_F, -TEMP_MAX_DELTA_F, TEMP_MAX_DELTA_F);
  return 1 + (delta / 10) * TEMP_EFFECT_PER_10F;
}

// ── Rest/fatigue ──
// Real, measurable proxies for physical fatigue -- deliberately NOT an attempt at
// modeling "clutch"/mental toughness/motivation, which sabermetric research has
// consistently found mostly doesn't hold up as a repeatable individual skill separate
// from overall talent (it looks real in small samples and vanishes in larger ones).
// This only scores what's actually observable from the schedule: extended stretches
// without a day off, a day game immediately after a night game ("getaway day"), and
// the second game of a doubleheader all measurably degrade bat speed/timing.
const FATIGUE_LOOKBACK_DAYS = 10;
const FATIGUE_NO_REST_STREAK_MIN = 7; // consecutive played days before it counts as real fatigue
const FATIGUE_STREAK_FACTOR = 0.95; // -5% for an extended no-rest streak
const FATIGUE_GETAWAY_FACTOR = 0.97; // -3% for a day game right after a night game
const FATIGUE_DOUBLEHEADER_G2_FACTOR = 0.94; // -6% for game 2 of a doubleheader
const DAY_GAME_HOUR_CT = 17; // matches the existing day/night cutoff used in computeDRPick

function isDayGameCT(gameDateIso) {
  const hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/Chicago' }).format(new Date(gameDateIso)));
  return hour < DAY_GAME_HOUR_CT;
}

// Doubleheader game 2 is free to detect -- it's right on today's own game object, no
// extra fetch needed. The no-rest-streak and getaway-day checks need the team's recent
// schedule, so they're fetched (and cached) once per team per day in
// teamRestFatigueFactor below, not once per batter.
function doubleheaderFatigueFactor(g) {
  const isG2 = g?.doubleHeader && g.doubleHeader !== 'N' && Number(g.gameNumber) === 2;
  return isG2 ? FATIGUE_DOUBLEHEADER_G2_FACTOR : 1;
}

const teamRestFatigueCache = new Map();
async function teamRestFatigueFactor(teamId, todayGameDateIso) {
  const today = cdtDateString(new Date(todayGameDateIso));
  const cacheKey = `${teamId}|${today}`;
  if (teamRestFatigueCache.has(cacheKey)) return teamRestFatigueCache.get(cacheKey);

  let factor = 1;
  try {
    const start = cdtDateString(new Date(new Date(todayGameDateIso).getTime() - FATIGUE_LOOKBACK_DAYS * 86400000));
    const sched = await fetchJSON(`${API}/schedule?sportId=1&teamId=${teamId}&startDate=${start}&endDate=${today}`);
    const gamesByDate = new Map();
    (sched?.dates || []).forEach(d => {
      const played = (d.games || []).filter(g => g.status?.abstractGameState !== 'Cancelled' && g.status?.abstractGameState !== 'Postponed');
      if (played.length) gamesByDate.set(d.date, played);
    });

    // Walk backward from the day before today, counting consecutive played days.
    let streak = 0;
    let cursor = new Date(new Date(todayGameDateIso).getTime() - 86400000);
    for (let i = 0; i < FATIGUE_LOOKBACK_DAYS; i++) {
      const key = cdtDateString(cursor);
      if (!gamesByDate.has(key)) break;
      streak++;
      cursor = new Date(cursor.getTime() - 86400000);
    }
    if (streak >= FATIGUE_NO_REST_STREAK_MIN) factor *= FATIGUE_STREAK_FACTOR;

    const yesterdayKey = cdtDateString(new Date(new Date(todayGameDateIso).getTime() - 86400000));
    const yesterdayGames = gamesByDate.get(yesterdayKey) || [];
    const yesterdayWasNight = yesterdayGames.some(g => !isDayGameCT(g.gameDate));
    if (yesterdayWasNight && isDayGameCT(todayGameDateIso)) factor *= FATIGUE_GETAWAY_FACTOR;
  } catch (e) {
    // Leave factor neutral (1) on any fetch/parse failure -- never block scoring on this.
  }

  teamRestFatigueCache.set(cacheKey, factor);
  return factor;
}

// HR Threats board hit-rate tracker: the live client-side board (app.js, getHRRows) gates
// its "scanned" pool at hrProb>=18, except the single top-scoring batter per game which
// gets a lower 14% bar. This backend job uses one uniform 18% cutoff across the whole
// pool — a known, deliberate simplification (skips the tiny per-game 14% carve-out) so
// the daily scanned/hit counts are simple to reason about and don't require re-deriving
// per-game rankings. Same buildBatterPool/scoreForMarket('hr', ...) model as Elite
// Picks, just applied to every qualifying batter instead of the top 3 per game.
const HR_THREAT_MIN_SCORE = 18;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function shrinkToLeague(raw, ab, leagueAvg, minAB = 40) {
  const w = Math.min(ab, minAB) / minAB;
  return raw * w + leagueAvg * (1 - w);
}

// Real, independently-computable "hot" proxy (no Statcast sync available
// server-side): recent AVG meaningfully above season AVG, or multiple real
// home runs within the last 10 games.
//
// v2: the original `recent.hr >= 1` branch was nowhere near selective enough
// -- a single home run somewhere in a ~10-game window is close to the norm
// for a healthy everyday hitter, not a notable trend. Confirmed directly: on
// a normal slate this fired for 158 of 163 real Diamond Report Headlines
// (generate-headlines.mjs's buildTrendHeadlines uses this exact flag to pick
// the "X is running hot" title), which is the opposite of a selective signal.
// Raised both bars to require a real, meaningfully hot stretch: 2+ real home
// runs (not 1) in the recent window, or a real 50-point (not 30-point) AVG
// jump over the season baseline -- both genuinely uncommon over a ~15-30 AB
// sample, unlike the old thresholds.
function computeIsHot(recent, seasonAvg) {
  if (!recent || recent.ab < 15) return false;
  const avgSurge = recent.avg != null && recent.avg >= seasonAvg + 0.050;
  const realPowerSurge = (recent.hr || 0) >= 2;
  return avgSurge || realPowerSurge;
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

// Mirrors the client-side buildBatterModel exactly (app.js, __DR_MONTE_CARLO__), including
// the pitcher-quality and park-factor blends — kept in sync so this backend grades the
// same model the live site actually shows, not a drifted approximation of it.
function buildBatterModel(row) {
  const avg = clamp(row.avg ?? 0.245, 0.12, 0.4);
  const obp = clamp(row.obp ?? avg + 0.065, avg, 0.5);
  const slg = clamp(row.slg ?? avg + 0.155, avg, 0.8);

  const PITCHER_WEIGHT = 0.35;
  const pitcherAvgAllowed = clamp(row.pitcherAvgAllowed ?? avg, 0.18, 0.32);
  const pitcherSlgAllowed = clamp(row.pitcherSlgAllowed ?? slg, 0.3, 0.55);
  const bAvg = avg * (1 - PITCHER_WEIGHT) + pitcherAvgAllowed * PITCHER_WEIGHT;
  const obpGap = Math.max(0, obp - avg);
  const bObp = clamp(bAvg + obpGap, bAvg, 0.5);
  const bSlg = slg * (1 - PITCHER_WEIGHT) + pitcherSlgAllowed * PITCHER_WEIGHT;

  const parkAdj = 1 + (((row.parkFactor ?? 100) - 100) / 100) * 0.5;
  const pSlg = clamp(bAvg + (bSlg - bAvg) * parkAdj, bAvg, 0.9);

  const pHit = bAvg * MC_AB_PER_PA;
  const pWalk = Math.max(0, bObp - pHit);
  const seasonAB = row.atBats || 0;
  const seasonHR = row.hrSeason || 0;
  const hrRatePerPA = seasonAB > 0 ? (seasonHR / seasonAB) * MC_AB_PER_PA : pHit * 0.11;
  // Same weather (row.weatherHRMult, set by buildBatterPool) and quality-of-contact
  // (battedBallPowerIndex/shrinkMult off row.statcast, already used by scoreForMarket('hr')
  // and computeLiveHRScore) corrections app.js's buildBatterModel now applies client-side —
  // kept in sync per this function's own header comment. Both default to neutral (1).
  const battedBallMult = shrinkMult(battedBallPowerIndex(row.statcast));
  const pHR = clamp(hrRatePerPA * battedBallMult * parkAdj * (row.weatherHRMult ?? 1), 0, pHit * 0.55);
  const hitBudget = Math.max(0, pHit - pHR);
  const extraBaseBudget = Math.max(0, (pSlg - bAvg) * MC_AB_PER_PA - pHR * 3);
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
  // pitcherSbAllowed/pAtt is the real SUCCESS RATE of steal attempts against this
  // battery -- high means a WEAK battery (runners usually succeed against him),
  // low means a STRONG one (good pop time / catcher arm, runners get thrown out).
  // A weak battery should make stealing MORE attractive (raise the multiplier
  // above 1); a strong one should deter it (multiplier below 1). This was
  // inverted (1 - delta instead of 1 + delta), so a strong battery was boosting
  // predicted SB odds and a weak one was suppressing them -- backwards.
  const batterySuppression = pAtt >= 5 ? clamp(1 + ((row.pitcherSbAllowed / pAtt) - 0.72) * 0.6, 0.7, 1.3) : 1;
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

// "At least one HR across N independent plate appearances at a constant per-PA
// rate" has an exact closed-form probability (1 - (1-p)^N) — no need to simulate
// it with Math.random(). gamePA itself was randomized around the base PA
// estimate (pa ± 0.8, uniform), so paDistribution() computes the exact
// probability of each possible PA count instead of sampling it, and the final
// probability is the weighted average of 1-(1-p)^PA across that distribution.
// Verified against the old 50,000-trial Monte Carlo output — matches exactly.
// Matches the same fix in app.js (window.simulateHRGameOdds).
function paDistribution(pa) {
  const lo = pa - 0.8, hi = pa + 0.8;
  const kMin = Math.floor(lo - 0.5), kMax = Math.ceil(hi + 0.5);
  const dist = {};
  for (let k = Math.max(1, kMin); k <= kMax; k++) {
    const segLo = Math.max(lo, k - 0.5);
    const segHi = Math.min(hi, k + 0.5);
    const overlap = Math.max(0, segHi - segLo);
    if (overlap > 0) {
      const kk = Math.max(1, k);
      dist[kk] = (dist[kk] || 0) + overlap / 1.6;
    }
  }
  return dist;
}
// Set by every simulateHRGameOdds call to record which path produced its return value
// -- captureHRThreatToday reads this immediately after calling scoreForMarket('hr', ...)
// to snapshot hrScoreSource onto the captured row, the same "measure which formula
// actually drove this real outcome" discipline as every other snapshot field there.
let __hrLastScoreSource = 'legacy';
function simulateHRGameOdds(pPerPA, battingOrder, logisticFeatures) {
  // Fitted logistic model (see predictHRLogistic above) wins on every cross-validated
  // metric against the legacy simulation+calibrateHRProb path below -- tried first,
  // falling through to the legacy path unchanged whenever its inputs aren't all
  // available (model not yet loaded, or a feature genuinely missing for this row).
  const logisticP = logisticFeatures ? predictHRLogistic(logisticFeatures) : null;
  __hrLastScoreSource = logisticP != null ? 'logistic' : 'legacy';
  if (logisticP != null) return logisticP;
  pPerPA = clamp(pPerPA || 0.03, 0, 0.5);
  const dist = paDistribution(estimatePA(battingOrder));
  let prob = 0;
  for (const k in dist) { prob += dist[k] * (1 - Math.pow(1 - pPerPA, Number(k))); }
  // Was hard-capped at 25 with no floor, unlike every other market's 1-99 range —
  // real per-game HR probability for a genuinely elite matchup can exceed 25%, so
  // the old cap flattened great and mediocre matchups into the same narrow band
  // and made ranking/selection nearly meaningless. See analyze-hr-matchups.mjs.
  //
  // calibrateHRProb (below) applies a real, evidence-tuned final correction here --
  // analyze-hr-matchups.mjs's calibration report showed the raw simulated
  // probability above is systematically overconfident, and increasingly so at the
  // high end (the 30%+ bucket predicted 33.2% but actually hit only 15.1% --
  // roughly 2x overstated), a compounding-overconfidence signature: several of
  // the individually-shrunk multipliers feeding hrPerPA above tend to move
  // together for the same real underlying "good matchup," so multiplying them
  // double-counts one real signal as several. shrinkMult already dampens each
  // factor individually; this is the missing final step that recalibrates the
  // combined OUTPUT against real observed outcomes, same "measure, then
  // correct" discipline as shrinkMult/tune-model-params.mjs, applied at the one
  // choke point every HR probability (server score, live-score snapshot, and
  // the identical client formula in app.js) already passes through.
  return Math.max(1, Math.min(99, Math.round(calibrateHRProb(prob * 100))));
}

// A pitcher's box-score HR/9 is allowed-per-9-innings, i.e. per 27 outs -- but a
// pitcher actually faces more batters than that per 9 innings, since everyone who
// reaches base (hit/walk/HBP) adds a batter faced without adding an out. ~38 is a
// realistic MLB-average batters-faced-per-9 (27 outs + ~11 baserunners allowed per
// WHIP), used as a fallback when a specific pitcher's own real batters-faced-per-9
// (see pitcherBattersFacedPer9 below) isn't available. Dividing by 27 instead of a
// realistic per-batter denominator overstated the pitcher's true HR-per-batter rate
// by about 40%.
const BATTERS_FACED_PER_9 = 38;
// Sanity bounds for a pitcher's own computed batters-faced-per-9 -- guards against a
// single bad/incomplete API response (e.g. a partial-season stat line) producing a
// wildly unrealistic denominator that would swing pitcherRate too far in either
// direction. Real MLB starters/relievers essentially always fall within this range.
const BF_PER_9_MIN = 30, BF_PER_9_MAX = 46;

// MLB's inningsPitched is a string like "63.2" where the digit after the decimal is
// THIRDS of an inning (.0/.1/.2), not a decimal fraction -- "63.2" means 63 and 2/3
// innings, not 63.2 innings. Parsing it as a plain float (as elsewhere in this
// codebase, e.g. the DRP model's team-IP totals) is a common, easy-to-miss mistake.
function parseInningsPitched(ip) {
  const s = String(ip ?? '').trim();
  if (!s) return 0;
  const [wholeStr, thirdStr] = s.split('.');
  const whole = Number(wholeStr) || 0;
  const third = Number(thirdStr || 0);
  return whole + (third === 1 ? 1 / 3 : third === 2 ? 2 / 3 : 0);
}

// A specific pitcher's own real batters-faced-per-9, when the season stat line has
// enough innings to trust it -- more accurate than the league-average
// BATTERS_FACED_PER_9 fallback, since a control pitcher who rarely walks anyone faces
// meaningfully fewer batters per 9 innings than a wild one who's constantly working
// out of traffic.
const PITCHER_BF_MIN_IP = 10;
function pitcherBattersFacedPer9(pitcherStat) {
  const bf = n(pitcherStat?.battersFaced);
  const ip = parseInningsPitched(pitcherStat?.inningsPitched);
  if (bf <= 0 || ip < PITCHER_BF_MIN_IP) return null;
  const rate = (bf / ip) * 9;
  return (rate >= BF_PER_9_MIN && rate <= BF_PER_9_MAX) ? rate : null;
}

// scripts/analyze-hr-matchups.mjs, run 2026-07-20 against the 362 HR Threat picks
// graded so far, found a statistically significant (z=2.26, p<0.05) calibration
// inversion: picks scored 22%+ hit at 6.5% actual, while picks scored under 22% hit
// at 14.3% actual -- backwards from what a well-calibrated model should show. The HR
// branch below stacks up to five independent multipliers (batter Statcast power,
// fatigue, home/road, pitcher Statcast power, wind, temperature) with no shrinkage on
// the composite -- each is individually reasonable and bounded, but a pick where
// several happen to line up favorably by chance compounds into an overconfident score.
// This dampens each multiplier's deviation from neutral (1.0) rather than removing any
// of them, so direction/relative ranking are preserved, just the compounding is damped.
//
// The shrinkage factor itself lives in data/model-params.json, not as a hardcoded
// constant here -- scripts/tune-model-params.mjs (run weekly, see
// .github/workflows/calibration-report.yml) re-checks calibration against newly graded
// picks and nudges it in small, bounded steps, gated behind a minimum sample size and
// statistical-significance bar, with every check (adjusted or not) logged to
// data/model-tuning-log.json. Keeping the tunable value in a data file rather than
// letting a scheduled job rewrite this source file means an auto-tune is always just a
// JSON diff -- inspectable and revertable exactly like every other bot-updated data file
// in this repo, never a silent source change. DEFAULT_MODEL_PARAMS is the fallback if
// that file is ever missing/unreadable, and is what a fresh checkout starts from.
const MODEL_PARAMS_PATH = path.join(__dirname, '..', 'data', 'model-params.json');
// HR_SCORE_CALIBRATION_SLOPE/INTERCEPT: a final linear recalibration of the
// whole simulated HR probability (calibrateHRProb below), separate from
// HR_MULT_SHRINKAGE above -- shrinkage dampens each individual input
// multiplier, this corrects the COMBINED output against real observed
// outcomes. Defaults (slope=1, intercept=0) are the identity transform --
// this ships behavior-neutral; scripts/tune-model-params.mjs's own
// calibration check is what earns the right to move these, the same "measure
// first, only the auto-tuner touches a live value" discipline as
// HR_MULT_SHRINKAGE.
const DEFAULT_MODEL_PARAMS = { HR_MULT_SHRINKAGE: 0.6, HR_SCORE_CALIBRATION_SLOPE: 1, HR_SCORE_CALIBRATION_INTERCEPT: 0 };
let modelParams = { ...DEFAULT_MODEL_PARAMS };
async function loadModelParams() {
  try {
    const raw = await readFile(MODEL_PARAMS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    modelParams = { ...DEFAULT_MODEL_PARAMS, ...(parsed.params || {}) };
  } catch (e) {
    // Missing/invalid file -- fall back to the documented default rather than
    // throwing; a capture/grade run must never be blocked by this.
  }
}
function shrinkMult(m) {
  return 1 + (m - 1) * modelParams.HR_MULT_SHRINKAGE;
}
// Real linear recalibration (y = intercept + slope*x) of the raw simulated HR
// probability, fit by scripts/tune-model-params.mjs against real graded
// outcomes -- see simulateHRGameOdds's own comment for why this exists
// alongside shrinkMult instead of replacing it. slope=1/intercept=0 (the
// shipped default until the auto-tuner has enough evidence to move them) is
// exactly the identity transform, so this is a no-op until real data justifies
// otherwise.
function calibrateHRProb(rawPct) {
  return modelParams.HR_SCORE_CALIBRATION_INTERCEPT + modelParams.HR_SCORE_CALIBRATION_SLOPE * rawPct;
}

// Fitted logistic-regression alternative to the calibrateHRProb linear correction above
// -- see scripts/fit-hr-logistic-model.mjs for the fit and data/hr-logistic-model.json
// for the persisted coefficients. Cross-validated against the same graded picks the
// legacy formula's own score was checked on, it wins on every metric (AUC 0.546 vs
// 0.487, Brier 0.117 vs 0.125, log-loss 0.395 vs 0.420). Exact port of app.js's own
// copy of this function (same two-independent-copies convention as shrinkMult/
// calibrateHRProb above). Returns null (never throws) when the model hasn't loaded or
// a required feature is missing, so simulateHRGameOdds below can fall back to the
// legacy path exactly as if this didn't exist.
const HR_LOGISTIC_MODEL_PATH = path.join(__dirname, '..', 'data', 'hr-logistic-model.json');
let hrLogisticModel = null;
async function loadHRLogisticModel() {
  try {
    const raw = await readFile(HR_LOGISTIC_MODEL_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.coefficients) hrLogisticModel = parsed;
  } catch (e) {
    // Missing/invalid file -- leave hrLogisticModel null, same graceful-fallback
    // discipline as loadModelParams above.
  }
}
function predictHRLogistic(features) {
  const model = hrLogisticModel;
  if (!model || !model.coefficients) return null;
  // Reads model.features itself rather than a hardcoded field list, so a future refit
  // that adds/removes a predictor (e.g. matchupEdge, zoneFitScore) works everywhere
  // this is called without another code change -- only the caller supplying the raw
  // feature values needs to know what's actually in this particular model. Exact port
  // of app.js's own copy of this function.
  const c = model.coefficients, means = model.featureMeans, stds = model.featureStds;
  const raw = {};
  for (const f of model.features) {
    if (f === 'isOnFire') { raw[f] = (features && features.isOnFire) ? 1 : 0; continue; }
    const v = features ? features[f] : undefined;
    if (!Number.isFinite(v)) return null;
    raw[f] = v;
  }
  let z = c.intercept;
  for (const f of model.features) {
    const std = (raw[f] - means[f]) / (stds[f] || 1);
    z += c[f] * std;
  }
  const p = 1 / (1 + Math.exp(-z));
  return Math.max(1, Math.min(99, Math.round(p * 100)));
}

// ── Live client HR score (exact port of app.js's HR Threats formula) ──────────────
// scoreForMarket('hr') above is this file's OWN, more sophisticated HR scoring, used
// for actual pick selection/grading -- but it's never been what a site visitor sees.
// The live board runs a separate, simpler client-side formula (loadHRPotential in
// app.js). computeLiveHRScore below is a line-for-line port of that formula (not a
// rewrite/approximation) purely so captureHRThreatToday can snapshot it alongside the
// real `score`, letting analyze-hr-matchups.mjs calibration-check what users actually
// see instead of only this file's internal scoring. See app.js's
// buildFallbackHotHitterProfile/getStatcastHotHitterProfile/loadHRPotential (the
// hrPerPA/hotMult block) for the original this mirrors.
function liveFallbackHotHitterProfile(ops, iso, last10HR, isFavorable) {
  return clamp(
    (ops >= .900 ? 22 : ops >= .820 ? 16 : ops >= .760 ? 10 : 0) +
    (iso >= .260 ? 22 : iso >= .210 ? 16 : iso >= .170 ? 9 : 0) +
    (last10HR >= 3 ? 26 : last10HR >= 2 ? 18 : last10HR >= 1 ? 10 : 0) +
    // streakDays (consecutive-day HR streak) isn't computed by buildBatterPool --
    // this file has no equivalent input -- so that addend (up to +14 client-side) is
    // deliberately omitted rather than faked. A small, known conservative gap versus
    // the real client score, only for players without live-repo Statcast coverage.
    (isFavorable ? 10 : 0), 0, 100
  );
}
function liveOnFireScore(row, statcastHotHitters) {
  const fromRepo = statcastHotHitters.get(String(row.id)) || statcastHotHitters.get(String(row.name || '').toLowerCase());
  const ops = row.ops || 0;
  const iso = row.iso || 0;
  if (!fromRepo) return liveFallbackHotHitterProfile(ops, iso, row.last10HR || 0, !!row.isFavorable);
  const xwobaTrend = n(fromRepo.xwobaTrend), hardHitTrend = n(fromRepo.hardHitTrend);
  const sweetSpotTrend = n(fromRepo.sweetSpotTrend), barrelTrend = n(fromRepo.barrelTrend);
  const batSpeedTrend = n(fromRepo.batSpeedTrend), blastTrend = n(fromRepo.blastTrend);
  const xwoba = n(fromRepo.xwoba), hardHit = n(fromRepo.hardHitPct), sweetSpot = n(fromRepo.sweetSpotPct);
  const barrel = n(fromRepo.barrelPct), batSpeed = n(fromRepo.batSpeed), blastRate = n(fromRepo.blastRate);
  const avgExitVelo = n(fromRepo.avgExitVelo), recentOpsTrend = n(fromRepo.recentOpsTrend);
  const pullPct = n(fromRepo.pullPct), fbPct = n(fromRepo.fbPct), ldPct = n(fromRepo.ldPct);
  return clamp(
    (xwoba >= .420 ? 18 : xwoba >= .370 ? 13 : xwoba >= .330 ? 7 : 0) +
    (xwobaTrend >= .060 ? 15 : xwobaTrend >= .030 ? 10 : xwobaTrend >= .015 ? 5 : 0) +
    (hardHit >= 52 ? 14 : hardHit >= 45 ? 10 : hardHit >= 40 ? 5 : 0) +
    (hardHitTrend >= 10 ? 12 : hardHitTrend >= 5 ? 8 : hardHitTrend >= 2 ? 4 : 0) +
    (sweetSpot >= 40 ? 9 : sweetSpot >= 34 ? 6 : sweetSpot >= 30 ? 3 : 0) +
    (sweetSpotTrend >= 8 ? 8 : sweetSpotTrend >= 4 ? 5 : sweetSpotTrend >= 2 ? 2 : 0) +
    (barrel >= 15 ? 10 : barrel >= 10 ? 7 : barrel >= 7 ? 3 : 0) +
    (barrelTrend >= 5 ? 7 : barrelTrend >= 2 ? 4 : 0) +
    (batSpeed >= 75 ? 5 : batSpeed >= 72 ? 3 : 0) +
    (batSpeedTrend >= 1.5 ? 5 : batSpeedTrend >= .7 ? 3 : 0) +
    (blastRate >= 18 ? 5 : blastRate >= 12 ? 3 : 0) +
    (blastTrend >= 5 ? 5 : blastTrend >= 2 ? 3 : 0) +
    (recentOpsTrend >= .150 ? 15 : recentOpsTrend >= .080 ? 10 : recentOpsTrend >= .040 ? 5 : 0) +
    (pullPct >= 40 && fbPct >= 38 ? 8 : pullPct >= 45 ? 6 : pullPct >= 38 ? 3 : 0) +
    (ldPct >= 25 ? 3 : ldPct >= 21 ? 1 : 0) +
    (avgExitVelo >= 91 ? 6 : avgExitVelo >= 89 ? 3 : 0), 0, 100
  );
}
// Mirrors app.js's loadHRPotential hrPerPA/hrProb block: batterRate (shrunk box-score
// HR/AB) blended with pitcherRate (HR/9-derived) and bullpenRate (real relievers-only
// HR-allowed rate, see BULLPEN_HR_RATE_PATH), workload-share-weighted so a quick-hook
// starter's discounted weight goes to the bullpen instead of just inflating the
// batter's own rate, then park/zone-matchup-adjusted and the hot-hitter read folded in
// as a bounded rate multiplier (shrunk by the same HR_MULT_SHRINKAGE this file already
// auto-tunes) before simulateHRGameOdds runs -- same formula already shipped
// client-side for the score-bucket ranking problem the calibration report surfaced.
const HRP_MIN_AB_FOR_RATE = 40;
const HRP_LEAGUE_AVG_HR_RATE = 0.031;
function computeLiveHRScore(row, statcastHotHitters, weatherHRMult = 1) {
  const ab = row.atBats || 0, hr = row.hrSeason || 0;
  const sampleWeight = Math.min(ab, HRP_MIN_AB_FOR_RATE) / HRP_MIN_AB_FOR_RATE;
  const rawBatterRate = ab > 0 ? hr / ab : 0;
  const boxScoreBatterRate = ((rawBatterRate * sampleWeight) + (HRP_LEAGUE_AVG_HR_RATE * (1 - sampleWeight))) * 0.88;
  // Quality-of-contact correction -- same battedBallPowerIndex/shrinkMult this file's
  // own scoreForMarket already applies, and the exact signal the live client formula
  // this function mirrors now also applies (see app.js's loadHRPotential). row.statcast
  // is already populated by buildBatterPool from the same statcastIndex
  // scoreForMarket uses, so this needs no separate data source.
  const batterRate = boxScoreBatterRate * shrinkMult(battedBallPowerIndex(row.statcast));
  const pitcherRate = row.pitcherHr9 > 0 ? row.pitcherHr9 / 38 : 0.03;
  const parkAdj = 1 + ((row.parkFactor - 100) / 100) * 0.5;
  const onFireScore = liveOnFireScore(row, statcastHotHitters);
  const hotMult = 1 + (onFireScore / 100) * 0.5;
  // Workload-scaled pitcher weight -- see startBFShare's own comment at
  // PITCHER_WORKLOAD_PATH above; row.startBFShare defaults to 1 (old flat weight,
  // unscaled) for any row built before that field existed.
  const startBFShare = row.startBFShare != null ? row.startBFShare : 1;
  const pitcherWeight = 0.4 * startBFShare;
  // Bullpen -- the weight startBFShare discounts away from a quick-hook starter used
  // to just flow into batterWeight below; now it goes to a real relievers-only rate
  // instead (see BULLPEN_HR_RATE_PATH above), same redesign as app.js's client-side
  // port. row.bullpenRate defaults to league average for any row built before that
  // field existed (bullpenWeight will be 0 too in that case, so it's inert either way).
  const bullpenRate = row.bullpenRate != null ? row.bullpenRate : HRP_LEAGUE_AVG_HR_RATE;
  const bullpenWeight = 0.4 * (1 - startBFShare);
  const batterWeight = 1 - pitcherWeight - bullpenWeight;
  // zoneMatchupMult was already computed by every caller (buildBatterPool) but never
  // actually passed into this function -- a real drift from the client formula this
  // mirrors, fixed here rather than left to compound further while touching this
  // function anyway. Defaults to neutral (1) for any row that doesn't have it.
  const zoneMult = row.zoneMatchupMult != null ? row.zoneMatchupMult : 1;
  const hrPerPA = ((batterRate * batterWeight) + (pitcherRate * pitcherWeight) + (bullpenRate * bullpenWeight)) * parkAdj * shrinkMult(hotMult) * weatherHRMult * zoneMult;
  const logisticFeatures = { batterISO: row.iso, pitcherHr9: row.pitcherHr9, pitcherWhip: row.pitcherWhip, parkFactor: row.parkFactor, windFactor: row.windFactor, temperatureFactor: row.temperatureFactor, isOnFire: onFireScore >= 70, matchupEdge: row.matchupEdge, startBFShare: row.startBFShare };
  return simulateHRGameOdds(hrPerPA, row.battingOrder, logisticFeatures);
}

function scoreForMarket(marketKey, row) {
  if (marketKey === 'hr') {
    // hrSeason/atBats is HR-per-AT-BAT; MC_AB_PER_PA converts it to HR-per-PLATE-
    // APPEARANCE so it's on the same footing as pitcherRate and simulateHRGameOdds
    // below, which all treat their input as a per-PA rate. Left unconverted this
    // overstated the batter's true per-PA HR odds by about 13% (AB is a smaller
    // denominator than PA, since PA also includes walks/HBP/sac flies).
    const boxScoreBatterRate = row.atBats > 0 ? (row.hrSeason / row.atBats) * MC_AB_PER_PA : LEAGUE_AVG_HR_RATE;
    // Corrects the box-score rate using real quality-of-contact data (xSLG, hard-hit%)
    // when a large enough Statcast sample exists for this batter -- see
    // battedBallPowerIndex/loadStatcastPowerIndex above. Neutral (1x, no change) when
    // there isn't one, so this never makes the model worse for an uncovered player.
    // fatigueFactor (see teamRestFatigueFactor/doubleheaderFatigueFactor above) and
    // homeRoadFactor (see homeRoadPowerFactor above) are both batter-side effects,
    // applied here rather than to the combined rate the way windFactor/temperatureFactor
    // are, since they're specific to this batter/team, not the whole park/game
    // environment.
    const batterRate = boxScoreBatterRate * shrinkMult(battedBallPowerIndex(row.statcast))
      * shrinkMult(row.fatigueFactor || 1) * shrinkMult(row.homeRoadFactor || 1);
    // Prefer this specific pitcher's own real batters-faced-per-9 (pitcherBFper9) when
    // their season stat line has enough innings to trust it; fall back to the league-
    // average constant otherwise.
    const boxScorePitcherRate = row.pitcherHr9 > 0 ? row.pitcherHr9 / (row.pitcherBFper9 || BATTERS_FACED_PER_9) : 0.03;
    // Corrects the box-score-allowed rate using real contact-quality-allowed data
    // (xSLG/hard-hit% allowed), the pitcher-side mirror of the batter correction above
    // -- battedBallPowerIndex is generic over both. Neutral (1x) with no Statcast
    // coverage or too thin a sample, same as the batter side.
    const pitcherRate = boxScorePitcherRate * shrinkMult(battedBallPowerIndex(row.pitcherStatcast));
    // Wind, temperature, and park (see windPowerFactor/temperaturePowerFactor and
    // parkAdj below) all affect the whole park/game environment equally regardless of
    // who's hitting or pitching, so they're applied once to the combined rate rather
    // than to the batter/pitcher components separately -- applying any of them twice
    // would double-count the same physical effect.
    // Park factor -- same formula buildBatterModel/computeLiveHRScore already use
    // elsewhere in this file (neutral at parkFactor=100). row.parkFactor was already
    // being computed and threaded into logisticFeatures below for the fitted model,
    // but never actually applied to this legacy hrPerPA itself -- a real gap (not a
    // documented simplification, see this file's own header comment) that meant the
    // non-logistic-model fallback path scored a hitter identically in Coors Field and
    // a pitcher's park. Fixed here, applied the same way as wind/temperature (shrunk,
    // once, on the combined rate) rather than computeLiveHRScore's unshrunk direct
    // multiply, matching this function's own existing treatment of every other
    // environmental factor.
    const parkAdj = 1 + (((row.parkFactor ?? 100) - 100) / 100) * 0.5;
    // Zone-matchup correction (see zoneMatchupMultiplier's header comment) -- pre-computed
    // in buildBatterPool (row.zoneMatchupMult) from the real zone maps already resolved
    // there, same "compute once outside scoreForMarket, apply with shrinkMult here" shape
    // as fatigueFactor/homeRoadFactor/windFactor/temperatureFactor above.
    // Workload-scaled pitcher weight -- pre-computed in buildBatterPool (row.startBFShare)
    // from real avg-batters-faced-per-start data, correcting for how a quick-hook
    // starter only actually faces a batter for 1-2 of his ~4 PA before the bullpen
    // takes over. Defaults to 1 (old flat weight, unscaled) for a row with no reliable
    // workload sample. See PITCHER_WORKLOAD_PATH's own comment for the calibration-
    // report evidence this addresses.
    const pitcherWeight = 0.4 * (row.startBFShare != null ? row.startBFShare : 1);
    const batterWeight = 1 - pitcherWeight;
    const hrPerPA = (batterRate * batterWeight + pitcherRate * pitcherWeight) * shrinkMult(row.windFactor || 1) * shrinkMult(row.temperatureFactor || 1) * shrinkMult(row.zoneMatchupMult || 1) * shrinkMult(parkAdj);
    const logisticFeatures = { batterISO: row.iso, pitcherHr9: row.pitcherHr9, pitcherWhip: row.pitcherWhip, parkFactor: row.parkFactor, windFactor: row.windFactor, temperatureFactor: row.temperatureFactor, isOnFire: row.isHot, matchupEdge: row.matchupEdge, startBFShare: row.startBFShare };
    return simulateHRGameOdds(hrPerPA, row.battingOrder, logisticFeatures);
  }
  if (marketKey === 'sb') return simulateSBOdds(row);
  return simulatePropOdds(marketKey, row);
}

// ── Building today's batter candidate pool ──
// Populated as a side effect of seasonBattingStat (below) — batSide comes back on the
// same /people/{id} response the season stat call already makes, same zero-extra-
// fetch reasoning as pitcherHandCache above. Feeds computeZoneFitServer's pull-side
// logic (see near zoneMatchupMultiplier below).
const batterHandCache = new Map();

async function seasonBattingStat(pid, season) {
  try {
    const d = await fetchJSON(`${API}/people/${pid}?hydrate=stats(group=hitting,type=season,season=${season})`);
    const person = d?.people?.[0];
    if (person?.batSide?.code) batterHandCache.set(pid, person.batSide.code);
    return person?.stats?.[0]?.splits?.[0]?.stat || {};
  } catch (e) { return {}; }
}
async function recentBattingForm(pid, season, games = 10) {
  try {
    const d = await fetchJSON(`${API}/people/${pid}/stats?stats=lastXGames&group=hitting&season=${season}&limit=${games}&gameType=R`);
    const splits = d?.stats?.[0]?.splits || [];
    if (!splits.length) return null;
    let ab = 0, h = 0, hr = 0, bb = 0, hbp = 0, tb = 0, sf = 0;
    splits.forEach(s => {
      const st = s.stat || {};
      ab += n(st.atBats); h += n(st.hits); hr += n(st.homeRuns);
      bb += n(st.baseOnBalls); hbp += n(st.hitByPitch); tb += n(st.totalBases); sf += n(st.sacFlies);
    });
    const obpDenom = ab + bb + hbp + sf;
    return {
      ab, hr,
      avg: ab > 0 ? h / ab : null,
      obp: obpDenom > 0 ? (h + bb + hbp) / obpDenom : null,
      slg: ab > 0 ? tb / ab : null,
    };
  } catch (e) { return null; }
}

// Batter pool only (see PARK_FACTORS/pitcherHandCache comments) — vs-LHP/vs-RHP
// split for this batter against *this specific game's* probable pitcher's hand. One
// extra request per batter, only paid here (not by the live client page), matching the
// user's ask to scope handedness data to the backend pool rather than page-load-latency
// -sensitive live tabs.
const MIN_SPLIT_AB = 15;
async function battingSplitVsHand(pid, season, pitcherHand) {
  const sitCode = pitcherHand === 'L' ? 'vl' : 'vr';
  try {
    const d = await fetchJSON(`${API}/people/${pid}/stats?stats=statSplits&group=hitting&sitCodes=${sitCode}&season=${season}`);
    const stat = d?.stats?.[0]?.splits?.[0]?.stat;
    const ab = n(stat?.atBats);
    if (!stat || ab < MIN_SPLIT_AB) return null;
    return {
      ab,
      avg: stat.avg != null ? n(stat.avg) : null,
      obp: stat.obp != null ? n(stat.obp) : null,
      slg: stat.slg != null ? n(stat.slg) : null,
    };
  } catch (e) { return null; }
}

// Same statSplits endpoint/pattern as battingSplitVsHand, sitCodes 'h'/'a' for
// home/road instead of 'vl'/'vr' for pitcher hand -- some batters have a real, sizable
// power difference between their home park and the road, separate from the generic
// team-level PARK_FACTORS table (which only captures the park itself, not whether this
// specific batter actually hits better or worse away from it). NOTE: same sandbox
// caveat as elsewhere in this file -- no live network access here to confirm 'h'/'a'
// are exactly the right sitCodes, though they match the documented pattern used for
// every other split already fetched in this file. A wrong guess here fails the fetch
// and falls back to null (no adjustment), same graceful-degradation posture as
// everywhere else.
const HOME_ROAD_MIN_AB = 30; // meaningfully higher than MIN_SPLIT_AB -- a home-only or
                              // away-only split is a much smaller slice of a season
                              // than a platoon split, and noisier as a result
async function battingSplitHomeAway(pid, season, isHome) {
  const sitCode = isHome ? 'h' : 'a';
  try {
    const d = await fetchJSON(`${API}/people/${pid}/stats?stats=statSplits&group=hitting&sitCodes=${sitCode}&season=${season}`);
    const stat = d?.stats?.[0]?.splits?.[0]?.stat;
    const ab = n(stat?.atBats);
    if (!stat || ab < HOME_ROAD_MIN_AB) return null;
    return { ab, slg: stat.slg != null ? n(stat.slg) : null };
  } catch (e) { return null; }
}

// Converts a batter's home-or-road SLG into a bounded multiplier on their own
// box-score HR rate, relative to their OWN season SLG (not a league constant --
// this is "how does this batter do here vs. their own baseline", not "vs. league").
// Tighter bounds than the Statcast/pitcher corrections since this compares a smaller,
// noisier sample against another sample rather than a fixed reference.
function homeRoadPowerFactor(splitStat, seasonSlg) {
  if (!splitStat || splitStat.slg == null || !(seasonSlg > 0)) return 1;
  return clamp(splitStat.slg / seasonSlg, 0.85, 1.20);
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

// ── DRP Game Simulation, Phase 3: real data + comparison tracking ──
// Wires Phases 1-2 to real lineups (battersForSide — real lineup if posted,
// else the same active-roster fallback already used elsewhere in this file)
// and real season pitching stats, then captures a comparison entry in a
// separate file (data/drp-sim-comparison.json — never merged into
// tracker.json, same pattern as the Ballpark Pal comparison) so the
// simulation's picks can be graded against real outcomes before ever
// replacing the live, formula-based DRP pick. Not read by the client.

const DRP_SIM_COMPARISON_PATH = path.join(__dirname, '..', 'data', 'drp-sim-comparison.json');

// Team-level season pitching line, used as the "bullpen" stat once a
// starter is pulled — a simplified proxy (it includes the starter's own
// innings too), not a true relief-only split. See simulateOneGame's own
// comment for the rest of the pitching-change simplifications.
async function fetchTeamPitchingAggregate(teamId, season) {
  try {
    const d = await fetchJSON(`${API}/teams/${teamId}/stats?stats=season&group=pitching&season=${season}`);
    return d?.stats?.[0]?.splits?.[0]?.stat || {};
  } catch (e) { return {}; }
}

async function buildDRPSimLineup(g, side, season) {
  const batters = await battersForSide(g, side);
  const stats = await mapLimit(batters, 6, async (b) => (b.id ? seasonBattingStat(b.id, season) : null));
  const valid = stats.filter(s => s && n(s.plateAppearances) > 0);
  return valid.length ? valid : null;
}

async function computeDRPSimulation(g, season) {
  const awayAbbr = g.teams.away.team.abbreviation;
  const homeAbbr = g.teams.home.team.abbreviation;
  const awayP = g.teams.away.probablePitcher;
  const homeP = g.teams.home.probablePitcher;
  if (!awayP || !homeP) return null;

  const [awayLineup, homeLineup, awayStarterStat, homeStarterStat, awayBullpenStat, homeBullpenStat] = await Promise.all([
    buildDRPSimLineup(g, 'away', season),
    buildDRPSimLineup(g, 'home', season),
    seasonPitchingStat(awayP.id, season),
    seasonPitchingStat(homeP.id, season),
    fetchTeamPitchingAggregate(g.teams.away.team.id, season),
    fetchTeamPitchingAggregate(g.teams.home.team.id, season),
  ]);
  if (!awayLineup || !homeLineup) return null;

  const sim = simulateDRPGame({ awayLineup, awayStarterStat, awayBullpenStat, homeLineup, homeStarterStat, homeBullpenStat }, 1000);
  const simPick = sim.awayWinPct >= sim.homeWinPct ? awayAbbr : homeAbbr;
  const simPickPct = Math.max(sim.awayWinPct, sim.homeWinPct);
  return { simPick, simPickPct, simAwayRuns: sim.avgAwayRuns, simHomeRuns: sim.avgHomeRuns };
}

async function loadDRPSimComparison() {
  try {
    const raw = await readFile(DRP_SIM_COMPARISON_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    parsed.entries ||= [];
    return parsed;
  } catch (e) {
    return {
      version: 1,
      generatedAt: null,
      entries: [],
      summary: {
        formula: { wins: 0, losses: 0, pushes: 0, total: 0 },
        simulation: { wins: 0, losses: 0, pushes: 0, total: 0 },
      },
    };
  }
}

async function saveDRPSimComparison(store) {
  store.generatedAt = new Date().toISOString();
  await mkdir(path.dirname(DRP_SIM_COMPARISON_PATH), { recursive: true });
  await writeFile(DRP_SIM_COMPARISON_PATH, JSON.stringify(store, null, 2) + '\n');
}

function recomputeDRPSimSummary(store) {
  const summary = {
    formula: { wins: 0, losses: 0, pushes: 0, total: 0 },
    simulation: { wins: 0, losses: 0, pushes: 0, total: 0 },
  };
  for (const e of store.entries) {
    if (e.formulaResult === 'win') summary.formula.wins++;
    else if (e.formulaResult === 'loss') summary.formula.losses++;
    else if (e.formulaResult === 'push') summary.formula.pushes++;
    if (e.formulaResult && e.formulaResult !== 'pending') summary.formula.total++;

    if (e.simResult === 'win') summary.simulation.wins++;
    else if (e.simResult === 'loss') summary.simulation.losses++;
    else if (e.simResult === 'push') summary.simulation.pushes++;
    if (e.simResult && e.simResult !== 'pending') summary.simulation.total++;
  }
  store.summary = summary;
}

async function gradeDRPSimComparison(compStore) {
  const today = cdtDateString(new Date());
  const pending = compStore.entries.filter(e => e.formulaResult === 'pending' && e.date < today);
  if (!pending.length) return 0;

  const dates = [...new Set(pending.map(e => e.date))];
  let graded = 0;
  for (const date of dates) {
    let games = [];
    try {
      const sched = await fetchJSON(`${API}/schedule?sportId=1&date=${date}&hydrate=linescore`);
      games = sched?.dates?.find(d => d.date === date)?.games || [];
    } catch (e) {
      console.warn(`DRP sim comparison: schedule fetch failed for ${date}:`, e.message);
      continue;
    }
    const gamesByPk = Object.fromEntries(games.map(g => [g.gamePk, g]));

    for (const e of pending.filter(r => r.date === date)) {
      const g = gamesByPk[e.gamePk];
      if (!g || g.status?.abstractGameState !== 'Final') continue;
      const awayScore = n(g.teams?.away?.score, NaN);
      const homeScore = n(g.teams?.home?.score, NaN);
      if (!Number.isFinite(awayScore) || !Number.isFinite(homeScore)) continue;
      const actualWinner = awayScore === homeScore ? 'TIE' : (awayScore > homeScore ? e.awayTeam : e.homeTeam);
      e.actualWinner = actualWinner;
      e.formulaResult = actualWinner === 'TIE' ? 'push' : (actualWinner === e.formulaPick ? 'win' : 'loss');
      e.simResult = actualWinner === 'TIE' ? 'push' : (actualWinner === e.simPick ? 'win' : 'loss');
      graded++;
    }
  }
  return graded;
}

// Called from inside captureToday (has previewGames/store.market.drp/season
// already in scope) — only simulates games we ourselves captured a formula
// DRP pick for, same guard the Ballpark Pal comparison capture uses.
async function captureDRPSimComparisonToday(compStore, previewGames, store, season) {
  let added = 0;
  for (const g of previewGames) {
    const awayAbbr = g.teams.away.team.abbreviation;
    const homeAbbr = g.teams.home.team.abbreviation;
    const gameDay = cdtDateString(new Date(g.gameDate));
    const key = `${gameDay}|${g.gamePk}`;
    if (compStore.entries.some(e => e.key === key)) continue;
    const formulaDrp = store.market.drp.find(r => r.gamePk === g.gamePk);
    if (!formulaDrp) continue;
    let sim;
    try {
      sim = await computeDRPSimulation(g, season);
    } catch (e) {
      console.warn(`DRP simulation failed for gamePk ${g.gamePk}:`, e.message);
      continue;
    }
    if (!sim) continue;
    compStore.entries.push({
      key, date: gameDay, gamePk: g.gamePk, awayTeam: awayAbbr, homeTeam: homeAbbr,
      formulaPick: formulaDrp.pick, formulaPickPct: formulaDrp.pickPct,
      simPick: sim.simPick, simPickPct: sim.simPickPct,
      simAwayRuns: sim.simAwayRuns, simHomeRuns: sim.simHomeRuns,
      actualWinner: null, formulaResult: 'pending', simResult: 'pending',
    });
    added++;
  }
  return added;
}

// ── Weather (exact port of app.js's stadiumCoords/windEffect/airDensityHRMult/
// windHRMult/fetchGameWeather) ──────────────────────────────────────────────
// The live client HR Threats board fetches real Open-Meteo weather per game and
// folds it into hrProb via a physics-based HR multiplier (see app.js's own header
// comments on airDensityHRMult/windHRMult for the full reasoning). computeLiveHRScore
// below exists purely to mirror that live formula for calibration -- so it needs this
// too, not this file's own, differently-designed windPowerFactor/temperaturePowerFactor
// (which read MLB's schedule-hydrated weather text, a different source scoreForMarket
// already uses). Ported verbatim rather than approximated, same as everything else
// computeLiveHRScore does.
const STADIUM_COORDS = {
  ARI:{lat:33.445,lon:-112.067,name:'Chase Field',dome:true,retractable:true},
  ATL:{lat:33.891,lon:-84.468,name:'Truist Park',dome:false},
  BAL:{lat:39.284,lon:-76.622,name:'Oriole Park',dome:false},
  BOS:{lat:42.347,lon:-71.097,name:'Fenway Park',dome:false},
  CHC:{lat:41.948,lon:-87.655,name:'Wrigley Field',dome:false},
  CWS:{lat:41.830,lon:-87.634,name:'Guaranteed Rate Field',dome:false},
  CIN:{lat:39.097,lon:-84.506,name:'Great American Ball Park',dome:false},
  CLE:{lat:41.496,lon:-81.685,name:'Progressive Field',dome:false},
  COL:{lat:39.756,lon:-104.994,name:'Coors Field',dome:false},
  DET:{lat:42.339,lon:-83.049,name:'Comerica Park',dome:false},
  HOU:{lat:29.757,lon:-95.355,name:'Minute Maid Park',dome:true,retractable:true},
  KC: {lat:39.051,lon:-94.480,name:'Kauffman Stadium',dome:false},
  LAA:{lat:33.800,lon:-117.883,name:'Angel Stadium',dome:false},
  LAD:{lat:34.074,lon:-118.240,name:'Dodger Stadium',dome:false},
  MIA:{lat:25.778,lon:-80.220,name:'loanDepot Park',dome:true,retractable:true},
  MIL:{lat:43.029,lon:-87.971,name:'American Family Field',dome:true,retractable:true},
  MIN:{lat:44.981,lon:-93.278,name:'Target Field',dome:false},
  NYM:{lat:40.757,lon:-73.846,name:'Citi Field',dome:false},
  NYY:{lat:40.829,lon:-73.926,name:'Yankee Stadium',dome:false},
  ATH:{lat:37.751,lon:-122.200,name:'Oakland Coliseum',dome:false},
  OAK:{lat:37.751,lon:-122.200,name:'Oakland Coliseum',dome:false},
  PHI:{lat:39.906,lon:-75.166,name:'Citizens Bank Park',dome:false},
  PIT:{lat:40.447,lon:-80.006,name:'PNC Park',dome:false},
  SD: {lat:32.707,lon:-117.157,name:'Petco Park',dome:false},
  SF: {lat:37.778,lon:-122.389,name:'Oracle Park',dome:false},
  SEA:{lat:47.591,lon:-122.332,name:'T-Mobile Park',dome:true,retractable:true},
  STL:{lat:38.623,lon:-90.193,name:'Busch Stadium',dome:false},
  TB: {lat:27.768,lon:-82.653,name:'Tropicana Field',dome:true},
  TEX:{lat:32.751,lon:-97.083,name:'Globe Life Field',dome:true,retractable:true},
  TOR:{lat:43.641,lon:-79.389,name:'Rogers Centre',dome:true,retractable:true},
  WSH:{lat:38.873,lon:-77.007,name:'Nationals Park',dome:false},
};
function liveWindEffect(deg, homeAbbr) {
  if (deg >= 60 && deg <= 150) return 'out';
  if (deg >= 240 && deg <= 330) return 'in';
  return 'cross';
}
function airDensityKgM3(tempF, pressureMslHPa, relHumidityPct) {
  const tempC = (tempF - 32) * 5 / 9;
  const tempK = tempC + 273.15;
  const satVaporHPa = 6.1078 * Math.pow(10, (7.5 * tempC) / (tempC + 237.3));
  const vaporHPa = satVaporHPa * (Math.max(0, Math.min(100, relHumidityPct ?? 50)) / 100);
  const totalPa = pressureMslHPa * 100;
  const vaporPa = vaporHPa * 100;
  const dryPa = totalPa - vaporPa;
  return (dryPa / (287.05 * tempK)) + (vaporPa / (461.495 * tempK));
}
const NEUTRAL_AIR_DENSITY = airDensityKgM3(70, 1013.25, 50);
function liveAirDensityHRMult(weather) {
  if (!weather || !Number.isFinite(weather.pressureMsl)) return 1;
  const rho = airDensityKgM3(weather.temp, weather.pressureMsl, weather.humidity);
  const densityRatio = NEUTRAL_AIR_DENSITY / rho;
  const DENSITY_HR_SENSITIVITY = 1.6;
  return Math.max(0.85, Math.min(1.15, 1 + DENSITY_HR_SENSITIVITY * (densityRatio - 1)));
}
function liveWindHRMult(weather, homeAbbr) {
  if (!weather || !(weather.wind > 5)) return 1;
  const impact = liveWindEffect(weather.windDir, homeAbbr);
  if (impact === 'cross') return 1;
  const WIND_HR_SENSITIVITY = 0.008;
  const mult = 1 + WIND_HR_SENSITIVITY * (weather.wind - 5) * (impact === 'out' ? 1 : -1);
  return Math.max(0.85, Math.min(1.2, mult));
}
// Cached per gamePk within a single run -- buildBatterPool below calls this once
// per game (not per batter/side), same reasoning as the client (weather is a whole-
// game condition), but a Map cache here also protects against any future caller
// requesting the same game's weather twice in one run.
// gameTimestamp (ms, optional) — same first-pitch-forecast lookup as app.js's
// fetchGameWeather/pickWeatherHourly (see that file's comment for the full
// rationale); duplicated rather than shared since server and client already
// duplicate every other weather multiplier in this pair of files (see
// liveAirDensityHRMult/airDensityHRMult, liveWindHRMult/windHRMult above).
function pickWeatherHourly(wd, gameTimestamp) {
  if (!gameTimestamp || gameTimestamp <= Date.now() + 20 * 60 * 1000) return wd.current;
  const h = wd.hourly;
  if (!h?.time?.length) return wd.current;
  let bestIdx = -1, bestDiff = Infinity;
  for (let i = 0; i < h.time.length; i++) {
    const diff = Math.abs(new Date(h.time[i] + 'Z').getTime() - gameTimestamp);
    if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
  }
  if (bestIdx < 0) return wd.current;
  return {
    temperature_2m: h.temperature_2m[bestIdx], relative_humidity_2m: h.relative_humidity_2m[bestIdx],
    windspeed_10m: h.windspeed_10m[bestIdx], winddirection_10m: h.winddirection_10m[bestIdx],
    precipitation: h.precipitation[bestIdx], pressure_msl: h.pressure_msl[bestIdx], weathercode: h.weathercode[bestIdx],
  };
}
const _liveWeatherCache = new Map();
async function fetchLiveGameWeather(gamePk, homeAbbr, awayAbbr, gameTimestamp) {
  if (_liveWeatherCache.has(gamePk)) return _liveWeatherCache.get(gamePk);
  const stadium = STADIUM_COORDS[homeAbbr] || STADIUM_COORDS[awayAbbr];
  let weather = null;
  if (stadium && (!stadium.dome || stadium.retractable)) {
    try {
      const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${stadium.lat}&longitude=${stadium.lon}&current=temperature_2m,relative_humidity_2m,windspeed_10m,winddirection_10m,precipitation,pressure_msl,weathercode&hourly=temperature_2m,relative_humidity_2m,windspeed_10m,winddirection_10m,precipitation,pressure_msl,weathercode&forecast_days=2&timezone=GMT&temperature_unit=fahrenheit&windspeed_unit=mph`);
      if (res.ok) {
        const wd = await res.json();
        const c = pickWeatherHourly(wd, gameTimestamp);
        weather = {
          temp: Math.round(c.temperature_2m), humidity: c.relative_humidity_2m,
          wind: Math.round(c.windspeed_10m), windDir: c.winddirection_10m,
          precip: c.precipitation, pressureMsl: c.pressure_msl, code: c.weathercode,
        };
      }
    } catch (e) { /* leave weather null -- same graceful degradation as everything else here */ }
  }
  _liveWeatherCache.set(gamePk, weather);
  return weather;
}

async function buildBatterPool(games, season) {
  const statcastIndex = await loadStatcastPowerIndex();
  const pitcherStatcastIndex = await loadPitcherStatcastPowerIndex();
  const pitcher2kSuppressionIndex = await loadPitcher2kSuppressionIndex();
  const pitcherWorkloadIndex = await loadPitcherWorkloadIndex();
  const bullpenHrRateIndex = await loadBullpenHrRateIndex();
  const statcastHotHittersIndex = await loadStatcastHotHittersIndex();
  const nearHRsIndex = await loadNearHRsIndex();
  const rows = [];
  for (const g of games) {
    // Once per game (weather isn't batter- or side-specific) -- see fetchLiveGameWeather's
    // header comment for why this mirrors app.js's own weather fetch/multiplier exactly.
    const gameWeather = await fetchLiveGameWeather(g.gamePk, g.teams.home.team.abbreviation, g.teams.away.team.abbreviation, new Date(g.gameDate).getTime());
    const weatherHRMult = gameWeather ? (liveAirDensityHRMult(gameWeather) * liveWindHRMult(gameWeather, g.teams.home.team.abbreviation)) : 1;
    for (const [side, opp] of [['away', 'home'], ['home', 'away']]) {
      const pitcher = g.teams[opp].probablePitcher;
      if (!pitcher) continue;
      const pitcherStat = await seasonPitchingStat(pitcher.id, season);
      const pitcherStatcast = pitcherStatcastIndex.get(String(pitcher.id)) || null;
      const pitcherHand = pitcherHandCache.get(pitcher.id) || 'R';
      // Pitcher's real weak-zone map for zoneMatchupMultiplier below -- hand-unconditioned
      // (pitcherZoneByHandCache is keyed by the OPPOSING BATTER's stand, which this pool
      // doesn't fetch -- see the per-batter comment below for why not), computed once per
      // pitcher since it's the same for every batter facing him.
      const pitcherZoneMapForHR = pitcherZoneCache.get(String(pitcher.id)) || null;
      // Workload share -- how much of a batter's ~4 PA this specific starter actually
      // sticks around for, vs handing the rest to the bullpen (see PITCHER_WORKLOAD_PATH
      // comment above). Same 0.55-1.15 clamp and reliable-sample-only gate as app.js's
      // client-side port, computed once per pitcher (not per batter) since it's the
      // same for every batter facing him this game.
      const pitcherWorkloadProfile = pitcherWorkloadIndex.get(String(pitcher.id)) || null;
      const startBFShare = (pitcherWorkloadProfile && pitcherWorkloadProfile.reliable && pitcherWorkloadLeagueAvgBF > 0)
        ? Math.max(0.55, Math.min(1.15, pitcherWorkloadProfile.avgBFperStart / pitcherWorkloadLeagueAvgBF))
        : 1;
      const teamAbbr = g.teams[side].team.abbreviation;
      const oppAbbr = g.teams[opp].team.abbreviation;
      // Real relievers-only HR-allowed rate for the PITCHING team (oppAbbr) -- see
      // BULLPEN_HR_RATE_PATH comment above. Same graceful league-average fallback
      // computeLiveHRScore's own client-side port already uses.
      const bullpenEntry = bullpenHrRateIndex.get(oppAbbr) || null;
      const bullpenRate = (bullpenEntry && bullpenEntry.reliable) ? bullpenEntry.shrunkRate : HRP_LEAGUE_AVG_HR_RATE;
      const batters = await battersForSide(g, side);
      // Computed once per team here (cached), not once per batter -- every batter on
      // this side shares the same team schedule / doubleheader status.
      const battingTeamFatigue = await teamRestFatigueFactor(g.teams[side].team.id, g.gameDate) * doubleheaderFatigueFactor(g);

      const sideRows = await mapLimit(batters, 6, async (b) => {
        const pid = b.id;
        const person = b.player?.person;
        if (!pid || !person?.fullName) return null;
        const [stat, recent, split, homeAwaySplit] = await Promise.all([
          seasonBattingStat(pid, season),
          recentBattingForm(pid, season),
          battingSplitVsHand(pid, season, pitcherHand),
          battingSplitHomeAway(pid, season, side === 'home'),
        ]);
        const ab = n(stat.atBats);
        const seasonAvg = shrinkToLeague(n(stat.avg), ab, LEAGUE_AVG_AVG, POOL_MIN_AB);
        const seasonObp = shrinkToLeague(n(stat.obp, seasonAvg + 0.065), ab, LEAGUE_AVG_OBP, POOL_MIN_AB);
        const seasonSlg = shrinkToLeague(n(stat.slg, seasonAvg + 0.155), ab, LEAGUE_AVG_SLG, POOL_MIN_AB);
        const homeRoadFactor = homeRoadPowerFactor(homeAwaySplit, seasonSlg);
        // Recency blend — mirrors the client-side loadHRPotential blend exactly (same
        // 20-AB cap, same 35% max weight), using the lastXGames data already fetched
        // above for the isHot signal.
        const RECENT_MAX_AB = 20, RECENT_MAX_WEIGHT = 0.35;
        const recentWeight = recent && recent.ab > 0 ? Math.min(recent.ab, RECENT_MAX_AB) / RECENT_MAX_AB * RECENT_MAX_WEIGHT : 0;
        const recAvg = recentWeight > 0 ? seasonAvg * (1 - recentWeight) + recent.avg * recentWeight : seasonAvg;
        const recObp = recentWeight > 0 && recent.obp != null ? seasonObp * (1 - recentWeight) + recent.obp * recentWeight : seasonObp;
        const recSlg = recentWeight > 0 && recent.slg != null ? seasonSlg * (1 - recentWeight) + recent.slg * recentWeight : seasonSlg;
        // Platoon blend — this batter's actual AVG/OBP/SLG against this specific
        // game's probable pitcher's throwing hand, applied on top of the recency blend.
        // Batter pool only (see battingSplitVsHand comment); the live client page
        // does not pay this extra per-batter request.
        const SPLIT_MAX_AB = 50, SPLIT_MAX_WEIGHT = 0.30;
        const splitWeight = split && split.ab > 0 ? Math.min(split.ab, SPLIT_MAX_AB) / SPLIT_MAX_AB * SPLIT_MAX_WEIGHT : 0;
        const avg = splitWeight > 0 && split.avg != null ? recAvg * (1 - splitWeight) + split.avg * splitWeight : recAvg;
        const obp = splitWeight > 0 && split.obp != null ? recObp * (1 - splitWeight) + split.obp * splitWeight : recObp;
        const slg = splitWeight > 0 && split.slg != null ? recSlg * (1 - splitWeight) + split.slg * splitWeight : recSlg;
        const ops = n(stat.ops, avg + obp);
        const iso = Math.max(0, slg - avg);
        const hrSeason = n(stat.homeRuns);
        const battingOrderRaw = b.fromLineup ? Number(b.player?.battingOrder) : NaN;
        const battingOrder = Number.isFinite(battingOrderRaw) ? Math.max(1, Math.min(9, Math.floor(battingOrderRaw / 100))) : null;
        const pitcherWhip = n(pitcherStat.whip, 1.25);
        const pitcherAvgAllowed = n(pitcherStat.avg, 0.24);
        const pitcherSlgAllowed = n(pitcherStat.slg, 0.4);
        // Uses the recency+platoon-blended `ops` above, not a raw season OPS -- a batter
        // who's been cold lately or has a bad split against this pitcher's throwing hand
        // shouldn't get tagged "favorable" off a stale season-long number the rest of the
        // model (iso, scoring) doesn't use either. Same fix already applied client-side
        // (app.js's isFavorable/isDue) for the equivalent raw-vs-shrunk-OPS bug.
        const isFavorable = ops >= 0.800 && (pitcherWhip >= 1.25 || pitcherAvgAllowed >= 0.260);
        const isHot = computeIsHot(recent, seasonAvg);
        // Mirrors the client's HR Threats board tags (app.js: isDrought/isDue) so the
        // HR Threat tracker capture below can snapshot them for real hit-rate analysis
        // later — those tags were never being validated against actual outcomes since
        // nothing captured them at pick time. Uses the same lastXGames window already
        // fetched for isHot (10 games here vs. the client's boxscore-log-based 8 games)
        // rather than a second API call for a near-identical signal.
        const isDrought = hrSeason > 0 && !!recent && recent.hr === 0;
        const isDue = isDrought && (
          (iso >= 0.170 ? 1 : 0) +
          (isFavorable ? 1 : 0) +
          (ops >= 0.750 ? 1 : 0) +
          (hrSeason >= 8 ? 1 : 0) // recent.hr===0 already established by isDrought above
        ) >= 2;
        // Mirrors the client board's "🚀 NEAR HR" chip (app.js's hasNearHR check against
        // nearHRs) so the tracker can finally answer whether real warning-track power
        // actually precedes a HR at a higher rate -- that question was previously
        // unanswerable since nothing captured it at pick time.
        const hasNearHR = (nearHRsIndex.get(String(pid)) || []).length > 0;
        const rowParkFactor = PARK_FACTORS[g.teams.home.team.abbreviation] || 100;
        // Raw platoon split (this batter's real AVG/OBP/SLG vs today's specific opposing
        // pitcher's throwing hand) -- already fetched above (see `split`) to blend into
        // avg/obp/slg/ops, but that blend only feeds isFavorable/iso, not the HR rate
        // itself (scoreForMarket('hr') drives batterRate off the raw hrSeason/atBats
        // count, not the platoon-blended OPS). Snapshotting the raw split here, purely
        // for analyze-hr-matchups.mjs to check later, rather than acting on it -- exactly
        // the same "measure before we build a live feature around it" step already taken
        // for isFavorable/isOnFire/etc before those became known-scoped signals. No new
        // fetch: split is already being paid for by the OPS blend above.
        const platoonAB = split?.ab ?? null;
        const platoonOps = (split && split.obp != null && split.slg != null) ? +(split.obp + split.slg).toFixed(3) : null;
        const platoonFavorable = platoonOps != null ? platoonOps >= 0.800 : null;
        // Same live-client Matchup Edge score as app.js's computeMatchupEdgeScore/HR
        // Threats board (see that function's header comment above) -- reuses the
        // pitcherHand/seasonAvg/seasonSlg/split already resolved above for the platoon
        // blend, so this is a zero-extra-fetch snapshot, same as platoonAB/platoonOps.
        const matchupEdge = computeMatchupEdgeScore(pid, pitcher.id, pitcherHand, seasonAvg, seasonSlg, split);
        // Zone-matchup correction consumed by scoreForMarket('hr') -- batter side
        // conditioned on this specific pitcher's throwing hand (batterZoneByHandCache is
        // keyed by the opposing pitcher's hand, and pitcherHand is already resolved above
        // for the platoon blend, so this is zero extra fetches); pitcher side left
        // hand-unconditioned since zoneMatchupMultiplier only reads whichever zone data
        // is on hand for each side independently (unlike computeZoneFitServer below,
        // which specifically needs this batter's own stand for its pull-side logic).
        const batterZoneMapForHR = (batterZoneByHandCache.get(String(pid))?.[pitcherHand]) || batterZoneCache.get(String(pid)) || null;
        const zoneMatchupMult = zoneMatchupMultiplier(batterZoneMapForHR, pitcherZoneMapForHR);
        // Zone Fit snapshot -- same real pitcherZoneMapForHR already loaded above for
        // zoneMatchupMult, plus this batter's own real stand (batterHandCache, populated
        // as a side effect of seasonBattingStat above) for the pull-side logic. Purely
        // recorded for later calibration (see captureHRThreatToday below); not consumed
        // by scoreForMarket.
        const zoneFit = computeZoneFitServer(zoneValsFromByZoneServer(pitcherZoneMapForHR), batterHandCache.get(pid) || null, iso);
        // Snapshot of the live client's own HR score (see computeLiveHRScore's header
        // comment) -- only meaningful for the 'hr' market; harmless (just unused) for
        // any other market this same pool feeds.
        const liveScore = computeLiveHRScore({
          id: pid, name: person.fullName, ops, iso, atBats: ab, hrSeason,
          pitcherHr9: n(pitcherStat.homeRunsPer9), pitcherWhip, parkFactor: rowParkFactor, battingOrder,
          windFactor: windPowerFactor(g.weather), temperatureFactor: temperaturePowerFactor(g.weather),
          last10HR: recent?.hr || 0, isFavorable, statcast: statcastIndex.get(String(pid)) || null, matchupEdge,
          startBFShare, bullpenRate, zoneMatchupMult,
        }, statcastHotHittersIndex, weatherHRMult);
        return {
          id: pid, name: person.fullName, teamAbbr, oppAbbr, gamePk: g.gamePk,
          pitcherId: pitcher.id, pitcherName: pitcher.fullName,
          avg, obp, slg, ops, iso, hrSeason, battingOrder,
          atBats: ab, stolenBases: n(stat.stolenBases), caughtStealing: n(stat.caughtStealing),
          pitcherHr9: n(pitcherStat.homeRunsPer9), pitcherSbAllowed: n(pitcherStat.stolenBases), pitcherCsAllowed: n(pitcherStat.caughtStealing),
          pitcherBFper9: pitcherBattersFacedPer9(pitcherStat),
          pitcherAvgAllowed, pitcherSlgAllowed, pitcherWhip, parkFactor: rowParkFactor,
          isFavorable, isHot, isDrought, isDue, hasNearHR, statcast: statcastIndex.get(String(pid)) || null,
          // `recent` (recentBattingForm's real lastXGames window) is already fetched
          // above for the isHot/isDrought/recency-blend inputs -- its real .hr count
          // wasn't previously stored on the row itself. Zero extra fetch.
          last10HR: recent?.hr ?? null,
          windFactor: windPowerFactor(g.weather), temperatureFactor: temperaturePowerFactor(g.weather),
          fatigueFactor: battingTeamFatigue,
          pitcherStatcast, homeRoadFactor,
          pitcher2kSuppressionDelta: pitcher2kSuppressionIndex.get(String(pitcher.id)) ?? null,
          startBFShare, pitcherWorkloadReliable: !!(pitcherWorkloadProfile && pitcherWorkloadProfile.reliable),
          liveScore, platoonAB, platoonOps, platoonFavorable, matchupEdge, zoneMatchupMult,
          zoneFitScore: zoneFit?.score ?? null, zoneFitLabel: zoneFit?.label ?? null,
          // Same per-game weather multiplier computeLiveHRScore above already used —
          // stored on the row too so buildBatterModel's own HR rate (used by
          // simulatePropOdds for hits/tb/rbis/hrrbi grading, not just the 'hr' market)
          // gets the same weather correction the live client site's Hits/RBI/TB/SB/HRRBI
          // board now applies (see app.js buildBatterModel).
          weatherHRMult,
        };
      });
      sideRows.filter(Boolean).forEach(r => rows.push(r));
    }
  }
  return rows;
}

// HR Threats board hit-rate tracker — draws from the same shared batter pool
// (buildBatterPool) as generate-headlines.mjs's storylines, captures every
// batter who clears HR_THREAT_MIN_SCORE (see that constant's comment for how this
// differs from the live client-side gate).
// Picks lock in the moment they're first captured, same as everywhere else in this file —
// a later same-day pass only adds newly-qualifying batters, never recomputes or drops one
// already captured.
async function captureHRThreatToday(store, pool) {
  store.market.hrThreat ||= [];
  if (!pool.length) return 0;
  const today = cdtDateString(new Date());
  const already = new Set(store.market.hrThreat.filter(r => r.date === today).map(r => r.playerId));
  let added = 0;
  pool.filter(r => r.atBats >= POOL_MIN_AB && !already.has(r.id)).forEach(r => {
    const score = scoreForMarket('hr', r);
    const hrScoreSource = __hrLastScoreSource;
    if (score < HR_THREAT_MIN_SCORE) return;
    const key = `${today}|HRTHREAT|${r.id}`;
    if (store.market.hrThreat.some(x => x.key === key)) return;
    store.market.hrThreat.push({
      key, date: today, playerId: r.id, playerName: r.name, team: r.teamAbbr, opp: r.oppAbbr,
      gamePk: r.gamePk, score, result: 'pending', actual: null,
      // Which formula actually produced `score` above -- 'logistic' (see
      // predictHRLogistic) once its inputs are available for a row, 'legacy'
      // (the multiplicative simulation + calibrateHRProb) otherwise. Lets a
      // later calibration pass compare the two paths' real hit rates directly
      // instead of assuming every row used the same formula.
      hrScoreSource,
      // The live client board's own score for this same player/matchup (see
      // computeLiveHRScore) -- captured alongside `score` (this file's separate,
      // internal scoring) so analyze-hr-matchups.mjs can calibration-check what site
      // visitors actually see, not just this file's pick-selection formula. Only
      // present on picks captured after this field shipped; older rows are simply
      // missing it, same as every other snapshot field added here over time.
      liveScore: r.liveScore ?? null,
      // Snapshot of the live client board's HR Threats tags at pick time (see
      // buildBatterPool's isFavorable/isHot/isDrought/isDue) — score above is a
      // separate Monte Carlo simulation and never used these tags, so this is the
      // first place any of them get recorded against a real outcome. isOnFire is
      // named to match the client (app.js), backed by the isHot proxy computed here.
      isOnFire: !!r.isHot, isFavorable: !!r.isFavorable, isDrought: !!r.isDrought, isDue: !!r.isDue,
      // Snapshot of the board's "🚀 NEAR HR" chip (real warning-track power in the last
      // 10 games, see sync-near-hrs.mjs) at pick time -- previously a display-only chip
      // with no way to check whether it actually precedes a HR at a higher rate.
      hasNearHR: !!r.hasNearHR,
      // Opposing pitcher matchup snapshot at pick time — previously only the opposing
      // TEAM was recorded (r.opp), with no way to tell which pitcher, or what inputs
      // the score actually used, drove any individual graded result. Recording these
      // lets a later analysis pass correlate real hit/miss outcomes against pitcher
      // quality/park/environment inputs instead of just the final blended score,
      // without needing to re-fetch or reconstruct any of it after the fact.
      pitcherId: r.pitcherId ?? null, pitcherName: r.pitcherName ?? null,
      pitcherHr9: r.pitcherHr9 ?? null, pitcherAvgAllowed: r.pitcherAvgAllowed ?? null,
      pitcherSlgAllowed: r.pitcherSlgAllowed ?? null, pitcherWhip: r.pitcherWhip ?? null,
      batterOPS: r.ops ?? null, batterISO: r.iso ?? null,
      // Real season AB total at pick time -- r.atBats already exists on the pool row
      // (used to gate pool eligibility via POOL_MIN_AB) but was never actually
      // persisted here, so there's been no way to check whether the model's real
      // calibration holds up for a part-time/platoon/bench batter the same way it
      // does for an everyday starter. Recorded purely for that later analysis; not
      // itself a scoring input (batterRate's own shrinkage already uses it live).
      batterAtBats: r.atBats ?? null,
      parkFactor: r.parkFactor ?? null, windFactor: r.windFactor ?? null, temperatureFactor: r.temperatureFactor ?? null,
      // Exploratory "Pitcher IQ" signal — see PITCHER_2K_SUPPRESSION_PATH comment.
      // Recorded here purely so it accumulates against real graded outcomes; not
      // used by scoreForMarket. Mostly null until a pitcher clears the sync
      // script's sample floor and is today's probable starter.
      pitcher2kSuppressionDelta: r.pitcher2kSuppressionDelta ?? null,
      // Exploratory platoon-split signal (this batter's real AVG/OBP/SLG vs today's
      // specific opposing pitcher's throwing hand) — see buildBatterPool's
      // platoonAB/platoonOps/platoonFavorable comment. Not used by any live scoring
      // (client or server) for the 'hr' market; recorded purely so
      // analyze-hr-matchups.mjs can check whether it's worth building into the Compare
      // tray before any live feature gets built around it. Null until this batter has
      // 15+ AB against this specific pitcher hand this season (battingSplitVsHand's own
      // sample floor).
      platoonAB: r.platoonAB ?? null, platoonOps: r.platoonOps ?? null, platoonFavorable: r.platoonFavorable ?? null,
      // Same "measure before it's a scoring input" treatment as platoonAB/platoonOps
      // above -- see computeMatchupEdgeScore's header comment. Null until both this
      // pitcher's and this batter's Statcast pitch-mix sync have landed.
      matchupEdge: r.matchupEdge ?? null,
      // Snapshot of the live client HR Threats board's "Zone Fit" chip (see
      // computeZoneFitServer above) at pick time -- previously a display-only chip with
      // no way to check whether "Strong"/"Elite Zone Fit" actually precedes a HR at a
      // higher rate than "Pitcher Zone Edge". Null until both this pitcher's zone sync
      // and this batter's own real batSide (batterHandCache) are available.
      zoneFitScore: r.zoneFitScore ?? null, zoneFitLabel: r.zoneFitLabel ?? null,
      // Workload-share signal now driving the live pitcher weight (see
      // PITCHER_WORKLOAD_PATH's comment) -- recorded raw (not just baked into the
      // final score) so a later analyze-hr-matchups.mjs pass can directly re-check
      // whether this specific correction is working, the same way the calibration
      // report originally surfaced the bug this fixes. 1 = neutral/no reliable
      // workload sample yet, not "confirmed average workload".
      startBFShare: r.startBFShare ?? null, pitcherWorkloadReliable: r.pitcherWorkloadReliable ?? false,
    });
    already.add(r.id);
    added++;
  });
  return added;
}

async function gradeHRThreatPending(store) {
  store.market.hrThreat ||= [];
  const today = cdtDateString(new Date());
  const pending = store.market.hrThreat.filter(r => r.result === 'pending' && r.date < today);
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
      console.warn(`HR Threat grading: boxscore fetch failed for gamePk ${gamePk}:`, e.message);
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
      const homeRuns = n(bat.homeRuns);
      rec.actual = homeRuns;
      rec.result = homeRuns >= 1 ? 'win' : 'loss';
      // Near miss (roadmap 2.5 "Performance Tracking") -- a loss where the batter
      // still had a real warning-track fly out (same NEAR_HR_MIN_DISTANCE_FT=375ft
      // definition sync-near-hrs.mjs already uses for the live "🚀 NEAR HR" chip) on
      // THIS SPECIFIC game date, not just somewhere in the trailing 10-game window.
      // near-hrs.json is resynced 4x/day (sync-statcast.yml) and this function only
      // ever grades a date that's already in the past, so by the time grading runs the
      // window has had at least a full day of resyncs to pick up that date's real
      // Statcast events -- reading the already-committed file here needs no extra
      // network call. Computed once at grading time and persisted on the row (rather
      // than recomputed later from the rolling window), since near-hrs.json only keeps
      // each player's last 10 games and would otherwise lose the answer once this date
      // rolls out of that window.
      if (rec.result === 'loss') {
        const nearHRIdx = await loadNearHRsIndex();
        const events = nearHRIdx.get(String(rec.playerId));
        rec.nearMiss = Array.isArray(events) && events.some(e => e.date === rec.date);
      } else {
        rec.nearMiss = false;
      }
      graded++;
    }
  }
  return graded;
}

async function captureToday(store, compStore, drpSimCompStore) {
  const today = cdtDateString(new Date());
  const sched = await fetchJSON(`${API}/schedule?sportId=1&date=${today}&hydrate=team,probablePitcher,linescore,weather`);
  const games = sched?.dates?.find(d => d.date === today)?.games || [];
  const season = today.slice(0, 4);
  const previewGames = games.filter(g => g.status?.abstractGameState === 'Preview');
  let added = 0;

  // Fetched at most once per day, not once per run — this script fires twice daily
  // (morning capture + an afternoon re-pass that catches HR Threat picks for batters
  // whose lineup spot wasn't posted yet on the first pass, see the workflow's cron
  // entries), and re-fetching odds on the second run would double real API usage
  // against a metered monthly quota for no benefit (K Props/DRP are already locked by then).
  let oddsLookup = { pitcherLines: new Map(), batterLines: new Map() };
  if (store.oddsLastFetchedDate !== today) {
    oddsLookup = await fetchOddsLookup();
    store.oddsLastFetchedDate = today;
    try {
      const lines = Array.from(oddsLookup.pitcherLines.entries())
        .filter(([, v]) => v.strikeouts)
        .map(([name, v]) => ({
          pitcherName: name,
          line: v.strikeouts.line,
          overPrice: v.strikeouts.overPrice,
          underPrice: v.strikeouts.underPrice,
          book: v.strikeouts.book,
        }));
      await mkdir(path.dirname(K_PROPS_ODDS_PATH), { recursive: true });
      await writeFile(K_PROPS_ODDS_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), lines }, null, 2) + '\n');
      console.log(`Wrote data/k-props.json: ${lines.length} real sportsbook K line(s).`);
    } catch (e) {
      console.warn('Failed to write data/k-props.json:', e.message);
    }
    try {
      const players = Array.from(oddsLookup.batterLines.entries()).map(([name, markets]) => ({ playerName: name, markets }));
      await mkdir(path.dirname(PROP_MARKET_ODDS_PATH), { recursive: true });
      await writeFile(PROP_MARKET_ODDS_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), players }, null, 2) + '\n');
      console.log(`Wrote data/prop-market-odds.json: real sportsbook batter prop lines for ${players.length} player(s).`);
    } catch (e) {
      console.warn('Failed to write data/prop-market-odds.json:', e.message);
    }
  } else {
    console.log('Odds already fetched today — reusing model-only fallback for this pass.');
  }

  // Free/unauthenticated (no quota to budget, unlike oddsLookup above), so this
  // is fetched on every pass -- harmless on the afternoon re-pass since it's
  // only actually used below for games that haven't been DRP-captured yet.
  const espnEventIds = await loadEspnEventIds();

  for (const g of previewGames) {
    const gameDay = cdtDateString(new Date(g.gameDate));
    const drpKey = `${gameDay}|DRP|${[g.teams.away.team.abbreviation, g.teams.home.team.abbreviation].sort().join('-')}`;
    // Check-before-compute: this script runs more than once a day (see the afternoon
    // re-pass comment above), and DRP/K Props are already fully captured on the first
    // pass — skip the expensive model recompute entirely instead of doing the work and
    // discarding it as a duplicate.
    if (!store.market.drp.some(r => r.key === drpKey)) {
      try {
        const drp = await computeDRPick(g, season, espnEventIds);
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
        const kp = await computeKProp(g, side, season, oddsLookup);
        if (kp) { store.market.kprop.push(kp); added++; }
      } catch (e) {
        console.warn(`K Props capture failed for gamePk ${g.gamePk}/${side}:`, e.message);
      }
    }
  }
  console.log(`Captured ${added} new pending DRP/K Props pick(s) for ${today}.`);

  if (compStore) {
    const bpAdded = await captureBallparkPalComparisonToday(compStore, previewGames, store);
    console.log(`Captured ${bpAdded} new Ballpark Pal comparison entr(ies) for ${today}.`);
  }

  if (drpSimCompStore) {
    const simAdded = await captureDRPSimComparisonToday(drpSimCompStore, previewGames, store, season);
    console.log(`Captured ${simAdded} new DRP simulation comparison entr(ies) for ${today}.`);
  }

  // Built once and shared — the HR Threats hit-rate tracker and generate-headlines.mjs's
  // storylines both need the same full batter pool (season stats, recent form, platoon
  // splits per batter), which is the single most expensive part of this script (per-batter
  // API calls).
  const pool = previewGames.length ? await buildBatterPool(previewGames, season) : [];

  const hrThreatAdded = await captureHRThreatToday(store, pool);
  console.log(`Captured ${hrThreatAdded} new pending HR Threat pool entry(ies) for ${today}.`);
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
      // Near miss (roadmap 2.5) -- a moneyline loss decided by a single run. A game
      // winner is inherently binary, so this is the closest real, unambiguous
      // "the model's read wasn't far off" bucket available without inventing a
      // synthetic score-based confidence number.
      rec.scoreMargin = Math.abs(awayScore - homeScore);
      rec.nearMiss = rec.result === 'loss' && rec.scoreMargin === 1;
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
        const pitching = p?.stats?.pitching || {};
        finalK = n(pitching.strikeOuts, NaN);
        // Real post-game performance, alongside finalK -- so a miss can later be told
        // apart as "the model's stuff read was wrong" (finalIP/finalBF look normal, K's
        // just didn't come) vs. "the model was right but got cut short" (a short outing/
        // early hook limited the strikeout opportunity regardless of how well they threw).
        const numOrNull = v => { const x = n(v, NaN); return Number.isFinite(x) ? x : null; };
        rec.finalIP = pitching.inningsPitched != null ? parseInningsPitched(pitching.inningsPitched) : null;
        rec.finalPitches = numOrNull(pitching.numberOfPitches);
        rec.finalBB = numOrNull(pitching.baseOnBalls);
        rec.finalHits = numOrNull(pitching.hits);
        rec.finalBF = numOrNull(pitching.battersFaced);
      } catch (e) {
        console.warn(`Boxscore fetch failed for gamePk ${rec.gamePk}:`, e.message);
      }
      if (!Number.isFinite(finalK)) continue;
      rec.finalK = finalK;
      rec.result = finalK === rec.line ? 'push' : (finalK > rec.line ? 'win' : 'loss');
      // Near miss (roadmap 2.5) -- a loss where the final K total still landed within
      // one strikeout of the line (e.g. Over 6.5, finalK 6): the model's read was
      // essentially correct, the pitcher just fell one K short/over. KPROP_NEAR_MISS_MARGIN
      // documented alongside the other roadmap-2.5 near-miss definitions in
      // scripts/generate-performance-report.mjs.
      rec.nearMiss = rec.result === 'loss' && Math.abs(finalK - rec.line) <= 1;
      graded++;
    }
  }
  console.log(`Graded ${graded} pick(s).`);

  const hrThreatGraded = await gradeHRThreatPending(store);
  console.log(`Graded ${hrThreatGraded} HR Threat pool entry(ies).`);
}

async function main() {
  await loadModelParams();
  await loadHRLogisticModel();
  const store = await loadTracker();
  await gradePending(store);

  const compStore = await loadBallparkPalComparison();
  const bpGraded = await gradeBallparkPalComparison(compStore);

  const drpSimCompStore = await loadDRPSimComparison();
  const simGraded = await gradeDRPSimComparison(drpSimCompStore);

  await captureToday(store, compStore, drpSimCompStore);
  recomputeAllTime(store);
  await saveTracker(store);
  console.log('tracker.json updated:', TRACKER_PATH);
  console.log('All-time:', JSON.stringify(store.allTime));

  recomputeBallparkPalSummary(compStore);
  await saveBallparkPalComparison(compStore);
  console.log(`Ballpark Pal comparison: graded ${bpGraded}, ${compStore.entries.length} total entries, summary:`, JSON.stringify(compStore.summary));

  recomputeDRPSimSummary(drpSimCompStore);
  await saveDRPSimComparison(drpSimCompStore);
  console.log(`DRP sim comparison: graded ${simGraded}, ${drpSimCompStore.entries.length} total entries, summary:`, JSON.stringify(drpSimCompStore.summary));
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
  buildBatterPool,
  captureHRThreatToday, gradeHRThreatPending,
  simulatePropOdds, simulateSBOdds, simulateHRGameOdds, scoreForMarket,
  fetchOddsLookup, normalizeName,
  loadEspnEventIds, fetchGameMoneyline,
  loadStatcastPowerIndex, loadPitcherStatcastPowerIndex, loadPitcher2kSuppressionIndex, battedBallPowerIndex, zoneMatchupMultiplier,
  computeZoneFitServer, zoneValsFromByZoneServer,
  computeMatchupEdgeScore, battingSplitVsHand,
  parseInningsPitched, pitcherBattersFacedPer9,
  windPowerFactor, temperaturePowerFactor, isDayGameCT, doubleheaderFatigueFactor, teamRestFatigueFactor,
  battingSplitHomeAway, homeRoadPowerFactor,
  loadBallparkPalComparison, saveBallparkPalComparison, recomputeBallparkPalSummary,
  fetchBallparkPalMoneyline, gradeBallparkPalComparison, captureBallparkPalComparisonToday,
  log5, computeMatchupOutcomeDist, LEAGUE_AVG_PA_RATES,
  sampleOutcome, advanceRunners, simulateHalfInning, simulateOneGame, simulateDRPGame,
  fetchTeamPitchingAggregate, buildDRPSimLineup, computeDRPSimulation,
  loadDRPSimComparison, saveDRPSimComparison, recomputeDRPSimSummary,
  gradeDRPSimComparison, captureDRPSimComparisonToday,
  loadModelParams, MODEL_PARAMS_PATH, DEFAULT_MODEL_PARAMS, shrinkMult, calibrateHRProb,
  loadHRLogisticModel, predictHRLogistic,
  computeIsHot,
  computeLiveHRScore, liveOnFireScore, liveFallbackHotHitterProfile,
};
