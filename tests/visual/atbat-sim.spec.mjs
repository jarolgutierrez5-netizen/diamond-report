import { test, expect } from '@playwright/test';
import { openAtBatSim, ATBAT_SIM_BATTER_NAME, ATBAT_SIM_PITCHER_NAME } from './lib/fixtures.mjs';

test.describe('Simulate At-Bats (Batter vs Pitcher modal)', () => {
  test('spins 4 reels, shows a recap, and pops a HOME RUN badge for an HR-heavy matchup', async ({ page }) => {
    await openAtBatSim(page);

    const pane = page.locator('.mu-tab-pane[data-tab="atbat-sim"]');
    await expect(pane).toBeVisible();
    await expect(pane.locator('.dr-sim-disclaimer')).toContainText("not a prediction of today's actual results");
    await expect(pane.locator('.dr-sim-disclaimer')).toContainText(ATBAT_SIM_BATTER_NAME);
    await expect(pane.locator('.dr-sim-disclaimer')).toContainText(ATBAT_SIM_PITCHER_NAME);

    const spinBtn = pane.locator('#dr-abs-spin-btn');
    await spinBtn.click();
    await expect(spinBtn).toBeDisabled();

    // Last reel lands at 500 + 3*350 = 1550ms; give it margin.
    await page.waitForTimeout(2000);

    await expect(spinBtn).toBeEnabled();
    await expect(spinBtn).toHaveText('🎰 Spin Again');

    const faces = pane.locator('.dr-abs-reel-face');
    await expect(faces).toHaveCount(4);
    for (let i = 0; i < 4; i++) {
      await expect(faces.nth(i)).toContainText('HR');
    }

    await expect(pane.locator('#dr-abs-recap')).toContainText('hypothetical 4-AB stretch');
    await expect(pane.locator('#dr-abs-recap')).toContainText('HR');

    // The fixture's stat pair makes 'hr' the overwhelmingly dominant sampled
    // outcome, so the popup badge should appear...
    const popup = pane.locator('.dr-abs-popup-hr');
    await expect(popup).toBeVisible();
    await expect(popup).toHaveText('💥 HOME RUN!');
    // ...and clean itself up (one-shot, matching the pick-hit celebration's
    // own cleanup-after-play pattern elsewhere on the site).
    await expect(popup).toBeHidden({ timeout: 2000 });
  });

  test('Spin Again re-rolls and reproduces the same seeded outcome', async ({ page }) => {
    await openAtBatSim(page);
    await page.locator('#dr-abs-spin-btn').click();
    await page.waitForTimeout(2000);
    const firstRecap = await page.locator('#dr-abs-recap').textContent();

    await page.locator('#dr-abs-spin-btn').click();
    await page.waitForTimeout(2000);
    const secondRecap = await page.locator('#dr-abs-recap').textContent();

    expect(secondRecap).toBe(firstRecap);
  });
});
