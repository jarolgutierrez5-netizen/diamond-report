// ─────────────────────────────────────────────────────────────────────────
// NFL Anytime TD + WNBA prop board family — extracted out of app.js (which had
// grown to ~19,900 lines / 1.2MB) as the first, lowest-risk slice of a larger
// file-size scoping pass. This is a clean, self-contained boundary: every one
// of these 21 functions was only ever called from within this same block, and
// every reference to them FROM app.js goes through `window.*` property access
// (never a bare identifier) — the guarded `typeof window.renderNFLTDBoard ===
// 'function'` check in activateGamePickPane, and the WNBA_PANE_RENDER_FN
// lookup table, which stores these as STRING names looked up via
// `window[name]()`, not bare references. That means this file can load in a
// completely separate <script> tag with zero call-site changes required in
// app.js.
//
// This file is a plain classic script (not a module), loaded via a normal
// <script> tag in index.html AFTER app.min.js, so it shares the same global
// scope app.js's other boards already do — every helper this file calls
// (drFetchDailyJSON, drCaptureSearchFocus, drRestoreSearchFocus,
// drMatchesSearch, drSearchInputHTML, drSetBoardSearch, fantasyEsc,
// window.drWatchStarHTML) is defined in app.js and already loaded by the time
// this file's own top-level code runs.
//
// Verified via scripts/audit-window-refs.mjs (now scans both files) and the
// full tests/visual/ Playwright suite before this split shipped — same
// pre-ship checks every other change in this app goes through.
//
// NOTE: this split is purely organizational right now — this file is still
// loaded eagerly on every page view (a normal <script> tag), not fetched only
// when the NFL/WNBA tab opens. On-demand loading (the actual page-weight win)
// is a natural follow-up now that this boundary exists, not bundled into this
// change to keep the risk surface small.
// ─────────────────────────────────────────────────────────────────────────

// ── NFL Anytime Touchdown Scorer (first real NFL board) ────────────────────
// Real season TD-per-game rate (data/nfl-player-stats.json, scripts/sync-nfl-
// player-stats.mjs) run through a simple Poisson at-least-one-event model --
// P(at least 1 TD) = 1 - e^(-lambda), lambda = real season TD/game rate. No
// opponent-defense adjustment yet (that's the natural next step, same as how
// the MLB HR formula itself started as a single real rate before Matchup
// Edge/Zone Fit/park/weather were layered in over many iterations) -- an
// honest first cut, not a finished model.
function nflAnytimeTDProb(tdPerGame) {
  const lambda = Math.max(0, Number(tdPerGame) || 0);
  const p = 1 - Math.exp(-lambda);
  return Math.max(1, Math.min(99, Math.round(p * 100)));
}

let nflTDDataPromise = null;
async function loadNFLTDData(force = false) {
  if (nflTDDataPromise && !force) return nflTDDataPromise;
  nflTDDataPromise = (async () => {
    const [scheduleData, statsData] = await Promise.all([
      drFetchDailyJSON('data/nfl-schedule.json').catch(() => null),
      drFetchDailyJSON('data/nfl-player-stats.json').catch(() => null),
    ]);
    return { schedule: (scheduleData && scheduleData.events) || [], players: (statsData && statsData.players) || {} };
  })();
  return nflTDDataPromise;
}

// Sort/filter state -- same module-level var + toggle-on-reclick shape as
// kPropsSortBy (app.js:12145): dir 1 = default (shown as ↓, higher first
// since every sort field here is "more is more relevant"), -1 = reversed.
let _nflTDSort = null;
let _nflTDSortDir = 1;
let _nflTDGameFilter = '';
const NFL_TD_SORT_FIELDS = [
  { key: 'prob', label: 'Prob' },
  { key: 'td', label: 'TD' },
  { key: 'games', label: 'Games' },
];
function nflTDSortBy(key) {
  if (_nflTDSort === key) { _nflTDSortDir *= -1; }
  else { _nflTDSort = key; _nflTDSortDir = 1; }
  if (!key) { _nflTDSort = null; _nflTDSortDir = 1; }
  renderNFLTDBoard();
}
function setNFLTDGameFilter(value) {
  _nflTDGameFilter = value || '';
  renderNFLTDBoard();
}

// Real computed banner, mirroring drKSummaryHTML's shape (app.js:11757) and
// the shared .dr1027-hr-summary class K Props/HR Threats already reuse --
// Top Rated/Board Avg/Scanned/Primary Signal, all pulled from this render's
// own real rows (same numbers already on each card, nothing new computed).
function nflTDSummaryHTML(rows) {
  if (!rows.length) return '';
  const byProb = rows.slice().sort((a, b) => b.prob - a.prob);
  const top = byProb[0];
  const sample = byProb.slice(0, Math.min(8, byProb.length));
  const avg = Math.round(sample.reduce((a, p) => a + p.prob, 0) / sample.length);
  return `<div class="dr1027-hr-summary"><div class="dr1027-summary-title">🏈 EXPANDED <span>NFL ANYTIME TD DATA</span></div><p class="dr1027-summary-copy">Real season touchdown rate per skill-position player, modeled as at-least-one-TD-this-game probability. Early model — no opponent defense adjustment yet.</p><div class="dr1027-summary-grid"><div class="dr1027-summary-metric good"><b>${fantasyEsc(top.name || '–')}</b><span>Top Rated</span></div><div class="dr1027-summary-metric"><b>${avg}%</b><span>Board Avg Probability</span></div><div class="dr1027-summary-metric"><b>${rows.length}</b><span>Players Scanned</span></div><div class="dr1027-summary-metric warn"><b>Anytime TD</b><span>Primary Signal</span></div></div></div>`;
}

function nflTDCardHTML(r) {
  const scoreCls = r.prob >= 55 ? 'good' : '';
  return `<div class="dr109-card${scoreCls ? ' prop-hit' : ''}">
    ${window.drWatchStarHTML('nfl-' + r.id, r.name)}
    <div class="dr109-card-head">
      <div class="dr109-player">
        <img loading="lazy" src="${r.headshot || ''}" onerror="this.style.display='none'" alt="">
        <div style="min-width:0">
          <div class="dr109-name">${fantasyEsc(r.name || 'Player')}</div>
          <div class="dr109-meta">${fantasyEsc(r.position || '')} · ${fantasyEsc(r.teamAbbr || '')} vs ${fantasyEsc(r.oppAbbr || '')}</div>
        </div>
      </div>
      <div class="dr109-score">${r.prob}%<small>Anytime TD</small></div>
    </div>
    <div class="dr109-chiprow">
      <span class="dr109-chip"><span>Season TD:</span><strong>${r.td != null ? r.td : '–'}</strong></span>
      <span class="dr109-chip"><span>Games:</span><strong>${r.games != null ? r.games : '–'}</strong></span>
      <span class="dr109-chip"><span>TD/GM:</span><strong>${r.tdPerGame != null ? r.tdPerGame.toFixed(2) : '–'}</strong></span>
      <span class="dr109-chip"><span>Season:</span><strong>${r.season != null ? r.season : '–'}</strong></span>
    </div>
  </div>`;
}

async function renderNFLTDBoard() {
  const el = document.getElementById('nfl-td-content');
  if (!el) return;
  const __searchFocus = drCaptureSearchFocus('nfltd-search-input');
  let data;
  try {
    data = await loadNFLTDData();
  } catch (e) {
    el.innerHTML = '<div class="mu-empty">Couldn\'t load NFL data. Check back shortly.</div>';
    return;
  }
  const upcoming = (data.schedule || []).filter(g => !g.completed && g.date).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  if (!upcoming.length) {
    el.innerHTML = '<div class="mu-empty">No upcoming NFL games found. Check back closer to kickoff.</div>';
    return;
  }
  // Same "nearest upcoming calendar date" scoping the MLB boards use for
  // "today's slate" -- games are sparse (especially in preseason), so this
  // is whichever real date has the next kickoff, not a fixed "today" that
  // could legitimately have zero games on it.
  const nextDate = upcoming[0].date.slice(0, 10);
  const slateGames = upcoming.filter(g => (g.date || '').slice(0, 10) === nextDate);
  const oppByTeam = {};
  slateGames.forEach(g => {
    if (g.home && g.away && g.home.abbreviation && g.away.abbreviation) {
      oppByTeam[g.home.abbreviation] = g.away.abbreviation;
      oppByTeam[g.away.abbreviation] = g.home.abbreviation;
    }
  });
  const allRows = Object.entries(data.players || {})
    .filter(([id, p]) => p.teamAbbr && oppByTeam[p.teamAbbr] != null && p.tdPerGame != null)
    .map(([id, p]) => Object.assign({ id }, p, { oppAbbr: oppByTeam[p.teamAbbr], prob: nflAnytimeTDProb(p.tdPerGame) }));
  if (!allRows.length) {
    el.innerHTML = `<div class="mu-empty">No player season stats synced yet for the ${fantasyEsc(nextDate)} slate. Check back once the daily sync has run.</div>`;
    return;
  }

  // Game filter dropdown -- real games on this slate, keyed by a stable
  // away@home team-abbreviation pair since NFL's real schedule data (see
  // sync-nfl-schedule.mjs) doesn't carry a per-player game id the way MLB's
  // gamePk does.
  const gameOptsHTML = ['<option value="">All Games</option>'].concat(
    slateGames.filter(g => g.home && g.away).map(g => {
      const gid = g.away.abbreviation + '@' + g.home.abbreviation;
      return `<option value="${gid}"${_nflTDGameFilter === gid ? ' selected' : ''}>${g.away.abbreviation} @ ${g.home.abbreviation}</option>`;
    })
  ).join('');

  let rows = allRows.filter(p => drMatchesSearch('nfltd', p.name));
  if (_nflTDGameFilter) {
    rows = rows.filter(p => {
      const opp = oppByTeam[p.teamAbbr];
      const gid = p.teamAbbr + '@' + opp, gidRev = opp + '@' + p.teamAbbr;
      return _nflTDGameFilter === gid || _nflTDGameFilter === gidRev;
    });
  }
  const sortKey = _nflTDSort || 'prob';
  rows = rows.slice().sort((a, b) => (b[sortKey] - a[sortKey]) * _nflTDSortDir);

  const sortBtns = NFL_TD_SORT_FIELDS.map(({ key, label }) => {
    const active = (_nflTDSort || 'prob') === key;
    const arrow = active ? (_nflTDSortDir === 1 ? ' ↓' : ' ↑') : '';
    return `<button onclick="nflTDSortBy('${key}')" style="font-size:9px;font-weight:700;font-family:Manrope,sans-serif;padding:4px 10px;border-radius:12px;border:1px solid ${active ? 'var(--accent2)' : 'var(--border)'};background:${active ? 'rgba(47,107,255,.12)' : 'var(--surface2)'};color:${active ? 'var(--accent2)' : 'var(--muted)'};cursor:pointer;white-space:nowrap;flex-shrink:0;transition:all .15s">${label}${arrow}</button>`;
  }).join('');

  const noMatches = !rows.length && ((window.__drBoardSearch.nfltd || '').trim() || _nflTDGameFilter);
  el.innerHTML = `<div class="dr109-summary"><div class="dr109-title">🏈 <span>${fantasyEsc(nextDate)} SLATE</span></div>`
    + `<p class="dr109-copy">Real season touchdown rate per skill-position player (${fantasyEsc(allRows[0].season)} season), modeled as at-least-one-TD-this-game probability. Early model — no opponent defense adjustment yet, values are generated from the active synced roster/stats data.</p></div>`
    + nflTDSummaryHTML(allRows)
    + `<div class="dr109-filter-row kprops-sticky-sort" style="display:flex;align-items:center;gap:6px;padding:8px 14px;background:var(--bg);border-bottom:1px solid var(--border);overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none;flex-wrap:nowrap">
        <span style="font-size:9px;font-weight:700;letter-spacing:1px;color:var(--muted);white-space:nowrap;flex-shrink:0">GAME:</span>
        <select onchange="setNFLTDGameFilter(this.value)" style="background:#0e1728;color:#fff;border:1px solid var(--border);border-radius:8px;padding:4px 8px;font-size:10px;font-weight:700;flex-shrink:0">${gameOptsHTML}</select>
        <span style="font-size:9px;font-weight:700;letter-spacing:1px;color:var(--muted);white-space:nowrap;flex-shrink:0">SORT:</span>
        ${sortBtns}
        <button onclick="nflTDSortBy(null)" style="font-size:9px;font-weight:700;font-family:Manrope,sans-serif;padding:3px 8px;border-radius:12px;border:1px solid var(--border);background:var(--surface2);color:var(--muted);cursor:pointer;white-space:nowrap;flex-shrink:0">RESET</button>
        ${drSearchInputHTML('nfltd', 'nfltd-search-input', 'Search players…', "drSetBoardSearch('nfltd',this.value,renderNFLTDBoard)")}
      </div>`
    + (noMatches ? `<div class="mu-empty" style="padding:24px">No players match the current search/filter.</div>` : rows.map(nflTDCardHTML).join(''));
  drRestoreSearchFocus(__searchFocus);
}
window.renderNFLTDBoard = renderNFLTDBoard;

// ── NFL Game Projections (favored team, real record/point differential) ───
// NFL has no per-game "starting pitcher" the way MLB's DRP board does, so
// this is entirely team-based: real win% and real point differential (data/
// nfl-team-stats.json, scripts/sync-nfl-team-stats.mjs -- ESPN's real
// standings), same shape as computeDRPick in scripts/update-tracker.mjs
// (start both teams at 50, add clamped points for each real signal, add a
// fixed home-field edge, normalize) just with football's own signals in
// place of ERA/WHIP/K9/season record. Early in a season (or in preseason,
// when this ships) win%/point differential are a tiny sample and genuinely
// noisy -- that's an honest reflection of a real small sample, not a bug,
// same "early model" framing the Anytime TD board above already uses.
const NFL_HOME_FIELD_EDGE = 2.5;
function nflGameWinProb(awayStats, homeStats) {
  let awayScore = 50, homeScore = 50;
  const awayWinPct = awayStats && awayStats.winPercent != null ? awayStats.winPercent : 0.5;
  const homeWinPct = homeStats && homeStats.winPercent != null ? homeStats.winPercent : 0.5;
  const winPctDiff = awayWinPct - homeWinPct;
  const winPctPts = Math.max(-20, Math.min(20, winPctDiff * 40));
  if (winPctPts >= 0) awayScore += winPctPts; else homeScore += Math.abs(winPctPts);

  const awayPD = awayStats && awayStats.pointDifferential != null ? awayStats.pointDifferential : 0;
  const homePD = homeStats && homeStats.pointDifferential != null ? homeStats.pointDifferential : 0;
  const pdDiff = awayPD - homePD;
  const pdPts = Math.max(-15, Math.min(15, pdDiff * 0.5));
  if (pdPts >= 0) awayScore += pdPts; else homeScore += Math.abs(pdPts);

  homeScore += NFL_HOME_FIELD_EDGE;

  const total = awayScore + homeScore;
  const awayPct = Math.max(1, Math.min(99, Math.round((awayScore / total) * 100)));
  return { awayPct, homePct: 100 - awayPct };
}

let nflGameDataPromise = null;
async function loadNFLGameData(force = false) {
  if (nflGameDataPromise && !force) return nflGameDataPromise;
  nflGameDataPromise = (async () => {
    const [scheduleData, teamStatsData, teamsData] = await Promise.all([
      drFetchDailyJSON('data/nfl-schedule.json').catch(() => null),
      drFetchDailyJSON('data/nfl-team-stats.json').catch(() => null),
      drFetchDailyJSON('data/nfl-teams.json').catch(() => null),
    ]);
    const teamMeta = {};
    ((teamsData && teamsData.teams) || []).forEach(t => { if (t.abbreviation) teamMeta[t.abbreviation] = t; });
    return { schedule: (scheduleData && scheduleData.events) || [], teamStats: (teamStatsData && teamStatsData.teams) || {}, teamMeta };
  })();
  return nflGameDataPromise;
}

let _nflGameSort = null;
let _nflGameSortDir = 1;
function nflGameSortBy(key) {
  if (_nflGameSort === key) { _nflGameSortDir *= -1; }
  else { _nflGameSort = key; _nflGameSortDir = 1; }
  if (!key) { _nflGameSort = null; _nflGameSortDir = 1; }
  renderNFLGameBoard();
}

function nflGameSummaryHTML(rows) {
  if (!rows.length) return '';
  const byConf = rows.slice().sort((a, b) => b.pickPct - a.pickPct);
  const top = byConf[0];
  const avg = Math.round(rows.reduce((a, r) => a + r.pickPct, 0) / rows.length);
  return `<div class="dr1027-hr-summary"><div class="dr1027-summary-title">🏈 EXPANDED <span>NFL GAME PROJECTIONS DATA</span></div><p class="dr1027-summary-copy">Favored team from each real matchup's win% and point differential, plus a fixed home-field edge. Early model — no injury/QB-status adjustment yet.</p><div class="dr1027-summary-grid"><div class="dr1027-summary-metric good"><b>${fantasyEsc(top.pick)}</b><span>Top Confidence Pick</span></div><div class="dr1027-summary-metric"><b>${avg}%</b><span>Board Avg Confidence</span></div><div class="dr1027-summary-metric"><b>${rows.length}</b><span>Games Scanned</span></div><div class="dr1027-summary-metric warn"><b>Moneyline</b><span>Primary Signal</span></div></div></div>`;
}

function nflRecordText(stats) {
  if (!stats) return '–';
  const ties = stats.ties ? `-${stats.ties}` : '';
  return `${stats.wins}-${stats.losses}${ties}`;
}

function nflGameCardHTML(g) {
  const pickAway = g.pick === g.away;
  return `<div class="dr109-card${g.pickPct >= 60 ? ' prop-hit' : ''}">
    <div class="dr109-card-head">
      <div class="dr109-player">
        <img loading="lazy" src="${(g.awayMeta && g.awayMeta.logo) || ''}" onerror="this.style.display='none'" alt="" style="width:32px;height:32px;object-fit:contain">
        <div style="min-width:0">
          <div class="dr109-name">${fantasyEsc(g.away)} @ ${fantasyEsc(g.home)}</div>
          <div class="dr109-meta">${fantasyEsc(nflRecordText(g.awayStats))} vs ${fantasyEsc(nflRecordText(g.homeStats))}</div>
        </div>
      </div>
      <div class="dr109-score">${g.pickPct}%<small>${fantasyEsc(g.pick)} to win</small></div>
    </div>
    <div class="dr109-chiprow">
      <span class="dr109-chip"><span>Pick:</span><strong>${fantasyEsc(g.pick)}</strong></span>
      <span class="dr109-chip"><span>${fantasyEsc(g.away)} Pt Diff:</span><strong>${g.awayStats && g.awayStats.pointDifferential != null ? (g.awayStats.pointDifferential >= 0 ? '+' : '') + g.awayStats.pointDifferential : '–'}</strong></span>
      <span class="dr109-chip"><span>${fantasyEsc(g.home)} Pt Diff:</span><strong>${g.homeStats && g.homeStats.pointDifferential != null ? (g.homeStats.pointDifferential >= 0 ? '+' : '') + g.homeStats.pointDifferential : '–'}</strong></span>
      <span class="dr109-chip"><span>Home Field:</span><strong>${fantasyEsc(g.home)}</strong></span>
    </div>
  </div>`;
}

async function renderNFLGameBoard() {
  const el = document.getElementById('nfl-game-content');
  if (!el) return;
  let data;
  try {
    data = await loadNFLGameData();
  } catch (e) {
    el.innerHTML = '<div class="mu-empty">Couldn\'t load NFL data. Check back shortly.</div>';
    return;
  }
  const upcoming = (data.schedule || []).filter(g => !g.completed && g.date && g.home && g.away).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  if (!upcoming.length) {
    el.innerHTML = '<div class="mu-empty">No upcoming NFL games found. Check back closer to kickoff.</div>';
    return;
  }
  // Same "nearest upcoming calendar date" slate scoping loadNFLTDData uses --
  // games are sparse (especially in preseason), so this is whichever real
  // date has the next kickoff, not a fixed "today" that could legitimately
  // have zero games on it.
  const nextDate = upcoming[0].date.slice(0, 10);
  const slateGames = upcoming.filter(g => (g.date || '').slice(0, 10) === nextDate);

  let rows = slateGames.map(g => {
    const awayStats = data.teamStats[g.away.abbreviation] || null;
    const homeStats = data.teamStats[g.home.abbreviation] || null;
    const { awayPct, homePct } = nflGameWinProb(awayStats, homeStats);
    const pick = awayPct >= homePct ? g.away.abbreviation : g.home.abbreviation;
    const pickPct = Math.max(awayPct, homePct);
    return {
      away: g.away.abbreviation, home: g.home.abbreviation,
      awayStats, homeStats, pick, pickPct,
      awayMeta: data.teamMeta[g.away.abbreviation], homeMeta: data.teamMeta[g.home.abbreviation],
      timestamp: Date.parse(g.date) || 0,
    };
  });

  if (_nflGameSort) {
    const sortKey = _nflGameSort;
    rows = rows.slice().sort((a, b) => (b[sortKey] - a[sortKey]) * _nflGameSortDir);
  } else {
    rows = rows.slice().sort((a, b) => a.timestamp - b.timestamp);
  }

  const sortBtns = [{ key: 'pickPct', label: 'Confidence' }].map(({ key, label }) => {
    const active = _nflGameSort === key;
    const arrow = active ? (_nflGameSortDir === 1 ? ' ↓' : ' ↑') : '';
    return `<button onclick="nflGameSortBy('${key}')" style="font-size:9px;font-weight:700;font-family:Manrope,sans-serif;padding:4px 10px;border-radius:12px;border:1px solid ${active ? 'var(--accent2)' : 'var(--border)'};background:${active ? 'rgba(47,107,255,.12)' : 'var(--surface2)'};color:${active ? 'var(--accent2)' : 'var(--muted)'};cursor:pointer;white-space:nowrap;flex-shrink:0;transition:all .15s">${label}${arrow}</button>`;
  }).join('');

  el.innerHTML = `<div class="dr109-summary"><div class="dr109-title">🏈 <span>${fantasyEsc(nextDate)} SLATE</span></div>`
    + `<p class="dr109-copy">Favored team from each real matchup's win% and point differential, plus a fixed home-field edge. Early model — no injury/QB-status adjustment yet, values are generated from the active synced standings data.</p></div>`
    + nflGameSummaryHTML(rows)
    + `<div class="dr109-filter-row kprops-sticky-sort" style="display:flex;align-items:center;gap:6px;padding:8px 14px;background:var(--bg);border-bottom:1px solid var(--border);overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none;flex-wrap:nowrap">
        <span style="font-size:9px;font-weight:700;letter-spacing:1px;color:var(--muted);white-space:nowrap;flex-shrink:0">SORT:</span>
        ${sortBtns}
        <button onclick="nflGameSortBy(null)" style="font-size:9px;font-weight:700;font-family:Manrope,sans-serif;padding:3px 8px;border-radius:12px;border:1px solid var(--border);background:var(--surface2);color:var(--muted);cursor:pointer;white-space:nowrap;flex-shrink:0">RESET</button>
      </div>`
    + rows.map(nflGameCardHTML).join('');
}
window.renderNFLGameBoard = renderNFLGameBoard;

// ── NFL Rushing Yards (real O/U line, real empirical hit rate) ─────────────
// Unlike Anytime TD's Poisson at-least-one-event model, rushing yards is a
// continuous per-game stat, so the probability here is the real EMPIRICAL
// rate at which this player's own actual per-game rushing yards this season
// cleared the line -- computed server-side in scripts/sync-nfl-player-stats.
// mjs's lineStats (same method sync-wnba-player-stats.mjs's own lineStats
// uses for the WNBA boards), not a fitted/simulated distribution. The line
// itself (39.5) was picked by checking the real percentile it falls at
// across this season's real synced rushers -- roughly the 65th-75th
// percentile among real RBs specifically (~92nd across every skill-position
// player, most of whom rarely rush at all) -- a genuine starter-caliber
// threshold, same relative selectivity the WNBA boards' own calibrated
// lines use, and close to a typical real sportsbook rushing-yards prop line.
const NFL_RUSH_YDS_LINE = 39.5;
const NFL_RUSH_MIN_GAMES = 4;

let nflRushDataPromise = null;
async function loadNFLRushData(force = false) {
  if (nflRushDataPromise && !force) return nflRushDataPromise;
  nflRushDataPromise = (async () => {
    const [scheduleData, statsData] = await Promise.all([
      drFetchDailyJSON('data/nfl-schedule.json').catch(() => null),
      drFetchDailyJSON('data/nfl-player-stats.json').catch(() => null),
    ]);
    return { schedule: (scheduleData && scheduleData.events) || [], players: (statsData && statsData.players) || {} };
  })();
  return nflRushDataPromise;
}

let _nflRushSort = null;
let _nflRushSortDir = 1;
let _nflRushGameFilter = '';
const NFL_RUSH_SORT_FIELDS = [
  { key: 'prob', label: 'Prob' },
  { key: 'rushYdsPerGame', label: 'Yds/Gm' },
  { key: 'games', label: 'Games' },
];
function nflRushSortBy(key) {
  if (_nflRushSort === key) { _nflRushSortDir *= -1; }
  else { _nflRushSort = key; _nflRushSortDir = 1; }
  if (!key) { _nflRushSort = null; _nflRushSortDir = 1; }
  renderNFLRushBoard();
}
function setNFLRushGameFilter(value) {
  _nflRushGameFilter = value || '';
  renderNFLRushBoard();
}

function nflRushSummaryHTML(rows) {
  if (!rows.length) return '';
  const byProb = rows.slice().sort((a, b) => b.prob - a.prob);
  const top = byProb[0];
  const sample = byProb.slice(0, Math.min(8, byProb.length));
  const avg = Math.round(sample.reduce((a, p) => a + p.prob, 0) / sample.length);
  return `<div class="dr1027-hr-summary"><div class="dr1027-summary-title">🏈 EXPANDED <span>NFL RUSHING YARDS DATA</span></div><p class="dr1027-summary-copy">Real empirical rate this season that each player's own actual per-game rushing yards cleared Over ${NFL_RUSH_YDS_LINE}, not a fitted or simulated distribution. Early model — no opponent run-defense adjustment yet.</p><div class="dr1027-summary-grid"><div class="dr1027-summary-metric good"><b>${fantasyEsc(top.name || '–')}</b><span>Top Rated</span></div><div class="dr1027-summary-metric"><b>${avg}%</b><span>Board Avg Probability</span></div><div class="dr1027-summary-metric"><b>${rows.length}</b><span>Players Scanned</span></div><div class="dr1027-summary-metric warn"><b>Over ${NFL_RUSH_YDS_LINE} Yds</b><span>Primary Line</span></div></div></div>`;
}

function nflRushCardHTML(r) {
  const scoreCls = r.prob >= 55 ? 'good' : '';
  return `<div class="dr109-card${scoreCls ? ' prop-hit' : ''}">
    ${window.drWatchStarHTML('nfl-' + r.id, r.name)}
    <div class="dr109-card-head">
      <div class="dr109-player">
        <img loading="lazy" src="${r.headshot || ''}" onerror="this.style.display='none'" alt="">
        <div style="min-width:0">
          <div class="dr109-name">${fantasyEsc(r.name || 'Player')}</div>
          <div class="dr109-meta">${fantasyEsc(r.position || '')} · ${fantasyEsc(r.teamAbbr || '')} vs ${fantasyEsc(r.oppAbbr || '')}</div>
        </div>
      </div>
      <div class="dr109-score">${r.prob}%<small>Over ${NFL_RUSH_YDS_LINE} Yds</small></div>
    </div>
    <div class="dr109-chiprow">
      <span class="dr109-chip"><span>Season Rush Yds:</span><strong>${r.rushYds != null ? r.rushYds : '–'}</strong></span>
      <span class="dr109-chip"><span>Games:</span><strong>${r.gamesWithRushYds != null ? r.gamesWithRushYds : '–'}</strong></span>
      <span class="dr109-chip"><span>Yds/GM:</span><strong>${r.rushYdsPerGame != null ? r.rushYdsPerGame.toFixed(1) : '–'}</strong></span>
      <span class="dr109-chip"><span>Std Dev:</span><strong>${r.rushStdDev != null ? r.rushStdDev.toFixed(1) : '–'}</strong></span>
    </div>
  </div>`;
}

async function renderNFLRushBoard() {
  const el = document.getElementById('nfl-rush-content');
  if (!el) return;
  const __searchFocus = drCaptureSearchFocus('nflrush-search-input');
  let data;
  try {
    data = await loadNFLRushData();
  } catch (e) {
    el.innerHTML = '<div class="mu-empty">Couldn\'t load NFL data. Check back shortly.</div>';
    return;
  }
  const upcoming = (data.schedule || []).filter(g => !g.completed && g.date).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  if (!upcoming.length) {
    el.innerHTML = '<div class="mu-empty">No upcoming NFL games found. Check back closer to kickoff.</div>';
    return;
  }
  // Same "nearest upcoming calendar date" scoping loadNFLTDData/
  // loadNFLGameData already use -- games are sparse (especially in
  // preseason), so this is whichever real date has the next kickoff, not a
  // fixed "today" that could legitimately have zero games on it.
  const nextDate = upcoming[0].date.slice(0, 10);
  const slateGames = upcoming.filter(g => (g.date || '').slice(0, 10) === nextDate);
  const oppByTeam = {};
  slateGames.forEach(g => {
    if (g.home && g.away && g.home.abbreviation && g.away.abbreviation) {
      oppByTeam[g.home.abbreviation] = g.away.abbreviation;
      oppByTeam[g.away.abbreviation] = g.home.abbreviation;
    }
  });
  // NFL_RUSH_MIN_GAMES keeps a single-game small sample (a real hit rate of
  // either 0% or 100% off one game tells a user nothing reliable) off the
  // board entirely, same "don't show a number the sample can't support"
  // rule POOL_MIN_AB enforces for MLB's batter pool.
  const allRows = Object.entries(data.players || {})
    .filter(([id, p]) => p.teamAbbr && oppByTeam[p.teamAbbr] != null && p.rushYdsPerGame != null && (p.gamesWithRushYds || 0) >= NFL_RUSH_MIN_GAMES)
    .map(([id, p]) => Object.assign({ id }, p, { oppAbbr: oppByTeam[p.teamAbbr], prob: p.probRushLine != null ? p.probRushLine : 0 }));
  if (!allRows.length) {
    el.innerHTML = `<div class="mu-empty">No player season stats synced yet for the ${fantasyEsc(nextDate)} slate. Check back once the daily sync has run.</div>`;
    return;
  }

  const gameOptsHTML = ['<option value="">All Games</option>'].concat(
    slateGames.filter(g => g.home && g.away).map(g => {
      const gid = g.away.abbreviation + '@' + g.home.abbreviation;
      return `<option value="${gid}"${_nflRushGameFilter === gid ? ' selected' : ''}>${g.away.abbreviation} @ ${g.home.abbreviation}</option>`;
    })
  ).join('');

  let rows = allRows.filter(p => drMatchesSearch('nflrush', p.name));
  if (_nflRushGameFilter) {
    rows = rows.filter(p => {
      const opp = oppByTeam[p.teamAbbr];
      const gid = p.teamAbbr + '@' + opp, gidRev = opp + '@' + p.teamAbbr;
      return _nflRushGameFilter === gid || _nflRushGameFilter === gidRev;
    });
  }
  const sortKey = _nflRushSort || 'prob';
  rows = rows.slice().sort((a, b) => (b[sortKey] - a[sortKey]) * _nflRushSortDir);

  const sortBtns = NFL_RUSH_SORT_FIELDS.map(({ key, label }) => {
    const active = (_nflRushSort || 'prob') === key;
    const arrow = active ? (_nflRushSortDir === 1 ? ' ↓' : ' ↑') : '';
    return `<button onclick="nflRushSortBy('${key}')" style="font-size:9px;font-weight:700;font-family:Manrope,sans-serif;padding:4px 10px;border-radius:12px;border:1px solid ${active ? 'var(--accent2)' : 'var(--border)'};background:${active ? 'rgba(47,107,255,.12)' : 'var(--surface2)'};color:${active ? 'var(--accent2)' : 'var(--muted)'};cursor:pointer;white-space:nowrap;flex-shrink:0;transition:all .15s">${label}${arrow}</button>`;
  }).join('');

  const noMatches = !rows.length && ((window.__drBoardSearch.nflrush || '').trim() || _nflRushGameFilter);
  el.innerHTML = `<div class="dr109-summary"><div class="dr109-title">🏈 <span>${fantasyEsc(nextDate)} SLATE</span></div>`
    + `<p class="dr109-copy">Real empirical rate this season that each player's own actual per-game rushing yards (${fantasyEsc(allRows[0].season)} season) cleared Over ${NFL_RUSH_YDS_LINE}. Early model — no opponent run-defense adjustment yet, values are generated from the active synced roster/stats data.</p></div>`
    + nflRushSummaryHTML(allRows)
    + `<div class="dr109-filter-row kprops-sticky-sort" style="display:flex;align-items:center;gap:6px;padding:8px 14px;background:var(--bg);border-bottom:1px solid var(--border);overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none;flex-wrap:nowrap">
        <span style="font-size:9px;font-weight:700;letter-spacing:1px;color:var(--muted);white-space:nowrap;flex-shrink:0">GAME:</span>
        <select onchange="setNFLRushGameFilter(this.value)" style="background:#0e1728;color:#fff;border:1px solid var(--border);border-radius:8px;padding:4px 8px;font-size:10px;font-weight:700;flex-shrink:0">${gameOptsHTML}</select>
        <span style="font-size:9px;font-weight:700;letter-spacing:1px;color:var(--muted);white-space:nowrap;flex-shrink:0">SORT:</span>
        ${sortBtns}
        <button onclick="nflRushSortBy(null)" style="font-size:9px;font-weight:700;font-family:Manrope,sans-serif;padding:3px 8px;border-radius:12px;border:1px solid var(--border);background:var(--surface2);color:var(--muted);cursor:pointer;white-space:nowrap;flex-shrink:0">RESET</button>
        ${drSearchInputHTML('nflrush', 'nflrush-search-input', 'Search players…', "drSetBoardSearch('nflrush',this.value,renderNFLRushBoard)")}
      </div>`
    + (noMatches ? `<div class="mu-empty" style="padding:24px">No players match the current search/filter.</div>` : rows.map(nflRushCardHTML).join(''));
  drRestoreSearchFocus(__searchFocus);
}
window.renderNFLRushBoard = renderNFLRushBoard;

// ── NFL Passing Yards (real O/U line, real empirical hit rate) ─────────────
// Same real-empirical-rate method as Rushing Yards above (continuous stat,
// so the probability is the real rate this player's own actual per-game
// passing yards cleared the line this season, computed server-side in
// scripts/sync-nfl-player-stats.mjs's lineStats -- not a fitted/simulated
// distribution). Line (224.5) picked the same way RUSH_YDS_LINE was: checked
// against the real percentile it falls at across this season's real synced
// QBs once the data was in hand, close to a typical real sportsbook
// passing-yards prop line.
const NFL_PASS_YDS_LINE = 224.5;
const NFL_PASS_MIN_GAMES = 4;

let nflPassDataPromise = null;
async function loadNFLPassData(force = false) {
  if (nflPassDataPromise && !force) return nflPassDataPromise;
  nflPassDataPromise = (async () => {
    const [scheduleData, statsData] = await Promise.all([
      drFetchDailyJSON('data/nfl-schedule.json').catch(() => null),
      drFetchDailyJSON('data/nfl-player-stats.json').catch(() => null),
    ]);
    return { schedule: (scheduleData && scheduleData.events) || [], players: (statsData && statsData.players) || {} };
  })();
  return nflPassDataPromise;
}

let _nflPassSort = null;
let _nflPassSortDir = 1;
let _nflPassGameFilter = '';
const NFL_PASS_SORT_FIELDS = [
  { key: 'prob', label: 'Prob' },
  { key: 'passYdsPerGame', label: 'Yds/Gm' },
  { key: 'games', label: 'Games' },
];
function nflPassSortBy(key) {
  if (_nflPassSort === key) { _nflPassSortDir *= -1; }
  else { _nflPassSort = key; _nflPassSortDir = 1; }
  if (!key) { _nflPassSort = null; _nflPassSortDir = 1; }
  renderNFLPassBoard();
}
function setNFLPassGameFilter(value) {
  _nflPassGameFilter = value || '';
  renderNFLPassBoard();
}

function nflPassSummaryHTML(rows) {
  if (!rows.length) return '';
  const byProb = rows.slice().sort((a, b) => b.prob - a.prob);
  const top = byProb[0];
  const sample = byProb.slice(0, Math.min(8, byProb.length));
  const avg = Math.round(sample.reduce((a, p) => a + p.prob, 0) / sample.length);
  return `<div class="dr1027-hr-summary"><div class="dr1027-summary-title">🏈 EXPANDED <span>NFL PASSING YARDS DATA</span></div><p class="dr1027-summary-copy">Real empirical rate this season that each player's own actual per-game passing yards cleared Over ${NFL_PASS_YDS_LINE}, not a fitted or simulated distribution. Early model — no opponent pass-defense adjustment yet.</p><div class="dr1027-summary-grid"><div class="dr1027-summary-metric good"><b>${fantasyEsc(top.name || '–')}</b><span>Top Rated</span></div><div class="dr1027-summary-metric"><b>${avg}%</b><span>Board Avg Probability</span></div><div class="dr1027-summary-metric"><b>${rows.length}</b><span>Players Scanned</span></div><div class="dr1027-summary-metric warn"><b>Over ${NFL_PASS_YDS_LINE} Yds</b><span>Primary Line</span></div></div></div>`;
}

function nflPassCardHTML(r) {
  const scoreCls = r.prob >= 55 ? 'good' : '';
  return `<div class="dr109-card${scoreCls ? ' prop-hit' : ''}">
    ${window.drWatchStarHTML('nfl-' + r.id, r.name)}
    <div class="dr109-card-head">
      <div class="dr109-player">
        <img loading="lazy" src="${r.headshot || ''}" onerror="this.style.display='none'" alt="">
        <div style="min-width:0">
          <div class="dr109-name">${fantasyEsc(r.name || 'Player')}</div>
          <div class="dr109-meta">${fantasyEsc(r.position || '')} · ${fantasyEsc(r.teamAbbr || '')} vs ${fantasyEsc(r.oppAbbr || '')}</div>
        </div>
      </div>
      <div class="dr109-score">${r.prob}%<small>Over ${NFL_PASS_YDS_LINE} Yds</small></div>
    </div>
    <div class="dr109-chiprow">
      <span class="dr109-chip"><span>Season Pass Yds:</span><strong>${r.passYds != null ? r.passYds : '–'}</strong></span>
      <span class="dr109-chip"><span>Games:</span><strong>${r.gamesWithPassYds != null ? r.gamesWithPassYds : '–'}</strong></span>
      <span class="dr109-chip"><span>Yds/GM:</span><strong>${r.passYdsPerGame != null ? r.passYdsPerGame.toFixed(1) : '–'}</strong></span>
      <span class="dr109-chip"><span>Std Dev:</span><strong>${r.passStdDev != null ? r.passStdDev.toFixed(1) : '–'}</strong></span>
    </div>
  </div>`;
}

async function renderNFLPassBoard() {
  const el = document.getElementById('nfl-pass-content');
  if (!el) return;
  const __searchFocus = drCaptureSearchFocus('nflpass-search-input');
  let data;
  try {
    data = await loadNFLPassData();
  } catch (e) {
    el.innerHTML = '<div class="mu-empty">Couldn\'t load NFL data. Check back shortly.</div>';
    return;
  }
  const upcoming = (data.schedule || []).filter(g => !g.completed && g.date).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  if (!upcoming.length) {
    el.innerHTML = '<div class="mu-empty">No upcoming NFL games found. Check back closer to kickoff.</div>';
    return;
  }
  // Same "nearest upcoming calendar date" scoping loadNFLTDData/
  // loadNFLGameData/loadNFLRushData already use -- games are sparse
  // (especially in preseason), so this is whichever real date has the next
  // kickoff, not a fixed "today" that could legitimately have zero games on it.
  const nextDate = upcoming[0].date.slice(0, 10);
  const slateGames = upcoming.filter(g => (g.date || '').slice(0, 10) === nextDate);
  const oppByTeam = {};
  slateGames.forEach(g => {
    if (g.home && g.away && g.home.abbreviation && g.away.abbreviation) {
      oppByTeam[g.home.abbreviation] = g.away.abbreviation;
      oppByTeam[g.away.abbreviation] = g.home.abbreviation;
    }
  });
  // NFL_PASS_MIN_GAMES keeps a single-game small sample (a real hit rate of
  // either 0% or 100% off one game tells a user nothing reliable) off the
  // board entirely, same rule NFL_RUSH_MIN_GAMES enforces above.
  const allRows = Object.entries(data.players || {})
    .filter(([id, p]) => p.teamAbbr && oppByTeam[p.teamAbbr] != null && p.passYdsPerGame != null && (p.gamesWithPassYds || 0) >= NFL_PASS_MIN_GAMES)
    .map(([id, p]) => Object.assign({ id }, p, { oppAbbr: oppByTeam[p.teamAbbr], prob: p.probPassLine != null ? p.probPassLine : 0 }));
  if (!allRows.length) {
    el.innerHTML = `<div class="mu-empty">No player season stats synced yet for the ${fantasyEsc(nextDate)} slate. Check back once the daily sync has run.</div>`;
    return;
  }

  const gameOptsHTML = ['<option value="">All Games</option>'].concat(
    slateGames.filter(g => g.home && g.away).map(g => {
      const gid = g.away.abbreviation + '@' + g.home.abbreviation;
      return `<option value="${gid}"${_nflPassGameFilter === gid ? ' selected' : ''}>${g.away.abbreviation} @ ${g.home.abbreviation}</option>`;
    })
  ).join('');

  let rows = allRows.filter(p => drMatchesSearch('nflpass', p.name));
  if (_nflPassGameFilter) {
    rows = rows.filter(p => {
      const opp = oppByTeam[p.teamAbbr];
      const gid = p.teamAbbr + '@' + opp, gidRev = opp + '@' + p.teamAbbr;
      return _nflPassGameFilter === gid || _nflPassGameFilter === gidRev;
    });
  }
  const sortKey = _nflPassSort || 'prob';
  rows = rows.slice().sort((a, b) => (b[sortKey] - a[sortKey]) * _nflPassSortDir);

  const sortBtns = NFL_PASS_SORT_FIELDS.map(({ key, label }) => {
    const active = (_nflPassSort || 'prob') === key;
    const arrow = active ? (_nflPassSortDir === 1 ? ' ↓' : ' ↑') : '';
    return `<button onclick="nflPassSortBy('${key}')" style="font-size:9px;font-weight:700;font-family:Manrope,sans-serif;padding:4px 10px;border-radius:12px;border:1px solid ${active ? 'var(--accent2)' : 'var(--border)'};background:${active ? 'rgba(47,107,255,.12)' : 'var(--surface2)'};color:${active ? 'var(--accent2)' : 'var(--muted)'};cursor:pointer;white-space:nowrap;flex-shrink:0;transition:all .15s">${label}${arrow}</button>`;
  }).join('');

  const noMatches = !rows.length && ((window.__drBoardSearch.nflpass || '').trim() || _nflPassGameFilter);
  el.innerHTML = `<div class="dr109-summary"><div class="dr109-title">🏈 <span>${fantasyEsc(nextDate)} SLATE</span></div>`
    + `<p class="dr109-copy">Real empirical rate this season that each player's own actual per-game passing yards (${fantasyEsc(allRows[0].season)} season) cleared Over ${NFL_PASS_YDS_LINE}. Early model — no opponent pass-defense adjustment yet, values are generated from the active synced roster/stats data.</p></div>`
    + nflPassSummaryHTML(allRows)
    + `<div class="dr109-filter-row kprops-sticky-sort" style="display:flex;align-items:center;gap:6px;padding:8px 14px;background:var(--bg);border-bottom:1px solid var(--border);overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none;flex-wrap:nowrap">
        <span style="font-size:9px;font-weight:700;letter-spacing:1px;color:var(--muted);white-space:nowrap;flex-shrink:0">GAME:</span>
        <select onchange="setNFLPassGameFilter(this.value)" style="background:#0e1728;color:#fff;border:1px solid var(--border);border-radius:8px;padding:4px 8px;font-size:10px;font-weight:700;flex-shrink:0">${gameOptsHTML}</select>
        <span style="font-size:9px;font-weight:700;letter-spacing:1px;color:var(--muted);white-space:nowrap;flex-shrink:0">SORT:</span>
        ${sortBtns}
        <button onclick="nflPassSortBy(null)" style="font-size:9px;font-weight:700;font-family:Manrope,sans-serif;padding:3px 8px;border-radius:12px;border:1px solid var(--border);background:var(--surface2);color:var(--muted);cursor:pointer;white-space:nowrap;flex-shrink:0">RESET</button>
        ${drSearchInputHTML('nflpass', 'nflpass-search-input', 'Search players…', "drSetBoardSearch('nflpass',this.value,renderNFLPassBoard)")}
      </div>`
    + (noMatches ? `<div class="mu-empty" style="padding:24px">No players match the current search/filter.</div>` : rows.map(nflPassCardHTML).join(''));
  drRestoreSearchFocus(__searchFocus);
}
window.renderNFLPassBoard = renderNFLPassBoard;

// ── NFL Receiving Yards + Receptions (two real O/U lines, one card) ────────
// Same real-empirical-rate method as Rushing/Passing Yards above, but this
// board covers two distinct real markets on one card rather than fusing
// them into a single combined number (receiving yards and receptions differ
// by an order of magnitude, so a raw sum would just be the yards number
// with receptions barely moving it -- unlike MLB's real H+R+RBI combined
// stat, where all three components sit on a comparable 0-4ish scale).
// Receiving Yards is the headline score (the more standard real receiving
// prop line); Receptions gets its own real probability too, shown as a
// first-class secondary chip, not just a raw average.
const NFL_REC_YDS_LINE = 34.5;
const NFL_RECEPTIONS_LINE = 2.5;
const NFL_REC_MIN_GAMES = 4;

let nflRecDataPromise = null;
async function loadNFLRecData(force = false) {
  if (nflRecDataPromise && !force) return nflRecDataPromise;
  nflRecDataPromise = (async () => {
    const [scheduleData, statsData] = await Promise.all([
      drFetchDailyJSON('data/nfl-schedule.json').catch(() => null),
      drFetchDailyJSON('data/nfl-player-stats.json').catch(() => null),
    ]);
    return { schedule: (scheduleData && scheduleData.events) || [], players: (statsData && statsData.players) || {} };
  })();
  return nflRecDataPromise;
}

let _nflRecSort = null;
let _nflRecSortDir = 1;
let _nflRecGameFilter = '';
const NFL_REC_SORT_FIELDS = [
  { key: 'prob', label: 'Rec Yds Prob' },
  { key: 'recYdsPerGame', label: 'Yds/Gm' },
  { key: 'receptionsPerGame', label: 'Rec/Gm' },
  { key: 'games', label: 'Games' },
];
function nflRecSortBy(key) {
  if (_nflRecSort === key) { _nflRecSortDir *= -1; }
  else { _nflRecSort = key; _nflRecSortDir = 1; }
  if (!key) { _nflRecSort = null; _nflRecSortDir = 1; }
  renderNFLRecBoard();
}
function setNFLRecGameFilter(value) {
  _nflRecGameFilter = value || '';
  renderNFLRecBoard();
}

function nflRecSummaryHTML(rows) {
  if (!rows.length) return '';
  const byProb = rows.slice().sort((a, b) => b.prob - a.prob);
  const top = byProb[0];
  const sample = byProb.slice(0, Math.min(8, byProb.length));
  const avg = Math.round(sample.reduce((a, p) => a + p.prob, 0) / sample.length);
  return `<div class="dr1027-hr-summary"><div class="dr1027-summary-title">🏈 EXPANDED <span>NFL RECEIVING YARDS + RECEPTIONS DATA</span></div><p class="dr1027-summary-copy">Real empirical rate this season that each player's own actual per-game receiving yards cleared Over ${NFL_REC_YDS_LINE} (plus a real, separate Receptions O/U ${NFL_RECEPTIONS_LINE} rate), not a fitted or simulated distribution. Early model — no opponent pass-defense adjustment yet.</p><div class="dr1027-summary-grid"><div class="dr1027-summary-metric good"><b>${fantasyEsc(top.name || '–')}</b><span>Top Rated</span></div><div class="dr1027-summary-metric"><b>${avg}%</b><span>Board Avg Probability</span></div><div class="dr1027-summary-metric"><b>${rows.length}</b><span>Players Scanned</span></div><div class="dr1027-summary-metric warn"><b>Over ${NFL_REC_YDS_LINE} Yds</b><span>Primary Line</span></div></div></div>`;
}

function nflRecCardHTML(r) {
  const scoreCls = r.prob >= 55 ? 'good' : '';
  return `<div class="dr109-card${scoreCls ? ' prop-hit' : ''}">
    ${window.drWatchStarHTML('nfl-' + r.id, r.name)}
    <div class="dr109-card-head">
      <div class="dr109-player">
        <img loading="lazy" src="${r.headshot || ''}" onerror="this.style.display='none'" alt="">
        <div style="min-width:0">
          <div class="dr109-name">${fantasyEsc(r.name || 'Player')}</div>
          <div class="dr109-meta">${fantasyEsc(r.position || '')} · ${fantasyEsc(r.teamAbbr || '')} vs ${fantasyEsc(r.oppAbbr || '')}</div>
        </div>
      </div>
      <div class="dr109-score">${r.prob}%<small>Over ${NFL_REC_YDS_LINE} Yds</small></div>
    </div>
    <div class="dr109-chiprow">
      <span class="dr109-chip"><span>Season Rec Yds:</span><strong>${r.recYds != null ? r.recYds : '–'}</strong></span>
      <span class="dr109-chip"><span>Yds/GM:</span><strong>${r.recYdsPerGame != null ? r.recYdsPerGame.toFixed(1) : '–'}</strong></span>
      <span class="dr109-chip"><span>Rec/GM:</span><strong>${r.receptionsPerGame != null ? r.receptionsPerGame.toFixed(1) : '–'}</strong></span>
      <span class="dr109-chip"><span>Over ${NFL_RECEPTIONS_LINE} Rec:</span><strong>${r.probReceptionsLine != null ? r.probReceptionsLine + '%' : '–'}</strong></span>
      <span class="dr109-chip"><span>Games:</span><strong>${r.gamesWithRecYds != null ? r.gamesWithRecYds : '–'}</strong></span>
    </div>
  </div>`;
}

async function renderNFLRecBoard() {
  const el = document.getElementById('nfl-rec-content');
  if (!el) return;
  const __searchFocus = drCaptureSearchFocus('nflrec-search-input');
  let data;
  try {
    data = await loadNFLRecData();
  } catch (e) {
    el.innerHTML = '<div class="mu-empty">Couldn\'t load NFL data. Check back shortly.</div>';
    return;
  }
  const upcoming = (data.schedule || []).filter(g => !g.completed && g.date).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  if (!upcoming.length) {
    el.innerHTML = '<div class="mu-empty">No upcoming NFL games found. Check back closer to kickoff.</div>';
    return;
  }
  // Same "nearest upcoming calendar date" scoping loadNFLTDData/
  // loadNFLGameData/loadNFLRushData/loadNFLPassData already use.
  const nextDate = upcoming[0].date.slice(0, 10);
  const slateGames = upcoming.filter(g => (g.date || '').slice(0, 10) === nextDate);
  const oppByTeam = {};
  slateGames.forEach(g => {
    if (g.home && g.away && g.home.abbreviation && g.away.abbreviation) {
      oppByTeam[g.home.abbreviation] = g.away.abbreviation;
      oppByTeam[g.away.abbreviation] = g.home.abbreviation;
    }
  });
  // NFL_REC_MIN_GAMES keeps a single-game small sample off the board
  // entirely, same rule NFL_RUSH_MIN_GAMES/NFL_PASS_MIN_GAMES enforce above.
  const allRows = Object.entries(data.players || {})
    .filter(([id, p]) => p.teamAbbr && oppByTeam[p.teamAbbr] != null && p.recYdsPerGame != null && (p.gamesWithRecYds || 0) >= NFL_REC_MIN_GAMES)
    .map(([id, p]) => Object.assign({ id }, p, { oppAbbr: oppByTeam[p.teamAbbr], prob: p.probRecYdsLine != null ? p.probRecYdsLine : 0 }));
  if (!allRows.length) {
    el.innerHTML = `<div class="mu-empty">No player season stats synced yet for the ${fantasyEsc(nextDate)} slate. Check back once the daily sync has run.</div>`;
    return;
  }

  const gameOptsHTML = ['<option value="">All Games</option>'].concat(
    slateGames.filter(g => g.home && g.away).map(g => {
      const gid = g.away.abbreviation + '@' + g.home.abbreviation;
      return `<option value="${gid}"${_nflRecGameFilter === gid ? ' selected' : ''}>${g.away.abbreviation} @ ${g.home.abbreviation}</option>`;
    })
  ).join('');

  let rows = allRows.filter(p => drMatchesSearch('nflrec', p.name));
  if (_nflRecGameFilter) {
    rows = rows.filter(p => {
      const opp = oppByTeam[p.teamAbbr];
      const gid = p.teamAbbr + '@' + opp, gidRev = opp + '@' + p.teamAbbr;
      return _nflRecGameFilter === gid || _nflRecGameFilter === gidRev;
    });
  }
  const sortKey = _nflRecSort || 'prob';
  rows = rows.slice().sort((a, b) => (b[sortKey] - a[sortKey]) * _nflRecSortDir);

  const sortBtns = NFL_REC_SORT_FIELDS.map(({ key, label }) => {
    const active = (_nflRecSort || 'prob') === key;
    const arrow = active ? (_nflRecSortDir === 1 ? ' ↓' : ' ↑') : '';
    return `<button onclick="nflRecSortBy('${key}')" style="font-size:9px;font-weight:700;font-family:Manrope,sans-serif;padding:4px 10px;border-radius:12px;border:1px solid ${active ? 'var(--accent2)' : 'var(--border)'};background:${active ? 'rgba(47,107,255,.12)' : 'var(--surface2)'};color:${active ? 'var(--accent2)' : 'var(--muted)'};cursor:pointer;white-space:nowrap;flex-shrink:0;transition:all .15s">${label}${arrow}</button>`;
  }).join('');

  const noMatches = !rows.length && ((window.__drBoardSearch.nflrec || '').trim() || _nflRecGameFilter);
  el.innerHTML = `<div class="dr109-summary"><div class="dr109-title">🏈 <span>${fantasyEsc(nextDate)} SLATE</span></div>`
    + `<p class="dr109-copy">Real empirical rate this season that each player's own actual per-game receiving yards (${fantasyEsc(allRows[0].season)} season) cleared Over ${NFL_REC_YDS_LINE}, plus a real, separate Receptions Over ${NFL_RECEPTIONS_LINE} rate. Early model — no opponent pass-defense adjustment yet, values are generated from the active synced roster/stats data.</p></div>`
    + nflRecSummaryHTML(allRows)
    + `<div class="dr109-filter-row kprops-sticky-sort" style="display:flex;align-items:center;gap:6px;padding:8px 14px;background:var(--bg);border-bottom:1px solid var(--border);overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none;flex-wrap:nowrap">
        <span style="font-size:9px;font-weight:700;letter-spacing:1px;color:var(--muted);white-space:nowrap;flex-shrink:0">GAME:</span>
        <select onchange="setNFLRecGameFilter(this.value)" style="background:#0e1728;color:#fff;border:1px solid var(--border);border-radius:8px;padding:4px 8px;font-size:10px;font-weight:700;flex-shrink:0">${gameOptsHTML}</select>
        <span style="font-size:9px;font-weight:700;letter-spacing:1px;color:var(--muted);white-space:nowrap;flex-shrink:0">SORT:</span>
        ${sortBtns}
        <button onclick="nflRecSortBy(null)" style="font-size:9px;font-weight:700;font-family:Manrope,sans-serif;padding:3px 8px;border-radius:12px;border:1px solid var(--border);background:var(--surface2);color:var(--muted);cursor:pointer;white-space:nowrap;flex-shrink:0">RESET</button>
        ${drSearchInputHTML('nflrec', 'nflrec-search-input', 'Search players…', "drSetBoardSearch('nflrec',this.value,renderNFLRecBoard)")}
      </div>`
    + (noMatches ? `<div class="mu-empty" style="padding:24px">No players match the current search/filter.</div>` : rows.map(nflRecCardHTML).join(''));
  drRestoreSearchFocus(__searchFocus);
}
window.renderNFLRecBoard = renderNFLRecBoard;

// ── WNBA prop board family (Points/Rebounds/Assists/3-Pointers Made/PRA) ───
// Each card's headline is the player's own real season per-game average --
// a real individual projection, same "the model projects N Ks" framing the
// K Props board uses (app.js: p.projK), NOT a probability against one fixed
// universal line the way the Hits/RBIs/Total Bases/Stolen Bases boards work.
// The Points board additionally adjusts that projection by real opponent
// scoring defense (data/wnba-team-defense.json, scripts/sync-wnba-team-
// defense.mjs -- ESPN's real avgPointsAgainst per team). Rebounds/Assists/
// 3PM/PRA have no equivalent real opponent-allowed data yet (ESPN's
// standings only publishes points-against, not rebounds/assists/3PM-
// against), so those boards' projection stays the unadjusted real season
// average rather than faking an adjustment with no real signal behind it.
//
// One config-driven engine serves all 5 boards (same house pattern the MLB
// Hits/RBIs/Total Bases/Stolen Bases/Hits+Runs+RBI family already uses --
// a type-keyed render() rather than 5 near-duplicate functions) instead of
// copy-pasting the points board four more times.
const WNBA_PROP_BOARDS = {
  points: {
    key: 'points', searchKey: 'wnbapts', contentId: 'wnba-points-content',
    icon: '🏀', label: 'Points', avgField: 'ptsPerGame', avgLabel: 'PPG', avgFullLabel: 'Points Per Game', stdDevField: 'ptsStdDev',
    // The headline number is a single-game projection for tonight (real
    // season average, defense-adjusted when possible), not a season rate --
    // projLabel drops the "per game" framing avgLabel correctly keeps for
    // the season-average chip below it, so "Proj Points" doesn't read like
    // a season stat the way "Proj PPG" did.
    projLabel: 'Points',
    // Real opponent points-allowed per team (ESPN standings). No other
    // board has a matching defenseStatKey yet -- see header comment above.
    defenseStatKey: 'avgPointsAgainst',
    sortFields: [{ key: 'projAvg', label: 'PPG' }, { key: 'consistency', label: 'Consistency' }, { key: 'games', label: 'Games' }],
  },
  rebounds: {
    key: 'rebounds', searchKey: 'wnbareb', contentId: 'wnba-rebounds-content',
    icon: '🏀', label: 'Rebounds', avgField: 'rebPerGame', avgLabel: 'RPG', avgFullLabel: 'Rebounds Per Game', stdDevField: 'rebStdDev',
    projLabel: 'Rebounds',
    sortFields: [{ key: 'projAvg', label: 'RPG' }, { key: 'consistency', label: 'Consistency' }, { key: 'games', label: 'Games' }],
  },
  assists: {
    key: 'assists', searchKey: 'wnbaast', contentId: 'wnba-assists-content',
    icon: '🏀', label: 'Assists', avgField: 'astPerGame', avgLabel: 'APG', avgFullLabel: 'Assists Per Game', stdDevField: 'astStdDev',
    projLabel: 'Assists',
    sortFields: [{ key: 'projAvg', label: 'APG' }, { key: 'consistency', label: 'Consistency' }, { key: 'games', label: 'Games' }],
  },
  threes: {
    key: 'threes', searchKey: 'wnba3pm', contentId: 'wnba-threes-content',
    icon: '🏀', label: '3-Pointers Made', avgField: 'threesPerGame', avgLabel: '3PM', avgFullLabel: '3-Pointers Made Per Game', stdDevField: 'threesStdDev',
    projLabel: '3-Pointers',
    sortFields: [{ key: 'projAvg', label: '3PM' }, { key: 'consistency', label: 'Consistency' }, { key: 'games', label: 'Games' }],
  },
  pra: {
    key: 'pra', searchKey: 'wnbapra', contentId: 'wnba-pra-content',
    icon: '🏀', label: 'PRA', avgField: 'praPerGame', avgLabel: 'PRA', avgFullLabel: 'Points+Rebounds+Assists Per Game', stdDevField: 'praStdDev',
    projLabel: 'PRA',
    sortFields: [{ key: 'projAvg', label: 'PRA' }, { key: 'consistency', label: 'Consistency' }, { key: 'games', label: 'Games' }],
  },
};

// Real opponent-defense adjustment for boards with a real per-team signal
// behind them (only Points has one so far). Returns null -- not a fabricated
// neutral ratio -- when the board has no defenseStatKey, or the specific
// opponent/league-average values aren't available, same "no data, no
// adjustment" honesty as every other null-guarded read in this engine.
function wnbaDefenseAdjustment(cfg, oppAbbr, teamDefense) {
  if (!cfg.defenseStatKey || !teamDefense) return null;
  const oppTeam = teamDefense.teams && teamDefense.teams[oppAbbr];
  const oppVal = oppTeam && oppTeam[cfg.defenseStatKey];
  const leagueAvg = teamDefense.leagueAvgPointsAgainst;
  if (oppVal == null || !(leagueAvg > 0)) return null;
  return { ratio: oppVal / leagueAvg, oppVal, leagueAvg };
}

// Real coefficient-of-variation read (stdDev relative to the player's own
// average) -- doesn't need a fixed line to compute, unlike the old cushion/
// risk pattern, so it survives the move away from universal thresholds.
// Steady/Moderate/Volatile bands chosen so a genuinely streaky boom-bust
// player (CV above ~0.6) reads differently from a steady rotation player
// (CV below ~0.35), same three-tier shape the old Risk chip used.
function wnbaStatConsistency(cfg, r) {
  const avg = Number(r[cfg.avgField]);
  const stdDev = Number(r[cfg.stdDevField]);
  if (!(avg > 0) || !Number.isFinite(stdDev)) return { cv: null, label: '–' };
  const cv = stdDev / avg;
  const label = cv < 0.35 ? 'Steady' : cv < 0.6 ? 'Moderate' : 'Volatile';
  return { cv, label };
}

// Schedule + player-stats + team-defense data is identical across all 5
// boards -- one shared fetch/cache rather than 5 separate ones.
let wnbaPropDataPromise = null;
async function loadWNBAPropData(force = false) {
  if (wnbaPropDataPromise && !force) return wnbaPropDataPromise;
  wnbaPropDataPromise = (async () => {
    const [scheduleData, statsData, teamDefenseData] = await Promise.all([
      drFetchDailyJSON('data/wnba-schedule.json').catch(() => null),
      drFetchDailyJSON('data/wnba-player-stats.json').catch(() => null),
      drFetchDailyJSON('data/wnba-team-defense.json').catch(() => null),
    ]);
    return {
      schedule: (scheduleData && scheduleData.events) || [],
      players: (statsData && statsData.players) || {},
      teamDefense: teamDefenseData || null,
    };
  })();
  return wnbaPropDataPromise;
}

// Sort/filter state keyed by board (cfg.key) instead of separate module-level
// `let`s per board -- mirrors the MLB prop-intelligence engine's edgeFilters[type]/
// gameFilters[type] shape for the same "one engine, many boards" reason.
const _wnbaPropState = {};
function wnbaPropStateFor(key) {
  if (!_wnbaPropState[key]) _wnbaPropState[key] = { sort: null, sortDir: 1, gameFilter: '' };
  return _wnbaPropState[key];
}
function wnbaPropSortBy(boardKey, key) {
  const st = wnbaPropStateFor(boardKey);
  if (st.sort === key) { st.sortDir *= -1; }
  else { st.sort = key; st.sortDir = 1; }
  if (!key) { st.sort = null; st.sortDir = 1; }
  renderWNBAPropBoard(WNBA_PROP_BOARDS[boardKey]);
}
function setWNBAPropGameFilter(boardKey, value) {
  wnbaPropStateFor(boardKey).gameFilter = value || '';
  renderWNBAPropBoard(WNBA_PROP_BOARDS[boardKey]);
}

function wnbaPropSummaryHTML(cfg, rows) {
  if (!rows.length) return '';
  const byAvg = rows.slice().sort((a, b) => b.projAvg - a.projAvg);
  const top = byAvg[0];
  const sample = byAvg.slice(0, Math.min(8, byAvg.length));
  const avg = (sample.reduce((a, p) => a + p.projAvg, 0) / sample.length).toFixed(1);
  const hasDefense = rows.some(r => r.defenseAdj);
  const copy = hasDefense
    ? `Real season ${cfg.avgFullLabel.toLowerCase()} per rostered player, adjusted for real opponent scoring defense (ESPN standings) where a real matchup exists -- the individual projection this board scores from.`
    : `Real season ${cfg.avgFullLabel.toLowerCase()} per rostered player -- each player's own real season average, the individual projection this board scores from. Early model -- no opponent defense adjustment yet.`;
  return `<div class="dr1027-hr-summary"><div class="dr1027-summary-title">${cfg.icon} EXPANDED <span>WNBA ${cfg.label.toUpperCase()} PROJECTIONS</span></div><p class="dr1027-summary-copy">${copy}</p><div class="dr1027-summary-grid"><div class="dr1027-summary-metric good"><b>${fantasyEsc(top.name || '–')}</b><span>Top Projected</span></div><div class="dr1027-summary-metric"><b>${avg}</b><span>Board Avg ${cfg.projLabel}</span></div><div class="dr1027-summary-metric"><b>${rows.length}</b><span>Players Scanned</span></div><div class="dr1027-summary-metric warn"><b>${cfg.label}</b><span>Primary Signal</span></div></div></div>`;
}

function wnbaPropCardHTML(cfg, r, topCutoff) {
  const projAvg = r.projAvg;
  const consistency = wnbaStatConsistency(cfg, r);
  const scoreCls = (topCutoff != null && projAvg != null && projAvg >= topCutoff) ? 'good' : '';
  const defAdj = r.defenseAdj;
  const matchupPct = defAdj ? Math.round((defAdj.ratio - 1) * 100) : null;
  return `<div class="dr109-card${scoreCls ? ' prop-hit' : ''}">
    ${window.drWatchStarHTML('wnba-' + r.id, r.name)}
    <div class="dr109-card-head">
      <div class="dr109-player">
        <img loading="lazy" src="${r.headshot || ''}" onerror="this.style.display='none'" alt="">
        <div style="min-width:0">
          <div class="dr109-name">${fantasyEsc(r.name || 'Player')}</div>
          <div class="dr109-meta">${fantasyEsc(r.position || '')} · ${fantasyEsc(r.teamAbbr || '')} vs ${fantasyEsc(r.oppAbbr || '')}</div>
        </div>
      </div>
      <div class="dr109-score">${projAvg != null ? projAvg.toFixed(1) : '–'}<small>Proj ${cfg.projLabel}</small></div>
    </div>
    <div class="dr109-chiprow">
      <span class="dr109-chip"><span>Season PPG:</span><strong>${r.ptsPerGame != null ? r.ptsPerGame.toFixed(1) : '–'}</strong></span>
      <span class="dr109-chip"><span>RPG:</span><strong>${r.rebPerGame != null ? r.rebPerGame.toFixed(1) : '–'}</strong></span>
      <span class="dr109-chip"><span>APG:</span><strong>${r.astPerGame != null ? r.astPerGame.toFixed(1) : '–'}</strong></span>
      <span class="dr109-chip"><span>3PM:</span><strong>${r.threesPerGame != null ? r.threesPerGame.toFixed(1) : '–'}</strong></span>
      <span class="dr109-chip"><span>PRA:</span><strong>${r.praPerGame != null ? r.praPerGame.toFixed(1) : '–'}</strong></span>
      <span class="dr109-chip"><span>Games:</span><strong>${r.games != null ? r.games : '–'}</strong></span>
      <span class="dr109-chip ${consistency.label === 'Steady' ? 'good' : consistency.label === 'Moderate' ? 'warn' : consistency.label === 'Volatile' ? 'bad' : ''}"><span>Consistency:</span><strong>${consistency.label}</strong></span>
      ${defAdj ? `<span class="dr109-chip ${matchupPct > 0 ? 'good' : matchupPct < 0 ? 'bad' : ''}" title="${fantasyEsc(r.oppAbbr)} allows real ${defAdj.oppVal.toFixed(1)} PPG vs. a real ${defAdj.leagueAvg.toFixed(1)} PPG league average"><span>Matchup:</span><strong>${fantasyEsc(r.oppAbbr)} ${matchupPct >= 0 ? '+' : ''}${matchupPct}%</strong></span>` : ''}
    </div>
  </div>`;
}

async function renderWNBAPropBoard(cfg) {
  const el = document.getElementById(cfg.contentId);
  if (!el) return;
  const st = wnbaPropStateFor(cfg.key);
  const __searchFocus = drCaptureSearchFocus(cfg.searchKey + '-search-input');
  let data;
  try {
    data = await loadWNBAPropData();
  } catch (e) {
    el.innerHTML = '<div class="mu-empty">Couldn\'t load WNBA data. Check back shortly.</div>';
    return;
  }
  const upcoming = (data.schedule || []).filter(g => !g.completed && g.date).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  if (!upcoming.length) {
    el.innerHTML = '<div class="mu-empty">No upcoming WNBA games found. Check back closer to tip-off.</div>';
    return;
  }
  // Same "nearest upcoming calendar date" scoping the NFL board uses for its
  // slate -- whichever real date has the next tip-off, not a fixed "today"
  // that could legitimately have zero games on it.
  const nextDate = upcoming[0].date.slice(0, 10);
  const slateGames = upcoming.filter(g => (g.date || '').slice(0, 10) === nextDate);
  const oppByTeam = {};
  slateGames.forEach(g => {
    if (g.home && g.away && g.home.abbreviation && g.away.abbreviation) {
      oppByTeam[g.home.abbreviation] = g.away.abbreviation;
      oppByTeam[g.away.abbreviation] = g.home.abbreviation;
    }
  });
  const allRows = Object.entries(data.players || {})
    .filter(([id, p]) => p.teamAbbr && oppByTeam[p.teamAbbr] != null && p[cfg.avgField] != null)
    .map(([id, p]) => {
      const oppAbbr = oppByTeam[p.teamAbbr];
      const consistency = wnbaStatConsistency(cfg, p);
      const defenseAdj = wnbaDefenseAdjustment(cfg, oppAbbr, data.teamDefense);
      const rawAvg = p[cfg.avgField];
      const projAvg = defenseAdj ? +(rawAvg * defenseAdj.ratio).toFixed(1) : rawAvg;
      return Object.assign({ id }, p, {
        oppAbbr, projAvg, defenseAdj,
        consistency: consistency.cv != null ? -consistency.cv : null,
      });
    });
  if (!allRows.length) {
    el.innerHTML = `<div class="mu-empty">No player season stats synced yet for the ${fantasyEsc(nextDate)} slate. Check back once the daily sync has run.</div>`;
    return;
  }

  const gameOptsHTML = ['<option value="">All Games</option>'].concat(
    slateGames.filter(g => g.home && g.away).map(g => {
      const gid = g.away.abbreviation + '@' + g.home.abbreviation;
      return `<option value="${gid}"${st.gameFilter === gid ? ' selected' : ''}>${g.away.abbreviation} @ ${g.home.abbreviation}</option>`;
    })
  ).join('');

  let rows = allRows.filter(p => drMatchesSearch(cfg.searchKey, p.name));
  if (st.gameFilter) {
    rows = rows.filter(p => {
      const opp = oppByTeam[p.teamAbbr];
      const gid = p.teamAbbr + '@' + opp, gidRev = opp + '@' + p.teamAbbr;
      return st.gameFilter === gid || st.gameFilter === gidRev;
    });
  }
  const sortKey = st.sort || 'projAvg';
  rows = rows.slice().sort((a, b) => {
    const av = a[sortKey], bv = b[sortKey];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return (bv - av) * st.sortDir;
  });

  const sortBtns = cfg.sortFields.map(({ key, label }) => {
    const active = (st.sort || 'projAvg') === key;
    const arrow = active ? (st.sortDir === 1 ? ' ↓' : ' ↑') : '';
    return `<button onclick="wnbaPropSortBy('${cfg.key}','${key}')" style="font-size:9px;font-weight:700;font-family:Manrope,sans-serif;padding:4px 10px;border-radius:12px;border:1px solid ${active ? 'var(--accent2)' : 'var(--border)'};background:${active ? 'rgba(47,107,255,.12)' : 'var(--surface2)'};color:${active ? 'var(--accent2)' : 'var(--muted)'};cursor:pointer;white-space:nowrap;flex-shrink:0;transition:all .15s">${label}${arrow}</button>`;
  }).join('');

  // Top-quartile highlight computed fresh from this render's own real values
  // -- relative to the actual field's real distribution, not a fixed
  // universal cutoff applied to every player regardless of position/role.
  const sortedVals = allRows.map(p => p.projAvg).filter(v => v != null).sort((a, b) => b - a);
  const topCutoff = sortedVals.length ? sortedVals[Math.max(0, Math.floor(sortedVals.length * 0.25) - 1)] : null;

  const hasDefense = allRows.some(r => r.defenseAdj);
  const boardCopy = hasDefense
    ? `Real season ${cfg.avgFullLabel.toLowerCase()} per rostered player (${fantasyEsc(allRows[0].season)} season), adjusted for real opponent scoring defense (ESPN standings' real points-allowed per team) where tonight's real opponent has one -- the Matchup chip shows the real adjustment. Consistency reads real season volatility (stdDev relative to their own average).`
    : `Real season ${cfg.avgFullLabel.toLowerCase()} per rostered player (${fantasyEsc(allRows[0].season)} season) -- each player's own real season average, shown directly as their individual projection for tonight, not a probability against a fixed universal line. Consistency reads real season volatility (stdDev relative to their own average). Early model -- no opponent defense adjustment yet.`;
  const noMatches = !rows.length && ((window.__drBoardSearch[cfg.searchKey] || '').trim() || st.gameFilter);
  el.innerHTML = `<div class="dr109-summary"><div class="dr109-title">${cfg.icon} <span>${fantasyEsc(nextDate)} SLATE</span></div>`
    + `<p class="dr109-copy">${boardCopy}</p></div>`
    + wnbaPropSummaryHTML(cfg, allRows)
    + `<div class="dr109-filter-row kprops-sticky-sort" style="display:flex;align-items:center;gap:6px;padding:8px 14px;background:var(--bg);border-bottom:1px solid var(--border);overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none;flex-wrap:nowrap">
        <span style="font-size:9px;font-weight:700;letter-spacing:1px;color:var(--muted);white-space:nowrap;flex-shrink:0">GAME:</span>
        <select onchange="setWNBAPropGameFilter('${cfg.key}',this.value)" style="background:#0e1728;color:#fff;border:1px solid var(--border);border-radius:8px;padding:4px 8px;font-size:10px;font-weight:700;flex-shrink:0">${gameOptsHTML}</select>
        <span style="font-size:9px;font-weight:700;letter-spacing:1px;color:var(--muted);white-space:nowrap;flex-shrink:0">SORT:</span>
        ${sortBtns}
        <button onclick="wnbaPropSortBy('${cfg.key}',null)" style="font-size:9px;font-weight:700;font-family:Manrope,sans-serif;padding:3px 8px;border-radius:12px;border:1px solid var(--border);background:var(--surface2);color:var(--muted);cursor:pointer;white-space:nowrap;flex-shrink:0">RESET</button>
        ${drSearchInputHTML(cfg.searchKey, cfg.searchKey + '-search-input', 'Search players…', `drSetBoardSearch('${cfg.searchKey}',this.value,function(){renderWNBAPropBoard(WNBA_PROP_BOARDS.${cfg.key});})`)}
      </div>`
    + (noMatches ? `<div class="mu-empty" style="padding:24px">No players match the current search/filter.</div>` : rows.map(r => wnbaPropCardHTML(cfg, r, topCutoff)).join(''));
  drRestoreSearchFocus(__searchFocus);
}

// Thin wrappers keep the existing public API (renderWNBAPointsBoard was
// already relied on by activateGamePickPane's setTimeout triggers) and add
// one per new board.
function renderWNBAPointsBoard() { return renderWNBAPropBoard(WNBA_PROP_BOARDS.points); }
window.renderWNBAPointsBoard = renderWNBAPointsBoard;
function renderWNBARebBoard() { return renderWNBAPropBoard(WNBA_PROP_BOARDS.rebounds); }
window.renderWNBARebBoard = renderWNBARebBoard;
function renderWNBAAstBoard() { return renderWNBAPropBoard(WNBA_PROP_BOARDS.assists); }
window.renderWNBAAstBoard = renderWNBAAstBoard;
function renderWNBA3PMBoard() { return renderWNBAPropBoard(WNBA_PROP_BOARDS.threes); }
window.renderWNBA3PMBoard = renderWNBA3PMBoard;
function renderWNBAPRABoard() { return renderWNBAPropBoard(WNBA_PROP_BOARDS.pra); }
window.renderWNBAPRABoard = renderWNBAPRABoard;
