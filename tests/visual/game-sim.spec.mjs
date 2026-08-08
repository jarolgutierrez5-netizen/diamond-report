import { test, expect } from '@playwright/test';
import { openGameSim, GAME_SIM_GAME_PK, GAME_SIM_AWAY_ABBR, GAME_SIM_HOME_ABBR } from './lib/fixtures.mjs';

test.describe('Simulate Game', () => {
  test('button stays disabled until both lineups are confirmed', async ({ page }) => {
    await openGameSim(page);
    // Re-seed with one side unconfirmed and re-check gating.
    await page.evaluate(({ gamePk }) => {
      const realLineup = Array.from({ length: 9 }, (_, i) => ({ id: i + 1, name: 'Player ' + i }));
      window.getRepoLineupForGame = (pk, side) => {
        if (pk !== gamePk) return null;
        if (side === 'away') return { confirmed: false, lineup: [] };
        return { confirmed: true, lineup: realLineup };
      };
      window.refreshGameSimButtonStates();
    }, { gamePk: GAME_SIM_GAME_PK });

    const btn = page.locator('[data-dr-sim-btn]');
    await expect(btn).toBeDisabled();
    await expect(btn).toHaveText('🔒 Lineups not posted yet');
  });

  test('button enables once both lineups are confirmed, and opens the modal', async ({ page }) => {
    await openGameSim(page);
    const btn = page.locator('[data-dr-sim-btn]');
    await expect(btn).toBeEnabled();
    await expect(btn).toHaveText('🎲 Simulate Game');

    await btn.click();
    const overlay = page.locator('#dr-sim-modal-overlay');
    await expect(overlay).toBeVisible();
    await expect(page.locator('#dr-sim-modal-title')).toHaveText(`${GAME_SIM_AWAY_ABBR} @ ${GAME_SIM_HOME_ABBR}`);
  });

  test('renders a disclaimer, a line score, and at least one scoring play, and Simulate Again re-rolls', async ({ page }) => {
    await openGameSim(page);
    await page.locator('[data-dr-sim-btn]').click();

    const body = page.locator('#dr-sim-modal-body');
    await expect(body.locator('.dr-sim-disclaimer')).toContainText('not a prediction of what will actually happen');
    await expect(body.locator('.dr-sim-linescore')).toBeVisible();
    // The fixture's batters always walk and the pitchers never do -- bases
    // load fast, so at least one real "X walks. Y scores." scoring play is a
    // deterministic near-certainty for this seed, and is exactly the format
    // ("player, verb, player scores") the feature exists to produce. The real
    // sentence text is in the DOM immediately (only its opacity is animated
    // by the reel-landing sequence), so this doesn't need to wait for the
    // slot-machine reel beside it to land.
    await expect(body.locator('.dr-sim-play-text').first()).toContainText('scores.');

    // The reroll button stays disabled until every play's reel has landed
    // (see animateGameSimPlays) so a click can't kick off a second
    // simulation while the first render's cosmetic Math.random() reel-
    // cycling is still running in the background -- that would steal draws
    // from the shared Math.random() stream and make even the FIRST play of
    // the *next* roll unpredictable. Playwright's click() already waits for
    // the button to become enabled, so no manual timing wait is needed here.
    //
    // Note: a reroll is NOT expected to reproduce the same rollout as the
    // first click, even under this fixture's seeded Math.random -- it
    // deliberately continues consuming the same global sequence rather than
    // re-seeding, so it draws a fresh, different set of outcomes each time
    // (that's the whole point of "Simulate Again"). This just verifies the
    // reroll mechanism itself actually re-simulates and re-renders.
    const reroll = body.locator('.dr-sim-reroll-btn');
    await reroll.click();
    await expect(reroll).toBeDisabled();
    await expect(body.locator('.dr-sim-linescore')).toBeVisible();
    await expect(body.locator('.dr-sim-play-text').first()).toContainText('scores.');
    await expect(reroll).toBeEnabled({ timeout: 8000 });
  });

  test('pops a HOME RUN badge on a scoring play that lands as a home run', async ({ page }) => {
    await openGameSim(page, { hrProne: true });
    await page.locator('[data-dr-sim-btn]').click();

    const body = page.locator('#dr-sim-modal-body');
    await expect(body.locator('.dr-sim-play-row').first()).toBeVisible();

    // The fixture's HR-prone stat pair makes 'hr' the overwhelmingly dominant
    // sampled outcome among scoring plays, so the first play's reel should
    // land on HR and pop the badge shortly after.
    const popup = body.locator('.dr-abs-popup-hr').first();
    await expect(popup).toBeVisible({ timeout: 2000 });
    await expect(popup).toHaveText('💥 HOME RUN!');
    // A high-scoring HR-heavy rollout can have several HR plays landing in
    // sequence, each popping its own one-shot badge -- so `.first()` can stay
    // "visible" for a while as one replaces another. Instead of racing that,
    // wait past the full staggered landing window (capped at 12 plays' worth
    // of delay) plus a cleanup cycle, then confirm none linger at all.
    await page.waitForTimeout(5000);
    await expect(body.locator('.dr-abs-popup-hr')).toHaveCount(0);
  });

  test('shows a graceful message when lineups are not posted', async ({ page }) => {
    await openGameSim(page);
    await page.evaluate(({ gamePk }) => {
      window.getRepoLineupForGame = () => null;
    }, { gamePk: GAME_SIM_GAME_PK });
    await page.evaluate(({ gamePk, awayAbbr, homeAbbr }) => {
      window.openGameSim(gamePk, awayAbbr, homeAbbr, awayAbbr, homeAbbr, 147, 111, 601, 'Away Starter', 602, 'Home Starter');
    }, { gamePk: GAME_SIM_GAME_PK, awayAbbr: GAME_SIM_AWAY_ABBR, homeAbbr: GAME_SIM_HOME_ABBR });
    await page.waitForTimeout(200);
    await expect(page.locator('#dr-sim-modal-body')).toContainText('Lineups aren’t posted for this game yet');
  });
});
