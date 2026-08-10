#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Release guard for simulateSBOdds's battery-suppression term (see the fix
// comment right above it in this same file) -- asserts the directionally
// obvious property that was silently violated before this script existed:
// a pitcher/catcher battery that real steal attempts succeed against LESS
// often (a strong battery) must produce a LOWER stolen-base probability than
// an otherwise-identical batter facing a battery that gets stolen on MORE
// often (a weak battery). There was no test anywhere in this repo covering
// this formula at all before now, which is exactly how the inverted sign
// shipped unnoticed.
//
// No historical backtest is possible here -- data/tracker.json has never
// captured stolen bases as a tracked/graded market (only drp/kprop/premium/
// hrThreat exist there), so this is a forward-only correctness check, not a
// before/after comparison against real graded picks.
//
// Run manually (`node scripts/verify-sb-battery-direction.mjs`) or wire into
// a release/CI step -- exits non-zero on failure so it can gate a deploy.
// ─────────────────────────────────────────────────────────────────────────

import { simulateSBOdds } from './update-tracker.mjs';

// Identical batter profile (real SB volume, a legitimate base-stealing
// threat) facing two batteries that differ ONLY in how often real steal
// attempts against them have succeeded this season.
const BASE_ROW = { stolenBases: 20, caughtStealing: 5, atBats: 400 };

// pAtt=20 for both (>= the pAtt>=5 threshold the real-data branch requires),
// success rate against the battery is the only thing that differs.
const WEAK_BATTERY = { ...BASE_ROW, pitcherSbAllowed: 19, pitcherCsAllowed: 1 };   // 95% success against him
const STRONG_BATTERY = { ...BASE_ROW, pitcherSbAllowed: 6, pitcherCsAllowed: 14 }; // 30% success against him

// simulateSBOdds is Monte Carlo (3000 trials) -- average several independent
// calls per fixture rather than trusting a single draw, so this doesn't flake
// near the boundary on an unlucky run.
const REPS = 8;
function avgScore(row) {
  let sum = 0;
  for (let i = 0; i < REPS; i++) sum += simulateSBOdds(row);
  return sum / REPS;
}

const weakScore = avgScore(WEAK_BATTERY);
const strongScore = avgScore(STRONG_BATTERY);

console.log(`Weak battery (95% success against him):   avg score ${weakScore.toFixed(1)}`);
console.log(`Strong battery (30% success against him): avg score ${strongScore.toFixed(1)}`);

if (strongScore >= weakScore) {
  console.error(`\nFAIL: strong-battery score (${strongScore.toFixed(1)}) is not lower than weak-battery score (${weakScore.toFixed(1)}) -- the battery-suppression direction is wrong.`);
  process.exit(1);
}

const gap = weakScore - strongScore;
if (gap < 5) {
  console.error(`\nFAIL: direction is correct but the gap (${gap.toFixed(1)} points) is implausibly small for a 95%-vs-30% success-rate battery difference -- check the formula hasn't been weakened.`);
  process.exit(1);
}

console.log(`\nPASS: strong battery scores ${gap.toFixed(1)} points lower than weak battery, as expected.`);
