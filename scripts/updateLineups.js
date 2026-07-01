#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const API = 'https://statsapi.mlb.com/api/v1';
const outPath = path.join(process.cwd(), 'data', 'lineups.json');
const intelPath = path.join(process.cwd(), 'data', 'lineup-intelligence.json');
const season = new Date().getFullYear();
const MIN_OFFICIAL_BATTERS = 9;

function todayCentral() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

async function getJson(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'DiamondReport-LineupIntelligence/3.6' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
  return res.json();
}

function readJson(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) { return null; }
}

function battingStat(playerObj) {
  return playerObj?.seasonStats?.batting || playerObj?.stats?.batting || {};
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeBoxscoreBatter(playerObj, idx) {
  const person = playerObj?.person || {};
  const stat = battingStat(playerObj);
  return {
    order: idx + 1,
    id: person.id || null,
    name: person.fullName || 'TBD',
    pos: playerObj?.position?.abbreviation || '–',
    stats: stat,
    todayHR: num(playerObj?.stats?.batting?.homeRuns, 0),
    confirmed: true,
    source: 'MLB boxscore batting order'
  };
}

function normalizeRosterBatter(rosterEntry, idx) {
  const stat = rosterEntry?.stats?.[0]?.splits?.[0]?.stat || {};
  return {
    order: idx + 1,
    id: rosterEntry?.person?.id || null,
    name: rosterEntry?.person?.fullName || 'TBD',
    pos: rosterEntry?.position?.abbreviation || '–',
    stats: stat,
    todayHR: 0,
    confirmed: false,
    source: 'active-roster projection'
  };
}

function compactLineupKey(lineup) {
  return (lineup || []).map(p => `${p.order}:${p.id || p.name}`).join('|');
}

function teamImpact(previousTeam, nextTeam) {
  const prev = previousTeam?.lineup || [];
  const next = nextTeam?.lineup || [];
  const prevKey = compactLineupKey(prev);
  const nextKey = compactLineupKey(next);
  const becameOfficial = !previousTeam?.confirmed && nextTeam?.confirmed;
  const changed = prev.length > 0 && prevKey !== nextKey;
  const added = next.filter(n => !prev.some(p => String(p.id || p.name) === String(n.id || n.name))).map(p => p.name);
  const removed = prev.filter(p => !next.some(n => String(n.id || n.name) === String(p.id || p.name))).map(p => p.name);
  const orderChanges = next.filter(n => {
    const p = prev.find(x => String(x.id || x.name) === String(n.id || n.name));
    return p && p.order !== n.order;
  }).map(p => ({ name: p.name, order: p.order }));
  return { becameOfficial, changed, added, removed, orderChanges, prevKey, nextKey };
}

function batterPowerScore(b) {
  const s = b.stats || {};
  const ab = num(s.atBats, 0);
  const hr = num(s.homeRuns, 0);
  const ops = num(s.ops, 0.700);
  const slg = num(s.slg, 0.390);
  const avg = num(s.avg, 0.240);
  const iso = Math.max(0, slg - avg);
  const hrRate = ab ? hr / ab : 0;
  return +(hrRate * 100 * 0.45 + ops * 10 * 0.25 + iso * 20 * 0.30).toFixed(2);
}

function teamSummary(team) {
  const lineup = team?.lineup || [];
  const avgPower = lineup.length ? lineup.reduce((s, b) => s + batterPowerScore(b), 0) / lineup.length : 0;
  const avgKRate = lineup.length ? lineup.reduce((sum, b) => {
    const st = b.stats || {};
    return sum + (num(st.plateAppearances, 0) ? num(st.strikeOuts, 0) / num(st.plateAppearances, 1) : 0.22);
  }, 0) / lineup.length : 0;
  return {
    confirmed: Boolean(team?.confirmed),
    source: team?.source || 'unavailable',
    topPowerBats: [...lineup].map(b => ({ order: b.order, id: b.id, name: b.name, pos: b.pos, score: batterPowerScore(b) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5),
    avgPowerScore: +avgPower.toFixed(2),
    avgKRate: +avgKRate.toFixed(3),
    lineupKey: compactLineupKey(lineup)
  };
}

async function getProjectedLineup(teamId) {
  const rosterUrl = `${API}/teams/${teamId}/roster?rosterType=active&hydrate=stats(group=hitting,type=season,season=${season})`;
  const data = await getJson(rosterUrl);
  return (data.roster || [])
    .filter(p => !['P', 'TWP'].includes(p.position?.abbreviation))
    .sort((a, b) => num(b.stats?.[0]?.splits?.[0]?.stat?.atBats, 0) - num(a.stats?.[0]?.splits?.[0]?.stat?.atBats, 0))
    .slice(0, 9)
    .map(normalizeRosterBatter);
}

function getPreviousTeam(existing, gamePk, side) {
  return existing?.games?.[String(gamePk)]?.teams?.[side] || null;
}

function alreadyConfirmed(existing, gamePk, side) {
  const team = getPreviousTeam(existing, gamePk, side);
  return Boolean(team?.confirmed && Array.isArray(team.lineup) && team.lineup.length >= MIN_OFFICIAL_BATTERS);
}

async function buildTeamLineup({ box, side, teamId, previousTeam }) {
  const teamBox = box?.teams?.[side];
  const official = (teamBox?.batters || [])
    .map(id => teamBox.players?.[`ID${id}`])
    .filter(Boolean)
    .slice(0, 9)
    .map(normalizeBoxscoreBatter);

  if (official.length >= MIN_OFFICIAL_BATTERS) {
    return {
      lineup: official,
      source: 'confirmed MLB batting lineup',
      confirmed: true,
      confirmedAt: previousTeam?.confirmed && compactLineupKey(previousTeam.lineup) === compactLineupKey(official)
        ? previousTeam.confirmedAt
        : new Date().toISOString()
    };
  }

  if (previousTeam?.confirmed && Array.isArray(previousTeam.lineup) && previousTeam.lineup.length >= MIN_OFFICIAL_BATTERS) {
    return {
      lineup: previousTeam.lineup,
      source: previousTeam.source || 'confirmed MLB batting lineup',
      confirmed: true,
      confirmedAt: previousTeam.confirmedAt || new Date().toISOString(),
      preservedFromPreviousRun: true
    };
  }

  try {
    return {
      lineup: await getProjectedLineup(teamId),
      source: 'projected active-roster lineup',
      confirmed: false,
      confirmedAt: null
    };
  } catch (e) {
    return {
      lineup: previousTeam?.lineup || [],
      source: previousTeam?.source || 'unavailable',
      confirmed: Boolean(previousTeam?.confirmed),
      confirmedAt: previousTeam?.confirmedAt || null,
      error: e.message
    };
  }
}

async function main() {
  const date = process.env.LINEUP_DATE || todayCentral();
  const existing = readJson(outPath);
  const scheduleUrl = `${API}/schedule?sportId=1&date=${date}&hydrate=team,probablePitcher&language=en`;
  const sched = await getJson(scheduleUrl);
  const games = sched.dates?.[0]?.games || [];
  const changedGames = [];
  const impacted = [];

  const output = {
    version: 6,
    date,
    generatedAt: new Date().toISOString(),
    timezone: 'America/Chicago',
    status: {
      allConfirmed: false,
      confirmedTeams: 0,
      totalTeams: games.length * 2,
      pendingTeams: games.length * 2,
      confirmedGames: 0,
      totalGames: games.length,
      skippedConfirmedTeams: 0,
      message: 'Lineup Intelligence checks hourly and only keeps polling teams that are still projected.'
    },
    note: 'Official MLB batting order is used as soon as the Stats API boxscore exposes at least nine batters. Confirmed teams are preserved and skipped on later hourly runs. Projected teams keep updating until confirmed.',
    games: {}
  };

  for (const game of games) {
    const gamePk = String(game.gamePk);
    const away = game.teams?.away?.team || {};
    const home = game.teams?.home?.team || {};
    const previousGame = existing?.games?.[gamePk];
    const gameObj = {
      gamePk: game.gamePk,
      date,
      gameDate: game.gameDate,
      status: game.status?.detailedState || game.status?.abstractGameState || 'Scheduled',
      matchup: `${away.abbreviation || away.name} @ ${home.abbreviation || home.name}`,
      allLineupsConfirmed: false,
      lastCheckedAt: new Date().toISOString(),
      teams: {
        away: { id: away.id, abbr: away.abbreviation || away.name, name: away.name, lineup: [], source: 'unavailable', confirmed: false },
        home: { id: home.id, abbr: home.abbreviation || home.name, name: home.name, lineup: [], source: 'unavailable', confirmed: false }
      }
    };

    let box = null;
    const needsBox = !alreadyConfirmed(existing, gamePk, 'away') || !alreadyConfirmed(existing, gamePk, 'home');
    if (needsBox) {
      try { box = await getJson(`${API}/game/${game.gamePk}/boxscore`); }
      catch (e) { gameObj.boxscoreError = e.message; }
    }

    for (const side of ['away', 'home']) {
      const baseTeam = gameObj.teams[side];
      const previousTeam = getPreviousTeam(existing, gamePk, side);
      let built;
      if (previousTeam?.confirmed && Array.isArray(previousTeam.lineup) && previousTeam.lineup.length >= MIN_OFFICIAL_BATTERS) {
        output.status.skippedConfirmedTeams += 1;
        built = {
          lineup: previousTeam.lineup,
          source: previousTeam.source || 'confirmed MLB batting lineup',
          confirmed: true,
          confirmedAt: previousTeam.confirmedAt,
          skippedBecauseAlreadyConfirmed: true
        };
      } else {
        built = await buildTeamLineup({ box, side, teamId: baseTeam.id, previousTeam });
      }

      const nextTeam = { ...baseTeam, ...built };
      gameObj.teams[side] = nextTeam;
      if (nextTeam.confirmed) output.status.confirmedTeams += 1;

      const impact = teamImpact(previousTeam, nextTeam);
      if (impact.becameOfficial || impact.changed || impact.added.length || impact.removed.length || impact.orderChanges.length) {
        impacted.push({
          gamePk: game.gamePk,
          matchup: gameObj.matchup,
          side,
          team: nextTeam.abbr,
          becameOfficial: impact.becameOfficial,
          changed: impact.changed,
          added: impact.added,
          removed: impact.removed,
          orderChanges: impact.orderChanges,
          recalc: ['HR Projections', 'Pitcher Reports', 'K Props']
        });
      }
    }

    gameObj.allLineupsConfirmed = gameObj.teams.away.confirmed && gameObj.teams.home.confirmed;
    if (gameObj.allLineupsConfirmed) output.status.confirmedGames += 1;
    if (impacted.some(i => String(i.gamePk) === gamePk)) changedGames.push({ gamePk: game.gamePk, matchup: gameObj.matchup });
    output.games[gamePk] = gameObj;
  }

  output.status.pendingTeams = output.status.totalTeams - output.status.confirmedTeams;
  output.status.allConfirmed = output.status.totalTeams > 0 && output.status.confirmedTeams === output.status.totalTeams;
  output.status.message = output.status.allConfirmed
    ? 'All MLB batting lineups are confirmed. HR Projections, Pitcher Reports, and K Props can use official lineups.'
    : `${output.status.pendingTeams} team lineup(s) still projected. Hourly Action keeps checking only unconfirmed teams.`;

  const intelligence = {
    version: 1,
    date,
    generatedAt: output.generatedAt,
    status: output.status,
    changedGames,
    impactedTeams: impacted,
    recalcNeeded: impacted.length > 0,
    recalcTargets: impacted.length ? ['HR Projections', 'Pitcher Reports', 'K Props'] : [],
    games: Object.fromEntries(Object.entries(output.games).map(([gamePk, g]) => [gamePk, {
      gamePk: g.gamePk,
      matchup: g.matchup,
      status: g.status,
      allLineupsConfirmed: g.allLineupsConfirmed,
      away: { abbr: g.teams.away.abbr, ...teamSummary(g.teams.away) },
      home: { abbr: g.teams.home.abbr, ...teamSummary(g.teams.home) }
    }]))
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  fs.writeFileSync(intelPath, JSON.stringify(intelligence, null, 2));
  console.log(`Saved ${Object.keys(output.games).length} games to data/lineups.json for ${date}`);
  console.log(output.status.message);
  if (impacted.length) console.log(`Lineup Intelligence flagged ${impacted.length} team update(s) for projection recalculation.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
