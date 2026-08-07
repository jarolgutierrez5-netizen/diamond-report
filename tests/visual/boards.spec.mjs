import { test, expect } from '@playwright/test';
import { openHRBoard, openPropBoard, BOARD_ROWS } from './lib/fixtures.mjs';

test.describe('HR Threats board', () => {
  test('card list renders primary chips + full-breakdown disclosure', async ({ page }) => {
    await openHRBoard(page);
    await expect(page.locator('#hr-potential-content .dr1027-hr-card-list')).toHaveScreenshot('hr-card-list.png');
  });

  test('filter bar renders (closed)', async ({ page }) => {
    await openHRBoard(page);
    await expect(page.locator('#gamepick-pane-hr .dr-filter-row').first()).toHaveScreenshot('hr-filter-row.png');
  });

  test('table view toggle switches rendering + persists sort/heat cells', async ({ page }) => {
    await openHRBoard(page);
    await page.click('#hrp-view-table-btn');
    await expect(page.locator('#hr-potential-content .hrpt-table')).toHaveScreenshot('hr-table-view.png');

    // Sparse/null-data row (id 3, battingOrder 9) must render its Sleeper
    // signal and fall back to dashes instead of crashing or leaving a blank
    // cell -- same regression class the card view's Sparse Data Batter
    // fixture already guards against.
    const sparseRow = page.locator('#hrp-row-3');
    await expect(sparseRow.locator('.hrpt-signals')).toContainText('😴');
    await expect(sparseRow.locator('td[data-label="Edge"]')).toHaveText('–');
  });

  test('table row expands to a detail panel, and collapses again on a second click', async ({ page }) => {
    await openHRBoard(page);
    await page.click('#hrp-view-table-btn');

    const firstRow = page.locator('.hrpt-row').first();
    const detailRow = page.locator('.hrpt-detail-row').first();
    await expect(detailRow).toBeHidden();

    await firstRow.click();
    await expect(detailRow).toBeVisible();
    await expect(detailRow.locator('.hrpt-why')).not.toBeEmpty();

    await firstRow.click();
    await expect(detailRow).toBeHidden();
  });

  test('"Full Matchup" button in an expanded table row opens the matchup modal', async ({ page }) => {
    await openHRBoard(page);
    await page.click('#hrp-view-table-btn');
    await page.locator('.hrpt-row').first().click();

    const openFullBtn = page.locator('.hrpt-detail-row').first().locator('.hrpt-open-full');
    await expect(openFullBtn).toBeVisible();
    // force:true -- Playwright's actionability wait flakes here on the
    // row's own dr-anim-in mount animation despite disableMotion(), even
    // though the button is genuinely clickable (manually verified via
    // direct DOM inspection: openMatchup fires and #mu-modal-overlay flips
    // to display:flex). The assertion below is the real check.
    await openFullBtn.click({ force: true });
    await expect(page.locator('#mu-modal-overlay')).toBeVisible();
  });
});

test.describe('RBI board (representative of the shared hits/rbi/tb/sb/hrrbi card hierarchy)', () => {
  test('card list renders primary chips + full-breakdown disclosure', async ({ page }) => {
    await openPropBoard(page, 'rbis', BOARD_ROWS);
    await expect(page.locator('#rbis-props-content')).toHaveScreenshot('rbi-board.png');
  });
});

test.describe('Filter bar scroll-fade hint', () => {
  test('fade shows when scrolled to start, hides at the end', async ({ page }) => {
    await openHRBoard(page);
    const row = page.locator('#gamepick-pane-hr .dr-filter-row').first();

    await expect(row).toHaveScreenshot('filter-fade-at-start.png');

    await row.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
      el.dispatchEvent(new Event('scroll'));
    });
    await expect(row).toHaveScreenshot('filter-fade-at-end.png');
  });
});
