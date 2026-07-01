#!/usr/bin/env node
/**
 * Diamond Report V4.1 — Statcast Hot Hitter Updater
 *
 * Builds data/statcast-hot-hitters.json for the HR Potential engine.
 * It tries Baseball Savant Statcast Search first, then falls back to Savant custom
 * leaderboards. The website also has a page-level fallback if this file is empty.
 */
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const OUT = path.join(ROOT, 'data', 'statcast-hot-hitters.json');
const SEASON = process.env.MLB_SEASON || new Date().getFullYear().toString();

function isoDate(d) { return d.toISOString().slice(0, 10); }
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d; }
function num(v, fallback = 0) {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(String(v).replace('%',''));
  return Number.isFinite(n) ? n : fallback;
}
function parseCSV(text) {
  const rows = [];
  let row = [], cell = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], nx = text[i+1];
    if (ch === '"' && inQuotes && nx === '"') { cell += '"'; i++; continue; }
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === ',' && !inQuotes) { row.push(cell); cell = ''; continue; }
    if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && nx === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(x => x !== '')) rows.push(row);
      row = [];
      continue;
    }
    cell += ch;
  }
  if (cell || row.length) { row.push(cell); if (row.some(x => x !== '')) rows.push(row); }
  if (!rows.length) return [];
  const header = rows.shift().map(h => h.trim());
  return rows.map(r => Object.fromEntries(header.map((h,i) => [h, r[i] ?? ''])));
}
async function fetchText(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'DiamondReportBot/4.1 (+github-actions)' }});
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return await res.text();
}
function pick(row, names, fallback = '') {
  for (const n of names) if (row[n] !== undefined && row[n] !== '') return row[n];
  return fallback;
}
function aggregateStatcastRows(rows) {
  const by = new Map();
  for (const r of rows) {
    const playerId = pick(r, ['batter', 'player_id', 'playerId']);
    const name = pick(r, ['player_name', 'name', 'last_name, first_name']);
    if (!playerId || !name) continue;
    const key = String(playerId);
    const ev = num(pick(r, ['launch_speed', 'exit_velocity'], ''));
    const la = num(pick(r, ['launch_angle'], ''));
    const xwoba = num(pick(r, ['estimated_woba_using_speedangle', 'estimated_woba_using_speed_angle', 'xwoba'], ''));
    const batSpeed = num(pick(r, ['bat_speed', 'avg_bat_speed'], ''));
    const attackAngle = num(pick(r, ['attack_angle'], ''));
    const b = by.get(key) || { playerId:Number(playerId), name, bbe:0, hard:0, sweet:0, barrels:0, xwobaSum:0, xwobaN:0, batSpeedSum:0, batSpeedN:0, blasts:0 };
    if (ev > 0 || la !== 0) {
      b.bbe++;
      if (ev >= 95) b.hard++;
      if (la >= 8 && la <= 32) b.sweet++;
      if (ev >= 98 && la >= 26 && la <= 30) b.barrels++;
      if (xwoba > 0) { b.xwobaSum += xwoba; b.xwobaN++; }
      if (batSpeed > 0) { b.batSpeedSum += batSpeed; b.batSpeedN++; }
      if (batSpeed >= 75 && attackAngle >= 5 && attackAngle <= 20) b.blasts++;
    }
    by.set(key, b);
  }
  return [...by.values()].filter(p => p.bbe >= 5).map(p => ({
    playerId: p.playerId,
    name: p.name,
    bbe: p.bbe,
    xwoba: +(p.xwobaN ? p.xwobaSum / p.xwobaN : 0).toFixed(3),
    hardHitPct: +(p.bbe ? p.hard / p.bbe * 100 : 0).toFixed(1),
    sweetSpotPct: +(p.bbe ? p.sweet / p.bbe * 100 : 0).toFixed(1),
    barrelPct: +(p.bbe ? p.barrels / p.bbe * 100 : 0).toFixed(1),
    batSpeed: +(p.batSpeedN ? p.batSpeedSum / p.batSpeedN : 0).toFixed(1),
    blastRate: +(p.bbe ? p.blasts / p.bbe * 100 : 0).toFixed(1),
  }));
}
async function fetchRecentStatcast(days) {
  const start = isoDate(daysAgo(days));
  const end = isoDate(new Date());
  const params = new URLSearchParams({
    all: 'true', hfGT: 'R|', player_type: 'batter', game_date_gt: start, game_date_lt: end,
    type: 'details', min_pitches: '0', min_results: '0', group_by: 'name', sort_col: 'launch_speed', sort_order: 'desc'
  });
  const url = `https://baseballsavant.mlb.com/statcast_search/csv?${params.toString()}`;
  const csv = await fetchText(url);
  return aggregateStatcastRows(parseCSV(csv));
}
async function fetchSeasonLeaderboard() {
  const params = new URLSearchParams({
    csv: 'true', chart: 'false', chartType: 'beeswarm', min: 'q', r: 'no', type: 'batter', x: 'pa', y: 'pa', year: SEASON,
    selections: 'pa,woba,xwoba,sweet_spot_percent,barrel_batted_rate,hard_hit_percent,avg_best_speed,avg_hyper_speed,whiff_percent,swing_percent'
  });
  const url = `https://baseballsavant.mlb.com/leaderboard/custom?${params.toString()}`;
  const csv = await fetchText(url);
  return parseCSV(csv).map(r => {
    const playerId = pick(r, ['player_id','playerId','id']);
    const name = pick(r, ['last_name, first_name','player_name','name']);
    if (!playerId || !name) return null;
    return {
      playerId: Number(playerId), name,
      xwoba: num(pick(r, ['xwoba','xwOBA'])),
      hardHitPct: num(pick(r, ['hard_hit_percent','Hard Hit %','hardhit_percent'])),
      sweetSpotPct: num(pick(r, ['sweet_spot_percent','Sweet-Spot %','la_sweet_spot_percent'])),
      barrelPct: num(pick(r, ['barrel_batted_rate','barrel_percent','Barrel %'])),
      batSpeed: num(pick(r, ['avg_best_speed','bat_speed','Bat Speed'])),
      blastRate: num(pick(r, ['blast_percent','Blasts %','blast_rate'])),
    };
  }).filter(Boolean);
}
function scorePlayer(p) {
  const score = Math.max(0, Math.min(100,
    (p.xwoba >= .420 ? 18 : p.xwoba >= .370 ? 13 : p.xwoba >= .330 ? 7 : 0) +
    (p.xwobaTrend >= .060 ? 15 : p.xwobaTrend >= .030 ? 10 : p.xwobaTrend >= .015 ? 5 : 0) +
    (p.hardHitPct >= 52 ? 14 : p.hardHitPct >= 45 ? 10 : p.hardHitPct >= 40 ? 5 : 0) +
    (p.hardHitTrend >= 10 ? 12 : p.hardHitTrend >= 5 ? 8 : p.hardHitTrend >= 2 ? 4 : 0) +
    (p.sweetSpotPct >= 40 ? 9 : p.sweetSpotPct >= 34 ? 6 : p.sweetSpotPct >= 30 ? 3 : 0) +
    (p.sweetSpotTrend >= 8 ? 8 : p.sweetSpotTrend >= 4 ? 5 : p.sweetSpotTrend >= 2 ? 2 : 0) +
    (p.barrelPct >= 15 ? 10 : p.barrelPct >= 10 ? 7 : p.barrelPct >= 7 ? 3 : 0) +
    (p.barrelTrend >= 5 ? 7 : p.barrelTrend >= 2 ? 4 : 0) +
    (p.batSpeed >= 75 ? 5 : p.batSpeed >= 72 ? 3 : 0) +
    (p.batSpeedTrend >= 1.5 ? 5 : p.batSpeedTrend >= .7 ? 3 : 0) +
    (p.blastRate >= 18 ? 5 : p.blastRate >= 12 ? 3 : 0) +
    (p.blastTrend >= 5 ? 5 : p.blastTrend >= 2 ? 3 : 0)
  ));
  return Math.round(score);
}
async function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  let players = [];
  let source = 'none';
  try {
    const recent10 = await fetchRecentStatcast(10);
    const recent30 = await fetchRecentStatcast(30).catch(() => []);
    const season = await fetchSeasonLeaderboard().catch(() => []);
    const seasonBy = new Map(season.map(p => [String(p.playerId), p]));
    const r30By = new Map(recent30.map(p => [String(p.playerId), p]));
    players = recent10.map(r => {
      const base = seasonBy.get(String(r.playerId)) || r30By.get(String(r.playerId)) || {};
      const prev = r30By.get(String(r.playerId)) || base || {};
      const out = {
        ...base, ...r,
        xwobaTrend: +(r.xwoba - num(prev.xwoba)).toFixed(3),
        hardHitTrend: +(r.hardHitPct - num(prev.hardHitPct)).toFixed(1),
        sweetSpotTrend: +(r.sweetSpotPct - num(prev.sweetSpotPct)).toFixed(1),
        barrelTrend: +(r.barrelPct - num(prev.barrelPct)).toFixed(1),
        batSpeedTrend: +(r.batSpeed - num(prev.batSpeed)).toFixed(1),
        blastTrend: +(r.blastRate - num(prev.blastRate)).toFixed(1),
      };
      out.onFireScore = scorePlayer(out);
      out.hotBoostPct = +(out.onFireScore / 100 * 7.5).toFixed(1);
      return out;
    }).filter(p => p.onFireScore >= 35).sort((a,b) => b.onFireScore - a.onFireScore).slice(0, 350);
    source = 'baseballsavant-statcast-search';
  } catch (e) {
    console.warn('Recent Statcast Search failed:', e.message);
    try {
      players = (await fetchSeasonLeaderboard()).map(p => {
        p.xwobaTrend = 0; p.hardHitTrend = 0; p.sweetSpotTrend = 0; p.barrelTrend = 0; p.batSpeedTrend = 0; p.blastTrend = 0;
        p.onFireScore = scorePlayer(p); p.hotBoostPct = +(p.onFireScore / 100 * 5.5).toFixed(1);
        return p;
      }).filter(p => p.onFireScore >= 35).sort((a,b) => b.onFireScore - a.onFireScore).slice(0, 350);
      source = 'baseballsavant-custom-leaderboard';
    } catch (e2) {
      console.warn('Season leaderboard failed:', e2.message);
      players = [];
      source = 'fallback-empty';
    }
  }
  fs.writeFileSync(OUT, JSON.stringify({ schemaVersion:'4.1', updatedAt:new Date().toISOString(), season:SEASON, source, players }, null, 2));
  console.log(`Wrote ${players.length} hot hitters to ${OUT} (${source})`);
}
main().catch(err => { console.error(err); process.exitCode = 1; });
