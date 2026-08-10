import { test, expect } from '@playwright/test';
import { blockExternalRequests, disableMotion } from './lib/fixtures.mjs';

const SCHEDULE = {
  events: [
    { date: '2026-08-11T23:00Z', completed: false, home: { abbreviation: 'LV' }, away: { abbreviation: 'NY' } },
  ],
};
const PLAYERS = {
  w1: {
    name: 'Easy Matchup Scorer', position: 'F', teamAbbr: 'NY', headshot: 'https://example.test/w1.png', season: 2026,
    games: 20, ptsPerGame: 10.0, ptsStdDev: 3.0,
    rebPerGame: 5.0, rebStdDev: 1.5, astPerGame: 2.0, astStdDev: 1.0,
    threesPerGame: 1.0, threesStdDev: 0.5, praPerGame: 17.0, praStdDev: 4.0,
  },
};
const TEAM_DEFENSE = {
  leagueAvgPointsAgainst: 80,
  teams: { LV: { avgPointsAgainst: 100 }, NY: { avgPointsAgainst: 80 } },
};

test.describe('WNBA Points board opponent-defense adjustment', () => {
  test('headline projection is defense-adjusted, Matchup chip shows the real ratio', async ({ page }) => {
    await blockExternalRequests(page);
    await page.route('**/data/wnba-schedule.json*', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(SCHEDULE) }));
    await page.route('**/data/wnba-player-stats.json*', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ updatedAt: new Date().toISOString(), players: PLAYERS }) }));
    await page.route('**/data/wnba-team-defense.json*', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ updatedAt: new Date().toISOString(), ...TEAM_DEFENSE }) }));
    await page.goto('/index.html', { waitUntil: 'domcontentloaded' });
    await disableMotion(page);
    await page.evaluate(() => {
      const hub = document.getElementById('dr-landing-hub');
      if (hub) hub.style.display = 'none';
      const props = document.getElementById('props');
      if (props) { props.classList.add('active'); props.style.display = ''; }
      window.showGamePickPane('wnbapts');
    });
    await page.waitForTimeout(400);

    // NY player faces LV, who allows 100 PPG vs. an 80 PPG league average
    // (ratio 1.25) -- real 10.0 PPG raw average becomes a real 12.5 Proj PPG.
    const card = page.locator('#wnba-points-content .dr109-card').first();
    await expect(card.locator('.dr109-score')).toContainText('12.5');
    await expect(card.locator('.dr109-chip', { hasText: 'Season PPG' })).toContainText('10.0');
    const matchup = card.locator('.dr109-chip', { hasText: 'Matchup' });
    await expect(matchup).toContainText('LV');
    await expect(matchup).toContainText('+25%');
    await expect(matchup).toHaveClass(/good/);
  });
});
