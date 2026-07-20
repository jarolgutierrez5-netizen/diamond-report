// TEMPORARY diagnostic — not part of the app, deleted after this check.
// Follow-up to the first probe: confirms whether real per-game DATA ROWS are
// present in the unauthenticated HTML (not just the table headers/shell), since
// the page's own JSON-LD metadata claims isAccessibleForFree:false.
async function main() {
  const res = await fetch('https://www.ballparkpal.com/Park-Factors.php', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });
  console.log('status:', res.status);
  const html = await res.text();
  console.log('length:', html.length);

  // Known real signal for today's slate (from the user's own CSV export) — if this
  // string appears in the raw unauthenticated HTML, real row data is present without
  // needing to log in.
  const needles = ['Coors Field', 'Wrigley Field', 'WAS @ COL', 'DET @ CHC'];
  needles.forEach(needle => {
    const idx = html.indexOf(needle);
    console.log(`"${needle}" found:`, idx >= 0, idx >= 0 ? `at index ${idx}` : '');
  });

  const tIdx = html.search(/<table[^>]*id="parkFactorsTable"/i);
  if (tIdx >= 0) {
    const tbodyIdx = html.indexOf('<tbody', tIdx);
    console.log('tbody found after table start:', tbodyIdx >= 0, 'at', tbodyIdx);
    if (tbodyIdx >= 0) {
      console.log('tbody snippet (2500 chars):', html.slice(tbodyIdx, tbodyIdx + 2500));
    }
  }

  // Check for any AJAX/fetch data-source URL DataTables might be configured with
  // (a sign the table is populated client-side from a separate endpoint instead of
  // server-rendered).
  const ajaxMatch = html.match(/ajax\s*:\s*[^,}\n]+/gi);
  console.log('DataTables ajax config hints:', JSON.stringify(ajaxMatch));

  console.log('mentions isAccessibleForFree:', html.includes('isAccessibleForFree'));
  const ldIdx = html.indexOf('isAccessibleForFree');
  if (ldIdx >= 0) console.log('context around isAccessibleForFree:', html.slice(Math.max(0, ldIdx - 100), ldIdx + 200));
}
main().catch(e => { console.error('PROBE FAILED', e); process.exit(1); });
