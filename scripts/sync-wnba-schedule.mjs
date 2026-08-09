#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// WNBA groundwork sync — pulls team metadata and a 7-day schedule window from
// ESPN's public site API into data/wnba-teams.json and data/wnba-schedule.json.
// First real WNBA data source (see scripts/sync-wnba-rosters.mjs and
// sync-wnba-player-stats.mjs for the rest of the pipeline, and the "15+ Points
// Probability" board in app.js that reads all three).
//
// Verified live against real ESPN endpoints during planning (not the
// unverified-in-sandbox caveat the NFL groundwork scripts carry -- this
// sandbox does have a route to site.api.espn.com and every shape below was
// confirmed against a real response before writing this script).
//
// Unlike NFL's scoreboard (which naturally returns the current week's full
// slate with no extra params, since NFL scoring is inherently week-based),
// WNBA's scoreboard endpoint defaults to *today only*. A single `dates=`
// range query (`YYYYMMDD-YYYYMMDD`) pulls a real 7-day window in one call,
// confirmed live to return real games spanning all 7 dates -- needed so the
// "nearest upcoming date" slate logic in renderWNBAPointsBoard always has
// real future games to find, not just whatever's left on today's slate.
//
// ESPN's site.api.espn.com endpoints are unofficial and undocumented but
// free, keyless, and widely relied on (same class of endpoint this app
// already uses for MLB/NFL scoreboards and news, see loadHubNews in app.js).
//
// Zero npm dependencies (Node's built-in fetch), matching update-tracker.mjs
// and the NFL groundwork scripts.
// ─────────────────────────────────────────────────────────────────────────

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const TEAMS_PATH = path.join(DATA_DIR, 'wnba-teams.json');
const SCHEDULE_PATH = path.join(DATA_DIR, 'wnba-schedule.json');

const TEAMS_URL = 'https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/teams?limit=20';

function ymd(d) {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}
function scoreboardURL() {
  const start = new Date();
  const end = new Date(start.getTime() + 6 * 24 * 60 * 60 * 1000);
  return `https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard?dates=${ymd(start)}-${ymd(end)}`;
}

async function fetchJSON(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function normalizeTeams(raw) {
  const list = raw?.sports?.[0]?.leagues?.[0]?.teams || [];
  return list.map(entry => {
    const t = entry?.team || {};
    return {
      id: t.id || null,
      abbreviation: t.abbreviation || null,
      displayName: t.displayName || null,
      shortDisplayName: t.shortDisplayName || null,
      location: t.location || null,
      color: t.color || null,
      alternateColor: t.alternateColor || null,
      logo: t.logos?.[0]?.href || null,
    };
  }).filter(t => t.id);
}

function normalizeSchedule(raw) {
  const events = raw?.events || [];
  return events.map(ev => {
    const comp = ev?.competitions?.[0] || {};
    const competitors = comp.competitors || [];
    const home = competitors.find(c => c.homeAway === 'home');
    const away = competitors.find(c => c.homeAway === 'away');
    return {
      id: ev.id || null,
      date: ev.date || null,
      name: ev.name || null,
      shortName: ev.shortName || null,
      status: comp.status?.type?.name || null,
      completed: !!comp.status?.type?.completed,
      home: home ? { teamId: home.team?.id || null, abbreviation: home.team?.abbreviation || null, score: home.score ?? null } : null,
      away: away ? { teamId: away.team?.id || null, abbreviation: away.team?.abbreviation || null, score: away.score ?? null } : null,
    };
  }).filter(g => g.id);
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  const [teamsRaw, scheduleRaw] = await Promise.all([
    fetchJSON(TEAMS_URL).catch(err => { console.error('Teams fetch failed:', err.message); return null; }),
    fetchJSON(scoreboardURL()).catch(err => { console.error('Scoreboard fetch failed:', err.message); return null; }),
  ]);

  const teams = teamsRaw ? normalizeTeams(teamsRaw) : [];
  const schedule = scheduleRaw ? normalizeSchedule(scheduleRaw) : [];

  console.log(`Teams: ${teams.length}, schedule events (7-day window): ${schedule.length}`);

  await writeFile(TEAMS_PATH, JSON.stringify({ updatedAt: new Date().toISOString(), teams }, null, 2) + '\n');
  await writeFile(SCHEDULE_PATH, JSON.stringify({ updatedAt: new Date().toISOString(), events: schedule }, null, 2) + '\n');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
