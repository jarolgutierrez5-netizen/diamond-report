#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Real MLB roster transactions (trades, waiver claims, etc.) — a new
// "transaction" headline category (Diamond Report Headlines), sourced
// directly from MLB Stats API's own official transactions log, the same
// public statsapi.mlb.com API already used for schedule/probable-pitcher/
// leaderboard data throughout this codebase (see update-tracker.mjs,
// generate-headlines.mjs's buildLeaderboardHeadline). This is the league's
// own structured transaction record, not copied journalism, so it fits the
// same "real data, no third-party reporting" bar the rest of this app holds
// itself to.
//
// Runs on its own short-interval schedule (sync-transactions.yml), separate
// from the heavier update-tracker.yml pipeline — a trade can happen at any
// hour, and this is a single cheap API call (no Statcast, no per-batter
// fan-out), so it's affordable to check far more often than the 3x/day
// tracker cadence in order to actually feel "live" during the day.
//
// V1 scope is intentionally narrow: real trades only (typeCode 'TR'), each
// tied to a real traded player. Other transaction types (waiver claims,
// DFAs, call-ups, IL moves) are already covered by the injury-return
// headline category or are lower-signal noise for this site's HR/K-focused
// audience — left out rather than added speculatively.
// ─────────────────────────────────────────────────────────────────────────

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const OUT_PATH = path.join(DATA_DIR, 'mlb-transactions.json');
const API = 'https://statsapi.mlb.com/api/v1';

// Kept intentionally wider than the 1-2 day window generate-headlines.mjs
// actually surfaces as "recent" news — this file is the sync's own real
// output, so a brief gap in this workflow's schedule (or generate-headlines
// running before this file updates) still has real, slightly-older trades
// on hand rather than nothing.
const LOOKBACK_DAYS = 5;

function isoDate(d) { return d.toISOString().slice(0, 10); }
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d; }
const WINDOW_START = isoDate(daysAgo(LOOKBACK_DAYS));
const WINDOW_END = isoDate(new Date());

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

// One real trade transaction -> our own trimmed shape. Returns null for
// anything that isn't a real player trade (team-only moves have no
// `person`) rather than guessing at a headline for it.
function normalizeTrade(tx) {
  if (!tx || tx.typeCode !== 'TR' || !tx.person?.fullName) return null;
  return {
    id: tx.id,
    playerId: tx.person.id || null,
    playerName: tx.person.fullName,
    fromTeam: tx.fromTeam?.name || null,
    toTeam: tx.toTeam?.name || null,
    date: tx.date || tx.effectiveDate || null,
    description: tx.description || null,
  };
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  const data = await fetchJSON(`${API}/transactions?startDate=${WINDOW_START}&endDate=${WINDOW_END}`);
  const raw = data?.transactions || [];
  const seen = new Set();
  const trades = [];
  for (const tx of raw) {
    const norm = normalizeTrade(tx);
    if (!norm || seen.has(norm.id)) continue;
    seen.add(norm.id);
    trades.push(norm);
  }
  // Most recent first, same convention as every other "recent events" list
  // in this app (near-hrs, recent-hrs).
  trades.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  console.log(`Found ${trades.length} real trade(s) in the last ${LOOKBACK_DAYS} days (${raw.length} total transactions checked).`);

  const out = { generatedAt: new Date().toISOString(), windowStart: WINDOW_START, windowEnd: WINDOW_END, trades };
  await writeFile(OUT_PATH, JSON.stringify(out, null, 2) + '\n');
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch(e => { console.error(e); process.exit(1); });
}

export { normalizeTrade, main };
