#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// NFL groundwork sync — pulls team metadata and the current schedule/scoreboard
// from ESPN's public site API into data/nfl-teams.json and data/nfl-schedule.json.
//
// This is infrastructure only: nothing in app.js reads these files yet, so
// running this script (or its workflow) has zero effect on the live site.
// It exists so the data pipeline is wired up and testable ahead of the NFL
// season (kickoff is early September), rather than building it blind once
// real predictions are wanted.
//
// ESPN's site.api.espn.com endpoints are unofficial and undocumented but are
// free, keyless, and widely relied on. The shapes below reflect their known
// public structure but haven't been verified against a live response from
// this environment (network to external APIs is unavailable in the dev
// sandbox this was written in) — run this via workflow_dispatch once merged
// so a real GitHub Actions runner (which does have normal internet access)
// confirms the team list actually populates before anything is built on top
// of it. The schedule file is expected to come back empty outside the NFL
// season, which is itself a correct result, not a bug.
//
// Zero npm dependencies (Node's built-in fetch), matching update-tracker.mjs.
// ─────────────────────────────────────────────────────────────────────────

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const TEAMS_PATH = path.join(DATA_DIR, 'nfl-teams.json');
const SCHEDULE_PATH = path.join(DATA_DIR, 'nfl-schedule.json');

const TEAMS_URL = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams?limit=40';
const SCOREBOARD_URL = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';

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
    fetchJSON(SCOREBOARD_URL).catch(err => { console.error('Scoreboard fetch failed:', err.message); return null; }),
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
