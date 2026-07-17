#!/usr/bin/env node
// Temporary diagnostic — NOT meant to stay in the repo. Investigates why Trea Turner,
// Brett Baty, and Francisco Alvarez (all in the 2026-07-16 NYM @ PHI game, gamePk 823440)
// hit home runs that day but were reported missing from the site's HR Threat list.
// Replicates the exact filtering logic from loadHRPotential() in app.js against the real
// boxscore/roster data for that game to see which check (if any) would exclude them.

const API = 'https://statsapi.mlb.com/api/v1';
const GAME_PK = 823440;
const TARGETS = ['Trea Turner', 'Brett Baty', 'Francisco Alvarez'];

async function fetchJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DiamondReportBot/1.0)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

const INACTIVE_STATUS_RE = /injured|\bil\b|restricted|suspended|bereavement|paternity|inactive|minor/;

async function main() {
  const sched = await fetchJSON(`${API}/schedule?sportId=1&date=2026-07-16&hydrate=team,probablePitcher,linescore`);
  const game = sched.dates?.[0]?.games?.find(g => g.gamePk === GAME_PK);
  console.log('Game found in schedule:', !!game);
  if (game) {
    console.log('Away:', game.teams.away.team.abbreviation, 'probablePitcher:', game.teams.away.probablePitcher?.fullName || 'NONE');
    console.log('Home:', game.teams.home.team.abbreviation, 'probablePitcher:', game.teams.home.probablePitcher?.fullName || 'NONE');
    console.log('Status:', game.status.abstractGameState, game.status.detailedState);
  }

  const box = await fetchJSON(`${API}/game/${GAME_PK}/boxscore`);
  for (const side of ['away', 'home']) {
    const teamBox = box.teams[side];
    const abbr = teamBox.team.abbreviation;
    console.log(`\n--- ${side.toUpperCase()} (${abbr}) ---`);
    console.log('batters array length:', (teamBox.batters || []).length);
    for (const [pid, p] of Object.entries(teamBox.players || {})) {
      const name = p.person?.fullName;
      if (!TARGETS.includes(name)) continue;
      const bo = Number(p.battingOrder ?? p.stats?.batting?.battingOrder ?? NaN);
      const inBattersArray = (teamBox.batters || []).includes(p.person.id);
      const hr = p.stats?.batting?.homeRuns;
      console.log(`FOUND: ${name} (id ${p.person.id})`);
      console.log(`  battingOrder raw: ${p.battingOrder}, parsed: ${bo}, passes starter filter (bo%100===0): ${Number.isFinite(bo) && bo % 100 === 0}`);
      console.log(`  in teamBox.batters[] array: ${inBattersArray}`);
      console.log(`  position: ${p.position?.abbreviation}, status: ${JSON.stringify(p.status)}`);
      console.log(`  actual homeRuns this game (box score): ${hr}`);
    }
  }

  // Roster status check (same source isActiveForHRThreat/loadActivePlayerIdsForGames uses)
  console.log('\n--- Active roster status check ---');
  for (const teamId of [143, 121]) { // PHI, NYM
    const roster = await fetchJSON(`${API}/teams/${teamId}/roster?rosterType=active&season=2026`);
    for (const entry of roster.roster || []) {
      const name = entry.person?.fullName;
      if (!TARGETS.includes(name)) continue;
      const statusText = String(entry.status?.description || entry.status?.code || '');
      console.log(`${name}: roster status = "${statusText}", flagged inactive by regex: ${INACTIVE_STATUS_RE.test(statusText.toLowerCase())}`);
    }
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
