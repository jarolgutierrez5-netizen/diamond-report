#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Scans app.js AND nfl-wnba-props.js (the first slice extracted out of app.js
// during a file-size scoping pass -- see that file's own header comment) for
// `window.NAME(...)` call sites with no matching definition anywhere across
// BOTH files -- both are plain classic scripts sharing one global scope at
// runtime (nfl-wnba-props.js loads right after app.min.js in index.html), so
// a definition in either file satisfies a call site in the other. This is the
// exact failure mode behind a real regression this
// session: a "dead code" cleanup deleted a fully live IIFE (window.simulatePropOdds/
// simulateSBOdds/simulateHRGameOdds/simulateKOdds/estimateGamePA) alongside a
// genuinely dead one. Every caller used the `window.X ? window.X(...) : <fallback>`
// guard pattern, so nothing ever threw -- Hits/RBI/TB/SB/HRRBI silently flatlined at
// a meaningless ~50% for every player, and HR Threats silently reverted to a worse
// pre-simulation formula, for the rest of that session's HR Threats work. A hard
// crash would have been caught by any smoke test; this silent-fallback shape is what
// slipped through, so that's specifically what this script hunts for.
//
// A "definition" here means either an explicit `window.NAME = ` assignment anywhere
// in the file, or a true top-level (not nested inside any IIFE/function) `function
// NAME(...)`/`var NAME = ...` declaration -- both auto-attach to window in a classic
// (non-module) script, same behavior this repo already relies on elsewhere (e.g.
// applyHotHitterBoost is reachable via window.applyHotHitterBoost with no explicit
// window.X= line). Top-level `let`/`const` do NOT auto-attach (confirmed elsewhere
// this session), so a top-level `let`/`const` name only counts if it also has an
// explicit `window.X =` line.
//
// Run manually any time: `node scripts/audit-window-refs.mjs`. Wired into
// build-assets.yml so it runs (and fails the build loudly) on every push that
// touches app.js, rather than relying on someone remembering to run it.
// ─────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
// Every plain classic script index.html loads that shares the one runtime
// global scope with app.js -- add a new file here the same way it's added to
// index.html's own <script> list, in load order, whenever a future slice gets
// extracted out of app.js.
const SCAN_FILES = ['app.js', 'nfl-wnba-props.js'];

// Known-safe gaps: guarded call sites (typeof window.X === 'function' checks) whose
// absence causes an optional enhancement to silently no-op, not a wrong/degraded
// result shown to a user -- unlike the dangerous `window.X ? window.X(...) :
// <wrong-fallback>` shape this script exists to catch. Documented here (rather than
// just filtered silently) so a real future regression touching either of these names
// still gets caught if their guard's behavior ever changes.
const KNOWN_SAFE_GAPS = new Set([
  'renderGameProps', // renderGameCenterIfNeeded's fallback after window.loadGameProps (which always exists) -- this branch never runs
  'enhanceDeepResearch', // guarded optional enhancement hook in renderPropIntelligencePanes; absence just skips it
]);

// Native browser/DOM globals -- never "defined" in app.js because the browser
// provides them; calling window.X() for one of these is completely normal and not
// the bug pattern this audit hunts for.
const NATIVE_GLOBALS = new Set([
  'addEventListener', 'removeEventListener', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame',
  'matchMedia', 'open', 'close', 'scrollTo', 'scrollBy', 'alert', 'confirm', 'prompt',
  'fetch', 'getComputedStyle', 'postMessage', 'requestIdleCallback', 'print',
]);

function main() {
  const defined = new Set();
  const called = new Map(); // name -> array of "file:line" strings
  let totalLines = 0;

  for (const fileName of SCAN_FILES) {
    const src = readFileSync(path.join(REPO_ROOT, fileName), 'utf8');
    const lines = src.split('\n');
    totalLines += lines.length;

    // Explicit `window.NAME = ` assignments anywhere in the file (any nesting level).
    for (const m of src.matchAll(/window\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=(?!=)/g)) {
      defined.add(m[1]);
    }

    // True top-level `function NAME(`/`var NAME =` declarations (column-0, not nested
    // inside any IIFE) -- these auto-attach to window; see header comment.
    for (const line of lines) {
      let m = line.match(/^(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/);
      if (m) { defined.add(m[1]); continue; }
      if (/^var\s+/.test(line)) {
        for (const vm of line.matchAll(/([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g)) defined.add(vm[1]);
      }
    }

    // Every `window.NAME(` call site -- a real invocation, not just a truthiness check.
    for (let i = 0; i < lines.length; i++) {
      for (const m of lines[i].matchAll(/window\.([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)) {
        const name = m[1];
        if (!called.has(name)) called.set(name, []);
        called.get(name).push(`${fileName}:${i + 1}`);
      }
    }
  }

  const broken = [];
  const knownSafe = [];
  for (const [name, callLines] of called) {
    if (NATIVE_GLOBALS.has(name)) continue;
    if (defined.has(name)) continue;
    if (KNOWN_SAFE_GAPS.has(name)) { knownSafe.push({ name, callLines }); continue; }
    broken.push({ name, callLines });
  }

  console.log(`Scanned ${totalLines} lines across ${SCAN_FILES.join(', ')}.`);
  console.log(`window.* names called as functions: ${called.size}`);
  console.log(`window.* names with a definition: ${defined.size}`);

  if (knownSafe.length) {
    console.log(`\n${knownSafe.length} known-safe gap(s) (guarded, no dangerous fallback -- see KNOWN_SAFE_GAPS):`);
    for (const g of knownSafe) console.log(`  window.${g.name} — line(s): ${g.callLines.join(', ')}`);
  }

  if (!broken.length) {
    console.log('\n✅ No broken references found — every window.*(...) call site has a matching definition.');
    return 0;
  }

  console.log(`\n❌ ${broken.length} broken reference(s) — called but never defined, with no known-safe explanation:`);
  for (const b of broken.sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`  window.${b.name} — line(s): ${b.callLines.join(', ')}`);
  }
  console.log('\nIf this is a genuine new optional/guarded hook (not a dangerous silent-wrong-fallback), add it to KNOWN_SAFE_GAPS with a comment explaining why it\'s safe. Otherwise this is very likely the same class of regression already found once this session -- go find the real definition.');
  return 1;
}

process.exit(main());
