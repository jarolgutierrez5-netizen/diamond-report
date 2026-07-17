#!/usr/bin/env node
// Temporary diagnostic — NOT meant to stay in the repo. Verifies the shape of
// /api/v1/teams/{id}/stats?stats=season&group=pitching&season=2026 (used by the new
// teamSeasonPitchingTotals() in app.js for the bullpen-strength signal in Projected
// Total) before trusting it in production — this endpoint/shape wasn't previously
// used anywhere else in this codebase, unlike the player-level stats hydrate call.

const API = 'https://statsapi.mlb.com/api/v1';
const TEAM_IDS = { NYM: 121, PHI: 143 };

async function fetchJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DiamondReportBot/1.0)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function main() {
  for (const [abbr, id] of Object.entries(TEAM_IDS)) {
    const url = `${API}/teams/${id}/stats?stats=season&group=pitching&season=2026`;
    const d = await fetchJSON(url);
    console.log(`\n=== ${abbr} (${id}) ===`);
    console.log('Top-level keys:', Object.keys(d));
    const stat = d.stats?.[0]?.splits?.[0]?.stat;
    console.log('stats[0].splits[0].stat present:', !!stat);
    if (stat) {
      console.log('stat keys:', Object.keys(stat).join(', '));
      console.log('earnedRuns:', stat.earnedRuns, ' inningsPitched:', stat.inningsPitched, ' era:', stat.era);
    } else {
      console.log('Full response (truncated):', JSON.stringify(d).slice(0, 1500));
    }
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
