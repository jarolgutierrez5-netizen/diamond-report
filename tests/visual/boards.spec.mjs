import { test, expect } from '@playwright/test';
import { openHRBoard, openPropBoard, openWNBAPropBoard, BOARD_ROWS } from './lib/fixtures.mjs';

test.describe('HR Threats board', () => {
  // The dense table's mobile collapse (stacked label:value rows) read worse
  // than the original card layout on an actual phone, so the split is now
  // viewport-driven: cards at <=768px (renderHRPTableV1032's own
  // window.innerWidth check, same 768px breakpoint the table's CSS already
  // used for its now-unused mobile collapse), table above that. No more
  // Cards/Table toggle -- there's nothing to switch, the board picks for you.
  test('filter bar renders (closed)', async ({ page }) => {
    await openHRBoard(page);
    await expect(page.locator('#gamepick-pane-hr .dr-filter-row').first()).toHaveScreenshot('hr-filter-row.png');
  });

  test('renders cards, not the table, at mobile/tablet widths', async ({ page }) => {
    test.skip(page.viewportSize().width > 768, 'card view only applies at <=768px; covered by the table tests above that width');
    await openHRBoard(page);
    await expect(page.locator('#hr-potential-content .dr1027-hr-card-list')).toBeVisible();
    await expect(page.locator('#hr-potential-content .hrpt-table')).toHaveCount(0);
  });

  test('desktop: table renders by default with sortable heat cells, renamed columns, and no confidence badge', async ({ page }) => {
    test.skip(page.viewportSize().width <= 768, 'table view is desktop-only; mobile/tablet render cards instead');
    await openHRBoard(page);
    // HR% runs a JS count-up (animateCountUp) independent of the fixture's
    // CSS-only disableMotion() -- give it time to land on its final value
    // before the screenshot instead of racing mid-animation.
    await page.waitForTimeout(700);
    await expect(page.locator('#hr-potential-content .hrpt-table')).toHaveScreenshot('hr-table-view.png');

    // .hrpt-table thead th is text-transform:uppercase, so compare
    // case-insensitively -- allInnerTexts() reflects the rendered (all-caps)
    // text, not the mixed-case text authored in HRPT_COLS.
    const headers = (await page.locator('.hrpt-table thead th').allInnerTexts()).map(h => h.toLowerCase());
    expect(headers.some(h => h.startsWith('pitch mix'))).toBe(true);
    expect(headers.some(h => h.startsWith('hr l10'))).toBe(true);
    expect(headers.some(h => h.startsWith('avg'))).toBe(true);
    expect(headers.some(h => h.startsWith('lineup'))).toBe(false);
    expect(headers.some(h => h.startsWith('pitcher'))).toBe(true);
    await expect(page.locator('#hrp-row-1 .hrpt-pitcher-name')).toHaveText('Weak Pitcher');
    expect(headers.some(h => h.startsWith('overlap'))).toBe(true);

    // The "○ Preliminary" confidence badge no longer renders on the HR% cell.
    await expect(page.locator('.dr-hrp-confidence-slot')).toHaveCount(0);

    // Sparse/null-data row (id 3, battingOrder 9) must render its Sleeper
    // signal and fall back to dashes instead of crashing or leaving a blank
    // cell -- same regression class the card view's Sparse Data Batter
    // fixture originally guarded against.
    const sparseRow = page.locator('#hrp-row-3');
    await expect(sparseRow.locator('.hrpt-signals')).toContainText('😴');
    await expect(sparseRow.locator('td[data-label="Edge"]')).toHaveText('–');

    // hrpOverlapPitches reads the module-scoped pitcherStatcast/
    // batterPitchTypeSeason `let` bindings directly (they're not window
    // properties, so this fixture can't seed real chip content the way
    // pitchMixFavorable already ships as a static field on BOARD_ROWS
    // itself) -- so the only thing verifiable here is the graceful-empty
    // path. hrpOverlapPitches's own threshold logic (reused verbatim from
    // isFavorableMatchupRow/normalizePitchTypeKey) is covered by an
    // isolated unit check instead, not a browser fixture.
    await expect(sparseRow.locator('.hrpt-overlap-cell')).toHaveText('–');
  });

  test('desktop: table row expands to a detail panel, and collapses again on a second click', async ({ page }) => {
    test.skip(page.viewportSize().width <= 768, 'table view is desktop-only; mobile/tablet render cards instead');
    await openHRBoard(page);

    const firstRow = page.locator('.hrpt-row').first();
    const detailRow = page.locator('.hrpt-detail-row').first();
    await expect(detailRow).toBeHidden();

    await firstRow.click();
    await expect(detailRow).toBeVisible();
    await expect(detailRow.locator('.hrpt-why')).not.toBeEmpty();

    await firstRow.click();
    await expect(detailRow).toBeHidden();
  });

  test('desktop: "Full Matchup" button in an expanded table row opens the matchup modal', async ({ page }) => {
    test.skip(page.viewportSize().width <= 768, 'table view is desktop-only; mobile/tablet render cards instead');
    await openHRBoard(page);
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

test.describe('WNBA Rebounds board (representative of the WNBA_PROP_BOARDS points/rebounds/assists/threes/pra family)', () => {
  test('card renders the player\'s own real average as the projection headline, real chip row, and summary banner', async ({ page }) => {
    await openWNBAPropBoard(page, 'wnbareb');
    const card = page.locator('#wnba-rebounds-content .dr109-card').first();
    await expect(card.locator('.dr109-score')).toContainText('9.4');
    await expect(card.locator('.dr109-score')).not.toContainText('%');
    await expect(card.locator('.dr109-score small')).toHaveText('Proj Rebounds');
    await expect(card.locator('.dr109-chip', { hasText: 'RPG' })).toContainText('9.4');
    await expect(card.locator('.dr109-chip', { hasText: 'Consistency' })).toBeVisible();
    await expect(card.locator('.dr-watch-star')).toHaveCount(1);
    await expect(page.locator('#wnba-rebounds-content .dr1027-hr-summary')).toContainText('Rotation Starter');
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
