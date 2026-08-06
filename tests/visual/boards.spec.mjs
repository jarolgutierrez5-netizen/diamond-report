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
