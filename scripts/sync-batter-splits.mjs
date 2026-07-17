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
// ─────────────────────────────────────────────────────────────────────────

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const HOT_HITTERS_PATH = path.join(DATA_DIR, 'statcast-hot-hitters.json');
const SEASON = new Date().getFullYear();
const MLB_API = 'https://statsapi.mlb.com/api/v1';

async function fetchJSON(url, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DiamondReportBot/1.0; +https://diamondreport.app)' } });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
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

async function buildSplitsForTeam(teamId) {
  const url = `${MLB_API}/teams/${teamId}/roster?rosterType=active&hydrate=person(stats(group=[hitting],type=[statSplits],sitCodes=[h,a,risp],season=${SEASON}))`;
  const d = await fetchJSON(url);
  const out = {};
  for (const entry of d.roster || []) {
    const person = entry.person;
    if (!person?.id) continue;
    const splits = extractSplits(person);
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
  console.log(`Fetched splits for ${totalWithSplits} players across ${teamIds.length - teamFailures}/${teamIds.length} teams.`);

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
