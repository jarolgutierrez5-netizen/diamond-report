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
// P(at least 1 TD) = 1 - e^(-lambda), lambda = real season TD/game rate,
// shifted by the same real opponent points-allowed ratio (nflDefenseAdjustment,
// defined below with the yardage boards) where a real matchup exists -- points
// allowed is arguably an even more directly relevant signal for touchdowns
// specifically than for yardage, since a TD is worth points by definition.
// Same "one real team-level signal, honestly applied" approach and same
// clamped 0.6-1.6 ratio range as the yardage boards use.
function nflAnytimeTDProb(tdPerGame, ratio) {
  const lambda = Math.max(0, Number(tdPerGame) || 0) * (ratio != null ? ratio : 1);
  const p = 1 - Math.exp(-lambda);
  return Math.max(1, Math.min(99, Math.round(p * 100)));
}

let nflTDDataPromise = null;
async function loadNFLTDData(force = false) {
  if (nflTDDataPromise && !force) return nflTDDataPromise;
  nflTDDataPromise = (async () => {
    const [scheduleData, statsData, teamStatsData] = await Promise.all([
      drFetchDailyJSON('data/nfl-schedule.json').catch(() => null),
      drFetchDailyJSON('data/nfl-player-stats.json').catch(() => null),
      drFetchDailyJSON('data/nfl-team-stats.json').catch(() => null),
    ]);
    return { schedule: (scheduleData && scheduleData.events) || [], players: (statsData && statsData.players) || {}, teamStats: teamStatsData || null };
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
  const hasDefense = rows.some(r => r.defenseAdj);
  const copy = hasDefense
    ? 'Real season touchdown rate per skill-position player, adjusted for real opponent scoring defense (ESPN standings) where a real matchup exists, modeled as at-least-one-TD-this-game probability.'
    : 'Real season touchdown rate per skill-position player, modeled as at-least-one-TD-this-game probability. Early model — no opponent defense adjustment yet.';
  return `<div class="dr1027-hr-summary"><div class="dr1027-summary-title">🏈 EXPANDED <span>NFL ANYTIME TD DATA</span></div><p class="dr1027-summary-copy">${copy}</p><div class="dr1027-summary-grid"><div class="dr1027-summary-metric good"><b>${fantasyEsc(top.name || '–')}</b><span>Top Rated</span></div><div class="dr1027-summary-metric"><b>${avg}%</b><span>Board Avg Probability</span></div><div class="dr1027-summary-metric"><b>${rows.length}</b><span>Players Scanned</span></div><div class="dr1027-summary-metric warn"><b>Anytime TD</b><span>Primary Signal</span></div></div></div>`;
}

function nflTDCardHTML(r) {
  const scoreCls = r.prob >= 55 ? 'good' : '';
  const defAdj = r.defenseAdj;
  const matchupPct = defAdj ? Math.round((defAdj.ratio - 1) * 100) : null;
  const primary = [
    nflChip('Line', 'Anytime TD', 'good'),
    nflChip('TD/GM', r.tdPerGame != null ? r.tdPerGame.toFixed(2) : '–', r.tdPerGame != null && r.tdPerGame >= 0.5 ? 'good' : ''),
    defAdj
      ? nflChip('Matchup', `${fantasyEsc(r.oppAbbr)} ${matchupPct >= 0 ? '+' : ''}${matchupPct}%`, matchupPct > 0 ? 'good' : matchupPct < 0 ? 'bad' : '', `${r.oppAbbr} allows real ${defAdj.oppVal.toFixed(1)} pts/gm vs. a real ${defAdj.leagueAvg.toFixed(1)} pts/gm league average`)
      : nflChip('Games', r.games != null ? r.games : '–', ''),
  ].join('');
  const secondaryParts = [
    nflChip('Season TD', r.td != null ? r.td : '–', ''),
    defAdj ? nflChip('Games', r.games != null ? r.games : '–', '') : '',
    nflChip('Season', r.season != null ? r.season : '–', ''),
  ].filter(Boolean).join('');
  const reason = ` ${fantasyEsc(r.name || 'This player')} grades at ${r.prob}% for Anytime TD because the model runs their real season touchdown rate (${r.tdPerGame != null ? r.tdPerGame.toFixed(2) : '–'} TD/gm over ${r.games != null ? r.games : '–'} games) through a real Poisson at-least-one-event model${defAdj ? ', with the rate shifted by a real opponent-defense matchup' : ''}. Opponent context: ${fantasyEsc(r.oppAbbr || 'opponent')}.`;
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
    <div class="dr109-chiprow">${primary}</div>
    ${nflBreakdownHTML(secondaryParts)}
    ${nflReasonHTML('Why it supports the line', reason)}
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
    .map(([id, p]) => {
      const oppAbbr = oppByTeam[p.teamAbbr];
      const defenseAdj = nflDefenseAdjustment(oppAbbr, data.teamStats);
      const prob = nflAnytimeTDProb(p.tdPerGame, defenseAdj ? defenseAdj.ratio : 1);
      return Object.assign({ id }, p, { oppAbbr, defenseAdj, prob });
    });
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

// Real-signal factor chips for the pick, same {team,label,type} shape and
// same .gp-factor pos/opp/neu chip language as MLB's Diamond Report Pick
// card (app.js's factors array) -- "pos" for a real signal favoring the
// pick, "opp" for one favoring the other side, "neu" for informational
// context that doesn't favor either team.
function nflGameFactors(g) {
  const factors = [];
  const awayWinPct = g.awayStats && g.awayStats.winPercent != null ? g.awayStats.winPercent : null;
  const homeWinPct = g.homeStats && g.homeStats.winPercent != null ? g.homeStats.winPercent : null;
  if (awayWinPct != null && homeWinPct != null && Math.abs(awayWinPct - homeWinPct) >= 0.05) {
    const better = awayWinPct > homeWinPct ? 'away' : 'home';
    factors.push({ team: better, label: `${better === 'away' ? g.away : g.home} win% edge (${Math.round(awayWinPct * 100)}% vs ${Math.round(homeWinPct * 100)}%)` });
  }
  const awayPD = g.awayStats && g.awayStats.pointDifferential != null ? g.awayStats.pointDifferential : null;
  const homePD = g.homeStats && g.homeStats.pointDifferential != null ? g.homeStats.pointDifferential : null;
  if (awayPD != null && homePD != null && Math.abs(awayPD - homePD) >= 3) {
    const better = awayPD > homePD ? 'away' : 'home';
    factors.push({ team: better, label: `${better === 'away' ? g.away : g.home} point diff edge (${awayPD >= 0 ? '+' : ''}${awayPD} vs ${homePD >= 0 ? '+' : ''}${homePD})` });
  }
  factors.push({ team: 'home', label: `${g.home} home field edge` });
  const awayGames = g.awayStats && g.awayStats.wins != null && g.awayStats.losses != null ? g.awayStats.wins + g.awayStats.losses : null;
  const homeGames = g.homeStats && g.homeStats.wins != null && g.homeStats.losses != null ? g.homeStats.wins + g.homeStats.losses : null;
  if ((awayGames != null && awayGames < 4) || (homeGames != null && homeGames < 4)) {
    factors.push({ team: 'neutral', label: `Early-season sample (${g.away} ${nflRecordText(g.awayStats)}, ${g.home} ${nflRecordText(g.homeStats)})`, type: 'neu' });
  }
  return factors;
}

// Same .gp-card anatomy as MLB's Diamond Report Pick card (app.js): team
// logos flanking a "@" divider, a highlighted pick box with the winning
// team's logo/abbr/win%/confidence tier, a real win% bar for each team, and
// a row of real-signal factor chips underneath -- built from the exact same
// win%/point-differential/home-field inputs nflGameWinProb already scores,
// just surfaced with the richer MLB card language instead of the flat
// generic prop-card chip row every other NFL board still uses (Game
// Projections isn't a per-player prop -- it's a game pick, the same shape
// as MLB's DRP board, so it earns DRP's own card language rather than the
// prop-card one).
function nflGameCardHTML(g) {
  const winner = g.pick === g.home ? 'home' : 'away';
  const diff = Math.abs(g.awayPct - g.homePct);
  const confidence = diff < 6 ? 'TOSS-UP' : diff < 12 ? 'LEAN' : diff < 20 ? 'LIKELY' : 'STRONG';
  const confColor = diff < 6 ? 'var(--muted)' : diff < 12 ? 'var(--accent2)' : diff < 20 ? '#2ecc71' : '#00ff88';
  const winLogo = (winner === 'away' ? (g.awayMeta && g.awayMeta.logo) : (g.homeMeta && g.homeMeta.logo)) || '';
  const factors = nflGameFactors(g);
  const factorChips = factors.slice(0, 6).map(f => {
    const cls = f.team === 'neutral' ? (f.type || 'neu') : (f.team === winner ? 'pos' : 'opp');
    return `<span class="gp-factor ${cls}">${fantasyEsc(f.label)}</span>`;
  }).join('');
  const awayWinPct = g.awayStats && g.awayStats.winPercent != null ? Math.round(g.awayStats.winPercent * 100) : null;
  const homeWinPct = g.homeStats && g.homeStats.winPercent != null ? Math.round(g.homeStats.winPercent * 100) : null;
  const pickIsHome = winner === 'home';
  const reason = ` ${fantasyEsc(g.pick)} grades at ${g.pickPct}% to win because the model combines real win%${awayWinPct != null && homeWinPct != null ? ` (${fantasyEsc(g.away)} ${awayWinPct}% vs. ${fantasyEsc(g.home)} ${homeWinPct}%)` : ''}, real point differential, and a fixed home-field edge${pickIsHome ? ' that favors the home team here' : ' the pick overcame'}.`;
  return `<div class="gp-card">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <div class="gp-matchup" style="flex:1;min-width:180px">
        <div class="gp-team">
          ${g.awayMeta && g.awayMeta.logo ? `<img class="gp-team-logo" src="${g.awayMeta.logo}" alt="${fantasyEsc(g.away)}" loading="lazy" decoding="async" onerror="this.style.display='none'">` : ''}
          <span class="gp-team-abbr">${fantasyEsc(g.away)}</span>
          <span style="font-size:9px;color:var(--muted);font-family:'JetBrains Mono',monospace">${fantasyEsc(nflRecordText(g.awayStats))}</span>
        </div>
        <div style="display:flex;flex-direction:column;align-items:center;gap:3px">
          <span class="gp-vs">@</span>
        </div>
        <div class="gp-team">
          ${g.homeMeta && g.homeMeta.logo ? `<img class="gp-team-logo" src="${g.homeMeta.logo}" alt="${fantasyEsc(g.home)}" loading="lazy" decoding="async" onerror="this.style.display='none'">` : ''}
          <span class="gp-team-abbr">${fantasyEsc(g.home)}</span>
          <span style="font-size:9px;color:var(--muted);font-family:'JetBrains Mono',monospace">${fantasyEsc(nflRecordText(g.homeStats))}</span>
        </div>
      </div>

      <div style="display:flex;flex-direction:column;align-items:center;gap:4px">
        <span style="font-size:9px;color:var(--muted);letter-spacing:1px;text-transform:uppercase">Moneyline Pick</span>
        <div class="gp-pick gp-pick-win" style="display:flex;flex-direction:row;align-items:center;gap:8px;padding:8px 16px">
          ${winLogo ? `<img src="${winLogo}" style="width:22px;height:22px;object-fit:contain" alt="${fantasyEsc(g.pick)}" loading="lazy" decoding="async" onerror="this.style.display='none'">` : ''}
          <div style="display:flex;flex-direction:column;align-items:center">
            <span style="font-family:'Manrope',sans-serif;font-size:22px;letter-spacing:1px;line-height:1;color:#2ecc71">${fantasyEsc(g.pick)}</span>
            <span style="font-size:9px;color:#2ecc71;opacity:.8;font-family:'JetBrains Mono',monospace">${g.pickPct}% WIN</span>
          </div>
        </div>
        <span style="font-size:10px;font-weight:700;color:${confColor};letter-spacing:.5px">${confidence}</span>
      </div>

      <div style="display:flex;flex-direction:column;gap:4px;min-width:120px">
        <div style="display:flex;align-items:center;gap:6px">
          <span style="font-size:10px;color:var(--muted);font-family:'JetBrains Mono',monospace;min-width:28px">${fantasyEsc(g.away)}</span>
          <div style="flex:1;height:8px;background:var(--border);border-radius:4px;overflow:hidden">
            <div style="width:${g.awayPct}%;height:100%;background:${winner === 'away' ? '#2ecc71' : 'var(--muted)'};border-radius:4px"></div>
          </div>
          <span style="font-size:10px;font-family:'JetBrains Mono',monospace;min-width:30px;text-align:right;color:${winner === 'away' ? '#2ecc71' : 'var(--muted)'}">${g.awayPct}%</span>
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          <span style="font-size:10px;color:var(--muted);font-family:'JetBrains Mono',monospace;min-width:28px">${fantasyEsc(g.home)}</span>
          <div style="flex:1;height:8px;background:var(--border);border-radius:4px;overflow:hidden">
            <div style="width:${g.homePct}%;height:100%;background:${winner === 'home' ? '#2ecc71' : 'var(--muted)'};border-radius:4px"></div>
          </div>
          <span style="font-size:10px;font-family:'JetBrains Mono',monospace;min-width:30px;text-align:right;color:${winner === 'home' ? '#2ecc71' : 'var(--muted)'}">${g.homePct}%</span>
        </div>
      </div>
    </div>

    <div class="gp-factors">${factorChips}</div>
    ${nflReasonHTML('Why it supports the pick', reason)}
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
      awayStats, homeStats, pick, pickPct, awayPct, homePct,
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

// ── NFL yardage boards' shared opponent-defense adjustment ─────────────────
// Real per-team pointsAgainst (data/nfl-team-stats.json) is the one real,
// actually-populated defensive signal ESPN exposes for NFL teams -- no real
// per-team rushing-yards-allowed/passing-yards-allowed split exists (see
// scripts/sync-nfl-team-stats.mjs's own comment on why), so this applies as
// a general defense-strength proxy across all three yardage boards (Rush/
// Pass/Rec), same "one real team-level signal, honestly applied, not a
// fabricated stat-specific split" approach wnbaDefenseAdjustment already
// uses for the WNBA Points board. Returns null -- not a fabricated neutral
// ratio -- when the opponent/league-average values aren't available.
// Clamped to a real, defensible range (a legitimately elite defense allowing
// ~40% fewer points than average, a legitimately poor one allowing ~60%
// more) -- verified live this was actually needed: early in a season (or in
// preseason, when this ships) a team's real pointsAgainst can be a 1-2 game
// sample, and an unclamped ratio produced a genuine 212%-adjustment/336-yard
// projection off one small-sample outlier. The clamp doesn't hide or
// fabricate anything -- oppVal/leagueAvg below are still the real unclamped
// numbers, shown as-is in the Matchup chip's tooltip; only the multiplier
// actually applied to a player's projection is bounded, same "clamp to a
// believable range so one tiny sample can't produce an absurd number" rule
// computeDRPick's own eraPts/whipPts/recordPts caps already use.
const NFL_DEFENSE_RATIO_MIN = 0.6, NFL_DEFENSE_RATIO_MAX = 1.6;
function nflDefenseAdjustment(oppAbbr, teamStats) {
  if (!teamStats) return null;
  const oppTeam = teamStats.teams && teamStats.teams[oppAbbr];
  const oppVal = oppTeam && oppTeam.pointsAgainst;
  const leagueAvg = teamStats.leagueAvgPointsAgainst;
  if (oppVal == null || !(leagueAvg > 0)) return null;
  const ratio = Math.max(NFL_DEFENSE_RATIO_MIN, Math.min(NFL_DEFENSE_RATIO_MAX, oppVal / leagueAvg));
  return { ratio, oppVal, leagueAvg };
}

// Standard normal CDF (Abramowitz-Stegun erf approximation, ~1.5e-7 max
// error) -- same "genuine closed-form calculation, no Math.random()" shape
// the MLB HR board's simulateHRGameOdds already uses, applied here to turn
// a real opponent-adjusted mean + a player's own real season stdDev into a
// real P(X >= line) read, instead of a raw ratio with no probability
// attached. This is the one place in the yardage boards' adjustment that's
// necessarily a parametric estimate rather than a historical count -- real
// games against this specific upcoming opponent don't exist yet for any
// forward matchup projection, the same unavoidable reality behind the WNBA
// Points board's own defense-adjusted projection.
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}
function normalCDF(x, mean, stdDev) {
  if (!(stdDev > 0)) return x >= mean ? 1 : 0;
  return 0.5 * (1 + erf((x - mean) / (stdDev * Math.SQRT2)));
}
function probOverLine(mean, stdDev, line) {
  return Math.max(1, Math.min(99, Math.round((1 - normalCDF(line, mean, stdDev)) * 100)));
}

// ── Shared NFL card anatomy (primary/secondary chips + reason) ─────────────
// Same card anatomy the MLB Hits/RBI/TB/SB/HRRBI boards already use (see
// app.js's chipSetPrimary/chipSetSecondary/reason around the shared prop
// engine): a few always-visible primary chips, the rest tucked behind a
// "Full breakdown" disclosure, and a plain-English "Why it supports the
// line" sentence -- previously every NFL card just dumped all its chips
// into one flat row with no disclosure and no reasoning text, unlike every
// MLB board.
function nflChip(k, v, cls, title) {
  const c = cls || '';
  const t = title ? ` title="${fantasyEsc(title)}"` : '';
  return `<span class="dr109-chip ${c}"${t}><span>${fantasyEsc(k)}:</span><strong>${fantasyEsc(v)}</strong></span>`;
}
function nflBreakdownHTML(secondaryChipsHtml) {
  if (!secondaryChipsHtml) return '';
  return `<details class="dr-hrp-breakdown"><summary>Full breakdown</summary><div class="dr109-chiprow" style="min-height:0 !important;margin-top:6px">${secondaryChipsHtml}</div></details>`;
}
function nflReasonHTML(label, text) {
  return `<div class="dr109-reason"><strong>${fantasyEsc(label)}:</strong>${text}</div>`;
}

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
    const [scheduleData, statsData, teamStatsData] = await Promise.all([
      drFetchDailyJSON('data/nfl-schedule.json').catch(() => null),
      drFetchDailyJSON('data/nfl-player-stats.json').catch(() => null),
      drFetchDailyJSON('data/nfl-team-stats.json').catch(() => null),
    ]);
    return { schedule: (scheduleData && scheduleData.events) || [], players: (statsData && statsData.players) || {}, teamStats: teamStatsData || null };
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
  const hasDefense = rows.some(r => r.defenseAdj);
  const copy = hasDefense
    ? `Real season rushing-yards rate, adjusted for real opponent scoring defense (ESPN standings) where a real matchup exists: each player's real season average and real stdDev shifted by the real opponent's points-allowed ratio, then run through a real probability calculation against Over ${NFL_RUSH_YDS_LINE} -- not a fitted or simulated distribution.`
    : `Real empirical rate this season that each player's own actual per-game rushing yards cleared Over ${NFL_RUSH_YDS_LINE}, not a fitted or simulated distribution. Early model — no opponent run-defense adjustment yet.`;
  return `<div class="dr1027-hr-summary"><div class="dr1027-summary-title">🏈 EXPANDED <span>NFL RUSHING YARDS DATA</span></div><p class="dr1027-summary-copy">${copy}</p><div class="dr1027-summary-grid"><div class="dr1027-summary-metric good"><b>${fantasyEsc(top.name || '–')}</b><span>Top Rated</span></div><div class="dr1027-summary-metric"><b>${avg}%</b><span>Board Avg Probability</span></div><div class="dr1027-summary-metric"><b>${rows.length}</b><span>Players Scanned</span></div><div class="dr1027-summary-metric warn"><b>Over ${NFL_RUSH_YDS_LINE} Yds</b><span>Primary Line</span></div></div></div>`;
}

function nflRushCardHTML(r) {
  const scoreCls = r.prob >= 55 ? 'good' : '';
  const defAdj = r.defenseAdj;
  const matchupPct = defAdj ? Math.round((defAdj.ratio - 1) * 100) : null;
  const effYdsPerGame = defAdj && r.adjMean != null ? r.adjMean : r.rushYdsPerGame;
  const primary = [
    nflChip('Line', `Over ${NFL_RUSH_YDS_LINE} Yds`, 'good'),
    nflChip(defAdj ? 'Adj Yds/GM' : 'Yds/GM', effYdsPerGame != null ? effYdsPerGame.toFixed(1) : '–', effYdsPerGame != null && effYdsPerGame >= NFL_RUSH_YDS_LINE ? 'good' : ''),
    defAdj
      ? nflChip('Matchup', `${fantasyEsc(r.oppAbbr)} ${matchupPct >= 0 ? '+' : ''}${matchupPct}%`, matchupPct > 0 ? 'good' : matchupPct < 0 ? 'bad' : '', `${r.oppAbbr} allows real ${defAdj.oppVal.toFixed(1)} pts/gm vs. a real ${defAdj.leagueAvg.toFixed(1)} pts/gm league average`)
      : nflChip('Games', r.gamesWithRushYds != null ? r.gamesWithRushYds : '–', ''),
  ].join('');
  const secondaryParts = [
    nflChip('Season Rush Yds', r.rushYds != null ? r.rushYds : '–', ''),
    defAdj ? nflChip('Season Yds/GM', r.rushYdsPerGame != null ? r.rushYdsPerGame.toFixed(1) : '–', '') : '',
    defAdj ? nflChip('Games', r.gamesWithRushYds != null ? r.gamesWithRushYds : '–', '') : '',
    nflChip('Std Dev', r.rushStdDev != null ? r.rushStdDev.toFixed(1) : '–', ''),
  ].filter(Boolean).join('');
  const reason = ` ${fantasyEsc(r.name || 'This player')} grades at ${r.prob}% for Over ${NFL_RUSH_YDS_LINE} Yds because the model runs their real season rushing profile (${r.rushYdsPerGame != null ? r.rushYdsPerGame.toFixed(1) : '–'} yds/gm over ${r.gamesWithRushYds != null ? r.gamesWithRushYds : '–'} games, std dev ${r.rushStdDev != null ? r.rushStdDev.toFixed(1) : '–'})${defAdj ? ', shifted by a real opponent-defense matchup,' : ''} through a real probability calculation. Opponent context: ${fantasyEsc(r.oppAbbr || 'opponent')}.`;
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
    <div class="dr109-chiprow">${primary}</div>
    ${nflBreakdownHTML(secondaryParts)}
    ${nflReasonHTML('Why it supports the line', reason)}
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
    .map(([id, p]) => {
      const oppAbbr = oppByTeam[p.teamAbbr];
      const defenseAdj = nflDefenseAdjustment(oppAbbr, data.teamStats);
      const adjMean = defenseAdj ? p.rushYdsPerGame * defenseAdj.ratio : null;
      // Only recompute via the parametric estimate when a real matchup AND a
      // real stdDev both exist -- otherwise fall back to the real empirical
      // season rate, same "no data, no adjustment" rule wnbaDefenseAdjustment
      // follows.
      const prob = (defenseAdj && p.rushStdDev != null)
        ? probOverLine(adjMean, p.rushStdDev, NFL_RUSH_YDS_LINE)
        : (p.probRushLine != null ? p.probRushLine : 0);
      return Object.assign({ id }, p, { oppAbbr, defenseAdj, adjMean, prob });
    });
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
    const [scheduleData, statsData, teamStatsData] = await Promise.all([
      drFetchDailyJSON('data/nfl-schedule.json').catch(() => null),
      drFetchDailyJSON('data/nfl-player-stats.json').catch(() => null),
      drFetchDailyJSON('data/nfl-team-stats.json').catch(() => null),
    ]);
    return { schedule: (scheduleData && scheduleData.events) || [], players: (statsData && statsData.players) || {}, teamStats: teamStatsData || null };
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
  const hasDefense = rows.some(r => r.defenseAdj);
  const copy = hasDefense
    ? `Real season passing-yards rate, adjusted for real opponent scoring defense (ESPN standings) where a real matchup exists: each player's real season average and real stdDev shifted by the real opponent's points-allowed ratio, then run through a real probability calculation against Over ${NFL_PASS_YDS_LINE} -- not a fitted or simulated distribution.`
    : `Real empirical rate this season that each player's own actual per-game passing yards cleared Over ${NFL_PASS_YDS_LINE}, not a fitted or simulated distribution. Early model — no opponent pass-defense adjustment yet.`;
  return `<div class="dr1027-hr-summary"><div class="dr1027-summary-title">🏈 EXPANDED <span>NFL PASSING YARDS DATA</span></div><p class="dr1027-summary-copy">${copy}</p><div class="dr1027-summary-grid"><div class="dr1027-summary-metric good"><b>${fantasyEsc(top.name || '–')}</b><span>Top Rated</span></div><div class="dr1027-summary-metric"><b>${avg}%</b><span>Board Avg Probability</span></div><div class="dr1027-summary-metric"><b>${rows.length}</b><span>Players Scanned</span></div><div class="dr1027-summary-metric warn"><b>Over ${NFL_PASS_YDS_LINE} Yds</b><span>Primary Line</span></div></div></div>`;
}

function nflPassCardHTML(r) {
  const scoreCls = r.prob >= 55 ? 'good' : '';
  const defAdj = r.defenseAdj;
  const matchupPct = defAdj ? Math.round((defAdj.ratio - 1) * 100) : null;
  const effYdsPerGame = defAdj && r.adjMean != null ? r.adjMean : r.passYdsPerGame;
  const primary = [
    nflChip('Line', `Over ${NFL_PASS_YDS_LINE} Yds`, 'good'),
    nflChip(defAdj ? 'Adj Yds/GM' : 'Yds/GM', effYdsPerGame != null ? effYdsPerGame.toFixed(1) : '–', effYdsPerGame != null && effYdsPerGame >= NFL_PASS_YDS_LINE ? 'good' : ''),
    defAdj
      ? nflChip('Matchup', `${fantasyEsc(r.oppAbbr)} ${matchupPct >= 0 ? '+' : ''}${matchupPct}%`, matchupPct > 0 ? 'good' : matchupPct < 0 ? 'bad' : '', `${r.oppAbbr} allows real ${defAdj.oppVal.toFixed(1)} pts/gm vs. a real ${defAdj.leagueAvg.toFixed(1)} pts/gm league average`)
      : nflChip('Games', r.gamesWithPassYds != null ? r.gamesWithPassYds : '–', ''),
  ].join('');
  const secondaryParts = [
    nflChip('Season Pass Yds', r.passYds != null ? r.passYds : '–', ''),
    defAdj ? nflChip('Season Yds/GM', r.passYdsPerGame != null ? r.passYdsPerGame.toFixed(1) : '–', '') : '',
    defAdj ? nflChip('Games', r.gamesWithPassYds != null ? r.gamesWithPassYds : '–', '') : '',
    nflChip('Std Dev', r.passStdDev != null ? r.passStdDev.toFixed(1) : '–', ''),
  ].filter(Boolean).join('');
  const reason = ` ${fantasyEsc(r.name || 'This player')} grades at ${r.prob}% for Over ${NFL_PASS_YDS_LINE} Yds because the model runs their real season passing profile (${r.passYdsPerGame != null ? r.passYdsPerGame.toFixed(1) : '–'} yds/gm over ${r.gamesWithPassYds != null ? r.gamesWithPassYds : '–'} games, std dev ${r.passStdDev != null ? r.passStdDev.toFixed(1) : '–'})${defAdj ? ', shifted by a real opponent-defense matchup,' : ''} through a real probability calculation. Opponent context: ${fantasyEsc(r.oppAbbr || 'opponent')}.`;
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
    <div class="dr109-chiprow">${primary}</div>
    ${nflBreakdownHTML(secondaryParts)}
    ${nflReasonHTML('Why it supports the line', reason)}
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
    .map(([id, p]) => {
      const oppAbbr = oppByTeam[p.teamAbbr];
      const defenseAdj = nflDefenseAdjustment(oppAbbr, data.teamStats);
      const adjMean = defenseAdj ? p.passYdsPerGame * defenseAdj.ratio : null;
      const prob = (defenseAdj && p.passStdDev != null)
        ? probOverLine(adjMean, p.passStdDev, NFL_PASS_YDS_LINE)
        : (p.probPassLine != null ? p.probPassLine : 0);
      return Object.assign({ id }, p, { oppAbbr, defenseAdj, adjMean, prob });
    });
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
    const [scheduleData, statsData, teamStatsData] = await Promise.all([
      drFetchDailyJSON('data/nfl-schedule.json').catch(() => null),
      drFetchDailyJSON('data/nfl-player-stats.json').catch(() => null),
      drFetchDailyJSON('data/nfl-team-stats.json').catch(() => null),
    ]);
    return { schedule: (scheduleData && scheduleData.events) || [], players: (statsData && statsData.players) || {}, teamStats: teamStatsData || null };
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
  const hasDefense = rows.some(r => r.defenseAdj);
  const copy = hasDefense
    ? `Real season receiving-yards and receptions rates, adjusted for real opponent scoring defense (ESPN standings) where a real matchup exists: each player's real season averages and real stdDevs shifted by the real opponent's points-allowed ratio, then run through a real probability calculation against Over ${NFL_REC_YDS_LINE} (plus a real, separate Receptions O/U ${NFL_RECEPTIONS_LINE}) -- not a fitted or simulated distribution.`
    : `Real empirical rate this season that each player's own actual per-game receiving yards cleared Over ${NFL_REC_YDS_LINE} (plus a real, separate Receptions O/U ${NFL_RECEPTIONS_LINE} rate), not a fitted or simulated distribution. Early model — no opponent pass-defense adjustment yet.`;
  return `<div class="dr1027-hr-summary"><div class="dr1027-summary-title">🏈 EXPANDED <span>NFL RECEIVING YARDS + RECEPTIONS DATA</span></div><p class="dr1027-summary-copy">${copy}</p><div class="dr1027-summary-grid"><div class="dr1027-summary-metric good"><b>${fantasyEsc(top.name || '–')}</b><span>Top Rated</span></div><div class="dr1027-summary-metric"><b>${avg}%</b><span>Board Avg Probability</span></div><div class="dr1027-summary-metric"><b>${rows.length}</b><span>Players Scanned</span></div><div class="dr1027-summary-metric warn"><b>Over ${NFL_REC_YDS_LINE} Yds</b><span>Primary Line</span></div></div></div>`;
}

function nflRecCardHTML(r) {
  const scoreCls = r.prob >= 55 ? 'good' : '';
  const defAdj = r.defenseAdj;
  const matchupPct = defAdj ? Math.round((defAdj.ratio - 1) * 100) : null;
  const effYdsPerGame = defAdj && r.adjMean != null ? r.adjMean : r.recYdsPerGame;
  const primary = [
    nflChip('Line', `Over ${NFL_REC_YDS_LINE} Yds`, 'good'),
    nflChip(defAdj ? 'Adj Yds/GM' : 'Yds/GM', effYdsPerGame != null ? effYdsPerGame.toFixed(1) : '–', effYdsPerGame != null && effYdsPerGame >= NFL_REC_YDS_LINE ? 'good' : ''),
    defAdj
      ? nflChip('Matchup', `${fantasyEsc(r.oppAbbr)} ${matchupPct >= 0 ? '+' : ''}${matchupPct}%`, matchupPct > 0 ? 'good' : matchupPct < 0 ? 'bad' : '', `${r.oppAbbr} allows real ${defAdj.oppVal.toFixed(1)} pts/gm vs. a real ${defAdj.leagueAvg.toFixed(1)} pts/gm league average`)
      : nflChip('Games', r.gamesWithRecYds != null ? r.gamesWithRecYds : '–', ''),
  ].join('');
  const secondaryParts = [
    nflChip('Season Rec Yds', r.recYds != null ? r.recYds : '–', ''),
    defAdj ? nflChip('Season Yds/GM', r.recYdsPerGame != null ? r.recYdsPerGame.toFixed(1) : '–', '') : '',
    nflChip('Rec/GM', r.receptionsPerGame != null ? r.receptionsPerGame.toFixed(1) : '–', ''),
    nflChip(`Over ${NFL_RECEPTIONS_LINE} Rec`, r.recProb != null ? r.recProb + '%' : '–', r.recProb != null && r.recProb >= 55 ? 'good' : ''),
    defAdj ? nflChip('Games', r.gamesWithRecYds != null ? r.gamesWithRecYds : '–', '') : '',
  ].filter(Boolean).join('');
  const reason = ` ${fantasyEsc(r.name || 'This player')} grades at ${r.prob}% for Over ${NFL_REC_YDS_LINE} Yds because the model runs their real season receiving profile (${r.recYdsPerGame != null ? r.recYdsPerGame.toFixed(1) : '–'} yds/gm, ${r.receptionsPerGame != null ? r.receptionsPerGame.toFixed(1) : '–'} rec/gm over ${r.gamesWithRecYds != null ? r.gamesWithRecYds : '–'} games)${defAdj ? ', shifted by a real opponent-defense matchup,' : ''} through a real probability calculation -- Receptions gets its own separate real O/U ${NFL_RECEPTIONS_LINE} read in the full breakdown. Opponent context: ${fantasyEsc(r.oppAbbr || 'opponent')}.`;
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
    <div class="dr109-chiprow">${primary}</div>
    ${nflBreakdownHTML(secondaryParts)}
    ${nflReasonHTML('Why it supports the line', reason)}
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
    .map(([id, p]) => {
      const oppAbbr = oppByTeam[p.teamAbbr];
      const defenseAdj = nflDefenseAdjustment(oppAbbr, data.teamStats);
      const adjMean = defenseAdj ? p.recYdsPerGame * defenseAdj.ratio : null;
      const prob = (defenseAdj && p.recYdsStdDev != null)
        ? probOverLine(adjMean, p.recYdsStdDev, NFL_REC_YDS_LINE)
        : (p.probRecYdsLine != null ? p.probRecYdsLine : 0);
      // Receptions gets the same real defense ratio applied to its own real
      // mean/stdDev -- a separate real probability, not derived from the
      // receiving-yards one.
      const adjReceptionsMean = defenseAdj && p.receptionsPerGame != null ? p.receptionsPerGame * defenseAdj.ratio : null;
      const recProb = (defenseAdj && p.receptionsStdDev != null && adjReceptionsMean != null)
        ? probOverLine(adjReceptionsMean, p.receptionsStdDev, NFL_RECEPTIONS_LINE)
        : (p.probReceptionsLine != null ? p.probReceptionsLine : null);
      return Object.assign({ id }, p, { oppAbbr, defenseAdj, adjMean, prob, recProb });
    });
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
