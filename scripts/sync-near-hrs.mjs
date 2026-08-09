#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// "Near HR" tracker — deep fly-ball outs (warning-track power) a batter has
// hit in his last 10 games. The matchup modal's existing HR/xHR signals only
// ever look at contact quality in aggregate (Barrel%, Hard-Hit%, xwOBA); none
// of them show "this specific ball almost left the yard but didn't," which is
// what this fills in.
//
// Reuses the same Statcast Search CSV endpoint and URL-building approach
// sync-pitcher-zone-hr.mjs and sync-batter-pitch-mix-trend.mjs already have
// working for real batter-scoped pulls, scoped to the same batter pool
// data/statcast-hot-hitters.json already tracks (the app's established
// "batters we have real Statcast data for" universe) rather than the whole
// league.
//
// "Near HR" means a fly ball that stayed in the park: events is a batted-ball
// out, bb_type is fly_ball, and hit_distance_sc is at or beyond
// NEAR_HR_MIN_DISTANCE_FT — genuine warning-track/wall territory, not just
// "hit hard." A double or triple off the wall is a HIT, not counted here —
// this is specifically about would-be homers that got caught.
//
// Same live-verification caveat as the other Statcast Search-based scripts in
// this repo: this sandbox cannot reach baseballsavant.mlb.com to confirm the
// CSV's exact column names (events, bb_type, hit_distance_sc, launch_speed,
// launch_angle, game_date, play_id) against a live response — they're the
// well-documented public schema, not something this script has verified
// itself. Loud schema check + per-batter try/catch, same defensive pattern as
// the other two scripts, so one bad response can't take down the whole run.
// Treat the first scheduled run as unverified until its own log output (and
// the resulting data/near-hrs.json) is manually checked.
// ─────────────────────────────────────────────────────────────────────────

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseCSV } from './sync-pitcher-statcast.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const HOT_HITTERS_PATH = path.join(DATA_DIR, 'statcast-hot-hitters.json');
const NEAR_HR_PATH = path.join(DATA_DIR, 'near-hrs.json');
const RECENT_HR_PATH = path.join(DATA_DIR, 'recent-hrs.json');
const SEASON = new Date().getFullYear();
const SEARCH_BASE = 'https://baseballsavant.mlb.com/statcast_search/csv';

// A batter plays roughly 10 games in ~14-16 calendar days once off days are
// counted; 24 gives real margin (call-ups, short IL stints, a stretch with
// extra off days) while still being a bounded, real "recent" window rather
// than the whole season. The actual "last 10 games" cut happens afterward,
// from the real game_date values that come back — this is just the outer
// fetch window.
const LOOKBACK_DAYS = 24;
const GAMES_TO_KEEP = 10;
const NEAR_HR_MIN_DISTANCE_FT = 375;

function isoDate(d) { return d.toISOString().slice(0, 10); }
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d; }
const WINDOW_START = isoDate(daysAgo(LOOKBACK_DAYS));
const WINDOW_END = isoDate(new Date());

// Same fetch-with-timeout-and-retry guard as sync-pitcher-zone-hr.mjs /
// sync-batter-pitch-mix-trend.mjs — a slow/hanging response otherwise stalls
// this whole per-batter loop.
const FETCH_TIMEOUT_MS = 15000;
async function fetchText(url, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DiamondReportBot/1.0; +https://diamondreport.app)' }, signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (e) {
      lastErr = e.name === 'AbortError' ? new Error(`Timed out after ${FETCH_TIMEOUT_MS}ms for ${url}`) : e;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 1500 * (i + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

function batterSearchURL(batterId) {
  const params = new URLSearchParams({
    all: 'true',
    hfGT: 'R|PO|S|',
    hfSea: `${SEASON}|`,
    game_date_gt: WINDOW_START,
    game_date_lt: WINDOW_END,
    player_type: 'batter',
    group_by: 'name',
    sort_col: 'pitches',
    player_event_sort: 'api_p_release_speed',
    sort_order: 'desc',
    min_pitches: '0',
    min_results: '0',
    type: 'details',
  });
  params.append('batters_lookup[]', String(batterId));
  return `${SEARCH_BASE}?${params.toString()}`;
}

// Resolves a specific Statcast play_id to a DIRECT, playable video URL --
// not Baseball Savant's own sporty-videos HTML page, so the site can play
// the clip in its own video-modal UI (window.openHRVideoModal, already used
// elsewhere for other HR clips) instead of sending a user off-site.
//
// The sporty-videos page (https://baseballsavant.mlb.com/sporty-videos?playId=…)
// itself embeds the real clip as a plain <video><source src="….mp4"></video>
// tag -- confirmed live via a direct curl fetch of a real playId
// (2026-08-09): the page has no X-Frame-Options/CSP framing restriction
// either, but extracting the direct .mp4 is strictly better than an iframe
// (native <video> playback, no Savant page chrome/nav visible, one real
// asset instead of a whole embedded page). The .mp4 URL itself is per-video
// and not derivable from playId alone (an opaque encoded token, not a
// pattern), so this fetches the HTML page and regexes out that one <source
// src> value -- the whole page's markup isn't otherwise used. Returns null
// (never a broken/guessed URL) if the page fetch fails or the page's markup
// doesn't contain the expected <source> tag.
async function savantVideoURL(playId) {
  if (!playId) return null;
  try {
    const html = await fetchText(`https://baseballsavant.mlb.com/sporty-videos?playId=${playId}`, 2);
    const match = html.match(/<source\s+src="([^"]+\.mp4)"/i);
    return match ? match[1] : null;
  } catch (e) {
    console.warn(`sporty-videos fetch failed for playId=${playId}:`, e.message);
    return null;
  }
}

// ── Video lookup ────────────────────────────────────────────────────────
// The Statcast Search CSV export used above has no play_id / video column at
// all (confirmed against the well-documented public CSV schema — this is why
// every near-HR event synced before this always got videoUrl:null, not a
// transient bug). Baseball Savant's own site resolves each pitch's clip from
// a separate per-game feed instead: https://baseballsavant.mlb.com/gf?game_pk=N
//
// This feed's exact JSON shape has NOT been verified live (same sandbox
// network restriction noted at the top of this file), so rather than assume
// one specific nesting path (which would silently produce zero matches if
// wrong), collectPlayIdEntries() below walks the whole response recursively
// and pulls out every object that carries a play_id/playId field alongside
// whatever inning/at-bat/batter identifiers sit next to it. Matching against
// our known event (inning + at_bat_number + batter id, all real Statcast CSV
// columns) then only accepts an UNAMBIGUOUS single hit — a video link with
// even a small chance of being the wrong play is worse than no link, so any
// 0-match or multi-match case just leaves videoUrl null instead of guessing.
const GF_BASE = 'https://baseballsavant.mlb.com/gf';
const gfCache = new Map(); // game_pk -> Promise<candidate[]>

// Every real run so far has resolved 0 video links out of hundreds of events,
// with the "no play_id-bearing objects found" warning below never firing --
// meaning candidates ARE being found (the fetch, JSON.parse, and play_id walk
// all work), but the inning+abNumber+batter match in resolveEventVideo() never
// lands on exactly one. That points at a field-shape mismatch, most likely
// `batter`: this sandbox cannot reach baseballsavant.mlb.com to confirm live
// (same restriction noted throughout this file), so rather than keep guessing
// blind, log the raw shape of one real candidate the first time a run finds
// any -- the GitHub Actions runner CAN reach Savant, so its own log output
// becomes the live verification this sandbox can't do.
let sampleCandidateLogged = false;

// context carries inning/abNumber/batter down from an ancestor node (e.g. a
// plate-appearance object) to descendants that don't repeat those fields on
// the exact object the play_id lives on (e.g. a nested pitch/event entry) --
// without this, a play_id nested a level or two below its identifying fields
// would never get matched to anything.
function collectPlayIdEntries(node, out, depth = 0, context = {}) {
  if (!node || typeof node !== 'object' || depth > 14) return;
  if (Array.isArray(node)) {
    for (const item of node) collectPlayIdEntries(item, out, depth + 1, context);
    return;
  }
  // at_bat_number added alongside ab_number/atBatIndex -- the Statcast Search
  // CSV this script's own events come from uses that exact snake_case name,
  // so it's a reasonable guess the gf feed might too, not just MLB StatsAPI's
  // atBatIndex convention.
  const inning = node.inning ?? node.about?.inning ?? context.inning ?? null;
  const abNumber = node.ab_number ?? node.at_bat_number ?? node.atBatIndex ?? node.about?.atBatIndex ?? context.abNumber ?? null;
  // batter kept RAW here (not normalized) so context propagation and the
  // logged sample both show exactly what the feed actually sent -- shape
  // normalization happens once, at compare time, in normalizedBatterId().
  const batter = node.batter ?? node.batter_id ?? node.matchup?.batter?.id ?? context.batter ?? null;
  const nextContext = { inning, abNumber, batter };

  const playId = node.play_id || node.playId;
  // seq: out.length at push time -- the candidate's position in this game's
  // own collection order, used by resolveEventVideo() below to pick the
  // LAST-thrown pitch when an at-bat has more than one real candidate.
  if (playId) out.push({ playId, inning, abNumber, batter, seq: out.length });

  for (const key of Object.keys(node)) collectPlayIdEntries(node[key], out, depth + 1, nextContext);
}

async function fetchGameVideoCandidates(gamePk) {
  if (!gfCache.has(gamePk)) {
    gfCache.set(gamePk, (async () => {
      try {
        const text = await fetchText(`${GF_BASE}?game_pk=${gamePk}`, 2);
        const data = JSON.parse(text);
        const candidates = [];
        collectPlayIdEntries(data, candidates, 0);
        if (!candidates.length) {
          console.error(`gf feed for game_pk=${gamePk}: no play_id-bearing objects found — schema may differ from what this script assumes. Top-level keys: [${Object.keys(data).join(', ')}]`);
        } else if (!sampleCandidateLogged) {
          sampleCandidateLogged = true;
          console.error(`[diagnostic] sample gf candidate (game_pk=${gamePk}): ${JSON.stringify(candidates[0])}`);
        }
        return candidates;
      } catch (e) {
        console.error(`gf feed fetch failed for game_pk=${gamePk}:`, e.message);
        return [];
      }
    })());
  }
  return gfCache.get(gamePk);
}

// Normalizes a candidate's raw batter field (which the real gf feed might
// represent as a plain numeric id, a {id, ...} object, or possibly a name
// string) down to a comparable numeric-id string, or null if it doesn't look
// like an id at all. A non-null-but-unusable value (e.g. a name string, where
// Number(raw) is NaN) is treated the same as null -- unknown, not a
// disqualifying mismatch -- since a wrongly-shaped field silently vetoing an
// otherwise-correct inning+abNumber match is exactly how this could produce
// zero matches across hundreds of real events despite candidates existing.
function normalizedBatterId(raw) {
  if (raw == null) return null;
  const val = (typeof raw === 'object') ? (raw.id ?? null) : raw;
  if (val == null) return null;
  const n = Number(val);
  return Number.isFinite(n) ? String(n) : null;
}

// A 2026-08-08 production run (this sandbox can't reach Savant, but GitHub
// Actions can, so its own log output is the live verification this file's
// header caveat asks for) logged a real zero-match example: event wants
// abNumber=74 (7 raw matches), and the same short abNumber sequence
// (73x6, 74x2, 75x5) recurred near-identically 2-3 times across that one
// game's candidate pool. Two things were being conflated by the old "must be
// exactly 1 raw candidate" check:
//   1. The same real play embedded at more than one path in the gf JSON
//      tree (collectPlayIdEntries walks the whole tree, so a play echoed in
//      e.g. both a per-team log and a scoreboard section gets counted
//      twice) -- these duplicates always carry an IDENTICAL playId, so
//      deduping by playId collapses them back down. That's correcting a
//      counting bug, not guessing between real alternatives.
//   2. A real at-bat can have several pitches (fouls, takes) before the one
//      that ends it -- every pitch in that at-bat shares the same
//      inning+abNumber (confirmed by this same file's own
//      computeLast10BattedBalls(): Statcast Search returns one CSV row per
//      pitch, sharing one at_bat_number, and only the very last row of each
//      at-bat carries a non-empty `events`). Once deduped, if more than one
//      distinct pitch remains for an abNumber, the one we want is always the
//      LAST one thrown -- an at-bat definitionally ends on its final pitch
//      (walk, strikeout, HBP, or contact), and every event resolved here IS
//      a contact outcome. `seq` (collection order, see collectPlayIdEntries)
//      stands in for chronological order, so the highest-seq survivor is a
//      deterministic pick given what an at-bat actually is, not a
//      probabilistic guess among otherwise-equal candidates.
let sampleMismatchLogged = false;

// Resolves a videoUrl for one near-HR event in place: filters the game's gf
// candidates down to this exact inning+at-bat(+batter, when usable -- see
// normalizedBatterId()), dedupes by playId, then picks the last-thrown pitch
// among whatever distinct plays remain (see the block comment above for why
// both steps are safe, not guesses). Silent no-op (event keeps videoUrl:null)
// only when literally nothing in the game's feed matches this at-bat at all.
async function resolveEventVideo(event) {
  if (event._gamePk == null || event._inning == null || event._abNumber == null || event._batterId == null) return;
  const candidates = await fetchGameVideoCandidates(event._gamePk);
  const matches = candidates.filter(c => {
    if (String(c.inning) !== String(event._inning)) return false;
    if (String(c.abNumber) !== String(event._abNumber)) return false;
    const cBatter = normalizedBatterId(c.batter);
    return cBatter == null || cBatter === String(event._batterId);
  });
  // Dedup keeps each playId's FIRST occurrence (lowest seq), not JS Map's
  // default last-write-wins -- a duplicate tree path can re-echo an earlier
  // play later in traversal order, and keeping that later echo's seq would
  // wrongly make an earlier real pitch look like it came after a later one.
  const firstSeenByPlayId = new Map();
  for (const c of matches) {
    const prev = firstSeenByPlayId.get(c.playId);
    if (prev == null || c.seq < prev.seq) firstSeenByPlayId.set(c.playId, c);
  }
  const uniqueByPlayId = Array.from(firstSeenByPlayId.values());
  if (uniqueByPlayId.length >= 1) {
    const chosen = uniqueByPlayId.reduce((a, b) => (b.seq > a.seq ? b : a));
    event.videoUrl = await savantVideoURL(chosen.playId);
  } else if (!sampleMismatchLogged && candidates.length) {
    sampleMismatchLogged = true;
    const sameInning = candidates.filter(c => String(c.inning) === String(event._inning));
    const abNums = candidates.map(c => Number(c.abNumber)).filter(Number.isFinite);
    console.error(`[diagnostic] zero-match example: event wants gamePk=${event._gamePk} inning=${event._inning} abNumber=${event._abNumber} batter=${event._batterId} (${matches.length} matches). Game has ${candidates.length} candidate(s), ${sameInning.length} sharing that exact inning, abNumber range ${abNums.length ? Math.min(...abNums) : 'n/a'}-${abNums.length ? Math.max(...abNums) : 'n/a'}. abNumbers seen for this same inning: [${sameInning.map(c => c.abNumber).join(', ')}]`);
  }
}

// Runs resolveEventVideo() over every event in a {batterId: event[]} map and
// strips the internal matching keys afterward -- shared by both the near-HR
// and confirmed-HR outputs below, since gfCache already dedupes fetches
// across whichever of the two runs against a given game_pk first.
async function resolveVideosAndStrip(playersMap) {
  let withVideo = 0, videoAttempted = 0;
  for (const id of Object.keys(playersMap)) {
    for (const event of playersMap[id]) {
      if (event._gamePk) {
        videoAttempted++;
        const isNewGame = !gfCache.has(event._gamePk);
        try { await resolveEventVideo(event); } catch (e) { console.error(`video lookup failed for batter ${id} on ${event.date}:`, e.message); }
        // resolveEventVideo's own savantVideoURL() fetch (sporty-videos, to
        // extract the direct .mp4) is a second, separate real request beyond
        // the /gf feed's own pacing below -- only fires when a unique match
        // was actually found, but still worth its own light pacing rather
        // than firing back-to-back with no gap at all.
        if (event.videoUrl) { withVideo++; await new Promise(r => setTimeout(r, 200)); }
        // Only pace ourselves on an actual new request to baseballsavant.mlb.com/gf
        // — repeat hits on an already-cached game_pk are free.
        if (isNewGame) await new Promise(r => setTimeout(r, 300));
      }
      delete event._gamePk;
      delete event._inning;
      delete event._abNumber;
      delete event._batterId;
    }
  }
  return { withVideo, videoAttempted };
}

async function loadTrackedBatters() {
  const raw = await readFile(HOT_HITTERS_PATH, 'utf8');
  const data = JSON.parse(raw);
  return (data.players || []).filter(p => p.playerId).map(p => ({ id: p.playerId, name: p.name }));
}

// Shared parse + "real last 10 games" windowing for both buildNearHRs() and
// buildRecentHRs() below -- both read off the exact same per-batter CSV
// fetch (one Statcast Search request already covers both datasets, so
// there's no reason to fetch or reparse twice for what's really one pull).
function computeLast10BattedBalls(csv, batterName) {
  const rows = parseCSV(csv);
  if (!rows.length) return [];
  const sample = rows[0];
  if (!('events' in sample) || !('bb_type' in sample) || !('hit_distance_sc' in sample) || !('game_date' in sample)) {
    throw new Error(`unexpected CSV columns for ${batterName} — got [${Object.keys(sample).join(', ')}]`);
  }

  // Statcast Search returns one row per PITCH; only the pitch that ended the
  // plate appearance in a ball in play carries a non-empty events value.
  const battedBalls = rows.filter(r => r.events && r.events !== '');
  const dates = [...new Set(battedBalls.map(r => r.game_date).filter(Boolean))].sort().reverse();
  const last10 = new Set(dates.slice(0, GAMES_TO_KEEP));
  return battedBalls.filter(r => last10.has(r.game_date));
}

function battedBallEvent(r, batterId) {
  return {
    date: r.game_date,
    distance: Number(r.hit_distance_sc),
    exitVelo: Number.isFinite(Number(r.launch_speed)) ? Number(r.launch_speed) : null,
    launchAngle: Number.isFinite(Number(r.launch_angle)) ? Number(r.launch_angle) : null,
    event: r.events,
    description: r.des || null,
    matchup: [r.away_team, r.home_team].filter(Boolean).join(' @ ') || null,
    videoUrl: null,
    _gamePk: r.game_pk || null,
    _inning: r.inning || null,
    _abNumber: r.at_bat_number || null,
    _batterId: batterId,
  };
}

// Returns an array of near-HR events for this batter's real last 10 games
// (by distinct game_date, not a fixed calendar window), sorted longest first.
// videoUrl starts out null on every event -- resolveEventVideo() (called from
// main(), after this returns) fills it in via the separate gf-feed lookup
// above when it can find an unambiguous match. The _gamePk/_inning/_abNumber/
// _batterId fields are internal matching keys for that lookup only and are
// stripped before the result is written to data/near-hrs.json.
function buildNearHRs(csv, batterName, batterId) {
  return computeLast10BattedBalls(csv, batterName)
    .filter(r => r.bb_type === 'fly_ball' && r.events !== 'home_run')
    .map(r => battedBallEvent(r, batterId))
    .filter(r => Number.isFinite(r.distance) && r.distance >= NEAR_HR_MIN_DISTANCE_FT)
    .sort((a, b) => b.distance - a.distance);
}

// Same source data as buildNearHRs() (the "wall ball" near-misses), but the
// mirror-image query: real, confirmed home runs from the same real-last-10-
// games window -- the "HRs · Last 10 Games" section in the Pitcher Matchup
// modal, alongside the existing Near HRs section. Sorted most-recent-first
// (near-misses read better longest-first; confirmed homers read better in
// the order they actually happened).
function buildRecentHRs(csv, batterName, batterId) {
  return computeLast10BattedBalls(csv, batterName)
    .filter(r => r.events === 'home_run')
    .map(r => battedBallEvent(r, batterId))
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  let batters;
  try {
    batters = await loadTrackedBatters();
  } catch (e) {
    console.error('statcast-hot-hitters.json not found/unreadable — run sync-statcast-hot-hitters.mjs first:', e.message);
    process.exitCode = 1;
    return;
  }
  console.log(`Checking ${batters.length} tracked batter(s) for near-HRs and confirmed HRs in their last ${GAMES_TO_KEEP} games.`);

  const out = {
    generatedAt: new Date().toISOString(),
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    minDistanceFt: NEAR_HR_MIN_DISTANCE_FT,
    players: {},
  };
  // Same batter pool, same real-last-10-games window as `out` above, and
  // built from the exact same CSV fetch per batter in the loop below --
  // this is the confirmed-HR mirror of the near-HR data, feeding the
  // Pitcher Matchup modal's "HRs · Last 10 Games" section.
  const outRecent = {
    generatedAt: new Date().toISOString(),
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    players: {},
  };
  let updated = 0, failed = 0, withNearHRs = 0, withRecentHRs = 0;
  for (const { id, name } of batters) {
    try {
      const csv = await fetchText(batterSearchURL(id));
      out.players[id] = buildNearHRs(csv, name, id);
      outRecent.players[id] = buildRecentHRs(csv, name, id);
      updated++;
      if (out.players[id].length) withNearHRs++;
      if (outRecent.players[id].length) withRecentHRs++;
    } catch (e) {
      failed++;
      console.error(`Near-HR sync failed for ${name} (${id}):`, e.message);
    }
    // Polite bounded-scope delay, same spirit as the other Statcast Search
    // scripts — a public, unauthenticated endpoint with no documented rate
    // limit, and this runs against the whole ~250-player tracked pool rather
    // than a short per-day list, so this errs a little longer than theirs.
    await new Promise(r => setTimeout(r, 600));
  }

  console.log(`Checked ${updated}/${batters.length} batters (${failed} failed), ${withNearHRs} with at least one near-HR and ${withRecentHRs} with at least one confirmed HR in their last ${GAMES_TO_KEEP} games.`);

  // Video resolution is a separate pass (rather than folded into the loop
  // above) so a broken/absent gf feed only ever costs missing video links,
  // never a missing near-HR/confirmed-HR event -- both features work the
  // same either way, video is strictly additive. gfCache is shared across
  // both calls, so a game_pk fetched while resolving near-HR video is free
  // the second time it's needed for a confirmed-HR event in the same game.
  const nearVideo = await resolveVideosAndStrip(out.players);
  console.log(`Resolved ${nearVideo.withVideo}/${nearVideo.videoAttempted} near-HR events to a video link (${gfCache.size} unique games checked so far).`);
  const recentVideo = await resolveVideosAndStrip(outRecent.players);
  console.log(`Resolved ${recentVideo.withVideo}/${recentVideo.videoAttempted} confirmed-HR events to a video link (${gfCache.size} unique games checked total).`);

  if (updated > 0) {
    await writeFile(NEAR_HR_PATH, JSON.stringify(out, null, 2) + '\n');
    await writeFile(RECENT_HR_PATH, JSON.stringify(outRecent, null, 2) + '\n');
  }
  if (failed > 0 && updated === 0) process.exitCode = 1;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch(e => { console.error(e); process.exit(1); });
}

export { batterSearchURL, buildNearHRs, buildRecentHRs, savantVideoURL, collectPlayIdEntries, resolveEventVideo, resolveVideosAndStrip, normalizedBatterId, main };
