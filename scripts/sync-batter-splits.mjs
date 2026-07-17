#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Merges situational hitting splits (home/away, runners-in-scoring-position) from
// the MLB Stats API into the existing per-player records in
// data/statcast-hot-hitters.json — same file/shape the other batter-data sync
// scripts in this repo already write to and app.js's getStatcastHotHitterProfile()
// already reads from.
//
// Unlike the Baseball Savant leaderboard scripts, there is no whole-league CSV for
// splits — MLB's Stats API only exposes them per player (or per team roster via
// hydration). To keep this bounded rather than one request per player (~700+),
// this pulls the full ACTIVE roster for all 30 teams (~30 requests) using the
// hydrate=person(stats(...)) pattern this app's own client code already uses
// successfully elsewhere (see app.js's many `hydrate=stats(group=hitting,...)`
// calls) with sitCodes added to scope to home/away/RISP splits.
//
// Known limitation: this environment cannot reach statsapi.mlb.com to verify the
// exact shape of a statSplits hydration response live — sitCodes values (h/a for
// home/away, risp for runners in scoring position) are the documented public
// values from community MLB-StatsAPI tooling, not confirmed against a live
// response. The raw split-stat shape for the first player found with any splits
// is always logged (success or not) so a schema mismatch can be fixed from the
// log in one pass rather than guessed blind repeatedly.
//
// Also captures injured/inactive roster status from the same roster response (no
// extra requests) using the identical detection app.js's rowLooksInactive() /
// loadActivePlayerIdsForGames() already use against this same endpoint in
// production. This is real IL/restricted/suspended list status, not a "rest day"
// signal — MLB doesn't publish a machine-readable reason a healthy player isn't in
// today's starting lineup (day off vs platoon vs demotion all look identical from
// this API), so that distinct ask isn't implemented here; a false "resting" label
// on a benched or demoted player would be worse than no label at all.
//
// Also computes a REAL rolling-form trend (recent 14-day AVG/OPS vs season AVG/OPS)
// via the same hydrate call, adding a `type=[byDateRange]` and `type=[season]` stats
// block alongside statSplits — still one request per team, no extra round trips.
// This replaces the Statcast-based trend attempt in sync-statcast-hot-hitters.mjs,
// which was confirmed live to not work (Savant ignores its startDate/endDate params
// on those leaderboards). The MLB Stats API's byDateRange stat type is the same
// hydrate mechanism already proven working elsewhere in this app (see app.js's many
// `hydrate=stats(group=hitting,type=season,...)` calls), just with a date range
// instead of season-long — a reliable source for the general "is he hot right now"
// signal that HR count over the last 10 games (last10HR, computed live client-side
// from game logs) doesn't fully capture on its own.
// ─────────────────────────────────────────────────────────────────────────

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const HOT_HITTERS_PATH = path.join(DATA_DIR, 'statcast-hot-hitters.json');
const SEASON = new Date().getFullYear();
const MLB_API = 'https://statsapi.mlb.com/api/v1';
const RECENT_DAYS = 14;
function isoDate(d) { return d.toISOString().slice(0, 10); }
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d; }
const RECENT_START = isoDate(daysAgo(RECENT_DAYS));
const RECENT_END = isoDate(new Date());

// The combined 3-stats-block hydrate URL (statSplits + byDateRange + season) is a
// much heavier request per team than the single-stat version this started as — a
// live run hung indefinitely on it with no timeout, well past the ~13s the
// single-stat version reliably took for all 30 teams. fetch() has no built-in
// timeout, so one slow/hanging response could stall the entire step (and, since
// this step isn't the last one, the whole workflow run) forever. AbortController
// bounds every request so a bad response degrades to "this team failed, move on"
// instead of a silent hang.
const FETCH_TIMEOUT_MS = 15000;
async function fetchJSON(url, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DiamondReportBot/1.0; +https://diamondreport.app)' }, signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (e) {
      lastErr = e.name === 'AbortError' ? new Error(`Timed out after ${FETCH_TIMEOUT_MS}ms for ${url}`) : e;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

async function activeTeamIds() {
  const d = await fetchJSON(`${MLB_API}/teams?sportId=1&activeStatus=Yes`);
  return (d.teams || []).map(t => t.id).filter(Boolean);
}

function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : null; }

// Best-effort: a split entry's category isn't in a fixed spot across MLB Stats API
// versions — try the common shapes seen in community tooling (sitCode on the split
// itself, or nested under split.code/split.description) before giving up on it.
function splitCode(s) {
  return s?.sitCode || s?.split?.code || s?.split?.description || s?.description || null;
}

let loggedSample = false;

function extractSplits(person) {
  const statGroups = person?.stats || [];
  const splitsGroup = statGroups.find(g => g.type?.displayName === 'statSplits' || g.type?.type === 'statSplits' || Array.isArray(g.splits));
  const splits = splitsGroup?.splits || [];
  if (!loggedSample && splits.length) {
    console.log(`Sample statSplits shape for ${person.fullName || person.id}: ${JSON.stringify(splits[0]).slice(0, 800)}`);
    loggedSample = true;
  }
  const out = {};
  for (const s of splits) {
    const code = String(splitCode(s) || '').toLowerCase();
    const stat = s?.stat;
    if (!stat) continue;
    const avg = num(stat.avg);
    const ops = num(stat.ops);
    if (code === 'h' || code.includes('home')) out.homeAvg = avg, out.homeOps = ops;
    else if (code === 'a' || code.includes('away')) out.awayAvg = avg, out.awayOps = ops;
    else if (code === 'risp' || code.includes('scoring')) out.rispAvg = avg, out.rispOps = ops;
  }
  return out;
}

// Same detection app.js's rowLooksInactive()/loadActivePlayerIdsForGames() already use
// in production against this exact roster endpoint — reusing it here rather than
// inventing a new one keeps "injured/IL" meaning the same thing everywhere in the app.
const INACTIVE_STATUS_RE = /injured|\bil\b|restricted|suspended|bereavement|paternity|inactive|minor/;

let loggedRecentFormSample = false;

// byDateRange/season stat groups (unlike statSplits) carry one stat block, not an
// array keyed by sitCode — same {stat:{...}} shape the app's own hydrate calls
// already parse elsewhere (see app.js: `d.people[0].stats[0].splits[0].stat`).
function extractStatGroup(person, matchType) {
  const statGroups = person?.stats || [];
  const group = statGroups.find(g => g.type?.type === matchType || g.type?.displayName === matchType);
  return group?.splits?.[0]?.stat || null;
}

function extractRecentForm(person) {
  const recent = extractStatGroup(person, 'byDateRange');
  const season = extractStatGroup(person, 'season');
  if (!loggedRecentFormSample && recent) {
    console.log(`Sample byDateRange shape for ${person.fullName || person.id}: ${JSON.stringify(recent).slice(0, 500)}`);
    loggedRecentFormSample = true;
  }
  if (!recent) return {};
  const recentPA = num(recent.plateAppearances) || 0;
  // Too few plate appearances in a 14-day window (injury, part-time role, recent
  // callup) makes AVG/OPS noise, not signal — same reasoning as the min=1 floor
  // sync-statcast-hot-hitters.mjs used for its (broken) Statcast trend attempt.
  if (recentPA < 10) return {};
  const out = { recentAvg: num(recent.avg), recentOps: num(recent.ops) };
  if (season) {
    const seasonAvg = num(season.avg), seasonOps = num(season.ops);
    if (out.recentOps != null && seasonOps != null) out.recentOpsTrend = +(out.recentOps - seasonOps).toFixed(3);
    if (out.recentAvg != null && seasonAvg != null) out.recentAvgTrend = +(out.recentAvg - seasonAvg).toFixed(3);
  }
  return out;
}

async function buildSplitsForTeam(teamId) {
  const url = `${MLB_API}/teams/${teamId}/roster?rosterType=active&hydrate=person(stats(group=[hitting],type=[statSplits],sitCodes=[h,a,risp],season=${SEASON}),stats(group=[hitting],type=[byDateRange],startDate=${RECENT_START},endDate=${RECENT_END}),stats(group=[hitting],type=[season],season=${SEASON}))`;
  const d = await fetchJSON(url);
  const out = {};
  for (const entry of d.roster || []) {
    const person = entry.person;
    if (!person?.id) continue;
    const splits = extractSplits(person);
    Object.assign(splits, extractRecentForm(person));
    const statusText = String(entry.status?.description || entry.status?.code || '');
    if (statusText && INACTIVE_STATUS_RE.test(statusText.toLowerCase())) {
      splits.rosterStatus = statusText;
    }
    if (Object.keys(splits).length) out[String(person.id)] = splits;
  }
  return out;
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  let hotHitters;
  try {
    hotHitters = JSON.parse(await readFile(HOT_HITTERS_PATH, 'utf8'));
  } catch (e) {
    console.error('statcast-hot-hitters.json not found or unreadable — run sync-statcast-hot-hitters.mjs first. ' + e.message);
    process.exitCode = 1;
    return;
  }
  if (!Array.isArray(hotHitters.players)) {
    console.error('statcast-hot-hitters.json has no players array — nothing to merge onto.');
    process.exitCode = 1;
    return;
  }

  let teamIds;
  try {
    teamIds = await activeTeamIds();
  } catch (e) {
    console.error('Failed to fetch active team list:', e.message);
    process.exitCode = 1;
    return;
  }
  console.log(`Found ${teamIds.length} active MLB teams.`);

  const allSplits = {};
  let teamFailures = 0;
  for (const teamId of teamIds) {
    try {
      const splits = await buildSplitsForTeam(teamId);
      Object.assign(allSplits, splits);
    } catch (e) {
      teamFailures++;
      console.warn(`Splits sync failed for team ${teamId}:`, e.message);
    }
    await new Promise(r => setTimeout(r, 300));
  }

  const totalWithSplits = Object.keys(allSplits).length;
  const totalInactive = Object.values(allSplits).filter(s => s.rosterStatus).length;
  const totalWithRecentForm = Object.values(allSplits).filter(s => s.recentOps != null).length;
  console.log(`Fetched splits for ${totalWithSplits} players across ${teamIds.length - teamFailures}/${teamIds.length} teams (${totalInactive} flagged injured/inactive, ${totalWithRecentForm} with recent-form trend).`);

  let merged = 0;
  for (const p of hotHitters.players) {
    const s = allSplits[p.playerId];
    if (!s) continue;
    Object.assign(p, s);
    merged++;
  }

  hotHitters.generatedAt = new Date().toISOString();
  await writeFile(HOT_HITTERS_PATH, JSON.stringify(hotHitters, null, 2) + '\n');
  console.log(`Merged situational splits onto ${merged} of ${hotHitters.players.length} existing batter records.`);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch(e => { console.error(e); process.exit(1); });
}

export { activeTeamIds, buildSplitsForTeam, extractSplits, main };
