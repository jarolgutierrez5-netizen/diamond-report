// TEMP diagnostic — verifies the new Ballpark Pal cross-check chips actually
// render client-side against the live production site with real game data.
// Not part of the permanent script set; reverted after use.
import { chromium } from 'playwright';

const BASE = 'https://diamond-report.jarolgutierrez5.workers.dev';

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.on('console', (msg) => { if (msg.type() === 'error') console.log('[browser console error]', msg.text()); });
  page.on('pageerror', (err) => console.log('[browser page error]', err.message));

  // ── Game Projections: Park & Weather panel + Ballpark Pal cross-check row ──
  await page.goto(`${BASE}/#gamepick=game`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.gp-card', { timeout: 25000 }).catch((e) => console.log('GAME PROJECTIONS: no .gp-card found —', e.message));
  await page.waitForTimeout(3000);
  const gpCards = await page.locator('.gp-card').count();
  console.log(`GAME PROJECTIONS: ${gpCards} card(s) rendered`);
  if (gpCards > 0) {
    const first = page.locator('.gp-card').first();
    await first.click();
    await page.waitForTimeout(600);
    const panelText = await first.locator('.gp-details-panel').innerText().catch(() => '<no panel found>');
    console.log('GAME PROJECTIONS: panel text sample:', JSON.stringify(panelText.slice(0, 500)));
    console.log('GAME PROJECTIONS: panel contains "Ballpark Pal":', panelText.includes('Ballpark Pal'));
  }

  // ── HR Threats: per-hitter Ballpark Pal chip ──
  await page.goto(`${BASE}/#gamepick=hr`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.dr1027-hr-card', { timeout: 25000 }).catch((e) => console.log('HR THREATS: no card found —', e.message));
  await page.waitForTimeout(3000);
  const hrCards = await page.locator('.dr1027-hr-card').count();
  const hrBpChips = await page.locator('.dr1027-hr-card:has-text("Ballpark Pal")').count();
  console.log(`HR THREATS: ${hrCards} card(s) rendered, ${hrBpChips} with a Ballpark Pal chip`);

  // ── K Props: game-level Park Env chip ──
  await page.goto(`${BASE}/#gamepick=k`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.dr109-card', { timeout: 25000 }).catch((e) => console.log('K PROPS: no card found —', e.message));
  await page.waitForTimeout(3000);
  const kCards = await page.locator('.dr109-card').count();
  const kParkEnv = await page.locator('.dr109-card:has-text("Park Env")').count();
  console.log(`K PROPS: ${kCards} card(s) rendered, ${kParkEnv} with a Park Env chip`);

  // ── Premium/Elite Picks: doubles/triples/singles badge on Hits/Total Bases ──
  await page.goto(`${BASE}/#gamepick=premium`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.premium-card', { timeout: 25000 }).catch((e) => console.log('PREMIUM: no card found —', e.message));
  await page.waitForTimeout(3000);
  const premiumCards = await page.locator('.premium-card').count();
  const premiumBp = await page.locator('.premium-card:has-text("🌐")').count();
  console.log(`PREMIUM: ${premiumCards} card(s) rendered, ${premiumBp} with a Ballpark Pal badge`);

  await browser.close();
}

main().catch((e) => { console.error('verify-render failed:', e); process.exit(1); });
