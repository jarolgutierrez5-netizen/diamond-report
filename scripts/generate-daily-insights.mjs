#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Generates data/daily-insights.json — genuine written analysis (a recap
// paragraph of yesterday's graded picks, plus several storyline blurbs about
// today's most notable matchups), grounded entirely in real numbers already
// computed by buildBatterPool/scoreForMarket. Not a template that spins
// generic filler text: every sentence below references a specific stat this
// script actually read for that specific player.
//
// Built in response to an AdSense "low value content" rejection — the site's
// core experience (Games Today, HR Threats, etc.) is entirely tables of
// numbers with no original prose anywhere, which is the textbook trigger for
// that rejection on a sports-picks site. This is the fix: real, substantive,
// auto-updating written content, not more data tables.
// ─────────────────────────────────────────────────────────────────────────

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  buildBatterPool, loadTracker, cdtDateString, scoreForMarket,
} from './update-tracker.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const OUT_PATH = path.join(DATA_DIR, 'daily-insights.json');
const API = 'https://statsapi.mlb.com/api/v1';

async function fetchJSON(url, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw lastErr;
}

function pct(wins, total) {
  return total > 0 ? Math.round((wins / total) * 1000) / 10 : null;
}

// ── Yesterday's recap paragraph ────────────────────────────────────────────
// Pulls every graded (win/loss) pick across all three markets dated exactly
// "yesterday" (CDT) and writes the combined record as a single grounded
// sentence. Used to also name a specific standout hit and a specific miss,
// but those two sentences were dropped by request — just the aggregate
// record now.
function buildRecap(tracker, yesterdayStr) {
  const markets = [
    { key: 'drp', label: 'Game Picks' },
    { key: 'kprop', label: 'Strikeout Props' },
    { key: 'hrThreat', label: 'HR Threats' },
  ];

  let wins = 0, losses = 0;
  for (const m of markets) {
    const rows = (tracker?.market?.[m.key] || []).filter(r => r.date === yesterdayStr && (r.result === 'win' || r.result === 'loss'));
    for (const r of rows) {
      if (r.result === 'win') wins++;
      else losses++;
    }
  }

  const total = wins + losses;
  if (total === 0) {
    return { forDate: yesterdayStr, record: { wins, losses, total, pct: null }, text: null };
  }

  const record = { wins, losses, total, pct: pct(wins, total) };
  const dateLabel = new Date(yesterdayStr + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
  const text = `Diamond Report went ${wins}-${losses} across all markets on ${dateLabel} (${record.pct}%).`;
  return { forDate: yesterdayStr, record, text };
}

// ── Today's storylines ─────────────────────────────────────────────────────
// Ranks today's batter pool by the same scoreForMarket('hr', ...) the live
// HR Threats board itself uses, then writes a 2-3 sentence blurb per notable
// player. Which template a player gets is decided by the same isHot/isDrought/
// isDue/isFavorable tags already computed for the HR Threats board tags —
// this isn't inventing a new signal, just narrating the ones that already
// exist. pitcher2kSuppressionDelta (see sync-pitcher-2k-suppression.mjs) gets
// folded in only when it's large enough to be worth a sentence (|delta|>=5).
const MIN_STORYLINE_AB = 40;
const STORYLINE_COUNT = 5;
const SUPPRESSION_NOTABLE = 5;

function parkDescriptor(pf) {
  if (pf == null) return null;
  if (pf >= 103) return 'a park that plays up for power';
  if (pf <= 97) return 'a pitcher-friendly park';
  return null;
}

function suppressionClause(delta) {
  if (delta == null || Math.abs(delta) < SUPPRESSION_NOTABLE) return '';
  return delta < 0
    ? ` This pitcher has also been genuinely tougher to hit hard once he gets to two strikes this season, not just generically good.`
    : ` Worth noting: this pitcher hasn't actually suppressed hard contact with two strikes this season the way his overall numbers suggest he should.`;
}

function storylineFor(row) {
  const pf = parkDescriptor(row.parkFactor);
  const oppLine = row.pitcherName ? `${row.oppAbbr} sends out ${row.pitcherName}` : `against ${row.oppAbbr}`;

  if (row.isDue) {
    return `${row.name} is in a real home run drought — none in his last 10 games — but the underlying indicators haven't cooled the same way: a .${Math.round(row.iso * 1000)} ISO and a ${row.ops.toFixed(3)} OPS this season say the power is still there, it just hasn't landed yet. ${oppLine} today${pf ? `, in ${pf}` : ''}.${suppressionClause(row.pitcher2kSuppressionDelta)}`;
  }
  if (row.isHot) {
    return `${row.name} is running hot right now, hitting well above his ${row.avg.toFixed(3)} season average over his last games with at least one home run in that stretch. He faces ${oppLine} today${pf ? `, in ${pf}` : ''}, a pitcher who's allowed a ${(row.pitcherAvgAllowed ?? 0).toFixed(3)} average against this season.${suppressionClause(row.pitcher2kSuppressionDelta)}`;
  }
  if (row.isFavorable) {
    return `${row.name} draws a favorable matchup today: his ${row.ops.toFixed(3)} OPS lines up against ${row.pitcherName || 'an opposing pitcher'}'s ${(row.pitcherWhip ?? 0).toFixed(2)} WHIP and ${(row.pitcherAvgAllowed ?? 0).toFixed(3)} average allowed${pf ? `, and the game is in ${pf}` : ''}.${suppressionClause(row.pitcher2kSuppressionDelta)}`;
  }
  return `${row.name} carries a .${Math.round(row.iso * 1000)} ISO and ${row.hrSeason} home runs this season into today's matchup with ${oppLine}, who's allowed a ${(row.pitcherHr9 ?? 0).toFixed(1)} HR/9 this year${pf ? `, in ${pf}` : ''}.${suppressionClause(row.pitcher2kSuppressionDelta)}`;
}

function buildStorylines(pool) {
  const eligible = pool.filter(r => r.atBats >= MIN_STORYLINE_AB && r.name && r.oppAbbr);
  const ranked = eligible
    .map(row => ({ row, score: scoreForMarket('hr', row) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, STORYLINE_COUNT);

  return ranked.map(({ row, score }) => ({
    playerId: row.id, playerName: row.name, team: row.teamAbbr, opp: row.oppAbbr,
    pitcherName: row.pitcherName || null, score,
    text: storylineFor(row),
  }));
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  const today = cdtDateString(new Date());
  const yesterday = cdtDateString(new Date(Date.now() - 24 * 60 * 60 * 1000));
  const season = today.slice(0, 4);

  const tracker = await loadTracker();
  const recap = buildRecap(tracker, yesterday);
  console.log(`Recap for ${yesterday}: ${recap.record.wins}-${recap.record.losses} (${recap.record.total} graded)`);

  // Storylines depend on a live MLB schedule/roster fetch, unlike the recap above
  // (pure local tracker.json read) -- a transient MLB API hiccup here shouldn't cost
  // the day's recap too, so this is isolated in its own try/catch rather than let
  // failing entirely short-circuit main() before the recap gets written out.
  let storylines = [];
  try {
    const sched = await fetchJSON(`${API}/schedule?sportId=1&date=${today}&hydrate=team,probablePitcher,linescore,weather`);
    const games = sched?.dates?.find(d => d.date === today)?.games || [];
    const previewGames = games.filter(g => g.status?.abstractGameState === 'Preview');
    if (previewGames.length) {
      const pool = await buildBatterPool(previewGames, season);
      storylines = buildStorylines(pool);
    }
    console.log(`Built ${storylines.length} storyline(s) for ${today} from a pool of ${previewGames.length} preview game(s).`);
  } catch (e) {
    console.warn(`Storyline generation failed, recap will still be written: ${e.message}`);
  }

  const out = { date: today, generatedAt: new Date().toISOString(), recap, storylines };
  await writeFile(OUT_PATH, JSON.stringify(out, null, 2) + '\n');
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch(e => { console.error(e); process.exit(1); });
}

export { buildRecap, buildStorylines, storylineFor, parkDescriptor, suppressionClause, main };
