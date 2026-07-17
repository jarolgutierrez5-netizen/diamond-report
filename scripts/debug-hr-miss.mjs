#!/usr/bin/env node
// Temporary diagnostic — NOT meant to stay in the repo. Phase 2: replicate the exact
// hrProb formula from loadHRPotential()/simulateHRGameOdds() in app.js against real
// stats for the full starting lineups of the 2026-07-16 NYM @ PHI game (gamePk 823440),
// to determine whether Trea Turner, Brett Baty, and Francisco Alvarez were excluded from
// the HR Threat list by the display-filter probability floor (topHrThreat && hrProb>=5,
// or hrProb>=10 otherwise) rather than by any of the earlier-ruled-out filters.

const API = 'https://statsapi.mlb.com/api/v1';
const GAME_PK = 823440;
const TARGETS = ['Trea Turner', 'Brett Baty', 'Francisco Alvarez'];

async function fetchJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DiamondReportBot/1.0)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// --- ported from app.js's HR-sim IIFE (verbatim math) ---
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function n(v, fallback) { v = parseFloat(v); return Number.isFinite(v) ? v : (fallback == null ? 0 : fallback); }
function estimatePA(battingOrder) {
  if (!battingOrder) return 4.2;
  return clamp(4.75 - (battingOrder - 1) * 0.11, 3.6, 4.75);
}
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
function simulateHRGameOdds(pPerPA, battingOrder) {
  pPerPA = clamp(n(pPerPA, 0.03), 0, 0.5);
  const dist = paDistribution(estimatePA(battingOrder));
  let prob = 0;
  for (const k in dist) prob += dist[k] * (1 - Math.pow(1 - pPerPA, Number(k)));
  return Math.max(1, Math.min(99, Math.round(prob * 100)));
}

const HRP_MIN_AB_FOR_RATE = 40;
const HRP_LEAGUE_AVG_HR_RATE = 0.031;

function batterHrRate(ab, hr) {
  const rawBatterRate = ab > 0 ? hr / ab : 0;
  const hrpSampleWeight = Math.min(ab, HRP_MIN_AB_FOR_RATE) / HRP_MIN_AB_FOR_RATE;
  return ((rawBatterRate * hrpSampleWeight) + (HRP_LEAGUE_AVG_HR_RATE * (1 - hrpSampleWeight))) * 0.88;
}

async function seasonHitting(pid) {
  const pd = await fetchJSON(`${API}/people/${pid}?hydrate=stats(group=hitting,type=season,season=2026)`);
  const s = pd.people?.[0]?.stats?.[0]?.splits?.[0]?.stat || {};
  return { ab: parseInt(s.atBats) || 0, hr: parseInt(s.homeRuns) || 0, name: pd.people?.[0]?.fullName };
}

async function seasonPitching(pid) {
  const pd = await fetchJSON(`${API}/people/${pid}?hydrate=stats(group=pitching,type=season,season=2026)`);
  const s = pd.people?.[0]?.stats?.[0]?.splits?.[0]?.stat || {};
  return { hr9: parseFloat(s.homeRunsPer9) || 0, name: pd.people?.[0]?.fullName };
}

async function main() {
  const sched = await fetchJSON(`${API}/schedule?sportId=1&date=2026-07-16&hydrate=team,probablePitcher,linescore`);
  const game = sched.dates?.[0]?.games?.find(g => g.gamePk === GAME_PK);
  const box = await fetchJSON(`${API}/game/${GAME_PK}/boxscore`);

  for (const side of ['away', 'home']) {
    const oppSide = side === 'away' ? 'home' : 'away';
    const pitcher = game.teams[oppSide].probablePitcher;
    const pitching = await seasonPitching(pitcher.id);
    const pitcherRate = pitching.hr9 > 0 ? pitching.hr9 / 38 : 0.03;
    // gameParkFactor defaults to 100 (data/park-factors.json has never successfully
    // populated), so parkAdj = 1 + ((100-100)/100)*0.5 = 1 exactly.
    const parkAdj = 1;

    const teamBox = box.teams[side];
    const abbr = teamBox.team.abbreviation;
    console.log(`\n=== ${side.toUpperCase()} (${abbr}) batters vs ${pitching.name} (HR/9=${pitching.hr9}, pitcherRate=${pitcherRate.toFixed(4)}) ===`);

    const starters = [];
    for (const [pid, p] of Object.entries(teamBox.players || {})) {
      const bo = Number(p.battingOrder ?? p.stats?.batting?.battingOrder ?? NaN);
      if (!Number.isFinite(bo) || bo % 100 !== 0) continue;
      starters.push({ pid: p.person.id, name: p.person.fullName, boRaw: bo, order: Math.max(1, Math.min(9, Math.floor(bo / 100))) });
    }
    starters.sort((a, b) => a.order - b.order);

    const rows = [];
    for (const st of starters) {
      const h = await seasonHitting(st.pid);
      const batterRate = batterHrRate(h.ab, h.hr);
      const hrPerPA = ((batterRate * 0.6) + (pitcherRate * 0.4)) * parkAdj;
      const hrProb = simulateHRGameOdds(hrPerPA, st.order);
      rows.push({ ...st, ab: h.ab, hr: h.hr, hrProb });
    }

    const topRow = rows.reduce((best, r) => (r.hrProb > best.hrProb ? r : best), rows[0]);
    rows.forEach(r => {
      const isTop = r.pid === topRow.pid;
      const displayed = (isTop && r.hrProb >= 5) || r.hrProb >= 10;
      const flag = TARGETS.includes(r.name) ? '  <<< TARGET' : '';
      console.log(`  #${r.order} ${r.name.padEnd(20)} AB=${r.ab} HR=${String(r.hr).padStart(2)} hrProb=${String(r.hrProb).padStart(2)}%  topHrThreat=${isTop}  DISPLAYED=${displayed}${flag}`);
    });
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
