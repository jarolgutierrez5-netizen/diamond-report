// Visual regression config for the static site's HTML/CSS. Scoped inside
// tests/visual (its own package.json + node_modules, same pattern as
// video/) so the rest of the repo keeps its no-package.json, pinned-npx-only
// build tooling untouched. Run with `npm ci && npx playwright test` from
// this directory (see README.md).
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFileName}/{arg}-{projectName}{ext}',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    trace: 'off',
  },
  expect: {
    // Chromium's own anti-aliasing jitter is real even with animations
    // disabled; 1% tolerates that without masking a genuine layout regression.
    toHaveScreenshot: { maxDiffPixelRatio: 0.01 },
  },
  webServer: {
    command: 'python3 -m http.server 8123',
    cwd: '../..',
    url: 'http://localhost:8123/index.html',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  projects: [
    // Height is generous on purpose: it's not modeling a real device, it
    // just needs to fit every locator screenshot in one viewport capture.
    // A locator taller than the viewport forces Playwright to stitch
    // together multiple scrolled captures, and any position:sticky/fixed
    // ancestor (this stylesheet has several -- header, nav, tab bar, filter
    // row) re-renders at its stuck position in every one of those captures,
    // showing up as a duplicate translucent bar floating mid-screenshot.
    // Width is what's under test at each breakpoint; height just needs
    // enough headroom to sidestep stitching altogether.
    { name: 'mobile-390', use: { viewport: { width: 390, height: 3200 }, baseURL: 'http://localhost:8123' } },
    { name: 'tablet-768', use: { viewport: { width: 768, height: 3200 }, baseURL: 'http://localhost:8123' } },
    { name: 'desktop-1280', use: { viewport: { width: 1280, height: 3200 }, baseURL: 'http://localhost:8123' } },
    { name: 'desktop-1440', use: { viewport: { width: 1440, height: 3200 }, baseURL: 'http://localhost:8123' } },
  ],
});
