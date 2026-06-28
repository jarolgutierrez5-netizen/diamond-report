# CLAUDE.md

Guidance for Claude Code (and other AI assistants) working in this repository.

## What this repo is

**Diamond Report** is a single-file, client-side MLB analytics dashboard. There is
no build system, no package manager, no server code, and no test suite — the
entire application is one static HTML file that runs directly in a browser and
fetches live data from the public MLB Stats API.

```
.
├── README.md            # one-line project name, nothing else
└── mlb_dashboard_23.html  # the entire application: markup + CSS + JS
```

There is no `package.json`, no `node_modules`, no config files, and no CI. Treat
this as a vanilla HTML/CSS/JS project — don't introduce a framework, bundler, or
package manager unless the user explicitly asks for one.

## Running / previewing it

Just open the file in a browser — no server or install step is required:

```bash
# any of these work
xdg-open mlb_dashboard_23.html
python3 -m http.server 8000   # then visit http://localhost:8000/mlb_dashboard_23.html
```

Opening it via `file://` works too since all data comes from `fetch()` calls to
the public `statsapi.mlb.com` API (CORS-enabled, no API key required). There is
no localhost-only API — if fetches fail when testing, it's almost always a CORS
or network issue, not a missing backend.

## Structure of `mlb_dashboard_23.html`

The file is organized top-to-bottom as `<style>` → `<body>` markup → `<script>`.
Everything lives in this one file; there are no `<link>`/`<script src>` includes
beyond Google Fonts.

### CSS (`<style>`, lines ~9–191)
- CSS custom properties under `:root` define the whole color palette
  (`--bg`, `--surface`, `--accent`, `--green`, `--live`, etc.). Reuse these
  variables for any new UI instead of hardcoding colors.
- Dark theme throughout. Fonts: `Bebas Neue` (headers/scores), `Inter` (body),
  `JetBrains Mono` (numeric/stat data).
- Sections are grouped by feature with comment banners (e.g. `/* Matchup Modal */`,
  `/* Pitch breakdown */`) — follow this pattern when adding new component styles.

### Markup (`<body>`)
Four tab-based sections inside `<main>`, toggled by `showTab()`:
- `#scores` — live/final game cards for today (default active tab)
- `#standings` — AL/NL division standings tables
- `#matchups` — the "Pitcher Report" table (lazy-loaded on first tab click)
- `#schedule` — upcoming games

Plus one modal (`#mu-modal-overlay`) for the Batter vs Pitcher matchup view.

### JavaScript (`<script>`, lines ~256–1090)
All vanilla JS, no modules, no imports — everything is global functions and
top-level `const`/`let`. Roughly in this order:

1. **Standings** — `standings` is a **hardcoded array** of all 30 teams with
   W/L records (lines ~257–288). This is the one piece of static "fake" data in
   the app and goes stale over time. `buildStandings(conf)` derives
   PCT/GB/sorting from it; `showLeague()` swaps between AL/NL.
2. **Live Scores** (`loadScores()`) — fetches today's schedule from
   `statsapi.mlb.com/api/v1/schedule`, buckets games into live/final/upcoming,
   renders via `gameCard()`/`upcomingCard()`. Polls every 30s via `setInterval`.
3. **Pitcher Report** (`loadPitcherReport()`, `renderPRTable()`, `sortPR()`) —
   fetches probable pitchers + season pitching stats, renders a sortable table
   (click column headers). Expandable rows show the opposing team's batting
   lineup (`toggleLineup()` → `fetchAndRenderLineup()` → `renderLineup()`),
   including HR probability estimates and "last 10 games" HR counts. Open
   lineup panels auto-refresh every 60s.
4. **Batter vs Pitcher Matchup Modal** (`openMatchup()`, `renderMatchupModal()`)
   — fetches H2H career stats plus both players' season stats, then renders a
   strike-zone heatmap and pitch-mix breakdown. **Important:** the strike-zone
   grid and pitch-mix percentages are *heuristic/modeled estimates* derived
   from season ERA/SLG/HR9 splits — they are explicitly not real Statcast pitch
   location data (see comments around line ~900). Don't represent this as
   real measured data when modifying it; keep the "estimated" framing in any
   UI text.

### Data sources
All live data comes from the unauthenticated MLB Stats API
(`https://statsapi.mlb.com/api/v1/...`): schedule, boxscore, people (player
stats), team roster, and `vsPlayer` head-to-head splits. No API key, no backend
proxy. Timezone handling is deliberately pinned to `America/Chicago` (see
comment in `loadScores()`) to avoid UTC date-boundary bugs when picking
"today's" games — preserve this when touching date logic.

## Conventions to follow

- **Keep it a single file.** Don't split CSS/JS into separate files or add a
  build step unless explicitly requested — that's a deliberate choice for easy
  hosting/sharing (e.g. as a GitHub Pages page or local file).
- **No frameworks/libraries.** No React, jQuery, lodash, chart libraries, etc.
  All rendering is done via template-literal HTML strings assigned to
  `.innerHTML`. Match this style for new features rather than introducing a
  rendering library.
- **Styling:** use the existing CSS variables and class-naming style (short,
  hyphenated, prefixed by component — e.g. `pr-*` for Pitcher Report, `mu-*`
  for the matchup modal, `h2h-*`, `sz-*` for strike zone). Inline `style=` is
  used liberally for one-off layout inside JS-generated HTML; that's consistent
  with the existing code, not an anti-pattern to "fix".
- **Escaping:** existing code does basic manual escaping of single quotes in
  names passed into `onclick="..."` strings (e.g.
  `name.replace(/'/g,"\\'")`). Follow the same pattern for any new
  user-controlled string interpolated into an inline event handler. Be mindful
  this is not full HTML-escaping — avoid making injection risk worse when
  touching this code (e.g. don't interpolate raw API string fields into
  `innerHTML` without the same guard the surrounding code already applies).
- **Stat formatting helpers** (`f()`, `fI()`, `fv()`, `fi()`, `fmtS()`) follow
  baseball convention of stripping the leading `0` from decimals below 1.000
  (e.g. `.275` not `0.275`). Reuse these helpers rather than reformatting stats
  ad hoc.
- **No tests exist.** There's no test runner to invoke. Verify changes by
  opening the file in a browser and exercising the affected tab/feature
  manually (check the Network tab for the relevant `statsapi.mlb.com` calls).
- The standings array is the only manually-maintained dataset in the file —
  if asked to "update standings," edit the `standings` array directly; don't
  try to wire it up to a live standings endpoint unless asked, since that's an
  intentional design choice already noted in the code.

## Git workflow

- Default branch is `main`. There is no CI configured in this repo (no
  `.github/workflows`), so there are no required checks to satisfy before
  pushing.
- Commit messages in history are short, descriptive, present/imperative tense
  (e.g. "Add files via upload", "Revise README for MLB Analytics Dashboard").
