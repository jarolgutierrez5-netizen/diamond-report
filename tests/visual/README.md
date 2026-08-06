# Visual regression tests

Screenshot tests for the shared card/filter components (HR Threats, the
prop-board card hierarchy it was extended to, and the filter bar), run at four
breakpoints: 390px (mobile), 768px (tablet), 1280px and 1440px (desktop).
Renders against synthetic `window.hrpRows` data (same seeding pattern used
throughout manual QA on this project) so results never depend on live game
data or network access -- every request that isn't to `localhost:8123` is
aborted, so the run is identical here and in CI regardless of real internet
access.

This directory has its own `package.json`/`node_modules` (gitignored) --
same scoped pattern as `video/`. The rest of the repo intentionally has no
root `package.json` (see `.github/workflows/build-assets.yml`); Playwright
needs real `node_modules` resolution for `@playwright/test` imports in
config/spec files, unlike the single-shot `npx terser`/`npx csso` CLI calls
used elsewhere, so it's scoped here rather than adopted repo-wide.

## Running locally

```
cd tests/visual
npm ci
npx playwright test              # run against the committed baselines
npx playwright test --update-snapshots   # after an intentional visual change
```

`npm ci` needs `node_modules/playwright-core/.local-browsers` (or the
`PLAYWRIGHT_BROWSERS_PATH` env var) to point at a Chromium matching this
project's pinned `@playwright/test` version (see `package.json`) -- run
`npx playwright install chromium` once if `browserType.launch` fails with
"Executable doesn't exist".

The dev server (`python3 -m http.server 8123` from the repo root) is started
automatically by `playwright.config.mjs` and reused if already running.

## Why viewport height is 3200px

It isn't modeling a real device -- width is what's under test at each
breakpoint. A `locator.screenshot()` taller than the viewport forces
Playwright to stitch together multiple scrolled captures, and this
stylesheet has several `position: sticky` ancestors (header, nav, tab bar,
filter row); each re-renders at its stuck position in every stitched
capture, showing up as a duplicate translucent bar floating mid-screenshot.
A tall viewport avoids the stitching path entirely instead of fighting it.

## Updating baselines

Screenshots live in `__screenshots__/`. When a change is an intentional
visual update (not a regression), regenerate and review the diff as you
would any other file:

```
npx playwright test --update-snapshots
git diff --stat tests/visual/__screenshots__
```
