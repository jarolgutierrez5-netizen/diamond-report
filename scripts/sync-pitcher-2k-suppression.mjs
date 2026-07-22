#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// "2-strike contact suppression" — an exploratory signal for whether a
// pitcher's stuff/sequencing gets meaningfully tougher to square up once he's
// got a batter to two strikes, versus his own season-average contact quality
// allowed. Built to test a user question ("is Pitcher IQ a thing that can be
// incorporated into HR Probability?") without committing to wiring it into
// the live model first.
//
// Deliberately NOT built on raw 2-strike HOME RUNS allowed: a single starter
// typically allows only 2-6 home runs with two strikes on across an entire
// season — far too few events to be anything but noise, even after shrinkage.
// Hard-hit% (exit velocity >= HARD_HIT_MPH on any ball actually put in play)
// uses the same underlying batted-ball population but at a much larger sample
// size per pitcher (season-long 2-strike balls-in-play typically run from the
// dozens into the hundreds for a full-time starter), so the resulting rate is
// actually trustworthy rather than shrunk to near-nothing.
//
// Same live-verification caveat as the other Statcast Search-based scripts in
// this repo: this sandbox cannot reach baseballsavant.mlb.com to confirm the
// CSV's exact column names (events, strikes, launch_speed, game_date) against
// a live response — they're the well-documented public schema (the same
// `type=details` per-pitch export sync-pitcher-rolling.mjs and
// sync-near-hrs.mjs already use), not something this script has verified
// itself. Loud schema check + per-pitcher try/catch, same defensive pattern
// as those scripts.
//
// This script intentionally does NOT wire its output into HR Probability or
// any other scoring path yet — it only computes and persists the signal so
// its real distribution/sample sizes can be inspected on live data before
// deciding whether it's worth the added model complexity.
// ─────────────────────────────────────────────────────────────────────────

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseCSV } from './sync-pitcher-statcast.mjs';
import { todaysProbablePitcherIds, pitcherSearchURL } from './sync-pitcher-zone-hr.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const OUT_PATH = path.join(DATA_DIR, 'pitcher-2k-suppression.json');

// Standard industry exit-velocity threshold for "hard-hit" — already used
// elsewhere in this repo (LEAGUE_AVG_HARD_HIT_PCT comparisons).
const HARD_HIT_MPH = 95;
// Empirical-Bayes shrinkage strength for the 2-strike rate toward the
// pitcher's own season rate — same style of constant as SITUATIONAL_SHRINK_K
// (sync-batter-situational-props.mjs) and HR_MULT_SHRINKAGE, sized smaller
// since the 2-strike balls-in-play sample here is typically much larger than
// the situational-props batter buckets those constants were tuned for.
const SUPPRESSION_SHRINK_K = 30;
// A pitcher with fewer 2-strike balls in play than this doesn't get a
// suppression figure at all — even shrunk, a sub-15-sample rate is more
// shrinkage-constant than signal.
const MIN_TWO_STRIKE_BIP = 15;

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

// One row per pitch; a row represents the pitch that ended a plate appearance
// whenever `events` is non-empty. Among those, the ones with a real
// `launch_speed` are the actual balls put in play (a strikeout/walk/HBP also
// sets `events` but leaves launch_speed blank) — same "events present = PA
// outcome row" convention sync-near-hrs.mjs already relies on.
function buildTwoStrikeSuppression(csv, name) {
  const rows = parseCSV(csv);
  if (!rows.length) return null;
  const sample = rows[0];
  if (!('events' in sample) || !('strikes' in sample) || !('launch_speed' in sample)) {
    throw new Error(`unexpected CSV columns for ${name} — got [${Object.keys(sample).join(', ')}]`);
  }

  let seasonBIP = 0, seasonHardHit = 0, twoStrikeBIP = 0, twoStrikeHardHit = 0;
  for (const r of rows) {
    if (!r.events || r.events === '') continue;
    // Number('') is 0, not NaN — a blank launch_speed (strikeout/walk/HBP row) would
    // otherwise silently count as a real "0 mph" batted ball and dilute the hard-hit
    // rate with events that were never actually put in play. Explicit blank check first.
    if (r.launch_speed === '' || r.launch_speed == null) continue;
    const ev = Number(r.launch_speed);
    if (!Number.isFinite(ev)) continue;
    const isHardHit = ev >= HARD_HIT_MPH;
    seasonBIP++;
    if (isHardHit) seasonHardHit++;
    if (Number(r.strikes) === 2) {
      twoStrikeBIP++;
      if (isHardHit) twoStrikeHardHit++;
    }
  }
  if (seasonBIP < 1 || twoStrikeBIP < MIN_TWO_STRIKE_BIP) return null;

  const seasonHardHitRate = seasonHardHit / seasonBIP;
  const rawTwoStrikeHardHitRate = twoStrikeHardHit / twoStrikeBIP;
  const shrunkTwoStrikeHardHitRate = (twoStrikeHardHit + SUPPRESSION_SHRINK_K * seasonHardHitRate) / (twoStrikeBIP + SUPPRESSION_SHRINK_K);

  return {
    seasonBIP,
    seasonHardHitPct: +(seasonHardHitRate * 100).toFixed(1),
    twoStrikeBIP,
    rawTwoStrikeHardHitPct: +(rawTwoStrikeHardHitRate * 100).toFixed(1),
    shrunkTwoStrikeHardHitPct: +(shrunkTwoStrikeHardHitRate * 100).toFixed(1),
    // Negative = suppresses hard contact with two strikes (tougher than his own
    // baseline). Positive = actually gets hit harder with two strikes (grooves
    // pitches / predictable in the count he should be toughest in).
    suppressionDeltaPct: +((shrunkTwoStrikeHardHitRate - seasonHardHitRate) * 100).toFixed(1),
  };
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  const ids = await todaysProbablePitcherIds();
  console.log(`Found ${ids.size} probable starter(s) for today.`);

  const out = { generatedAt: new Date().toISOString(), hardHitMph: HARD_HIT_MPH, shrinkK: SUPPRESSION_SHRINK_K, minTwoStrikeBIP: MIN_TWO_STRIKE_BIP, pitchers: {} };
  let updated = 0, skipped = 0, failed = 0;
  for (const [id, name] of ids) {
    try {
      const csv = await fetchText(pitcherSearchURL(id));
      const result = buildTwoStrikeSuppression(csv, name);
      if (!result) { skipped++; continue; }
      out.pitchers[id] = { name, ...result };
      updated++;
    } catch (e) {
      failed++;
      console.error(`2-strike suppression sync failed for ${name} (${id}):`, e.message);
    }
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`Updated ${updated} pitcher(s), ${skipped} skipped (under ${MIN_TWO_STRIKE_BIP}-BIP sample floor), ${failed} failed, out of ${ids.size} probable starters.`);
  if (updated > 0) {
    await writeFile(OUT_PATH, JSON.stringify(out, null, 2) + '\n');
  }
  if (failed > 0 && updated === 0) process.exitCode = 1;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch(e => { console.error(e); process.exit(1); });
}

export { buildTwoStrikeSuppression, HARD_HIT_MPH, SUPPRESSION_SHRINK_K, MIN_TWO_STRIKE_BIP, main };
