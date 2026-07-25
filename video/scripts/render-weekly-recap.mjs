import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const trackerPath = path.join(repoRoot, 'data', 'tracker.json');

const MARKET_LABELS = {
  drp: 'Moneyline (DRP)',
  kprop: 'K Props',
  hrThreat: 'HR Threats',
};

function pct(wins, total) {
  return total === 0 ? 0 : Math.round((wins / total) * 100);
}

function computeWeeklyStats(tracker, days = 7) {
  const today = new Date(tracker.generatedAt ?? Date.now());
  const cutoff = new Date(today);
  cutoff.setUTCDate(cutoff.getUTCDate() - (days - 1));
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const todayStr = today.toISOString().slice(0, 10);

  const markets = [];
  let overallWins = 0;
  let overallLosses = 0;

  for (const [key, label] of Object.entries(MARKET_LABELS)) {
    const rows = tracker.market?.[key] ?? [];
    const settled = rows.filter(
      (r) => r.date >= cutoffStr && r.date <= todayStr && (r.result === 'win' || r.result === 'loss'),
    );
    const wins = settled.filter((r) => r.result === 'win').length;
    const losses = settled.filter((r) => r.result === 'loss').length;
    overallWins += wins;
    overallLosses += losses;
    markets.push({ label, wins, losses, winPct: pct(wins, wins + losses) });
  }

  const rangeLabel = `${formatDate(cutoff)} – ${formatDate(today)}`;

  return {
    rangeLabel,
    markets,
    overallWins,
    overallLosses,
    overallWinPct: pct(overallWins, overallWins + overallLosses),
  };
}

function formatDate(d) {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

async function main() {
  const tracker = JSON.parse(readFileSync(trackerPath, 'utf8'));
  const props = computeWeeklyStats(tracker);

  console.log('Rendering WeeklyRecap with:', JSON.stringify(props, null, 2));

  const bundleLocation = await bundle({
    entryPoint: path.join(__dirname, '..', 'src', 'index.ts'),
  });

  const browserExecutable =
    '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell';

  const composition = await selectComposition({
    serveUrl: bundleLocation,
    id: 'WeeklyRecap',
    inputProps: props,
    browserExecutable,
  });

  const outPath = path.join(__dirname, '..', 'out', 'weekly-recap.mp4');

  await renderMedia({
    composition,
    serveUrl: bundleLocation,
    codec: 'h264',
    outputLocation: outPath,
    inputProps: props,
    browserExecutable,
  });

  console.log('Rendered:', outPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
