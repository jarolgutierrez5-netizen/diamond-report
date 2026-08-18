#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// NFL groundwork sync — pulls team metadata and a 14-day schedule window from
// ESPN's public site API into data/nfl-teams.json and data/nfl-schedule.json.
//
// The scoreboard endpoint used to be called with no params at all, on the
// assumption that NFL scoring is inherently week-based so the parameterless
// call would just return "the current week's full slate." Confirmed live
// (2026-08-18) that assumption was wrong: with no params ESPN's scoreboard
// freezes on the same week's response for the several days between real
// weeks (e.g. still returning the completed Preseason Week 1 slate days
// after those games ended, with real Week 2/3 games already scheduled and
// fetchable). Every NFL board's "nearest upcoming calendar date" scoping
// (nfl-wnba-props.js) depends on data/nfl-schedule.json actually containing
// real future games, so a frozen snapshot silently breaks every board.
//
// Fixed the same way sync-wnba-schedule.mjs already does it: an explicit
// `dates=YYYYMMDD-YYYYMMDD` range query, confirmed live to return real
// STATUS_SCHEDULED games. 14 days (vs. WNBA's 7) covers the real gap between
// the end of NFL preseason and Week 1 regular-season kickoff (~10-11 days in
// most years) -- since the window is anchored to "today" on every daily run,
// it always reaches far enough ahead to find the next real games even across
// that gap, not just a fixed lookback.
//
// ESPN's site.api.espn.com endpoints are unofficial and undocumented but
// free, keyless, and widely relied on (same class of endpoint this app
// already uses for MLB/WNBA scoreboards and news).
//
// Zero npm dependencies (Node's built-in fetch), matching update-tracker.mjs
// and the WNBA groundwork scripts.
// ─────────────────────────────────────────────────────────────────────────

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const TEAMS_PATH = path.join(DATA_DIR, 'nfl-teams.json');
const SCHEDULE_PATH = path.join(DATA_DIR, 'nfl-schedule.json');

const TEAMS_URL = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams?limit=40';

function ymd(d) {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}
function scoreboardURL() {
  const start = new Date();
  const end = new Date(start.getTime() + 13 * 24 * 60 * 60 * 1000);
  return `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${ymd(start)}-${ymd(end)}`;
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

  console.log(`Teams: ${teams.length}, schedule events: ${schedule.length}`);

  await writeFile(TEAMS_PATH, JSON.stringify({ updatedAt: new Date().toISOString(), teams }, null, 2));
  await writeFile(SCHEDULE_PATH, JSON.stringify({ updatedAt: new Date().toISOString(), events: schedule }, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
