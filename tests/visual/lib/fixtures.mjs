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
