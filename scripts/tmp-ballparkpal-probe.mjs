// TEMPORARY diagnostic — not part of the app, deleted after this check.
// Investigates whether ballparkpal.com/Park-Factors.php can be scraped/synced
// automatically (a stable HTML table, an embedded JSON blob, or a discoverable
// CSV export endpoint), as a possible upgrade over the site's current hand-tuned
// wind/temp weather formula.
async function main() {
  const res = await fetch('https://www.ballparkpal.com/Park-Factors.php', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });
  console.log('status:', res.status);
  console.log('content-type:', res.headers.get('content-type'));
  const html = await res.text();
  console.log('length:', html.length);

  // Look for CSV/export hints
  const csvHints = html.match(/[^"']*\.(csv|CSV)[^"']*/g) || [];
  console.log('csv-like references:', JSON.stringify([...new Set(csvHints)].slice(0, 20)));

  const exportHints = html.match(/[^"']*(export|download)[^"']*/gi) || [];
  console.log('export/download references:', JSON.stringify([...new Set(exportHints)].slice(0, 20)));

  // Look for an embedded data table or JSON blob
  const hasTable = /<table/i.test(html);
  console.log('has <table>:', hasTable);
  const scriptMatches = html.match(/<script[^>]*src="([^"]+)"/g) || [];
  console.log('script tags (first 15):', JSON.stringify(scriptMatches.slice(0, 15)));

  // Look for robots meta / login wall signals
  console.log('mentions login/subscribe:', /login|subscribe|sign in|paywall/i.test(html));

  // Print a chunk around the first <table if present
  const tIdx = html.search(/<table/i);
  if (tIdx >= 0) console.log('table snippet:', html.slice(tIdx, tIdx + 1500));

  console.log('--- first 2000 chars of body ---');
  console.log(html.slice(0, 2000));
}
main().catch(e => { console.error('PROBE FAILED', e); process.exit(1); });
