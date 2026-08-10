// Shared setup for visual regression specs. Renders real board components
// against synthetic in-memory rows (same window.hrpRows seeding pattern used
// throughout manual QA this project) so screenshots are deterministic and
// never depend on live game data or network access -- everything reaches
// localhost:8123 only, every cross-origin request (MLB headshots, the
// production API) is aborted so photos/scouting-reports/lineups render
// identically in this sandbox and in CI regardless of real internet access.
const FIXED_GAME_TIME = new Date('2026-08-06T23:05:00Z').getTime();

export const BOARD_ROWS = [
  {
    // Strong matchup: every chip should render its "good" color.
    id: 1, name: 'Strong Signal Batter', pos: 'OF', teamAbbr: 'NYY', oppAbbr: 'BOS',
    pitcherId: 101, pitcherName: 'Weak Pitcher', gamePk: 9001, timeLabel: '7:05 PM',
    timeColor: '#fff', gameTimestamp: FIXED_GAME_TIME, homeAbbr: 'NYY', battingOrder: 3,
    hrProb: 24.6, matchupEdge: 78, zoneFitScore: 81, pitchMixPitches: 46, pitchMixFavorable: true,
    avg: .312, ops: .945, obp: .398, slg: .547, iso: .235, hrSeason: 27, last10HR: 4,
    parkFactor: 112, weatherHRMult: 1.08, isFavorable: true, topHrThreat: true,
    obpAhead: .360, tableSettersGood: true, isOnFire: true, onFireScore: 88,
  },
  {
    // Weak matchup: chips should render their "bad" color, not just hide.
    id: 2, name: 'Weak Signal Batter', pos: '1B', teamAbbr: 'BOS', oppAbbr: 'NYY',
    pitcherId: 102, pitcherName: 'Strong Pitcher', gamePk: 9001, timeLabel: '7:05 PM',
    timeColor: '#fff', gameTimestamp: FIXED_GAME_TIME, homeAbbr: 'NYY', battingOrder: 7,
    // hrProb kept >=7 -- the HR Threats board's own eligibility filter
    // (getHRRows) excludes anything below that regardless of what's seeded
    // here, same real threshold production rows are held to.
    hrProb: 8.5, matchupEdge: 32, zoneFitScore: 41, pitchMixPitches: 38, pitchMixFavorable: false,
    avg: .218, ops: .612, obp: .278, slg: .334, iso: .116, hrSeason: 5, last10HR: 0,
    parkFactor: 94, weatherHRMult: 0.92, isFavorable: false, topHrThreat: false,
    obpAhead: .290, tableSettersGood: false,
  },
  {
    // Sparse/null data: regression guard for the "labels must never vanish,
    // fall back to '-' instead" bug fixed earlier this project.
    id: 3, name: 'Sparse Data Batter', pos: 'C', teamAbbr: 'NYY', oppAbbr: 'BOS',
    pitcherId: null, pitcherName: '', gamePk: 9001, timeLabel: '7:05 PM',
    timeColor: '#fff', gameTimestamp: FIXED_GAME_TIME, homeAbbr: 'NYY', battingOrder: 9,
    hrProb: 7.2, matchupEdge: null, zoneFitScore: null, pitchMixPitches: null, pitchMixFavorable: null,
    avg: null, ops: null, obp: null, slg: null, iso: null, hrSeason: null, last10HR: null,
    parkFactor: null, weatherHRMult: null,
  },
];

export async function blockExternalRequests(page) {
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith('http://localhost:8123') || url.startsWith('http://127.0.0.1:8123')) {
      route.continue();
    } else {
      route.abort();
    }
  });
}

export async function disableMotion(page) {
  await page.addStyleTag({
    content: `*, *::before, *::after {
      animation: none !important;
      transition: none !important;
      caret-color: transparent !important;
      scroll-behavior: auto !important;
    }`,
  });
}

// Seeds window.hrpRows and neutralizes every async/network-driven enrichment
// (background refresh timers, lineup fetch, scouting report fetch) so the
// render is deterministic and settles quickly instead of racing a real
// network call that this test intentionally blocks.
async function seedRows(page, rows) {
  await page.evaluate((rows) => {
    window.loadHRPotential = () => Promise.resolve();
    window.loadHRPotentialWithRetry = () => {};
    window.loadRepoLineups = () => Promise.resolve();
    window.loadHRScoutingReport = () => Promise.resolve(
      '<span style="color:var(--muted)">No opposing pitcher assigned yet — scouting report unavailable.</span>'
    );
    const hub = document.getElementById('dr-landing-hub');
    if (hub) hub.style.display = 'none';
    const props = document.getElementById('props');
    if (props) { props.classList.add('active'); props.style.display = ''; }
    window.hrpRows = rows;
    window.__hrpFilterSet = new Set();
  }, rows);
}

export async function openHRBoard(page, rows = BOARD_ROWS) {
  await blockExternalRequests(page);
  await page.goto('/index.html', { waitUntil: 'domcontentloaded' });
  await disableMotion(page);
  await seedRows(page, rows);
  await page.evaluate(() => { window.renderHRPTable(); window.showGamePickPane('hr'); });
  await page.waitForTimeout(300);
  // Re-seed + re-render immediately before the caller screenshots: guards
  // against a background auto-refresh timer racing in with an (intentionally
  // network-blocked, empty) result between the first render and the shot.
  await seedRows(page, rows);
  await page.evaluate(() => { window.renderHRPTable(); });
  await page.waitForTimeout(200);
}

// A deterministic real-shaped (9-batter) lineup matchup for the Simulate
// Game feature -- gameSimReady() gates on a real 9-man lineup (same as
// production, real MLB lineups are always 9), so the fixture has to match
// that shape for the "button enables" path to actually exercise it.
export const GAME_SIM_GAME_PK = 999001;
export const GAME_SIM_AWAY_ABBR = 'NYY';
export const GAME_SIM_HOME_ABBR = 'BOS';
const GAME_SIM_AWAY_LINEUP = Array.from({ length: 9 }, (_, i) => ({ id: 701 + i, name: `Away ${i + 1}`, pos: 'OF' }));
const GAME_SIM_HOME_LINEUP = Array.from({ length: 9 }, (_, i) => ({ id: 801 + i, name: `Home ${i + 1}`, pos: 'OF' }));
// Deliberately extreme, unambiguous rate stats -- the away lineup always
// walks (guaranteeing a real, assertable "X walks. Y scores." once bases
// fill), the home pitcher entry is unhittable, so the deterministic
// Math.random() sequence below produces a small, exactly-predictable
// scoreline instead of something that has to be re-derived by hand from a
// realistic-but-messy stat line.
const ALWAYS_WALK_BATTER = { plateAppearances: 600, hits: 0, homeRuns: 0, doubles: 0, triples: 0, baseOnBalls: 600, hitByPitch: 0, strikeOuts: 0 };
const NEVER_WALK_PITCHER = { battersFaced: 600, hits: 0, homeRuns: 0, baseOnBalls: 0, hitBatsmen: 0, strikeOuts: 0 };
// Same "opposite extreme" pair as the At-Bats slot machine's own HR-prone
// fixture -- used when a test needs a scoring play to be a home run
// specifically (for the reel pop-up), rather than the walk-driven scoreline
// the default pair above produces.
// NOT maxed to 100%/0% like the At-Bats tab's single-PA fixture -- a full
// game replays plate appearances in a while(outs<3) loop per half-inning, so
// leaving strikeouts at a real, healthy rate for both sides matters here:
// pushing 'hr' too close to 100% starves the 'k'/'out' probability mass the
// loop depends on to ever terminate. A 50/50 HR-or-K batter against a very
// homer-prone (5x league average) but otherwise ordinary pitcher still makes
// 'hr' the overwhelming favorite among outcomes that actually score a run,
// while keeping strikeouts common enough that every half-inning ends fast.
const GAME_SIM_ALWAYS_HR_BATTER = { plateAppearances: 600, hits: 300, homeRuns: 300, doubles: 0, triples: 0, baseOnBalls: 0, hitByPitch: 0, strikeOuts: 300 };
const GAME_SIM_GOPHER_BALL_PITCHER = { battersFaced: 600, hits: 150, homeRuns: 90, baseOnBalls: 45, hitBatsmen: 0, strikeOuts: 150 };

async function seedGameSimRoutes(page, hrProne = false) {
  const battingStat = hrProne ? GAME_SIM_ALWAYS_HR_BATTER : ALWAYS_WALK_BATTER;
  const pitchingStat = hrProne ? GAME_SIM_GOPHER_BALL_PITCHER : NEVER_WALK_PITCHER;
  await page.route('**/api/v1/people/*', (route) => {
    const url = route.request().url();
    const stat = /group=hitting/.test(url) ? battingStat : pitchingStat;
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ people: [{ stats: [{ splits: [{ stat }] }] }] }) });
  });
  await page.route('**/api/v1/teams/*/stats*', (route) => {
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ stats: [{ splits: [{ stat: pitchingStat }] }] }) });
  });
}

// Seeds a single deterministic Simulate Game button for GAME_SIM_GAME_PK
// with both lineups confirmed. Injects the button directly with the exact
// markup/onclick shape the real Game Projections card (loadGameProps,
// app.js) produces, rather than driving that card's own real network-heavy
// render pipeline (weather/odds/standings/etc, all orthogonal to this
// feature and already its own thing to test) — this exercises the real
// click -> openGameSim -> runGameSim -> buildGameSimMatchup -> render flow
// exactly as production wires it, just without reconstructing the card
// around it. Stubs getRepoLineupForGame directly (a real top-level
// function — same "stub the public function directly" house preference as
// seedRows above), and seeds Math.random to a fixed sequence before any app
// script runs so the single-trial rollout is exactly reproducible.
export async function openGameSim(page, { randomSeed = 0.05, hrProne = false } = {}) {
  await blockExternalRequests(page);
  await seedGameSimRoutes(page, hrProne);
  // Simple linear-congruential PRNG, seeded, deterministic across runs —
  // Math.random() itself can't be seeded, and this is the one piece of new
  // fixture infrastructure a Monte Carlo feature needs that nothing else in
  // this suite required before it.
  await page.addInitScript((seed) => {
    let s = seed * 2 ** 31;
    Math.random = () => {
      s = (s * 1103515245 + 12345) % 2 ** 31;
      return s / 2 ** 31;
    };
  }, randomSeed);
  await page.goto('/index.html', { waitUntil: 'domcontentloaded' });
  await disableMotion(page);
  await page.evaluate(({ gamePk, awayAbbr, homeAbbr, awayLineup, homeLineup }) => {
    const hub = document.getElementById('dr-landing-hub');
    if (hub) hub.style.display = 'none';
    const props = document.getElementById('props');
    if (props) { props.classList.add('active'); props.style.display = ''; }
    window.showGamePickPane('game');
    window.loadRepoLineups = async () => null;
    window.getRepoLineupForGame = (pk, side) => {
      if (pk !== gamePk) return null;
      return { confirmed: true, lineup: side === 'away' ? awayLineup : homeLineup };
    };
    const el = document.getElementById('gameprops-content');
    if (el) el.innerHTML = `<div class="gp-card" data-game-pk="${gamePk}">
      <button type="button" class="btn-lineup dr-sim-btn" disabled data-dr-sim-btn data-gamepk="${gamePk}" title="Checking again automatically once lineups post" onclick="event.stopPropagation();openGameSim(${gamePk},'${awayAbbr}','${homeAbbr}','${awayAbbr}','${homeAbbr}',147,111,601,'Away Starter',602,'Home Starter')">🔒 Lineups not posted yet</button>
    </div>`;
    if (typeof window.refreshGameSimButtonStates === 'function') window.refreshGameSimButtonStates();
  }, { gamePk: GAME_SIM_GAME_PK, awayAbbr: GAME_SIM_AWAY_ABBR, homeAbbr: GAME_SIM_HOME_ABBR, awayLineup: GAME_SIM_AWAY_LINEUP, homeLineup: GAME_SIM_HOME_LINEUP });
  await page.waitForTimeout(150);
}

// Deterministic Batter vs Pitcher matchup for the "Simulate At-Bats" slot
// machine (openMatchup -> renderMatchupModal's new atbat-sim tab). Deliberately
// extreme, unambiguous rate stats in the SAME family as GAME_SIM's
// ALWAYS_WALK_BATTER/NEVER_WALK_PITCHER above -- here both sides are maxed
// toward "home run every time" (batter all-HR AND pitcher a total gopher-ball
// arm) so computeMatchupOutcomeDist's log5 combination makes 'hr' the
// overwhelmingly dominant sampled outcome regardless of the exact seeded
// Math.random sequence, which is what the popup-on-HR assertion needs to be
// reliable rather than hand-deriving one exact LCG sequence.
export const ATBAT_SIM_BATTER_ID = 601;
export const ATBAT_SIM_PITCHER_ID = 602;
export const ATBAT_SIM_BATTER_NAME = 'Sim Batter';
export const ATBAT_SIM_PITCHER_NAME = 'Sim Pitcher';
const ALWAYS_HR_BATTER = { plateAppearances: 600, hits: 600, homeRuns: 600, doubles: 0, triples: 0, baseOnBalls: 0, hitByPitch: 0, strikeOuts: 0 };
const GOPHER_BALL_PITCHER = { battersFaced: 600, hits: 600, homeRuns: 600, baseOnBalls: 0, hitBatsmen: 0, strikeOuts: 0 };

async function seedAtBatSimRoutes(page) {
  // openMatchup's H2H/expected-stats/split fetches all hit .../people/<id>/stats?...
  // -- a distinct, more specific path shape from the plain hydrate lookup
  // below, so it needs its own route registered separately.
  await page.route('**/api/v1/people/*/stats*', (route) => {
    const url = route.request().url();
    if (/sitCodes=/.test(url)) {
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ stats: [{ splits: [] }] }) });
      return;
    }
    const stat = /group=hitting/.test(url) ? ALWAYS_HR_BATTER : GOPHER_BALL_PITCHER;
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ stats: [{ splits: [{ stat }] }] }) });
  });
  await page.route('**/api/v1/people/*', (route) => {
    const url = route.request().url();
    const stat = /group=hitting/.test(url) ? ALWAYS_HR_BATTER : GOPHER_BALL_PITCHER;
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ people: [{ stats: [{ splits: [{ stat }] }] }] }) });
  });
}

// Opens the Batter vs Pitcher modal directly via window.openMatchup (a real,
// bare top-level function in app.js, reachable as a global exactly like
// window.getRepoLineupForGame elsewhere in this file) rather than driving a
// board card's own render pipeline to produce a clickable "Matchup" button --
// same "exercise the real function directly" tradeoff openGameSim's fixture
// already makes for its own click -> render chain.
export async function openAtBatSim(page, { randomSeed = 0.05 } = {}) {
  await blockExternalRequests(page);
  await seedAtBatSimRoutes(page);
  await page.addInitScript((seed) => {
    let s = seed * 2 ** 31;
    Math.random = () => {
      s = (s * 1103515245 + 12345) % 2 ** 31;
      return s / 2 ** 31;
    };
  }, randomSeed);
  await page.goto('/index.html', { waitUntil: 'domcontentloaded' });
  await disableMotion(page);
  await page.evaluate(({ batterId, batterName, pitcherId, pitcherName }) => {
    const hub = document.getElementById('dr-landing-hub');
    if (hub) hub.style.display = 'none';
    window.openMatchup(batterId, batterName, pitcherId, pitcherName);
  }, { batterId: ATBAT_SIM_BATTER_ID, batterName: ATBAT_SIM_BATTER_NAME, pitcherId: ATBAT_SIM_PITCHER_ID, pitcherName: ATBAT_SIM_PITCHER_NAME });
  await page.waitForSelector('#mu-modal-overlay .mu-tab-btn[data-tab="atbat-sim"]', { timeout: 15000 });
  await page.locator('.mu-tab-btn[data-tab="atbat-sim"]').click();
}

export async function openPropBoard(page, pane, rows = BOARD_ROWS) {
  await blockExternalRequests(page);
  await page.goto('/index.html', { waitUntil: 'domcontentloaded' });
  await disableMotion(page);
  await seedRows(page, rows);
  await page.evaluate((pane) => {
    window.renderPropIntelligencePanes();
    window.showGamePickPane(pane);
  }, pane);
  await page.waitForTimeout(300);
  await seedRows(page, rows);
  await page.evaluate(() => { window.renderPropIntelligencePanes(); });
  await page.waitForTimeout(200);
}

const WNBA_SCHEDULE = {
  events: [
    { date: '2026-08-11T23:00Z', completed: false, home: { abbreviation: 'LVA' }, away: { abbreviation: 'NYL' } },
  ],
};
// One deterministic real-shaped player per board key -- covers the app.js
// WNBA_PROP_BOARDS engine's shared card/summary path (headshot, watch star,
// cushion/risk, all 5 season averages) without needing real synced data.
export const WNBA_PLAYERS = {
  w1: {
    name: 'Rotation Starter', position: 'F', teamAbbr: 'LVA', headshot: 'https://example.test/w1.png', season: 2026,
    games: 20, ptsPerGame: 14.9, ptsStdDev: 3.4, gamesWith15Plus: 8, prob15Plus: 40,
    rebPerGame: 9.4, rebStdDev: 2.1, gamesWithRebLine: 15, probRebLine: 75,
    astPerGame: 2.3, astStdDev: 1.1, gamesWithAstLine: 3, probAstLine: 15,
    threesPerGame: 0.4, threesStdDev: 0.6, gamesWith3PMLine: 1, prob3PMLine: 5,
    praPerGame: 26.6, praStdDev: 5.0, gamesWithPRALine: 12, probPRALine: 60,
  },
};

// Opens a WNBA prop board (renderWNBAPropBoard's config-driven engine, app.js)
// via real fetch mocks for data/wnba-schedule.json + data/wnba-player-stats.json
// rather than seeding a window global directly -- that data flows through
// loadWNBAPropData's own drFetchDailyJSON call, so this is the fixture-level
// equivalent of seedRows for this board family.
export async function openWNBAPropBoard(page, pane, players = WNBA_PLAYERS) {
  await blockExternalRequests(page);
  await page.route('**/data/wnba-schedule.json*', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(WNBA_SCHEDULE) }));
  await page.route('**/data/wnba-player-stats.json*', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ updatedAt: new Date().toISOString(), players }) }));
  await page.goto('/index.html', { waitUntil: 'domcontentloaded' });
  await disableMotion(page);
  await page.evaluate((pane) => { window.showGamePickPane(pane); }, pane);
  await page.waitForTimeout(400);
}
